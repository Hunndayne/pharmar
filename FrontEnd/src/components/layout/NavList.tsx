import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { NavItem } from '../../routes/navigation'

type NavListProps = {
  items: NavItem[]
  onNavigate?: () => void
}

type NavEntry = {
  key: string
  path: string
  group: string | null
}

const STORAGE_KEY = 'pharmar:nav:active'

const readRemembered = (): string | null => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const writeRemembered = (key: string) => {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, key)
  } catch {
    // storage unavailable: the in-memory state still works for this page load
  }
}

export function NavList({ items, onNavigate }: NavListProps) {
  const { pathname } = useLocation()
  const [remembered, setRemembered] = useState<string | null>(readRemembered)

  const entries = useMemo<NavEntry[]>(
    () =>
      items.flatMap<NavEntry>((item) =>
        item.type === 'item'
          ? [{ key: item.path, path: item.path, group: null }]
          : item.children.map((child) => ({
              key: `${item.label}:${child.path}`,
              path: child.path,
              group: item.label,
            }))
      ),
    [items]
  )

  const matches = entries.filter((entry) => entry.path === pathname)
  const activeEntry = matches.find((entry) => entry.key === remembered) ?? matches[0] ?? null
  const activeKey = activeEntry?.key ?? null
  const activeGroup = activeEntry?.group ?? null

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const [syncedGroup, setSyncedGroup] = useState<string | null>(null)
  if (activeGroup !== syncedGroup) {
    setSyncedGroup(activeGroup)
    if (activeGroup) setOpenGroups((prev) => ({ ...prev, [activeGroup]: true }))
  }

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  const handleClick = (key: string) => {
    setRemembered(key)
    writeRemembered(key)
    onNavigate?.()
  }

  const navItemClass = (active: boolean) =>
    [
      'block rounded-full px-4 py-2.5 text-[15px] font-semibold transition-colors',
      active ? 'bg-[#06142b] text-white' : 'text-ink-700 hover:bg-white/70 hover:text-ink-900',
    ].join(' ')

  const groupHeaderClass = (containsActive: boolean) =>
    [
      'block w-full rounded-full px-4 py-2.5 text-left text-[15px] font-semibold transition-colors',
      containsActive ? 'text-ink-900' : 'text-ink-700 hover:bg-white/70',
    ].join(' ')

  return (
    <nav className="space-y-1">
      {items.map((item) => (
        item.type === 'item' ? (
          <Link
            key={item.path}
            to={item.path}
            onClick={() => handleClick(item.path)}
            aria-current={activeKey === item.path ? 'page' : undefined}
            className={navItemClass(activeKey === item.path)}
          >
            {item.label}
          </Link>
        ) : (
          <div key={item.label} className="space-y-1">
            <button
              type="button"
              onClick={() => toggleGroup(item.label)}
              aria-expanded={Boolean(openGroups[item.label])}
              className={groupHeaderClass(activeGroup === item.label)}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{item.label}</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-4 w-4 transition-transform ${openGroups[item.label] ? 'rotate-180' : ''}`}
                >
                  <path d="M5 8l5 5 5-5" />
                </svg>
              </span>
            </button>
            {openGroups[item.label] ? (
              <div className="ml-4 space-y-1 border-l border-ink-900/10 pl-2">
                {item.children.map((child) => {
                  const key = `${item.label}:${child.path}`
                  const active = activeKey === key
                  return (
                    <Link
                      key={key}
                      to={child.path}
                      onClick={() => handleClick(key)}
                      aria-current={active ? 'page' : undefined}
                      className={[
                        'block rounded-full px-4 py-2 text-sm font-medium transition-colors',
                        active
                          ? 'bg-[#0a1c3a] text-white'
                          : 'text-ink-700 hover:bg-white/70 hover:text-ink-900',
                      ].join(' ')}
                    >
                      {child.label}
                    </Link>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      ))}
    </nav>
  )
}
