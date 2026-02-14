import type { NavItem } from '../../routes/navigation'
import { NavList } from './NavList'

type SidebarProps = {
  items: NavItem[]
  menuOpen: boolean
  onToggleMenu: () => void
  onOpenSettings: () => void
  onOpenUsersManagement: () => void
  onOpenServicesHealth: () => void
  onLogout: () => void
  canManageUsers: boolean
}

export function Sidebar({
  items,
  menuOpen,
  onToggleMenu,
  onOpenSettings,
  onOpenUsersManagement,
  onOpenServicesHealth,
  onLogout,
  canManageUsers,
}: SidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden h-screen w-72 flex-col overflow-y-auto border-r border-ink-900/5 bg-fog-50 px-6 py-8 lg:flex">
      <div className="space-y-10">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">PHARMAR</p>
          <h1 className="mt-2 text-4xl font-semibold leading-tight text-ink-900">Hệ thống nhà thuốc</h1>
          <p className="mt-3 text-sm text-ink-500">Phiên bản demo dashboard</p>
        </div>
        <NavList items={items} />
      </div>

      <div className="relative mt-auto pt-8">
        <button
          type="button"
          onClick={onToggleMenu}
          className="w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold text-ink-700 hover:bg-white/70 hover:text-ink-900"
        >
          Tài khoản
        </button>

        {menuOpen ? (
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-full overflow-hidden rounded-2xl border border-ink-900/10 bg-white py-1 shadow-lift">
            <button
              type="button"
              onClick={onOpenServicesHealth}
              className="w-full px-4 py-2 text-left text-sm text-ink-800 hover:bg-fog-50"
            >
              Sức khỏe dịch vụ
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className="w-full px-4 py-2 text-left text-sm text-ink-800 hover:bg-fog-50"
            >
              Cài đặt người dùng
            </button>
            {canManageUsers ? (
              <button
                type="button"
                onClick={onOpenUsersManagement}
                className="w-full px-4 py-2 text-left text-sm text-ink-800 hover:bg-fog-50"
              >
                Quản lý tài khoản
              </button>
            ) : null}
            <button
              type="button"
              onClick={onLogout}
              className="w-full px-4 py-2 text-left text-sm text-coral-500 hover:bg-coral-500/10"
            >
              Đăng xuất
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
