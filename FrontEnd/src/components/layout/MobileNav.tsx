import { useState } from 'react'
import type { NavItem } from '../../routes/navigation'
import { NavList } from './NavList'

type MobileNavProps = {
  open: boolean
  items: NavItem[]
  user: { username: string; full_name?: string | null; role?: string | null } | null
  onClose: () => void
  onOpenSettings: () => void
  onOpenUsersManagement: () => void
  onOpenServicesHealth: () => void
  onLogout: () => void
  canManageUsers: boolean
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Chủ nhà thuốc',
  manager: 'Quản lý',
  pharmacist: 'Dược sĩ',
  cashier: 'Thu ngân',
  admin: 'Admin',
}

export function MobileNav({
  open,
  items,
  user,
  onClose,
  onOpenSettings,
  onOpenUsersManagement,
  onOpenServicesHealth,
  onLogout,
  canManageUsers,
}: MobileNavProps) {
  const [accountOpen, setAccountOpen] = useState(false)

  if (!open) return null

  const handleAction = (action: () => void) => {
    onClose()
    setAccountOpen(false)
    action()
  }

  const displayName = user?.full_name || user?.username || 'Tài khoản'
  const roleLabel = user?.role ? (ROLE_LABELS[user.role] ?? user.role) : null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-ink-900/30"
        aria-label="Đóng menu"
        onClick={onClose}
      />
      <aside className="absolute left-0 top-0 flex h-full w-[82%] max-w-xs flex-col border-r border-white/60 bg-fog-50 px-4 py-6 shadow-lift">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">PHARMAR</p>
          <p className="mt-2 text-lg font-semibold text-ink-900">Hệ thống nhà thuốc</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <NavList items={items} onNavigate={onClose} />
        </div>

        {/* Account accordion */}
        <div className="mt-3 border-t border-ink-900/10 pt-3">
          <button
            type="button"
            onClick={() => setAccountOpen((o) => !o)}
            className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-white/70"
          >
            {/* Avatar */}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-900 text-xs font-bold text-white">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-semibold text-ink-900">{displayName}</span>
              {roleLabel ? <span className="block text-[11px] text-ink-500">{roleLabel}</span> : null}
            </span>
            {/* Chevron */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-4 w-4 shrink-0 text-ink-400 transition-transform duration-200 ${accountOpen ? 'rotate-180' : ''}`}
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </button>

          {/* Dropdown options */}
          {accountOpen ? (
            <div className="mt-1 space-y-0.5 pl-1">
              <button
                type="button"
                onClick={() => handleAction(onOpenSettings)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-ink-400">
                  <path fillRule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.294A1 1 0 0 1 1 10.68V9.32a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.379 3.03l1.25.834a6.957 6.957 0 0 1 1.416-.587L8.34 1.804ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
                </svg>
                Cài đặt người dùng
              </button>

              {canManageUsers ? (
                <button
                  type="button"
                  onClick={() => handleAction(onOpenUsersManagement)}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-ink-400">
                    <path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 17a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" />
                  </svg>
                  Quản lý tài khoản
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => handleAction(onOpenServicesHealth)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-ink-400">
                  <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                </svg>
                Sức khỏe dịch vụ
              </button>

              <button
                type="button"
                onClick={() => handleAction(onLogout)}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-coral-500 transition-colors hover:bg-coral-500/10"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
                  <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Z" clipRule="evenodd" />
                  <path fillRule="evenodd" d="M6 10a.75.75 0 0 1 .75-.75h9.546l-1.048-.943a.75.75 0 1 1 1.004-1.114l2.5 2.25a.75.75 0 0 1 0 1.114l-2.5 2.25a.75.75 0 1 1-1.004-1.114l1.048-.943H6.75A.75.75 0 0 1 6 10Z" clipRule="evenodd" />
                </svg>
                Đăng xuất
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  )
}
