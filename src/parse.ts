import _ from 'lodash'
import { OpenAPIV3 } from 'openapi-types'

import SwaggerParser from '@apidevtools/swagger-parser'

const HTTP_METHODS = Object.values(OpenAPIV3.HttpMethods) as OpenAPIV3.HttpMethods[]

function resolveCircular(obj: any, seen: WeakSet<any>) {
  _.forEach(obj, (value, key) => {
    if (value !== null && typeof value === 'object') {
      // 简单解决循环引用
      if (seen.has(value)) {
        if (key === 'items') {
          obj[key] = { tsType: '/** recursive */ any' }
        } else if (key === 'properties') {
          obj[key] = _.mapValues(value, (v) => {
            return { tsType: '/** recursive */ any' }
          })
        } else {
          return {}
        }
      } else {
        seen.add(value)
        _.forEach(value, (val) => resolveCircular(val, seen))
        seen.delete(value)
      }
    }
  })

  return obj
}

export class Parser {
  document: OpenAPIV3.Document | null = null
  parser = new SwaggerParser()

  async init(api: OpenAPIV3.Document<any>) {
    const doc = await SwaggerParser.dereference(api)

    this.document = resolveCircular(doc, new WeakSet()) as OpenAPIV3.Document<{}>
  }

  public getProcessedOperationObjects() {
    if (!this.document) return null as never

    const { paths } = this.document
    const pathKeys = Object.keys(paths)

    return pathKeys
      .filter((key) => paths[key])
      .map((key) => [key, paths[key] as OpenAPIV3.PathItemObject] as const)
      .map(([key, path]) =>
        HTTP_METHODS.filter((method) => path?.[method]).map(
          (method) => [key, method, { ...path![method]! }] as const
        )
      )
      .flat(1)
      .map(([url, method, item]) => this.processOperationObject(item, { url, method }))
  }

  private processOperationObject(
    item: OpenAPIV3.OperationObject,
    { url, method }: { url: string; method: string }
  ) {
    const [requestBody, isMultipart] = (() => {
      const bodyContent = (item.requestBody as OpenAPIV3.RequestBodyObject)?.content
      const mediaObject = bodyContent
        ? bodyContent?.['application/json'] ||
          bodyContent?.['multipart/form-data'] ||
          _.values(bodyContent)[0]
        : null
      const isMultipart = Boolean(bodyContent?.['multipart/form-data'])

      return [mediaObject, isMultipart] as const
    })()

    const parameters = this.processParametersObject(item.parameters) || []
    const pathParams = parameters
      .filter((el) => el.in === 'path')
      .sort((a, b) => Number(b.schema?.required || 0) - Number(a.schema?.required || 0))
    const queryParams = parameters.filter((el) => el.in === 'query')
    const responseData = _.values(
      (item.responses['200'] as OpenAPIV3.ResponseObject)?.content
    )?.[0]

    return {
      ...item,
      isMultipart,
      parameters: {
        pathParams,
        queryParams,
      },
      responseData,
      requestBody: requestBody,
      __extra__: { url, method },
    }
  }

  private processParametersObject(parameters: OpenAPIV3.OperationObject['parameters']) {
    return parameters
      ?.map((el) => el! as OpenAPIV3.ParameterObject)
      .sort((a, b) => a.in.localeCompare(b.in))
      .map((param) => ({
        ...param,
        schema: param.schema as OpenAPIV3.SchemaObject | undefined,
      }))
  }
}
