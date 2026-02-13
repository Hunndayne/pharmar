type MobileHeaderProps = {
  onMenu: () => void
  onPrimaryAction?: () => void
  primaryActionLabel?: string
  title: string
}

export function MobileHeader({
  onMenu,
  onPrimaryAction,
  primaryActionLabel,
  title,
}: MobileHeaderProps) {
  return (
    <div className="sticky top-0 z-40 border-b border-white/60 bg-white/80 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Mở menu"
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-ink-900/10 bg-white/80 text-ink-900"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" stroke="currentColor" strokeWidth="2" fill="none">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Nhà thuốc Thanh Huy</p>
          <p className="text-sm font-semibold text-ink-900">{title}</p>
        </div>
        {primaryActionLabel ? (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="flex items-center gap-2 rounded-full bg-ink-900 px-3 py-2 text-[11px] font-semibold text-white shadow-lift"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" stroke="currentColor" strokeWidth="2" fill="none">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            <span className="hidden sm:inline whitespace-nowrap">{primaryActionLabel}</span>
          </button>
        ) : (
          <div className="h-10 w-10" />
        )}
      </div>
    </div>
  )
}
