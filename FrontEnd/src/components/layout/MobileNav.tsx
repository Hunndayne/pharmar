import type { NavItem } from '../../routes/navigation'
import { NavList } from './NavList'

type MobileNavProps = {
  open: boolean
  items: NavItem[]
  onClose: () => void
}

export function MobileNav({ open, items, onClose }: MobileNavProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-ink-900/30"
        aria-label="Đóng menu"
        onClick={onClose}
      />
      <aside className="absolute left-0 top-0 h-full w-[82%] max-w-xs overflow-y-auto border-r border-white/60 bg-fog-50 px-4 py-6 shadow-lift">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">PHARMAR</p>
          <p className="mt-2 text-lg font-semibold text-ink-900">Hệ thống nhà thuốc</p>
        </div>
        <NavList items={items} onNavigate={onClose} />
      </aside>
    </div>
  )
}
