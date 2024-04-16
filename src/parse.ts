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
  refs: SwaggerParser.$Refs | null = null

  async init(api: OpenAPIV3.Document<any>) {
    this.refs = await SwaggerParser.resolve(api)
    this.document = resolveCircular(api, new WeakSet()) as OpenAPIV3.Document<{}>
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
      const reqBody = item.requestBody && this.resolveSimpleRef(item.requestBody)
      const bodyContent = reqBody?.content
      const mediaObject = bodyContent
        ? bodyContent?.['application/json'] ||
          bodyContent?.['multipart/form-data'] ||
          _.values(bodyContent)[0]
        : null
      let isMultipart = Boolean(bodyContent?.['multipart/form-data'])

      if (isMultipart) {
        return [mediaObject, isMultipart] as const
      }

      const schema = mediaObject?.schema as OpenAPIV3.SchemaObject | null
      // NOTE
      // fix real cases where `type` is not marked as `multipart/form-data`,
      // but some parameter is actually `binary`
      if (schema && schema.properties) {
        isMultipart = _.values(schema.properties)
          .map((el) => el as OpenAPIV3.SchemaObject)
          .some((el) => el.type === 'string' && el.format === 'binary')
      }

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
      ?.map((el) => this.resolveSimpleRef(el))
      .filter(Boolean)
      .sort((a, b) => a.in.localeCompare(b.in))
      .map((param) => ({
        ...param,
        schema: param.schema as OpenAPIV3.SchemaObject | undefined,
      }))
  }

  private resolveSimpleRef<T extends object>(o: T | OpenAPIV3.ReferenceObject) {
    if (o && '$ref' in o) {
      if (this.refs!.exists(o.$ref)) {
        this.refs!.get(o.$ref) as OpenAPIV3.ParameterObject
      }
      return null as never
    }
    return o as T
  }
}

