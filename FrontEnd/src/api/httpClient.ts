import { controlledFetch } from './fetchControl'

export type ApiQueryParams = Record<string, string | number | boolean | null | undefined>

export type ApiValidationDetailItem = {
  type?: string
  loc?: (string | number)[]
  msg?: string
  input?: unknown
  ctx?: unknown
  url?: string
}

export type ApiFetchOptions = {
  dedupe?: boolean
  dedupeKey?: string
  getCacheMs?: number
  retryOn429?: boolean
  max429Retries?: number
}

export class ApiError extends Error {
  status: number
  detail?: unknown
  validationDetail?: ApiValidationDetailItem[]

  constructor(
    message: string,
    status: number,
    options?: {
      detail?: unknown
      validationDetail?: ApiValidationDetailItem[]
    },
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = options?.detail
    this.validationDetail = options?.validationDetail
  }
}

type ApiUrlBuilder = (path: string, params?: ApiQueryParams) => string

type ApiRequestOptions = {
  init?: RequestInit
  token?: string
  params?: ApiQueryParams
  fetchMode?: 'default' | 'controlled'
  fetchOptions?: ApiFetchOptions
  includeValidationDetail?: boolean
  defaultErrorMessage?: string
}

const DEV_FRONTEND_PORTS = new Set(['3000', '4173', '5173', '5174'])

const sanitizePrefix = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

const sanitizeBase = (value: string) => value.trim().replace(/\/+$/, '')

const API_BASE = sanitizeBase(import.meta.env.VITE_API_BASE_URL ?? '')

const getOrigin = () => (typeof window !== 'undefined' ? window.location.origin : 'http://localhost')

const buildApiRoot = (prefix: string, devGatewayPort?: number) => {
  const isLikelyDevFrontendPort =
    typeof window !== 'undefined' && DEV_FRONTEND_PORTS.has(window.location.port)

  if (devGatewayPort && !API_BASE && import.meta.env.DEV && isLikelyDevFrontendPort) {
    const protocol = window.location.protocol || 'http:'
    const hostname = window.location.hostname || 'localhost'
    return `${protocol}//${hostname}:${devGatewayPort}${prefix}`
  }

  if (!API_BASE) return prefix
  if (!prefix) return API_BASE

  const lowerBase = API_BASE.toLowerCase()
  const lowerPrefix = prefix.toLowerCase()
  if (lowerBase.endsWith(lowerPrefix)) return API_BASE

  return `${API_BASE}${prefix}`
}

export const createApiUrlBuilder = ({
  envPrefix,
  fallbackPrefix,
  devGatewayPort,
}: {
  envPrefix?: string
  fallbackPrefix: string
  devGatewayPort?: number
}): ApiUrlBuilder => {
  const prefix = sanitizePrefix(envPrefix ?? fallbackPrefix)

  return (path, params) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const root = buildApiRoot(prefix, devGatewayPort)
    const target = root ? `${root}${normalizedPath}` : normalizedPath
    const url = new URL(target, getOrigin())

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return
        url.searchParams.set(key, String(value))
      })
    }

    return url.toString()
  }
}

const isFormDataBody = (body: BodyInit | null | undefined): body is FormData =>
  typeof FormData !== 'undefined' && body instanceof FormData

const readJsonPayload = async (response: Response) => {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return null
  return response.json().catch(() => null)
}

const buildValidationMessage = (validationDetail: ApiValidationDetailItem[]) =>
  validationDetail
    .map((item) => {
      const loc = Array.isArray(item?.loc) ? item.loc.join('.') : ''
      return loc ? `${loc}: ${item?.msg ?? 'Du lieu khong hop le'}` : (item?.msg ?? 'Du lieu khong hop le')
    })
    .join('; ')

const buildApiError = (
  payload: unknown,
  status: number,
  includeValidationDetail: boolean,
  defaultErrorMessage: string,
) => {
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const validationDetail =
    includeValidationDetail && Array.isArray(record.detail)
      ? (record.detail as ApiValidationDetailItem[])
      : undefined

  const detailMessage = validationDetail?.length ? buildValidationMessage(validationDetail) : undefined
  const detail =
    detailMessage ??
    (typeof record.detail === 'string' ? record.detail : undefined) ??
    (typeof record.message === 'string' ? record.message : undefined) ??
    `${defaultErrorMessage} (${status})`

  return new ApiError(detail, status, {
    detail: record.detail,
    validationDetail,
  })
}

const executeRequest = async (
  buildUrl: ApiUrlBuilder,
  path: string,
  options: ApiRequestOptions = {},
) => {
  const init = options.init ?? {}
  const headers = new Headers(init.headers)
  const body = init.body ?? null

  if (!headers.has('Content-Type') && body && !isFormDataBody(body)) {
    headers.set('Content-Type', 'application/json')
  }
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`)

  const requestInit: RequestInit = {
    ...init,
    headers,
  }

  const url = buildUrl(path, options.params)
  const response =
    options.fetchMode === 'controlled'
      ? await controlledFetch(url, requestInit, options.fetchOptions ?? {})
      : await fetch(url, requestInit)

  if (!response.ok) {
    const payload = await readJsonPayload(response)
    throw buildApiError(
      payload,
      response.status,
      options.includeValidationDetail ?? false,
      options.defaultErrorMessage ?? 'Yeu cau that bai',
    )
  }

  return response
}

export const requestJson = async <T>(
  buildUrl: ApiUrlBuilder,
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> => {
  const response = await executeRequest(buildUrl, path, options)
  const payload = await readJsonPayload(response)
  return payload as T
}

export const requestBlob = async (
  buildUrl: ApiUrlBuilder,
  path: string,
  options: ApiRequestOptions = {},
) => {
  const response = await executeRequest(buildUrl, path, options)
  return response.blob()
}

export const requestResponse = async (
  buildUrl: ApiUrlBuilder,
  path: string,
  options: ApiRequestOptions = {},
) => executeRequest(buildUrl, path, options)
