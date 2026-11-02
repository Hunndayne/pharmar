import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { inventoryApi, type InventoryStockStatus } from '../api/inventoryService'
import {
  reportApi,
  type ProfitProductBreakdownRow,
  type RestockHighlightResponse,
  type RestockUrgency,
} from '../api/reportService'
import { saleApi } from '../api/saleService'
import { storeApi } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { SkeletonChart, SkeletonKpi, SkeletonList } from '../components/Skeleton'
import {
  formatDateShortInAppTimeZone as formatDateShort,
  formatDateTimeInTimeZone,
  getCurrentDateKeyInTimeZone,
  getMonthStartDateKeyInTimeZone,
  normalizeTimeZone,
  persistAppTimeZone,
  readStoredAppTimeZone,
  shiftDateKey,
} from '../utils/timezone'

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

type StockCounts = Record<InventoryStockStatus, number> & { total: number }

type CoreData = {
  todaySales: number
  todayReturns: number
  todayCancelled: number
  todayInvoices: number
  monthRevenue: number
  monthInvoices: number
  trend: TrendRow[]
  topProducts: TopProductRow[]
  stock: StockCounts
}

type AlertTone = 'danger' | 'warning'

type AlertItem = {
  key: string
  label: string
  hint: string
  count: number
  to: string
  tone: AlertTone
}

const TREND_DAYS = 14
const RESTOCK_LIMIT = 6

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const formatCurrency = (value: number) => `${Math.round(Math.max(0, value)).toLocaleString('vi-VN')}đ`

const formatCompactCurrency = (value: number) => {
  const safe = Math.max(0, value)
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`
  if (safe >= 1_000) return `${Math.round(safe / 1_000).toLocaleString('vi-VN')}k`
  return `${Math.round(safe)}`
}

const formatQuantity = (value: number) => Math.round(Math.max(0, value)).toLocaleString('vi-VN')

const formatDecimal = (value: number) =>
  Math.max(0, value).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })

const formatDaysCover = (value: number | null) => (value === null ? '—' : `${formatDecimal(value)} ngày`)

const percentChange = (current: number, previous: number) => {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

const emptyStockCounts = (): StockCounts => ({
  total: 0,
  out_of_stock: 0,
  expired: 0,
  expiring_soon: 0,
  near_date: 0,
  low_stock: 0,
  normal: 0,
})

const urgencyMeta: Record<RestockUrgency, { label: string; className: string }> = {
  critical: { label: 'Khẩn cấp', className: 'bg-coral-500/10 text-coral-500' },
  high: { label: 'Ưu tiên', className: 'bg-amber-500/10 text-amber-700' },
  normal: { label: 'Theo dõi', className: 'bg-brand-500/10 text-brand-700' },
}

const alertToneMeta: Record<AlertTone, { dot: string; count: string }> = {
  danger: { dot: 'bg-coral-500', count: 'text-coral-500' },
  warning: { dot: 'bg-amber-500', count: 'text-amber-700' },
}

const buildAlerts = (stock: StockCounts, restock: RestockHighlightResponse | null): AlertItem[] => {
  const candidates: AlertItem[] = [
    { key: 'expired', label: 'Lô đã hết hạn', hint: 'Tách khỏi quầy và lập biên bản hủy', count: stock.expired, to: '/han-su-dung', tone: 'danger' },
    { key: 'out', label: 'Hết hàng', hint: 'Khách hỏi sẽ không có để bán', count: stock.out_of_stock, to: '/ton-kho', tone: 'danger' },
    { key: 'critical', label: 'Cần nhập gấp', hint: 'Sắp hết theo tốc độ bán hiện tại', count: restock?.critical_count ?? 0, to: '/goi-y-nhap-hang', tone: 'danger' },
    { key: 'expiring', label: 'Sắp hết hạn', hint: 'Ưu tiên bán trước hoặc trả nhà cung cấp', count: stock.expiring_soon, to: '/han-su-dung', tone: 'warning' },
    { key: 'near', label: 'Cận date', hint: 'Theo dõi để xếp lên trước', count: stock.near_date, to: '/han-su-dung', tone: 'warning' },
    { key: 'low', label: 'Tồn thấp', hint: 'Dưới ngưỡng đặt hàng lại', count: stock.low_stock, to: '/goi-y-nhap-hang', tone: 'warning' },
  ]
  return candidates.filter((item) => item.count > 0)
}

function ChevronIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-4 w-4 ${className}`} aria-hidden="true">
      <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} aria-hidden="true">
      <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.2h-3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) return null
  const rounded = Math.round(value)
  const tone =
    rounded > 0 ? 'bg-brand-500/10 text-brand-700' : rounded < 0 ? 'bg-coral-500/10 text-coral-500' : 'bg-ink-900/5 text-ink-600'
  const arrow = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '•'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {arrow} {Math.abs(rounded)}%
    </span>
  )
}

