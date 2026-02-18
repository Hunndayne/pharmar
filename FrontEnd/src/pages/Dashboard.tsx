import { useCallback, useEffect, useMemo, useState } from 'react'
import { inventoryApi } from '../api/inventoryService'
import {
  saleApi,
  type SaleInvoiceListItem,
  type SaleInvoiceResponse,
} from '../api/saleService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

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

const MAX_REPORT_PAGES = 25
const PAGE_SIZE = 200
const MAX_INVOICES_FOR_TOP = 80
const DETAIL_CHUNK_SIZE = 10

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const formatCurrency = (value: number) => `${Math.round(Math.max(0, value)).toLocaleString('vi-VN')}đ`

const formatDateShort = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(5)
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

const toDateKey = (value: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return date.toISOString().slice(0, 10)
}

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

export function Dashboard() {
  const { token } = useAuth()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string>('')

  const [kpis, setKpis] = useState<KpiItem[]>([])
  const [trendRows, setTrendRows] = useState<TrendRow[]>([])
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])

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

  const loadDashboard = useCallback(async () => {
    const accessToken = token?.access_token
    if (!accessToken) {
      setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const now = new Date()
      const today = toDateKey(now.toISOString())
      const firstDayOfMonth = toDateKey(new Date(now.getFullYear(), now.getMonth(), 1).toISOString())
      const trendStart = toDateKey(addDays(now, -13).toISOString())

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

      setUpdatedAt(new Date().toLocaleString('vi-VN'))
    } catch (dashboardError) {
      setError(getErrorMessage(dashboardError, 'Không thể tải dữ liệu dashboard.'))
    } finally {
      setLoading(false)
    }
  }, [buildTopProducts, fetchInvoicesByRange, token?.access_token])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const maxTrendAmount = useMemo(
    () => trendRows.reduce((max, row) => Math.max(max, row.amount), 0),
    [trendRows],
  )

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
            void loadDashboard()
          }}
          className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          disabled={loading}
        >
          {loading ? 'Đang tải...' : 'Tải lại'}
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

      <section className="grid gap-4 xl:grid-cols-[1.6fr,1fr]">
        <article className="glass-card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Doanh thu</p>
              <h3 className="mt-2 text-2xl font-semibold text-ink-900">Xu hướng 14 ngày</h3>
            </div>
            <span className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-sm font-semibold text-ink-700">
              {trendRows.length ? `${formatDateShort(trendRows[0].date)} - ${formatDateShort(trendRows[trendRows.length - 1].date)}` : '-'}
            </span>
          </div>

          <div className="mt-6 space-y-2">
            {!trendRows.length ? (
              <p className="rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">Chưa có dữ liệu doanh thu.</p>
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
