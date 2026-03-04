import { useCallback, useEffect, useState } from 'react'
import { notificationApi, type NotificationRecord } from '../api/notificationService'
import { useAuth } from '../auth/AuthContext'

type CategoryFilter = 'all' | 'sale' | 'low_stock' | 'expiry_warning' | 'system' | 'general'
type ReadFilter = 'all' | 'unread' | 'read'

const pageSize = 20

const categoryLabels: Record<string, string> = {
  all: 'Tất cả',
  sale: 'Bán hàng',
  low_stock: 'Tồn kho thấp',
  expiry_warning: 'Hết hạn',
  system: 'Hệ thống',
  general: 'Chung',
}

const categoryColors: Record<string, string> = {
  sale: 'bg-sky-100 text-sky-700',
  low_stock: 'bg-amber-100 text-amber-700',
  expiry_warning: 'bg-coral-100 text-coral-700',
  system: 'bg-violet-100 text-violet-700',
  general: 'bg-ink-100 text-ink-600',
}

const formatDateTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

export function Notifications() {
  const { token } = useAuth()
  const accessToken = token?.access_token ?? ''

  const [rows, setRows] = useState<NotificationRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [readFilter, setReadFilter] = useState<ReadFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number | boolean | undefined> = {
        page,
        size: pageSize,
      }
      if (categoryFilter !== 'all') params.category = categoryFilter
      if (readFilter === 'unread') params.is_read = false
      if (readFilter === 'read') params.is_read = true

      const res = await notificationApi.listNotifications(accessToken, params)
      setRows(res.items)
      setTotal(res.total)
      setTotalPages(res.pages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định')
    } finally {
      setLoading(false)
    }
  }, [accessToken, categoryFilter, readFilter, page])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const handleMarkAllRead = async () => {
    try {
      await notificationApi.markAllRead(accessToken)
      void loadRows()
    } catch {
      // ignore
    }
  }

  const handleMarkRead = async (id: string) => {
    try {
      await notificationApi.markRead(accessToken, [id])
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, is_read: true } : r)))
    } catch {
      // ignore
    }
  }

  const handleDeleteAllRead = async () => {
    if (!confirm('Xóa tất cả thông báo đã đọc?')) return
    try {
      await notificationApi.deleteAllRead(accessToken)
      void loadRows()
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl font-bold text-ink-900">Thông báo</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleMarkAllRead()}
            className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-fog-50"
          >
            Đánh dấu tất cả đã đọc
          </button>
          <button
            type="button"
            onClick={() => void handleDeleteAllRead()}
            className="rounded-lg border border-coral-200 bg-white px-3 py-1.5 text-sm text-coral-600 hover:bg-coral-50"
          >
            Xóa đã đọc
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-500">Loại:</span>
          {(Object.keys(categoryLabels) as CategoryFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setCategoryFilter(key); setPage(1) }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                categoryFilter === key
                  ? 'bg-ink-900 text-white'
                  : 'bg-fog-100 text-ink-600 hover:bg-fog-200'
              }`}
            >
              {categoryLabels[key]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-500">Trạng thái:</span>
          {(['all', 'unread', 'read'] as ReadFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setReadFilter(key); setPage(1) }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                readFilter === key
                  ? 'bg-ink-900 text-white'
                  : 'bg-fog-100 text-ink-600 hover:bg-fog-200'
              }`}
            >
              {key === 'all' ? 'Tất cả' : key === 'unread' ? 'Chưa đọc' : 'Đã đọc'}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-coral-500">{error}</p>}
      {loading && <p className="text-sm text-ink-500">Đang tải...</p>}

      {/* Notification list */}
      <div className="space-y-2">
        {rows.length === 0 && !loading && (
          <div className="rounded-xl border border-ink-100 bg-white p-8 text-center text-sm text-ink-400">
            Không có thông báo nào
          </div>
        )}
        {rows.map((n) => (
          <div
            key={n.id}
            className={`rounded-xl border bg-white p-4 transition hover:shadow-sm ${
              n.is_read ? 'border-ink-100' : 'border-sky-200 bg-sky-50/30'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!n.is_read && (
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-500" />
                  )}
                  <h3 className={`text-sm font-semibold ${n.is_read ? 'text-ink-600' : 'text-ink-900'}`}>
                    {n.title}
                  </h3>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${categoryColors[n.category] ?? categoryColors.general}`}>
                    {categoryLabels[n.category] ?? n.category}
                  </span>
                  {n.email_sent && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                      Email
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink-500 line-clamp-2">{n.body}</p>
                <p className="mt-1.5 text-xs text-ink-400">{formatDateTime(n.created_at)}</p>
              </div>
              {!n.is_read && (
                <button
                  type="button"
                  onClick={() => void handleMarkRead(n.id)}
                  className="shrink-0 rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-500 hover:bg-fog-50"
                >
                  Đã đọc
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-500">
            Tổng {total} thông báo — Trang {page}/{totalPages}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-ink-200 px-3 py-1 text-sm disabled:opacity-40"
            >
              Trước
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-ink-200 px-3 py-1 text-sm disabled:opacity-40"
            >
              Sau
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
