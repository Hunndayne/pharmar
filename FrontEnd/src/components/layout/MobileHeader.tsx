type MobileHeaderProps = {
  onMenu: () => void
  title: string
  onPrimaryAction?: () => void
  primaryActionLabel?: string
}

export function MobileHeader({ onMenu, title, onPrimaryAction, primaryActionLabel }: MobileHeaderProps) {
  return (
    <div className="sticky top-0 z-40 border-b border-white/60 bg-white/85 backdrop-blur lg:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Mở menu"
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-ink-900/10 bg-white/80 text-ink-900"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">PHARMAR</p>
          <p className="text-sm font-semibold text-ink-900">{title}</p>
        </div>

        {primaryActionLabel ? (
          <button
            type="button"
            onClick={onPrimaryAction}
            className="inline-flex items-center gap-1 rounded-full bg-ink-900 px-3 py-2 text-xs font-semibold text-white shadow-lift"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            <span className="hidden sm:inline">{primaryActionLabel}</span>
          </button>
        ) : (
          <span className="h-10 w-10" />
        )}
      </div>
    </div>
  )
}
