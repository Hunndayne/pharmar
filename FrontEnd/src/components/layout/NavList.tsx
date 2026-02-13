import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import type { NavItem } from '../../routes/navigation'

type NavListProps = {
  items: NavItem[]
  onNavigate?: () => void
}

export function NavList({ items, onNavigate }: NavListProps) {
  const { pathname } = useLocation()
  const groupKeys = useMemo(
    () =>
      items
        .filter((item): item is Extract<NavItem, { type: 'group' }> => item.type === 'group')
        .map((group) => group.label),
    [items]
  )

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () =>
      groupKeys.reduce<Record<string, boolean>>((acc, key) => {
        acc[key] = false
        return acc
      }, {})
  )

  useEffect(() => {
    setOpenGroups((prev) =>
      items.reduce<Record<string, boolean>>((acc, item) => {
        if (item.type !== 'group') return acc
        const childActive = item.children.some((child) => child.path === pathname)
        acc[item.label] = prev[item.label] || childActive
        return acc
      }, {})
    )
  }, [items, pathname])

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const navItemClass = (active: boolean) =>
    [
      'block rounded-full px-4 py-2.5 text-[15px] font-semibold transition-colors',
      active ? 'bg-[#06142b] text-white' : 'text-ink-700 hover:bg-white/70 hover:text-ink-900',
    ].join(' ')

  return (
    <nav className="space-y-1">
      {items.map((item) => (
        item.type === 'item' ? (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={({ isActive }) => navItemClass(isActive)}
          >
            {item.label}
          </NavLink>
        ) : (
          <div key={item.label} className="space-y-1">
            <button
              type="button"
              onClick={() => toggleGroup(item.label)}
              className={navItemClass(item.children.some((child) => child.path === pathname))}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{item.label}</span>
                <span className="text-sm leading-none">{openGroups[item.label] ? '−' : '+'}</span>
              </span>
            </button>
            {openGroups[item.label] ? (
              <div className="space-y-1 pl-4">
                {item.children.map((child) => (
                  <NavLink
                    key={child.path}
                    to={child.path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      [
                        'block rounded-full px-4 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-[#0a1c3a] text-white'
                          : 'text-ink-700 hover:bg-white/70 hover:text-ink-900',
                      ].join(' ')
                    }
                  >
                    {child.label}
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
        )
      ))}
    </nav>
  )
}
