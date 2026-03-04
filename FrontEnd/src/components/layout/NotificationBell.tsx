import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { notificationApi, type NotificationRecord } from '../../api/notificationService'
import { useAuth } from '../../auth/AuthContext'

const POLL_INTERVAL = 30_000 // 30 seconds

const categoryLabels: Record<string, string> = {
  sale: 'Bán hàng',
  low_stock: 'Tồn kho',
  expiry_warning: 'Hết hạn',
  system: 'Hệ thống',
  general: 'Chung',
}

const formatTimeAgo = (value: string) => {
  const diff = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Vừa xong'
  if (minutes < 60) return `${minutes} phút trước`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} giờ trước`
  const days = Math.floor(hours / 24)
  return `${days} ngày trước`
}

export function NotificationBell() {
  const { token } = useAuth()
  const accessToken = token?.access_token ?? ''
  const navigate = useNavigate()

  const [unreadCount, setUnreadCount] = useState(0)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [recentItems, setRecentItems] = useState<NotificationRecord[]>([])
  const [loadingRecent, setLoadingRecent] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Poll unread count
  const fetchUnread = useCallback(async () => {
    if (!accessToken) return
    try {
      const res = await notificationApi.getUnreadCount(accessToken)
      setUnreadCount(res.unread_count)
    } catch {
      // ignore
    }
  }, [accessToken])

  useEffect(() => {
    void fetchUnread()
    const timer = setInterval(() => void fetchUnread(), POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchUnread])

  // Load recent when dropdown opens
  useEffect(() => {
    if (!dropdownOpen || !accessToken) return
    setLoadingRecent(true)
    notificationApi
      .listNotifications(accessToken, { size: 5 })
      .then((res) => setRecentItems(res.items))
      .catch(() => {})
      .finally(() => setLoadingRecent(false))
  }, [dropdownOpen, accessToken])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleMarkAllRead = async () => {
    try {
      await notificationApi.markAllRead(accessToken)
      setUnreadCount(0)
      setRecentItems((prev) => prev.map((r) => ({ ...r, is_read: true })))
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setDropdownOpen((o) => !o)}
        className="relative rounded-full p-2 text-ink-600 hover:bg-fog-100 hover:text-ink-900"
        aria-label="Thông báo"
      >
        {/* Bell SVG icon */}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {dropdownOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-ink-900">Thông báo</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                className="text-xs text-sky-600 hover:underline"
              >
                Đọc tất cả
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {loadingRecent && (
              <p className="px-4 py-3 text-center text-xs text-ink-400">Đang tải...</p>
            )}
            {!loadingRecent && recentItems.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-ink-400">Không có thông báo</p>
            )}
            {recentItems.map((n) => (
              <div
                key={n.id}
                className={`border-b border-ink-50 px-4 py-3 last:border-b-0 ${!n.is_read ? 'bg-sky-50/40' : ''}`}
              >
                <div className="flex items-start gap-2">
                  {!n.is_read && <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />}
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-medium ${n.is_read ? 'text-ink-600' : 'text-ink-900'}`}>
                      {n.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-400 line-clamp-1">{n.body}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[10px] text-ink-300">{formatTimeAgo(n.created_at)}</span>
                      <span className="text-[10px] text-ink-300">{categoryLabels[n.category] ?? n.category}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-ink-100">
            <button
              type="button"
              onClick={() => {
                setDropdownOpen(false)
                navigate('/thong-bao')
              }}
              className="w-full px-4 py-2.5 text-center text-xs font-medium text-sky-600 hover:bg-fog-50"
            >
              Xem tất cả thông báo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
