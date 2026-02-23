import type { NavItem } from '../../routes/navigation'
import { NavList } from './NavList'

type MobileNavProps = {
  open: boolean
  items: NavItem[]
  onClose: () => void
  onOpenSettings: () => void
  onOpenUsersManagement: () => void
  onOpenServicesHealth: () => void
  onLogout: () => void
  canManageUsers: boolean
}

export function MobileNav({
  open,
  items,
  onClose,
  onOpenSettings,
  onOpenUsersManagement,
  onOpenServicesHealth,
  onLogout,
  canManageUsers,
}: MobileNavProps) {
  if (!open) return null

  const handleAction = (action: () => void) => {
    onClose()
    action()
  }

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

        <div className="mt-4 border-t border-ink-900/10 pt-4">
          <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.22em] text-ink-500">Tài khoản</p>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => handleAction(onOpenServicesHealth)}
              className="block w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
            >
              Sức khỏe dịch vụ
            </button>
            <button
              type="button"
              onClick={() => handleAction(onOpenSettings)}
              className="block w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
            >
              Cài đặt người dùng
            </button>
            {canManageUsers ? (
              <button
                type="button"
                onClick={() => handleAction(onOpenUsersManagement)}
                className="block w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold text-ink-700 transition-colors hover:bg-white/70 hover:text-ink-900"
              >
                Quản lý tài khoản
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => handleAction(onLogout)}
              className="block w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold text-coral-500 transition-colors hover:bg-coral-500/10"
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}
