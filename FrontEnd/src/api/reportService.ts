import { ApiError, buildUsersApiUrl } from './usersService'

export type ReportSummaryResponse = {
  total_sales: number
  total_revenue: number
}

export type ReportEvent = Record<string, unknown>
export type ReportPageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}
export type ProfitBreakdownGroup = 'invoice' | 'day' | 'week' | 'month' | 'product'

export type ProfitSummaryResponse = {
  invoice_count: number
  net_revenue: number
  cogs: number
  gross_profit: number
  collected_profit: number
  gross_margin_percent: number
  service_fee_total: number
}

export type ProfitInvoiceBreakdownRow = {
  invoice_id: string
  invoice_code: string
  created_at: string
  customer_name: string
  customer_phone: string
  status: string
  subtotal: number
  net_revenue: number
  cogs: number
  gross_profit: number
  collected_profit: number
  amount_paid: number
  debt_amount: number
  service_fee_amount: number
  service_fee_mode: string
}

export type ProfitPeriodBreakdownRow = {
  period_key: string
  invoice_count: number
  net_revenue: number
  cogs: number
  gross_profit: number
  collected_profit: number
}

export type ProfitProductBreakdownRow = {
  product_id: string
  product_code: string
  product_name: string
  sold_base_qty: number
  net_revenue: number
  cogs: number
  gross_profit: number
  margin_percent: number
}

const toNumberSafe = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const requestReportJson = async <T>(
  path: string,
  token?: string,
  init: RequestInit = {},
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path, params), {
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

  getProfitSummary: async (
    token: string,
    params?: { date_from?: string; date_to?: string },
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/profit/summary',
      token,
      { method: 'GET' },
      params,
    )
    const row = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    return {
      invoice_count: Math.max(0, Math.round(toNumberSafe(row.invoice_count))),
      net_revenue: Math.max(0, toNumberSafe(row.net_revenue)),
      cogs: Math.max(0, toNumberSafe(row.cogs)),
      gross_profit: toNumberSafe(row.gross_profit),
      collected_profit: toNumberSafe(row.collected_profit),
      gross_margin_percent: toNumberSafe(row.gross_margin_percent),
      service_fee_total: Math.max(0, toNumberSafe(row.service_fee_total)),
    } satisfies ProfitSummaryResponse
  },

  getProfitBreakdown: async <T extends Record<string, unknown>>(
    token: string,
    params: {
      group_by: ProfitBreakdownGroup
      page?: number
      size?: number
      date_from?: string
      date_to?: string
    },
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/profit/breakdown',
      token,
      { method: 'GET' },
      params,
    )
    if (!payload || typeof payload !== 'object') {
      return { items: [], total: 0, page: 1, size: params.size ?? 20, pages: 1 } as ReportPageResponse<T>
    }
    const row = payload as Record<string, unknown>
    return {
      items: Array.isArray(row.items) ? (row.items as T[]) : [],
      total: Math.max(0, Math.round(toNumberSafe(row.total))),
      page: Math.max(1, Math.round(toNumberSafe(row.page)) || 1),
      size: Math.max(1, Math.round(toNumberSafe(row.size)) || (params.size ?? 20)),
      pages: Math.max(1, Math.round(toNumberSafe(row.pages)) || 1),
    } satisfies ReportPageResponse<T>
  },

  getProfitTopProducts: async (
    token: string,
    params?: { date_from?: string; date_to?: string; limit?: number },
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/profit/top-products',
      token,
      { method: 'GET' },
      params,
    )
    if (!Array.isArray(payload)) return [] as ProfitProductBreakdownRow[]
    return payload.filter(
      (item): item is ProfitProductBreakdownRow => typeof item === 'object' && item !== null,
    )
  },
}