function KpiCard({ title, value, children }: { title: string; value: string; children?: React.ReactNode }) {
  return (
    <article className="glass-card rounded-3xl p-4 sm:p-5">
      <p className="text-xs font-medium text-ink-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">{value}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-500">{children}</div>
    </article>
  )
}

function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-lg font-semibold text-ink-900">{title}</h3>
        {subtitle ? <p className="mt-1 text-sm text-ink-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function Dashboard() {
  const { token } = useAuth()
  const inFlightRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restockError, setRestockError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState('')
  const [core, setCore] = useState<CoreData | null>(null)
  const [restockData, setRestockData] = useState<RestockHighlightResponse | null>(null)

  const resolveDashboardTimeZone = useCallback(async (accessToken: string) => {
    try {
      const setting = await storeApi.getSetting(accessToken, 'system.timezone')
      return persistAppTimeZone(typeof setting.value === 'string' ? setting.value : '')
    } catch {
      return normalizeTimeZone(readStoredAppTimeZone())
    }
  }, [])

  const loadCore = useCallback(async (accessToken: string, timeZone: string): Promise<CoreData> => {
    const now = new Date()
    const today = getCurrentDateKeyInTimeZone(timeZone, now)
    const firstDayOfMonth = getMonthStartDateKeyInTimeZone(timeZone, now)
    // The month may be older than the trend window, so fetch from whichever starts earlier.
    const trendStart = shiftDateKey(today, -(TREND_DAYS - 1))
    const fetchFrom = firstDayOfMonth < trendStart ? firstDayOfMonth : trendStart

    const [todayStats, revenueSummary, stockSummary, topProductsRaw] = await Promise.all([
      saleApi.getStatsToday(accessToken),
      reportApi.getRevenueSummary(accessToken, { date_from: fetchFrom, date_to: today }),
      inventoryApi.getStockSummary(accessToken),
      reportApi.getProfitTopProducts(accessToken, { date_from: firstDayOfMonth, date_to: today, limit: 5 }),
    ])

    const monthRows = revenueSummary.daily_rows.filter((r) => r.date >= firstDayOfMonth)
    const dailyMap = new Map(revenueSummary.daily_rows.map((r) => [r.date, r]))
    const trend: TrendRow[] = []
    for (let diff = TREND_DAYS - 1; diff >= 0; diff -= 1) {
      const dateKey = shiftDateKey(today, -diff)
      const row = dailyMap.get(dateKey)
      trend.push({ date: dateKey, amount: row?.total_amount ?? 0, invoices: row?.invoice_count ?? 0 })
    }

    const stock = emptyStockCounts()
    stock.total = stockSummary.length
    for (const item of stockSummary) {
      if (item.status in stock) stock[item.status] += 1
    }

    return {
      todaySales: Math.max(0, toNumber(todayStats.net_sales)),
      todayReturns: Math.max(0, toNumber(todayStats.total_returns)),
      todayCancelled: Math.max(0, toNumber(todayStats.total_cancelled)),
      todayInvoices: Math.max(0, todayStats.total_invoices),
      monthRevenue: monthRows.reduce((sum, r) => sum + r.total_amount, 0),
      monthInvoices: monthRows.reduce((sum, r) => sum + r.invoice_count, 0),
      trend,
      topProducts: topProductsRaw.map((p: ProfitProductBreakdownRow) => ({
        name: p.product_name || 'Sản phẩm không tên',
        count: p.sold_base_qty,
        revenue: p.net_revenue,
      })),
      stock,
    }
  }, [])

  const loadDashboard = useCallback(async () => {
    if (inFlightRef.current) return
    const accessToken = token?.access_token
    if (!accessToken) {
      setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      return
    }

    inFlightRef.current = true
    setLoading(true)
    setError(null)
    setRestockError(null)

    try {
      const timeZone = await resolveDashboardTimeZone(accessToken)
      const [coreResult, restockResult] = await Promise.allSettled([
        loadCore(accessToken, timeZone),
        reportApi.getRestockHighlights(accessToken, { limit: RESTOCK_LIMIT }),
      ])

      if (coreResult.status === 'fulfilled') {
        setCore(coreResult.value)
      } else {
        setError(getErrorMessage(coreResult.reason, 'Không thể tải dữ liệu tổng quan.'))
      }

      if (restockResult.status === 'fulfilled') {
        setRestockData(restockResult.value)
      } else {
        setRestockError(getErrorMessage(restockResult.reason, 'Không thể tải gợi ý nhập hàng lúc này.'))
      }

      if (coreResult.status === 'fulfilled' || restockResult.status === 'fulfilled') {
        setUpdatedAt(formatDateTimeInTimeZone(new Date(), timeZone))
      }
    } finally {
      inFlightRef.current = false
      setLoading(false)
    }
  }, [loadCore, resolveDashboardTimeZone, token?.access_token])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const trend = useMemo(() => core?.trend ?? [], [core])
  const maxTrendAmount = useMemo(() => trend.reduce((max, row) => Math.max(max, row.amount), 0), [trend])
  const yesterdayAmount = trend.length >= 2 ? trend[trend.length - 2].amount : 0
  const last7 = trend.slice(-7).reduce((sum, r) => sum + r.amount, 0)
  const prev7 = trend.slice(-14, -7).reduce((sum, r) => sum + r.amount, 0)
  const trendTotal = trend.reduce((sum, r) => sum + r.amount, 0)
  const peakDay = trend.reduce<TrendRow | null>((best, r) => (r.amount > 0 && (!best || r.amount > best.amount) ? r : best), null)

  const alerts = core ? buildAlerts(core.stock, restockData) : []
  const stockSafeRate = core && core.stock.total > 0 ? Math.round((core.stock.normal / core.stock.total) * 100) : null
  const restockItems = restockData?.items ?? []
  const topProducts = core?.topProducts ?? []
  const maxTopRevenue = topProducts.reduce((max, p) => Math.max(max, p.revenue), 0)
  const showSkeleton = loading && !core

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Tổng quan</p>
          <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">Dashboard nhà thuốc</h2>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt ? <span className="hidden text-xs text-ink-500 sm:inline">Cập nhật {updatedAt}</span> : null}
          <button
            type="button"
            onClick={() => {
              void loadDashboard()
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition hover:border-ink-900/20 disabled:opacity-60"
          >
            <RefreshIcon spinning={loading} />
            {loading ? 'Đang tải' : 'Tải lại'}
          </button>
        </div>
      </header>

      {error ? <p className="rounded-2xl bg-coral-500/10 px-4 py-3 text-sm text-coral-500">{error}</p> : null}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {showSkeleton || !core ? (
          Array.from({ length: 4 }, (_, index) => (
            showSkeleton ? (
              <SkeletonKpi key={index} />
            ) : (
              <div key={index} className="glass-card h-[118px] rounded-3xl" />
            )
          ))
        ) : (
          <>
            <KpiCard title="Doanh thu hôm nay" value={formatCurrency(core.todaySales)}>
              <span>Hôm qua {formatCompactCurrency(yesterdayAmount)}</span>
              {core.todayReturns > 0 || core.todayCancelled > 0 ? (
                <span className="text-coral-500">
                  Trả/hủy {formatCompactCurrency(core.todayReturns + core.todayCancelled)}
                </span>
              ) : null}
            </KpiCard>
            <KpiCard title="Đơn hôm nay" value={formatQuantity(core.todayInvoices)}>
              <span>
                {core.todayInvoices > 0
                  ? `TB ${formatCompactCurrency(core.todaySales / core.todayInvoices)}/đơn`
                  : 'Chưa có đơn nào'}
              </span>
            </KpiCard>
            <KpiCard title="7 ngày qua" value={formatCurrency(last7)}>
              <DeltaBadge value={percentChange(last7, prev7)} />
              <span>so với 7 ngày trước</span>
            </KpiCard>
            <KpiCard title="Tháng này" value={formatCurrency(core.monthRevenue)}>
              <span>{formatQuantity(core.monthInvoices)} hóa đơn</span>
            </KpiCard>
          </>
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="glass-card flex flex-col rounded-3xl p-5 sm:p-6 xl:col-span-2">
          <SectionHeader
            title="Doanh thu 14 ngày"
            subtitle={
              trend.length
                ? `${formatDateShort(trend[0].date)} – ${formatDateShort(trend[trend.length - 1].date)} · Tổng ${formatCurrency(trendTotal)}`
                : undefined
            }
            action={
              peakDay ? (
                <span className="rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-700">
                  Cao nhất {formatDateShort(peakDay.date)} · {formatCompactCurrency(peakDay.amount)}
                </span>
              ) : null
            }
          />

          {!trend.length ? (
            showSkeleton ? (
              <SkeletonChart className="mt-6 h-48" />
            ) : (
              <div className="mt-6 h-48 rounded-2xl bg-white/60" />
            )
          ) : (
            <div className="mt-6 flex flex-1 flex-col">
              <div className="relative min-h-48 flex-1">
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                  {[0, 1, 2].map((line) => (
                    <div key={line} className="border-t border-dashed border-ink-900/10" />
                  ))}
                </div>
                <span className="absolute -top-5 right-0 text-[11px] text-ink-400">
                  {formatCompactCurrency(maxTrendAmount)}
                </span>
                <div className="relative flex h-full items-end gap-1 sm:gap-2">
                  {trend.map((row, index) => {
                    const isToday = index === trend.length - 1
                    const ratio = maxTrendAmount > 0 ? (row.amount / maxTrendAmount) * 100 : 0
                    return (
                      <div key={row.date} className="group relative flex h-full flex-1 items-end">
                        <div
                          className={`w-full rounded-t-md transition-colors ${
                            isToday ? 'bg-brand-600' : 'bg-brand-300 group-hover:bg-brand-500'
                          }`}
                          style={{ height: `${row.amount > 0 ? Math.max(2, ratio) : 0}%` }}
                        />
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-xl bg-ink-900 px-3 py-2 text-xs text-white shadow-lift group-hover:block">
                          <p className="font-semibold">{formatCurrency(row.amount)}</p>
                          <p className="text-white/70">
                            {formatDateShort(row.date)} · {formatQuantity(row.invoices)} đơn
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="mt-2 flex gap-1 sm:gap-2">
                {trend.map((row, index) => (
                  <span
                    key={row.date}
                    className={`flex-1 text-center text-[10px] sm:text-xs ${
                      index === trend.length - 1 ? 'font-semibold text-brand-700' : 'text-ink-400'
                    } ${index % 2 === 1 && index !== trend.length - 1 ? 'invisible sm:visible' : ''}`}
                  >
                    {row.date.slice(8, 10)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </article>

        <article className="glass-card flex flex-col rounded-3xl p-5 sm:p-6">
          <SectionHeader title="Cần xử lý" subtitle="Tính từ tồn kho và tốc độ bán hiện tại" />

          <div className="mt-4 flex-1">
            {!core ? (
              showSkeleton ? (
                <SkeletonList rows={3} leading="dot" />
              ) : (
                <div className="h-40 rounded-2xl bg-white/60" />
              )
            ) : alerts.length ? (
              <ul className="divide-y divide-ink-900/5">
                {alerts.map((item) => {
                  const tone = alertToneMeta[item.tone]
                  return (
                    <li key={item.key}>
                      <Link
                        to={item.to}
                        className="group -mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 transition hover:bg-white/80"
                      >
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink-900">{item.label}</span>
                          <span className="block truncate text-xs text-ink-500">{item.hint}</span>
                        </span>
                        <span className={`text-lg font-semibold tabular-nums ${tone.count}`}>
                          {formatQuantity(item.count)}
                        </span>
                        <ChevronIcon className="text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-ink-600" />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="rounded-2xl bg-brand-500/10 px-4 py-6 text-center">
                <p className="text-sm font-semibold text-brand-700">Không có việc gấp</p>
                <p className="mt-1 text-xs text-brand-700/80">Tồn kho và hạn dùng đang ổn.</p>
              </div>
            )}
          </div>

          {stockSafeRate !== null && core ? (
            <div className="mt-4 border-t border-ink-900/5 pt-4">
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>Tồn kho an toàn</span>
                <span className="font-semibold text-ink-900">
                  {stockSafeRate}% · {formatQuantity(core.stock.normal)}/{formatQuantity(core.stock.total)} mặt hàng
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-900/5">
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${stockSafeRate}%` }} />
              </div>
            </div>
          ) : null}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="glass-card rounded-3xl p-5 sm:p-6 xl:col-span-2">
          <SectionHeader
            title="Gợi ý nhập hàng"
            subtitle={
              restockData
                ? `Theo doanh số ${restockData.sales_window_days} ngày · đủ hàng ${restockData.target_cover_days} ngày`
                : undefined
            }
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/goi-y-nhap-hang"
                  className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold text-brand-700 transition hover:bg-brand-500/10"
                >
                  Xem tất cả
                  {restockData && restockData.total_actionable > 0 ? ` (${formatQuantity(restockData.total_actionable)})` : ''}
                  <ChevronIcon />
                </Link>
                <Link
                  to="/nhap-hang"
                  className="inline-flex rounded-full bg-ink-900 px-4 py-1.5 text-sm font-semibold text-white"
                >
                  Nhập hàng
                </Link>
              </div>
            }
          />

          {restockError ? (
            <p className="mt-4 rounded-2xl bg-coral-500/10 px-4 py-3 text-sm text-coral-500">{restockError}</p>
          ) : null}

          {!restockData && !restockError ? (
            <SkeletonList rows={4} leading="none" className="mt-4" />
          ) : null}

          {restockData && !restockItems.length ? (
            <p className="mt-4 rounded-2xl bg-brand-500/10 px-4 py-4 text-sm text-brand-700">
              Tồn kho hiện tại đủ theo cấu hình, chưa cần nhập thêm.
            </p>
          ) : null}

          {restockItems.length ? (
            <>
              <div className="mt-4 hidden overflow-x-auto sm:block">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-ink-900/10 text-xs text-ink-500">
                      <th className="pb-2 pr-4 font-medium">Thuốc</th>
                      <th className="pb-2 pr-4 text-right font-medium">Tồn</th>
                      <th className="pb-2 pr-4 text-right font-medium">Bán/ngày</th>
                      <th className="pb-2 pr-4 text-right font-medium">Còn đủ</th>
                      <th className="pb-2 pr-4 text-right font-medium">Nên nhập</th>
                      <th className="pb-2 text-right font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {restockItems.map((item) => {
                      const urgency = urgencyMeta[item.urgency]
                      return (
                        <tr key={item.drug_id} className="border-b border-ink-900/5 last:border-0">
                          <td className="py-3 pr-4">
                            <p className="font-semibold text-ink-900">{item.drug_name || 'Thuốc chưa đặt tên'}</p>
                            <p className="text-xs text-ink-500">
                              {item.drug_code || 'Không có mã'}
                              {item.base_unit ? ` · ${item.base_unit}` : ''}
                            </p>
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums text-ink-700">{formatQuantity(item.current_qty)}</td>
                          <td className="py-3 pr-4 text-right tabular-nums text-ink-700">{formatDecimal(item.avg_daily_sold)}</td>
                          <td className="py-3 pr-4 text-right tabular-nums text-ink-700">{formatDaysCover(item.days_cover)}</td>
                          <td className="py-3 pr-4 text-right font-semibold tabular-nums text-ink-900">
                            {formatQuantity(item.suggested_qty)}
                          </td>
                          <td className="py-3 text-right">
                            <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${urgency.className}`}>
                              {urgency.label}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <ul className="mt-4 divide-y divide-ink-900/5 sm:hidden">
                {restockItems.map((item) => {
                  const urgency = urgencyMeta[item.urgency]
                  return (
                    <li key={item.drug_id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink-900">{item.drug_name || 'Thuốc chưa đặt tên'}</p>
                          <p className="text-xs text-ink-500">
                            Tồn {formatQuantity(item.current_qty)} · còn đủ {formatDaysCover(item.days_cover)}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${urgency.className}`}>
                          {urgency.label}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-ink-700">
                        Nên nhập <span className="font-semibold text-ink-900">{formatQuantity(item.suggested_qty)}</span>
                        {item.base_unit ? ` ${item.base_unit}` : ''}
                      </p>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}
        </article>

        <article className="glass-card rounded-3xl p-5 sm:p-6">
          <SectionHeader title="Bán chạy tháng này" subtitle="Theo doanh thu thuần" />
          <div className="mt-4">
            {!core ? (
              showSkeleton ? (
                <SkeletonList rows={5} leading="rank" trailing={false} />
              ) : (
                <div className="h-40 rounded-2xl bg-white/60" />
              )
            ) : !topProducts.length ? (
              <p className="text-sm text-ink-500">Chưa có dữ liệu bán hàng tháng này.</p>
            ) : (
              <ol className="space-y-4">
                {topProducts.map((item, index) => (
                  <li key={`${item.name}-${index}`} className="flex items-start gap-3">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        index === 0 ? 'bg-brand-600 text-white' : 'bg-ink-900/5 text-ink-600'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-ink-900">{item.name}</p>
                        <p className="shrink-0 text-sm font-semibold tabular-nums text-ink-700">
                          {formatCompactCurrency(item.revenue)}
                        </p>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-900/5">
                        <div
                          className="h-full rounded-full bg-brand-400"
                          style={{ width: `${maxTopRevenue > 0 ? (item.revenue / maxTopRevenue) * 100 : 0}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-ink-500">{formatQuantity(item.count)} đơn vị đã bán</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </article>
      </section>
    </div>
  )
}
