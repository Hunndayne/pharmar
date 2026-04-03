import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { inventoryApi } from '../api/inventoryService'
import {
  reportApi,
  type DashboardAiInsightSeverity,
  type DashboardAiInsightsResponse,
  type RestockHighlightResponse,
  type RestockUrgency,
} from '../api/reportService'
import {
  saleApi,
  type SaleInvoiceListItem,
  type SaleInvoiceResponse,
} from '../api/saleService'
import { storeApi } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import {
  formatDateShortInTimeZone,
  formatDateTimeInTimeZone,
  getCurrentDateKeyInTimeZone,
  getMonthStartDateKeyInTimeZone,
  normalizeTimeZone,
  persistAppTimeZone,
  readStoredAppTimeZone,
  shiftDateKey,
  toDateKeyInTimeZone,
} from '../utils/timezone'

type KpiItem = {
  title: string
  value: string
  note: string
}

type TrendRow = {
  date: string
  amount: number
  invoices: number
}

type TopProductRow = {
  name: string
  count: number
  revenue: number
}

const MAX_REPORT_PAGES = 5
const PAGE_SIZE = 50
const MAX_INVOICES_FOR_TOP = 30
const DETAIL_CHUNK_SIZE = 6
const DASHBOARD_AUTO_REFRESH_GAP_MS = 15000
const RESTOCK_LIMIT = 8

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const formatCurrency = (value: number) => `${Math.round(Math.max(0, value)).toLocaleString('vi-VN')}đ`

const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  Math.max(0, value).toLocaleString('vi-VN', options)

const formatQuantity = (value: number) => formatNumber(Math.round(Math.max(0, value)))

const formatDecimal = (value: number, maximumFractionDigits = 1) =>
  formatNumber(value, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })

const formatDateShort = (value: string, timeZone = readStoredAppTimeZone()) =>
  formatDateShortInTimeZone(value, timeZone)

const formatDateTime = (value: string, timeZone = readStoredAppTimeZone()) =>
  formatDateTimeInTimeZone(value, timeZone)

const formatDaysCover = (value: number | null) => {
  if (value === null) return 'Chưa đủ dữ liệu'
  return `${formatDecimal(value)} ngày`
}

const toDateKey = (value: string, timeZone = readStoredAppTimeZone()) =>
  toDateKeyInTimeZone(value, timeZone)

const addDays = (date: Date, diff: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + diff)
  return next
}

