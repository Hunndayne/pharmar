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

export type RestockUrgency = 'critical' | 'high' | 'normal'

export type RestockHighlightItem = {
  drug_id: string
  drug_code: string
  drug_name: string
  base_unit: string
  current_qty: number
  reorder_level: number
  sold_qty_window: number
  avg_daily_sold: number
  target_qty: number
  suggested_qty: number
  days_cover: number | null
  stock_status: string
  urgency: RestockUrgency
}

export type RestockHighlightResponse = {
  generated_at: string
  sales_window_days: number
  target_cover_days: number
  total_actionable: number
  critical_count: number
  high_count: number
  items: RestockHighlightItem[]
}

export type DashboardAiInsightSeverity = 'high' | 'medium' | 'low'
export type DashboardAiInsightStatus = 'ready' | 'stale' | 'pending' | 'disabled'

export type DashboardAiInsightItem = {
  title: string
  summary: string
  why_it_matters: string
  recommended_action: string
  severity: DashboardAiInsightSeverity
  confidence: number
  source_refs: string[]
}

export type DashboardAiInsightsResponse = {
  status: DashboardAiInsightStatus
  generated_at: string
  slot_at: string
  model: string
  items: DashboardAiInsightItem[]
}

const toNumberSafe = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const toStringSafe = (value: unknown) => (typeof value === 'string' ? value : '')

const mapDashboardAiInsightsResponse = (payload: unknown) => {
  const row = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const itemsRaw = Array.isArray(row.items) ? row.items : []
  const statusRaw = toStringSafe(row.status).toLowerCase()

  return {
    status:
      statusRaw === 'ready' || statusRaw === 'stale' || statusRaw === 'disabled'
        ? statusRaw
        : 'pending',
    generated_at: toStringSafe(row.generated_at),
    slot_at: toStringSafe(row.slot_at),
    model: toStringSafe(row.model),
    items: itemsRaw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        const severityRaw = toStringSafe(item.severity).toLowerCase()
        const refsRaw = Array.isArray(item.source_refs) ? item.source_refs : []
        return {
          title: toStringSafe(item.title),
          summary: toStringSafe(item.summary),
          why_it_matters: toStringSafe(item.why_it_matters) || toStringSafe(item.summary),
          recommended_action:
            toStringSafe(item.recommended_action) ||
            'Kiểm tra chi tiết trên dashboard và xử lý trong ngày.',
          severity:
            severityRaw === 'high' || severityRaw === 'low'
              ? severityRaw
              : 'medium',
          confidence: Math.max(0, Math.min(1, toNumberSafe(item.confidence))),
          source_refs: refsRaw
            .map((entry) => toStringSafe(entry))
            .filter(Boolean),
        } satisfies DashboardAiInsightItem
      })
      .filter((item) => item.title && item.summary && item.why_it_matters && item.source_refs.length > 0),
  } satisfies DashboardAiInsightsResponse
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

  getRestockHighlights: async (
    token: string,
    params?: { limit?: number },
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/restock/highlights',
      token,
      { method: 'GET' },
      params,
    )
    const row = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
    const itemsRaw = Array.isArray(row.items) ? row.items : []

    return {
      generated_at: toStringSafe(row.generated_at),
      sales_window_days: Math.max(7, Math.round(toNumberSafe(row.sales_window_days)) || 60),
      target_cover_days: Math.max(1, Math.round(toNumberSafe(row.target_cover_days)) || 14),
      total_actionable: Math.max(0, Math.round(toNumberSafe(row.total_actionable))),
      critical_count: Math.max(0, Math.round(toNumberSafe(row.critical_count))),
      high_count: Math.max(0, Math.round(toNumberSafe(row.high_count))),
      items: itemsRaw
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => {
          const urgency = toStringSafe(item.urgency).toLowerCase()
          return {
            drug_id: toStringSafe(item.drug_id),
            drug_code: toStringSafe(item.drug_code),
            drug_name: toStringSafe(item.drug_name),
            base_unit: toStringSafe(item.base_unit),
            current_qty: Math.max(0, Math.round(toNumberSafe(item.current_qty))),
            reorder_level: Math.max(0, Math.round(toNumberSafe(item.reorder_level))),
            sold_qty_window: Math.max(0, Math.round(toNumberSafe(item.sold_qty_window))),
            avg_daily_sold: Math.max(0, toNumberSafe(item.avg_daily_sold)),
            target_qty: Math.max(0, Math.round(toNumberSafe(item.target_qty))),
            suggested_qty: Math.max(0, Math.round(toNumberSafe(item.suggested_qty))),
            days_cover:
              item.days_cover === null || item.days_cover === undefined
                ? null
                : Math.max(0, toNumberSafe(item.days_cover)),
            stock_status: toStringSafe(item.stock_status),
            urgency:
              urgency === 'critical' || urgency === 'high'
                ? urgency
                : 'normal',
          } satisfies RestockHighlightItem
        }),
    } satisfies RestockHighlightResponse
  },

  getDashboardAiInsights: async (
    token: string,
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/ai/dashboard-insights',
      token,
      { method: 'GET' },
    )
    return mapDashboardAiInsightsResponse(payload)
  },

  refreshDashboardAiInsights: async (
    token: string,
  ) => {
    const payload = await requestReportJson<unknown>(
      '/report/ai/dashboard-insights/refresh',
      token,
      { method: 'POST' },
    )
    return mapDashboardAiInsightsResponse(payload)
  },
}
