import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  reportApi,
  type RestockHighlightItem,
  type RestockItemPageResponse,
  type RestockUrgency,
} from '../api/reportService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { formatDateTimeInTimeZone, readStoredAppTimeZone } from '../utils/timezone'

type UrgencyFilter = 'all' | RestockUrgency

const PAGE_SIZE = 20

const urgencyMeta: Record<UrgencyFilter, { label: string; className: string }> = {
  all: {
    label: 'Tất cả',
    className: 'border-ink-900/10 bg-white text-ink-700',
  },
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

const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  Math.max(0, value).toLocaleString('vi-VN', options)

const formatQuantity = (value: number) => formatNumber(Math.round(Math.max(0, value)))

const formatDecimal = (value: number, maximumFractionDigits = 1) =>
  formatNumber(value, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })

const formatDateTime = (value: string, timeZone = readStoredAppTimeZone()) =>
  formatDateTimeInTimeZone(value, timeZone)

const formatDaysCover = (value: number | null) => {
  if (value === null) return 'Chưa đủ dữ liệu'
  return `${formatDecimal(value)} ngày`
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function RestockSuggestions() {
  const { token } = useAuth()
  const accessToken = token?.access_token ?? ''

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [urgency, setUrgency] = useState<UrgencyFilter>('all')
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [data, setData] = useState<RestockItemPageResponse | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (!accessToken) {
      setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
      return
    }

    let cancelled = false

    const loadData = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await reportApi.getRestockItems(accessToken, {
          page,
          size: PAGE_SIZE,
          search: search || undefined,
          urgency,
        })
        if (!cancelled) {
          setData(response)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(getErrorMessage(loadError, 'Không thể tải danh sách gợi ý nhập hàng.'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadData()
    return () => {
      cancelled = true
    }
  }, [accessToken, page, reloadToken, search, urgency])

  const items = data?.items ?? []
  const rangeStart = data && data.total > 0 ? (data.page - 1) * data.size + 1 : 0
  const rangeEnd = data && data.total > 0 ? Math.min(data.page * data.size, data.total) : 0
  const summaryText = useMemo(() => {
    if (!data) return 'Dữ liệu đề xuất được tính từ doanh số gần đây, tồn hiện tại và cấu hình của cửa hàng.'
    return `${data.sales_window_days} ngày gần nhất · Mục tiêu đủ hàng ${data.target_cover_days} ngày`
  }, [data])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Nhập hàng</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Chi tiết thuốc cần nhập</h2>
          <p className="mt-2 text-sm text-ink-600">{summaryText}</p>
          {data?.generated_at ? (
            <p className="mt-2 text-xs text-ink-500">Dữ liệu sinh lúc {formatDateTime(data.generated_at)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/"
            className="inline-flex rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Về dashboard
          </Link>
          <Link
            to="/nhap-hang"
            className="inline-flex rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Vào nhập hàng
          </Link>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Cần hành động</p>
          <p className="mt-3 text-3xl font-semibold text-ink-900">
            {data ? formatQuantity(data.total_actionable) : '-'}
          </p>
          <p className="mt-2 text-sm text-ink-600">Tổng số mặt hàng đang cần bổ sung theo cấu hình hiện tại</p>
        </article>
        <article className="glass-card rounded-3xl bg-coral-500/10 p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-coral-500">Khẩn cấp</p>
          <p className="mt-3 text-3xl font-semibold text-coral-500">
            {data ? formatQuantity(data.critical_count) : '-'}
          </p>
          <p className="mt-2 text-sm text-coral-500">Nguy cơ hụt hàng ngay trong ngắn hạn</p>
        </article>
        <article className="glass-card rounded-3xl bg-amber-500/10 p-5">
          <p className="text-xs uppercase tracking-[0.24em] text-amber-700">Ưu tiên</p>
          <p className="mt-3 text-3xl font-semibold text-amber-700">
            {data ? formatQuantity(data.high_count) : '-'}
          </p>
          <p className="mt-2 text-sm text-amber-700">Cần bổ sung sớm để giữ tồn an toàn</p>
        </article>
      </section>

      <section className="glass-card rounded-3xl p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),auto,auto,auto]">
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Tìm theo mã thuốc, tên thuốc, đơn vị"
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {(['all', 'critical', 'high', 'normal'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setUrgency(value)
                  setPage(1)
                }}
                className={`rounded-full border px-4 py-2 text-sm font-semibold ${
                  urgency === value
                    ? urgencyMeta[value].className
                    : 'border-ink-900/10 bg-white text-ink-700'
                }`}
              >
                {urgencyMeta[value].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchInput('')
              setSearch('')
              setUrgency('all')
              setPage(1)
            }}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setReloadToken((current) => current + 1)}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Tải lại
          </button>
        </div>
      </section>

      {loading ? (
        <p className="rounded-2xl bg-white/80 px-4 py-4 text-sm text-ink-600">Đang tải danh sách gợi ý nhập hàng...</p>
      ) : null}

      {error ? (
        <p className="rounded-2xl bg-coral-500/10 px-4 py-4 text-sm text-coral-500">{error}</p>
      ) : null}

      {!loading && !error && !items.length ? (
        <p className="rounded-2xl bg-brand-500/10 px-4 py-4 text-sm text-brand-700">
          Không có mặt hàng nào phù hợp với bộ lọc hiện tại.
        </p>
      ) : null}

      {items.length ? (
        <>
          <div className="hidden overflow-x-auto rounded-3xl bg-white/80 lg:block">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-ink-900/10 text-xs uppercase tracking-[0.2em] text-ink-500">
                  <th className="px-5 py-4">Thuoc</th>
                  <th className="px-5 py-4 text-right">Ton</th>
                  <th className="px-5 py-4 text-right">Ban ky</th>
                  <th className="px-5 py-4 text-right">TB/ngay</th>
                  <th className="px-5 py-4 text-right">Du hang</th>
                  <th className="px-5 py-4 text-right">Nguong</th>
                  <th className="px-5 py-4 text-right">Muc tieu</th>
                  <th className="px-5 py-4 text-right">De xuat</th>
                  <th className="px-5 py-4 text-right">Uu tien</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <RestockTableRow key={item.drug_id} item={item} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 lg:hidden">
            {items.map((item) => (
              <RestockCard key={item.drug_id} item={item} />
            ))}
          </div>

          <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Hiển thị {rangeStart} - {rangeEnd} trong {formatQuantity(data?.total ?? 0)} thuốc
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                disabled={(data?.page ?? 1) <= 1 || loading}
              >
                Trước
              </button>
              <span>
                {data?.page ?? 1}/{data?.pages ?? 1}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(data?.pages ?? 1, current + 1))}
                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                disabled={(data?.page ?? 1) >= (data?.pages ?? 1) || loading}
              >
                Sau
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

function RestockTableRow({ item }: { item: RestockHighlightItem }) {
  const urgency = urgencyMeta[item.urgency]

  return (
    <tr className="border-b border-ink-900/5 align-top">
      <td className="px-5 py-4">
        <p className="font-semibold text-ink-900">{item.drug_name || 'Thuốc chưa đặt tên'}</p>
        <p className="mt-1 text-xs text-ink-500">
          {item.drug_code || 'Không có mã'}
          {item.base_unit ? ` · ${item.base_unit}` : ''}
        </p>
      </td>
      <td className="px-5 py-4 text-right font-medium text-ink-900">{formatQuantity(item.current_qty)}</td>
      <td className="px-5 py-4 text-right text-ink-700">{formatQuantity(item.sold_qty_window)}</td>
      <td className="px-5 py-4 text-right text-ink-700">{formatDecimal(item.avg_daily_sold)}</td>
      <td className="px-5 py-4 text-right text-ink-700">{formatDaysCover(item.days_cover)}</td>
      <td className="px-5 py-4 text-right text-ink-700">{formatQuantity(item.reorder_level)}</td>
      <td className="px-5 py-4 text-right text-ink-700">{formatQuantity(item.target_qty)}</td>
      <td className="px-5 py-4 text-right font-semibold text-ink-900">{formatQuantity(item.suggested_qty)}</td>
      <td className="px-5 py-4 text-right">
        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${urgency.className}`}>
          {urgency.label}
        </span>
      </td>
    </tr>
  )
}

function RestockCard({ item }: { item: RestockHighlightItem }) {
  const urgency = urgencyMeta[item.urgency]

  return (
    <article className="rounded-3xl bg-white/80 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-ink-900">{item.drug_name || 'Thuốc chưa đặt tên'}</p>
          <p className="mt-1 text-xs text-ink-500">
            {item.drug_code || 'Không có mã'}
            {item.base_unit ? ` · ${item.base_unit}` : ''}
          </p>
        </div>
        <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${urgency.className}`}>
          {urgency.label}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-ink-700">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Ton hien tai</p>
          <p className="mt-1 font-semibold text-ink-900">{formatQuantity(item.current_qty)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">De xuat nhap</p>
          <p className="mt-1 font-semibold text-ink-900">{formatQuantity(item.suggested_qty)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Ban trong ky</p>
          <p className="mt-1">{formatQuantity(item.sold_qty_window)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">TB/ngay</p>
          <p className="mt-1">{formatDecimal(item.avg_daily_sold)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Du hang</p>
          <p className="mt-1">{formatDaysCover(item.days_cover)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Muc tieu</p>
          <p className="mt-1">{formatQuantity(item.target_qty)}</p>
        </div>
      </div>
    </article>
  )
}
