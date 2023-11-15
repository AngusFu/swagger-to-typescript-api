import _ from 'lodash'
import { OpenAPI, OpenAPIV2, OpenAPIV3 } from 'openapi-types'
import prettier from 'prettier'
import { convertObj } from 'swagger2openapi'

import { Parser } from './parse'
import { renderOperation } from './render'

export async function swaggerToTypeScript(document: OpenAPI.Document<{}>) {
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
    semi: false,
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