const isValidSaleStatus = (status: string) => {
  const normalized = status.trim().toLowerCase()
  return normalized === 'completed' || normalized === 'returned'
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

const urgencyMeta: Record<
  RestockUrgency,
  { label: string; className: string }
> = {
  critical: {
    label: 'Khẩn cấp',
    className: 'border-coral-500/20 bg-coral-500/10 text-coral-500',
  },
  high: {
    label: 'Ưu tiên',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  },
  normal: {
    label: 'Theo dõi',
    className: 'border-brand-500/20 bg-brand-500/10 text-brand-700',
  },
}

const aiSeverityMeta: Record<
  DashboardAiInsightSeverity,
  { label: string; className: string }
> = {
  high: {
    label: 'Ưu tiên cao',
    className: 'border-coral-500/20 bg-coral-500/10 text-coral-500',
  },
  medium: {
    label: 'Cần theo dõi',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  },
  low: {
    label: 'Thông tin',
    className: 'border-brand-500/20 bg-brand-500/10 text-brand-700',
  },
}

const aiStatusMeta = {
  ready: {
    label: 'Sẵn sàng',
    className: 'border-brand-500/20 bg-brand-500/10 text-brand-700',
  },
  stale: {
    label: 'Dữ liệu cũ',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  },
  pending: {
    label: 'Đang chờ lịch',
    className: 'border-ink-900/10 bg-white text-ink-700',
  },
  disabled: {
    label: 'Đã tắt',
    className: 'border-ink-900/10 bg-white text-ink-700',
  },
} as const

export function Dashboard() {
  const { token } = useAuth()
  const lastLoadedAtRef = useRef(0)
  const inFlightRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [restockLoading, setRestockLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiRefreshing, setAiRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restockError, setRestockError] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string>('')

  const [kpis, setKpis] = useState<KpiItem[]>([])
  const [trendRows, setTrendRows] = useState<TrendRow[]>([])
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])
  const [restockData, setRestockData] = useState<RestockHighlightResponse | null>(null)
  const [aiInsights, setAiInsights] = useState<DashboardAiInsightsResponse | null>(null)

  const resolveDashboardTimeZone = useCallback(async () => {
    try {
      const setting = await storeApi.getSetting('system.timezone')
      return persistAppTimeZone(typeof setting.value === 'string' ? setting.value : '')
    } catch {
      return normalizeTimeZone(readStoredAppTimeZone())
    }
  }, [])

  const fetchInvoicesByRange = useCallback(
    async (accessToken: string, dateFrom: string, dateTo: string) => {
      const rows: SaleInvoiceListItem[] = []
      let page = 1
      let pages = 1

      while (page <= pages && page <= MAX_REPORT_PAGES) {
        const response = await saleApi.listInvoices(accessToken, {
          page,
          size: PAGE_SIZE,
          date_from: dateFrom,
          date_to: dateTo,
        })
        rows.push(...response.items)
        pages = Math.max(1, response.pages || 1)
        page += 1
      }

      return rows
    },
    [],
  )

  const buildTopProducts = useCallback(
    async (accessToken: string, invoices: SaleInvoiceListItem[]) => {
      const candidates = invoices
        .filter((invoice) => isValidSaleStatus(invoice.status))
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, MAX_INVOICES_FOR_TOP)

      if (!candidates.length) return [] as TopProductRow[]

      const details: SaleInvoiceResponse[] = []
      for (let index = 0; index < candidates.length; index += DETAIL_CHUNK_SIZE) {
        const chunk = candidates.slice(index, index + DETAIL_CHUNK_SIZE)
        const chunkDetails = await Promise.all(
          chunk.map(async (invoice) => {
            try {
              return await saleApi.getInvoiceById(accessToken, invoice.id)
            } catch {
              return null
            }
          }),
        )
        details.push(...chunkDetails.filter((item): item is SaleInvoiceResponse => item !== null))
      }

      const aggregate = new Map<string, TopProductRow>()
      details.forEach((invoice) => {
        invoice.items.forEach((item) => {
          const name = item.product_name?.trim() || 'Sản phẩm không tên'
          const current = aggregate.get(name) ?? { name, count: 0, revenue: 0 }
          current.count += Math.max(0, item.quantity)
          current.revenue += Math.max(0, toNumber(item.line_total))
          aggregate.set(name, current)
        })
      })

      return Array.from(aggregate.values())
        .sort((left, right) => right.revenue - left.revenue)
        .slice(0, 5)
    },
    [],
  )

  const loadDashboardCore = useCallback(async (accessToken: string, timeZone: string) => {
    const now = new Date()
    const today = getCurrentDateKeyInTimeZone(timeZone, now)
    const firstDayOfMonth = getMonthStartDateKeyInTimeZone(timeZone, now)
    const trendStart = shiftDateKey(today, -13)

    const [todayStats, monthInvoices, trendInvoices, stockSummary] = await Promise.all([
      saleApi.getStatsToday(accessToken),
      fetchInvoicesByRange(accessToken, firstDayOfMonth, today),
      fetchInvoicesByRange(accessToken, trendStart, today),
      inventoryApi.getStockSummary(accessToken),
    ])

    const monthlyValid = monthInvoices.filter((invoice) => isValidSaleStatus(invoice.status))
    const monthRevenue = monthlyValid.reduce(
      (sum, invoice) => sum + Math.max(0, toNumber(invoice.total_amount)),
      0,
    )

    const stockTotal = stockSummary.length
    const stockSafe = stockSummary.filter((item) => item.status === 'normal').length
    const stockNeedAttention = stockSummary.filter((item) => item.status !== 'normal').length
    const stockSafeRate = stockTotal > 0 ? Math.round((stockSafe / stockTotal) * 100) : 0

    const todaySales = Math.max(0, toNumber(todayStats.net_sales))
    const todayReturns = Math.max(0, toNumber(todayStats.total_returns))
    const todayCancelled = Math.max(0, toNumber(todayStats.total_cancelled))

    setKpis([
      {
        title: 'Doanh thu hôm nay',
        value: formatCurrency(todaySales),
        note: `Hoàn trả: ${formatCurrency(todayReturns)} · Hủy: ${formatCurrency(todayCancelled)}`,
      },
      {
        title: 'Doanh thu tháng này',
        value: formatCurrency(monthRevenue),
        note: `${monthlyValid.length.toLocaleString('vi-VN')} hóa đơn hợp lệ`,
      },
      {
        title: 'Số đơn hôm nay',
        value: Math.max(0, todayStats.total_invoices).toLocaleString('vi-VN'),
        note: `Ngày ${formatDateShort(todayStats.date)}`,
      },
      {
        title: 'Tồn kho an toàn',
        value: `${stockSafeRate}%`,
        note: `${stockNeedAttention.toLocaleString('vi-VN')} mặt hàng cần theo dõi`,
      },
    ])

    const trendMap = new Map<string, TrendRow>()
    trendInvoices.forEach((invoice) => {
      if (!isValidSaleStatus(invoice.status)) return
      const key = toDateKey(invoice.created_at)
      if (!key) return

      const current = trendMap.get(key) ?? { date: key, amount: 0, invoices: 0 }
      current.amount += Math.max(0, toNumber(invoice.total_amount))
      current.invoices += 1
      trendMap.set(key, current)
    })

    const trend: TrendRow[] = []
    for (let diff = 13; diff >= 0; diff -= 1) {
      const dateKey = toDateKey(addDays(now, -diff).toISOString())
      trend.push(trendMap.get(dateKey) ?? { date: dateKey, amount: 0, invoices: 0 })
    }
    setTrendRows(trend)

    const top = await buildTopProducts(accessToken, monthInvoices)
    setTopProducts(top)
  }, [buildTopProducts, fetchInvoicesByRange])

  const loadRestockHighlights = useCallback(async (accessToken: string) => {
    const response = await reportApi.getRestockHighlights(accessToken, { limit: RESTOCK_LIMIT })
    setRestockData(response)
  }, [])

  const loadDashboardAiInsights = useCallback(async (accessToken: string) => {
    const response = await reportApi.getDashboardAiInsights(accessToken)
    setAiInsights(response)
  }, [])

  const refreshDashboardAiInsights = useCallback(async () => {
    const accessToken = token?.access_token
    if (!accessToken) {
      setAiError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      return
    }

    setAiRefreshing(true)
    setAiError(null)

    try {
      const timeZone = await resolveDashboardTimeZone()
      const response = await reportApi.refreshDashboardAiInsights(accessToken)
      setAiInsights(response)
      setUpdatedAt(formatDateTimeInTimeZone(new Date(), timeZone))
      lastLoadedAtRef.current = Date.now()
    } catch (refreshError) {
      setAiError(getErrorMessage(refreshError, 'Không thể phân tích AI Insight lúc này.'))
    } finally {
      setAiRefreshing(false)
    }
  }, [resolveDashboardTimeZone, token?.access_token])

  const loadDashboard = useCallback(async (options?: { force?: boolean }) => {
    const force = Boolean(options?.force)
    if (!force) {
      if (inFlightRef.current) return
      if (kpis.length > 0 && Date.now() - lastLoadedAtRef.current < DASHBOARD_AUTO_REFRESH_GAP_MS) {
        return
      }
    }
    const accessToken = token?.access_token
    if (!accessToken) {
      setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      setRestockError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      setAiError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      return
    }

    inFlightRef.current = true
    setLoading(true)
    setRestockLoading(true)
    setAiLoading(true)
    setError(null)
    setRestockError(null)
    setAiError(null)

    try {
      const timeZone = await resolveDashboardTimeZone()
      const [coreResult, restockResult, aiResult] = await Promise.allSettled([
        loadDashboardCore(accessToken, timeZone),
        loadRestockHighlights(accessToken),
        loadDashboardAiInsights(accessToken),
      ])

      let refreshed = false

      if (coreResult.status === 'fulfilled') {
        refreshed = true
      } else {
        setError(getErrorMessage(coreResult.reason, 'Không thể tải dữ liệu dashboard.'))
      }

      if (restockResult.status === 'fulfilled') {
        refreshed = true
      } else {
        setRestockError(
          getErrorMessage(restockResult.reason, 'Không thể tải gợi ý nhập hàng lúc này.'),
        )
      }

      if (aiResult.status === 'fulfilled') {
        refreshed = true
      } else {
        setAiError(
          getErrorMessage(aiResult.reason, 'Không thể tải AI Insight lúc này.'),
        )
      }

      if (refreshed) {
        setUpdatedAt(formatDateTimeInTimeZone(new Date(), timeZone))
        lastLoadedAtRef.current = Date.now()
      }
    } finally {
      inFlightRef.current = false
      setLoading(false)
      setRestockLoading(false)
      setAiLoading(false)
    }
  }, [kpis.length, loadDashboardAiInsights, loadDashboardCore, loadRestockHighlights, resolveDashboardTimeZone, token?.access_token])

  useEffect(() => {
    void loadDashboard({ force: true })
  }, [loadDashboard])

  const maxTrendAmount = useMemo(
    () => trendRows.reduce((max, row) => Math.max(max, row.amount), 0),
    [trendRows],
  )

  const aiBusy = aiLoading || aiRefreshing
  const dashboardBusy = loading || restockLoading || aiBusy
  const restockItems = restockData?.items ?? []
  const restockSummary = restockData
    ? `${restockData.sales_window_days} ngày gần nhất · Mục tiêu đủ hàng ${restockData.target_cover_days} ngày`
    : 'Dựa trên tồn kho hiện tại, doanh số bán gần đây và cấu hình cửa hàng'
  const aiStatus = aiInsights?.status ?? 'pending'
  const aiStatusBadge = aiStatusMeta[aiStatus]
  const aiItems = aiInsights?.items ?? []

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Tổng quan</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Dashboard nhà thuốc</h2>
          {updatedAt ? <p className="mt-2 text-xs text-ink-500">Cập nhật: {updatedAt}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void loadDashboard({ force: true })
          }}
          className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          disabled={dashboardBusy}
        >
          {dashboardBusy ? 'Đang tải...' : 'Tải lại'}
        </button>
      </header>

      {error ? <p className="text-sm text-coral-500">{error}</p> : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((item) => (
          <article key={item.title} className="glass-card rounded-3xl p-5">
            <p className="text-xs uppercase tracking-[0.24em] text-ink-600">{item.title}</p>
            <p className="mt-3 text-3xl font-semibold text-ink-900">{item.value}</p>
            <p className="mt-2 text-sm text-ink-600">{item.note}</p>
          </article>
        ))}
      </section>

      <section className="glass-card rounded-3xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Nhập hàng</p>
            <h3 className="mt-2 text-2xl font-semibold text-ink-900">Gợi ý nhập hàng</h3>
            <p className="mt-2 text-sm text-ink-600">{restockSummary}</p>
            {restockData?.generated_at ? (
              <p className="mt-2 text-xs text-ink-500">
                Dữ liệu sinh lúc {formatDateTime(restockData.generated_at)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/nhap-hang"
              className="inline-flex rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Vào nhập hàng
            </Link>
            <Link
              to="/cua-hang/cai-dat"
              className="inline-flex rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
            >
              Cấu hình
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3">
          <article className="rounded-3xl bg-white/80 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Cần hành động</p>
            <p className="mt-2 text-3xl font-semibold text-ink-900">
              {restockData ? formatQuantity(restockData.total_actionable) : '-'}
            </p>
            <p className="mt-2 text-sm text-ink-600">
              {restockData && restockItems.length < restockData.total_actionable
                ? `Đang hiển thị top ${formatQuantity(restockItems.length)}`
                : 'Danh sách thuốc cần nhập theo cấu hình hiện tại'}
            </p>
          </article>
          <article className="rounded-3xl bg-coral-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-coral-500">Khẩn cấp</p>
            <p className="mt-2 text-3xl font-semibold text-coral-500">
              {restockData ? formatQuantity(restockData.critical_count) : '-'}
            </p>
            <p className="mt-2 text-sm text-coral-500">Mặt hàng có nguy cơ hết hàng ngay</p>
          </article>
          <article className="rounded-3xl bg-amber-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-amber-700">Ưu tiên</p>
            <p className="mt-2 text-3xl font-semibold text-amber-700">
              {restockData ? formatQuantity(restockData.high_count) : '-'}
            </p>
            <p className="mt-2 text-sm text-amber-700">Mặt hàng thấp hơn ngưỡng an toàn</p>
          </article>
        </div>

        {restockLoading && !restockData ? (
          <p className="mt-6 rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">
            Đang tải gợi ý nhập hàng...
          </p>
        ) : null}

        {restockError && !restockItems.length ? (
          <p className="mt-6 rounded-2xl bg-coral-500/10 px-4 py-4 text-sm text-coral-500">
            {restockError}
          </p>
        ) : null}

        {!restockLoading && !restockError && restockData && !restockItems.length ? (
          <p className="mt-6 rounded-2xl bg-brand-500/10 px-4 py-4 text-sm text-brand-700">
            Tồn kho hiện tại đang đủ theo cấu hình.
          </p>
        ) : null}

        {restockItems.length ? (
          <>
            {restockLoading ? (
              <p className="mt-4 text-xs text-ink-500">Đang cập nhật lại gợi ý nhập hàng...</p>
            ) : null}
            {restockError ? (
              <p className="mt-4 text-sm text-coral-500">{restockError}</p>
            ) : null}

            <div className="mt-6 hidden overflow-x-auto lg:block">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ink-900/10 text-xs uppercase tracking-[0.2em] text-ink-500">
                    <th className="pb-3 pr-4">Thuốc</th>
                    <th className="pb-3 pr-4 text-right">Tồn</th>
                    <th className="pb-3 pr-4 text-right">Bán kỳ</th>
                    <th className="pb-3 pr-4 text-right">TB/ngày</th>
                    <th className="pb-3 pr-4 text-right">Đủ hàng</th>
                    <th className="pb-3 pr-4 text-right">Ngưỡng</th>
                    <th className="pb-3 pr-4 text-right">Đề xuất</th>
                    <th className="pb-3 text-right">Mức ưu tiên</th>
                  </tr>
                </thead>
                <tbody>
                  {restockItems.map((item) => {
                    const urgency = urgencyMeta[item.urgency]
                    return (
                      <tr key={item.drug_id} className="border-b border-ink-900/5 align-top">
                        <td className="py-4 pr-4">
                          <p className="font-semibold text-ink-900">
                            {item.drug_name || 'Thuốc chưa đặt tên'}
                          </p>
                          <p className="mt-1 text-xs text-ink-500">
                            {item.drug_code || 'Không có mã'}
                            {item.base_unit ? ` · ${item.base_unit}` : ''}
                          </p>
                        </td>
                        <td className="py-4 pr-4 text-right font-medium text-ink-900">
                          {formatQuantity(item.current_qty)}
                        </td>
                        <td className="py-4 pr-4 text-right text-ink-700">
                          {formatQuantity(item.sold_qty_window)}
                        </td>
                        <td className="py-4 pr-4 text-right text-ink-700">
                          {formatDecimal(item.avg_daily_sold)}
                        </td>
                        <td className="py-4 pr-4 text-right text-ink-700">
                          {formatDaysCover(item.days_cover)}
                        </td>
                        <td className="py-4 pr-4 text-right text-ink-700">
                          {formatQuantity(item.reorder_level)}
                        </td>
                        <td className="py-4 pr-4 text-right font-semibold text-ink-900">
                          {formatQuantity(item.suggested_qty)}
                        </td>
                        <td className="py-4 text-right">
                          <span
                            className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${urgency.className}`}
                          >
                            {urgency.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-6 grid gap-3 lg:hidden">
              {restockItems.map((item) => {
                const urgency = urgencyMeta[item.urgency]
                return (
                  <article key={item.drug_id} className="rounded-3xl bg-white/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-ink-900">
                          {item.drug_name || 'Thuốc chưa đặt tên'}
                        </p>
                        <p className="mt-1 text-xs text-ink-500">
                          {item.drug_code || 'Không có mã'}
                          {item.base_unit ? ` · ${item.base_unit}` : ''}
                        </p>
                      </div>
                      <span
                        className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${urgency.className}`}
                      >
                        {urgency.label}
                      </span>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-ink-700">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Tồn hiện tại</p>
                        <p className="mt-1 font-semibold text-ink-900">
                          {formatQuantity(item.current_qty)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Đề xuất nhập</p>
                        <p className="mt-1 font-semibold text-ink-900">
                          {formatQuantity(item.suggested_qty)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Bán trong kỳ</p>
                        <p className="mt-1">{formatQuantity(item.sold_qty_window)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Đủ hàng</p>
                        <p className="mt-1">{formatDaysCover(item.days_cover)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">TB/ngày</p>
                        <p className="mt-1">{formatDecimal(item.avg_daily_sold)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Ngưỡng</p>
                        <p className="mt-1">{formatQuantity(item.reorder_level)}</p>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        ) : null}
      </section>

      <section className="glass-card rounded-3xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-ink-600">AI Insight</p>
            <h3 className="mt-2 text-2xl font-semibold text-ink-900">Phân tích tự động</h3>
            <p className="mt-2 text-sm text-ink-600">
              Snapshot AI được tạo theo lịch cố định lúc 07:00, 12:00, 18:00.
            </p>
            {aiInsights?.generated_at ? (
              <p className="mt-2 text-xs text-ink-500">
                Tạo lúc {formatDateTime(aiInsights.generated_at)}
                {aiInsights.slot_at ? ` · Slot ${formatDateTime(aiInsights.slot_at)}` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void refreshDashboardAiInsights()
              }}
              className="inline-flex rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition hover:border-ink-900/20 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={aiBusy || aiStatus === 'disabled'}
            >
              {aiRefreshing ? 'Đang phân tích...' : 'Phân tích ngay'}
            </button>
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${aiStatusBadge.className}`}
            >
              {aiStatusBadge.label}
            </span>
          </div>
        </div>

        {aiBusy && !aiInsights ? (
          <p className="mt-6 rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">
            {aiRefreshing ? 'Đang phân tích AI Insight...' : 'Đang tải AI Insight...'}
          </p>
        ) : null}

        {aiError ? (
          <p className="mt-6 rounded-2xl bg-coral-500/10 px-4 py-4 text-sm text-coral-500">
            {aiError}
          </p>
        ) : null}

        {!aiError && aiStatus === 'disabled' ? (
          <p className="mt-6 rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">
            AI Insight đang được tắt trên hệ thống.
          </p>
        ) : null}

        {!aiError && aiStatus === 'pending' ? (
          <p className="mt-6 rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">
            Chưa có snapshot AI. Dashboard sẽ đọc kết quả sau lần phân tích theo lịch tiếp theo hoặc khi bạn chạy phân tích ngay.
          </p>
        ) : null}

        {!aiError && aiStatus === 'stale' ? (
          <p className="mt-6 rounded-2xl bg-amber-500/10 px-4 py-4 text-sm text-amber-700">
            AI tạm thời lỗi ở lượt gần nhất. Đang hiển thị snapshot thành công gần nhất.
          </p>
        ) : null}

        {!aiError && aiStatus !== 'disabled' && aiStatus !== 'pending' && !aiItems.length ? (
          <p className="mt-6 rounded-2xl bg-brand-500/10 px-4 py-4 text-sm text-brand-700">
            AI chưa phát hiện điểm nổi bật nào trong snapshot hiện tại.
          </p>
        ) : null}

        {aiItems.length ? (
          <>
            {aiBusy ? (
              <p className="mt-4 text-xs text-ink-500">Đang đồng bộ lại snapshot AI...</p>
            ) : null}
            <div className="mt-6 grid gap-3 xl:grid-cols-2">
              {aiItems.map((item, index) => {
                const severity = aiSeverityMeta[item.severity]
                return (
                  <article key={`${item.title}-${index}`} className="rounded-3xl bg-white/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="text-lg font-semibold text-ink-900">{item.title}</h4>
                      <span
                        className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${severity.className}`}
                      >
                        {severity.label}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-ink-700">{item.summary}</p>
                    <div className="mt-4 rounded-2xl bg-ink-900/5 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500">
                        Vì sao quan trọng
                      </p>
                      <p className="mt-2 text-sm leading-6 text-ink-700">{item.why_it_matters}</p>
                    </div>
                    <div className="mt-3 rounded-2xl bg-brand-500/10 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-700">
                        Việc nên làm
                      </p>
                      <p className="mt-2 text-sm leading-6 text-ink-800">{item.recommended_action}</p>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-ink-500">
                      <span>Độ tin cậy {formatDecimal(item.confidence * 100, 0)}%</span>
                      <span>{item.source_refs.length.toLocaleString('vi-VN')} fact nội bộ</span>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        ) : null}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.6fr,1fr]">
        <article className="glass-card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Doanh thu</p>
              <h3 className="mt-2 text-2xl font-semibold text-ink-900">Xu hướng 14 ngày</h3>
            </div>
            <span className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-sm font-semibold text-ink-700">
              {trendRows.length
                ? `${formatDateShort(trendRows[0].date)} - ${formatDateShort(trendRows[trendRows.length - 1].date)}`
                : '-'}
            </span>
          </div>

          <div className="mt-6 space-y-2">
            {!trendRows.length ? (
              <p className="rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">
                Chưa có dữ liệu doanh thu.
              </p>
            ) : (
              trendRows.map((row) => {
                const ratio = maxTrendAmount > 0 ? (row.amount / maxTrendAmount) * 100 : 0
                return (
                  <div key={row.date} className="grid grid-cols-[72px,1fr,120px] items-center gap-3 text-sm">
                    <span className="text-ink-600">{formatDateShort(row.date)}</span>
                    <div className="h-2 rounded-full bg-white/80">
                      <div
                        className="h-2 rounded-full bg-brand-500"
                        style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }}
                      />
                    </div>
                    <span className="text-right font-semibold text-ink-900">{formatCurrency(row.amount)}</span>
                  </div>
                )
              })
            )}
          </div>
        </article>

        <article className="glass-card rounded-3xl p-6">
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Thuốc bán chạy</p>
          <h3 className="mt-2 text-2xl font-semibold text-ink-900">Top sản phẩm tháng</h3>
          <div className="mt-5 space-y-4">
            {!topProducts.length ? (
              <p className="text-sm text-ink-600">Chưa có dữ liệu sản phẩm bán chạy.</p>
            ) : (
              topProducts.map((item) => (
                <div key={item.name} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-ink-900">{item.name}</p>
                    <p className="text-sm text-ink-600">{item.count.toLocaleString('vi-VN')} sản phẩm</p>
                  </div>
                  <p className="font-semibold text-ink-700">{formatCurrency(item.revenue)}</p>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </div>
  )
}
