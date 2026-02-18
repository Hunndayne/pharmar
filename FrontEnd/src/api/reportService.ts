import { ApiError, buildUsersApiUrl } from './usersService'

export type ReportSummaryResponse = {
  total_sales: number
  total_revenue: number
}

export type ReportEvent = Record<string, unknown>

const toNumberSafe = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const requestReportJson = async <T>(
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail =
      (typeof payload?.detail === 'string' ? payload.detail : undefined) ??
      payload?.message ??
      `Yêu cầu thất bại (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const reportApi = {
  getSummary: async (token?: string) => {
    const payload = await requestReportJson<unknown>('/report/summary', token, { method: 'GET' })
    if (!payload || typeof payload !== 'object') {
      return { total_sales: 0, total_revenue: 0 } satisfies ReportSummaryResponse
    }
    return {
      total_sales: Math.max(0, Math.round(toNumberSafe((payload as Record<string, unknown>).total_sales))),
      total_revenue: Math.max(0, toNumberSafe((payload as Record<string, unknown>).total_revenue)),
    } satisfies ReportSummaryResponse
  },

  listEvents: async (token?: string) => {
    const payload = await requestReportJson<unknown>('/report/events', token, { method: 'GET' })
    if (!Array.isArray(payload)) return [] as ReportEvent[]
    return payload.filter((item): item is ReportEvent => typeof item === 'object' && item !== null)
  },
}
