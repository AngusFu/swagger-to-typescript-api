import _ from 'lodash'
import { OpenAPI, OpenAPIV2, OpenAPIV3 } from 'openapi-types'
import prettier from 'prettier'
import { convertObj } from 'swagger2openapi'

import { Parser } from './parse'
import { renderOperation } from './render'

interface OpenAPITypeConversion {
  boolean?: { default?: string }
  number?: {
    default?: string
    float?: string
    double?: string
  }
  integer?: {
    default?: string
    int32?: string
    int64?: string
  }
  string?: {
    default?: string
    date?: string
    'date-time'?: string
    password?: string
    binary?: string
    byte?: string
    [key: string]: any
  }
}

export async function swaggerToTypeScript(
  document: OpenAPI.Document<{}>,
  options?: {
    openAPITypes?: OpenAPITypeConversion
  }
) {
  const parser = new Parser()

  if ((document as any).swagger?.startsWith('2.')) {
    fixMissingRef(document)
    await parser.init(
      (await convertObj(document as OpenAPIV2.Document<{}>, { resolve: false })).openapi
    )
  } else {
    await parser.init(document as OpenAPIV3.Document<{}>)
  }

  const code = [
    ` /* eslint-disable */
      import { toFormData } from 'axios'
      import type { AxiosResponse, AxiosRequestConfig, AxiosInstance } from 'axios'
      type PickData<T> = T extends { data?: any } ? T['data'] : any
      const interpolatePath = (str: string, values: any) => str.replace(/{([^{}]+)}/g, (_, g1) => values[g1])

      ${renderTypeConversion(options?.openAPITypes)}
    `,
  ]

  const ops = parser.getProcessedOperationObjects() || []
  const tasks = ops.map((el) => () => renderOperation(el))

  while (tasks.length) {
    code.push(await tasks.pop()!()!)
  }

  code.push(`
    const collectApis = () => ({
      ${ops
        .reduce((acc, el) => [...acc, `...${el.operationId}(),`], [] as string[])
        .join('\n')}
    });

    export type Collection = ReturnType<typeof collectApis>
    export type Keys = keyof Collection
    export type ApiTypes<K extends Keys> = Collection[K][0]
    export type ApiRequestParams<K extends Keys> = Parameters<Collection[K][1]>
    
    export type ApiDataTypes<K extends Keys, T extends keyof ApiTypes<Keys>> = ApiTypes<K>[T]
    
    export function createRequest(axios: AxiosInstance) {
      const collections = collectApis()
    
      return function request<K extends Keys, U = any>(key: K) {
        const fn = collections[key][1] as (...args: any[]) => AxiosRequestConfig;
    
        return (...args: ApiRequestParams<K>) => axios(fn(...args)) as Promise<U>
      }
    }
    
    type Arg<K extends Keys> = ApiRequestParams<K>
    type BaseResp<K extends Keys, U extends "Response" | "ResponseData"> = Promise<AxiosResponse<ApiDataTypes<K, U>>>;

    export interface BaseRequest<T extends "Response" | "ResponseData"> {
      ${ops
        .map((el) => ({
          ...el,
          title: el.description || '',
          req: `"${el.__extra__.method.toUpperCase()} ${el.__extra__.url}"`,
        }))
        .map(
          (el) => `
          /** @summary ${el.summary} */
          <K extends ${el.req}>(key: K): (...args: Arg<K>) => BaseResp<K, T>;
        `
        )
        .join('\n')}
    }

    export function createAxiosAPI(axios: AxiosInstance) {
      return createRequest(axios) as BaseRequest<'Response'>
    }
  `)

  const fullCode = await prettier.format(code.join('\n'), {
    parser: 'typescript',
    tabWidth: 2,
    printWidth: 120,
    proseWrap: 'never',
    singleQuote: true,
    semi: true,
    trailingComma: 'es5',
    endOfLine: 'auto',
  })

  return fullCode
}

function fixMissingRef(obj: any, root = obj) {
  _.forEach(obj, (value) => {
    if (value !== null && typeof value === 'object') {
      // 删除无效引用
      if ('$ref' in value) {
        if (!_.get(root, value.$ref.replace('#/', '').split('/'))) {
          delete value.$ref
          delete value.originalRef
        }
      } else {
        _.forEach(value, (val) => fixMissingRef(val, root))
      }
    }
  })

  return obj
}

function renderTypeConversion(opt?: OpenAPITypeConversion) {
  const getBooleanType = (key: string, defaults = 'boolean') =>
    _.get(opt, ['boolean', key], defaults)
  const getNumberType = (key: string, defaults = 'number') =>
    _.get(opt, ['number', key], defaults)
  const getIntType = (key: string, defaults = 'number') =>
    _.get(opt, ['integer', key], defaults)
  const getStringType = (key: string, defaults = 'string') =>
    _.get(opt, ['string', key], defaults)

  const stringFormats = _.without(
    _.keys(opt?.string),
    ...['default', 'date', 'date-time', 'password', 'binary', 'byte']
  )

  return `
      type $$Boolean = {
        /** @SEE https://swagger.io/docs/specification/data-models/data-types/#boolean */
        ['default']: ${getBooleanType('default')}
      }

      type $$Number = {
        /**
         * Any numbers.
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['default']: ${getNumberType('default')}
        /**
         * Floating-point numbers.
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['float']: ${getNumberType('float')}
        /**
         * Floating-point numbers with double precision.
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['double']: ${getNumberType('double')}
      }

      type $$Integer = {
        /**
         * Integer numbers.
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['default']: ${getIntType('default')}
        /**
         * Signed 32-bit integers (commonly used integer type).
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['int32']: ${getIntType('int32')}
        /**
         * Signed 64-bit integers (long type).
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#numbers
         */
        ['int64']: ${getIntType('int64', 'string')}
      }

      // https://swagger.io/docs/specification/data-models/data-types/#string
      type $String = {
        /**
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#string
         */
        ['default']: ${getStringType('default')}
        /**
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#string
         */
        ['date']: ${getStringType('date')}
        /**
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#string
         */
        ['date-time']: ${getStringType('date-time')}
        /**
         * a hint to UIs to mask the input
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#string
         */
        ['password']: ${getStringType('password')}
        /**
         * binary file contents
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#file
         */
        ['binary']: ${getStringType('binary', 'File')}
        /**
         * 通常代表 base64-encoded file contents
         * 但是实际使用中貌似也有例外
         * @SEE https://swagger.io/docs/specification/data-models/data-types/#file
         */
        ['byte']: ${getStringType('byte')}

        ${stringFormats.map((key) => `['${key}']: ${getStringType(key)};`).join('\n')}
      }
    

      type $Get<T extends { default: any; [k: string]: any }, K extends string> = [K] extends [
        keyof T,
      ]
        ? T[K]
        : T['default']

      type __GetType<
        // https://cswr.github.io/JsonSchema/spec/basic_types/
        // https://swagger.io/docs/specification/data-models/data-types/
        Type extends 'string' | 'number' | 'integer' | 'boolean',
        Fmt extends string = 'default',
      > = [Type] extends ['number']
        ? $Get<$$Number, Fmt>
        : [Type] extends ['integer']
        ? $Get<$$Integer, Fmt>
        : [Type] extends ['boolean']
        ? $Get<$$Boolean, Fmt>
        : [Type] extends ['string']
        ? $Get<$String, Fmt>
        : never
        
  `
}
