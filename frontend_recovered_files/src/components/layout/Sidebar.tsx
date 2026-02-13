import { NavList } from './NavList'
import type { NavItem } from '../../routes/navigation'

type SidebarProps = {
  items: NavItem[]
}

export function Sidebar({ items }: SidebarProps) {
  return (
    <aside className="hidden w-72 flex-col justify-between border-r border-white/60 bg-white/70 px-6 py-8 backdrop-blur lg:flex">
      <div className="space-y-10">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Nhà Thuốc Thanh Huy</p>
          <h1 className="mt-2 text-2xl font-semibold text-ink-900">Hệ thống nhà thuốc</h1>
          <p className="mt-3 text-sm text-ink-600">Phiên bản demo dashboard</p>
        </div>
        <NavList items={items} showBadge />
      </div>
      <div className="rounded-3xl bg-ink-900 px-5 py-6 text-white shadow-lift">
        <p className="text-xs uppercase tracking-wider text-white/70">Thông báo</p>
        <p className="mt-3 text-lg font-semibold">3 lô thuốc cần xử lý</p>
        <p className="mt-2 text-sm text-white/70">Kiểm tra HSD và lập kế hoạch nhập bổ sung.</p>
      </div>
    </aside>
  )
}
