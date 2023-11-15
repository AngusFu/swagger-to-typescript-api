import { compile } from 'json-schema-to-typescript'
import _, { camelCase, fromPairs, mapValues } from 'lodash'
import { OpenAPIV3 } from 'openapi-types'

import { Parser } from './parse'

type Operation = NonNullable<ReturnType<Parser['getProcessedOperationObjects']>>[number]

export async function renderOperation(operation: Operation) {
  const { method, url } = operation.__extra__
  const requestLine = `${method.toUpperCase()} ${url}`

  const op = preprocessOperation(operation)

  const omitAxiosKeysType = [
    'method',
    'url',
    op.params.query ? 'params' : null,
    op.data ? 'data' : null,
  ]
    .filter(Boolean)
    .map((el) => JSON.stringify(el))
    .join('|')
  const configType = [
    `Omit<AxiosRequestConfig<any>, ${omitAxiosKeysType}>`,
    op.params.query
      ? op.params.query.required
        ? `{ params: __BaseTypes__['Params'] }`
        : `{ params?: __BaseTypes__['Params'] }`
      : '',
    op.data
      ? op.data.required
        ? "{ data: __BaseTypes__['Body'] }"
        : "{ data?: __BaseTypes__['Body'] }"
      : '',
  ]
    .filter(Boolean)
    .join('&')

  const pathParams = op.params.path?.value.map((el) => ({
    ...el,
    name: camelCase(el.name),
  }))
  const simplePathArgs = op.params.path?.isSimple
    ? pathParams
        ?.map(({ required, schema, name }) => {
          const isI64 = schema?.format === 'int64'
          const realType = schema?.type !== 'string' && !isI64 ? 'number' : 'string'

          return `${isI64 ? '/** @format int64 */' : ''} ${name}: ${realType}${
            !required ? '| undefined' : ''
          }`
        })
        .join(',')
    : ''

  const fnArgs = [
    op.params.path?.isSimple
      ? simplePathArgs
      : op.params.path
      ? `pathParams: __BaseTypes__["PathParams"]`
      : '',
    op.params.query?.required || op.data?.required
      ? `__options: __Config`
      : `__options?: __Config`,
  ]
    .filter(Boolean)
    .join(',')

  const pathExpr = op.params.path?.isSimple
    ? `interpolatePath(__url, {${pathParams?.map((el) => el.name).join(',') || ''}})`
    : op.params.path
    ? `interpolatePath(__url, pathParams)`
    : '__url'

  const fnResult = _.trim(`
     (${fnArgs}) => ({
      ...__options,
      url: ${pathExpr},
      method: "${method}",
      data: ${op.data?.isMultipart ? 'toFormData' : ''}(__options?.data)
    })
  `)

  const interfaceCode = await compileToTs(op.helperSchema, '__BaseTypes__')

  return `
    /**
     * @summary ${requestLine}
     * @path ${operation.summary}
     */
    function ${operation.operationId!}() {
      const __path = "${requestLine}" as const;
      const __url = __path.slice(${method.length + 1});

      ${interfaceCode.replace(/([\s])export[\s]+(type|enum|interface)/g, '$1$2')}

      type __Config = ${configType};
      const __request = ${fnResult};

      return {
        [__path]: [
          0 as unknown as __BaseTypes__ & { ResponseData:  PickData<__BaseTypes__["Response"]> },
          __request
        ] as const
      };
    }
  `
}

function compileToTs(schema: any, name: string) {
  return compile(schema, name, {
    format: false,
    bannerComment: undefined,
    additionalProperties: false,
    declareExternallyReferenced: true,
    unreachableDefinitions: false,
  })
}

function preprocessOperation(operation: Operation) {
  const { requestBody, isMultipart, responseData } = operation

  const pathParams = operation.parameters.pathParams
  const queryParams = operation.parameters.queryParams

  const hasPathParams = pathParams.length > 0
  const hasQuery = queryParams.length > 0
  const hasRequestBody = Boolean(requestBody?.schema)
  const hasRequiredQuery = hasQuery && queryParams.some((el) => el.required)
  const hasRequiredBody = (requestBody?.schema as OpenAPIV3.SchemaObject)?.required
    ?.length

  const isSimplePathParams =
    pathParams.length > 0 &&
    pathParams.length < 3 &&
    pathParams.every((el) => el.required)

  const helperSchema = {
    type: 'object',
    summary: operation.summary,
    deprecated: operation.deprecated,
    description: operation.description || operation.summary,
    required: ['Body', 'Response', 'Params', 'PathParams'],
    properties: {
      Body: hasRequestBody
        ? processSchemaObject(requestBody!.schema!, 'Body')
        : undefined,
      Response: responseData?.schema
        ? processSchemaObject(responseData.schema, 'Response')
        : undefined,
      Params: queryParams.length
        ? {
            type: 'object',
            properties: fromPairs(
              queryParams.map((el) => [
                el.name,
                processSchemaObject(el.schema!, 'Params'),
              ])
            ),
          }
        : undefined,
      PathParams: queryParams.length
        ? {
            type: 'object',
            properties: fromPairs(
              pathParams.map((el) => [
                el.name,
                processSchemaObject(el.schema!, 'PathParams'),
              ])
            ),
          }
        : undefined,
    },
  }

  return {
    params: {
      path: hasPathParams
        ? {
            value: pathParams,
            isSimple: isSimplePathParams,
          }
        : null,
      query: hasQuery
        ? {
            value: queryParams,
            required: hasRequiredQuery,
          }
        : null,
    },

    data: requestBody
      ? {
          value: requestBody,
          isMultipart,
          required: hasRequiredBody,
        }
      : null,

    helperSchema,
  }
}

function processSchemaObject(
  _schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  interfaceName: string
): any {
  if (!_schema) return

  const schema = _schema as OpenAPIV3.SchemaObject
  const { type, format } = schema
  const title = schema.title && (interfaceName || schema.title)

  if (type === 'array') {
    return {
      ...schema,
      title,
      items: schema.items && processSchemaObject(schema.items, `${interfaceName}Item$`),
    }
  }

  if (type === 'object') {
    return {
      ...schema,
      title,
      properties: mapValues(schema.properties, (val, key) =>
        processSchemaObject(val, `${interfaceName}_${_.upperFirst(key)}`)
      ),
    }
  }

  // int64 处理
  const type2 = type === 'integer' && format === 'int64' ? 'string' : type

  return {
    ...schema,
    type: type2,
    title,
    description: [schema.description || '', format ? `@format ${format}` : '']
      .join('\n')
      .trim(),
  }
}
