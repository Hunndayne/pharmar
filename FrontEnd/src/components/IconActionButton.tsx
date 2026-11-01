import type { ReactNode, Ref } from 'react'

type Tone = 'default' | 'brand' | 'primary' | 'danger'

type IconActionButtonProps = {
  label: string
  // Shown instead of the icon-only form on phones; omit to render icon-only below `sm`.
  shortLabel?: string
  icon: ReactNode
  tone?: Tone
  onClick: () => void
  disabled?: boolean
  ref?: Ref<HTMLButtonElement>
}

const toneClass: Record<Tone, string> = {
  default: 'border border-ink-900/10 bg-white/80 text-ink-900 hover:border-ink-900/25',
  brand: 'border border-brand-500/30 bg-brand-500/10 text-brand-700 hover:bg-brand-500/15',
  primary: 'bg-ink-900 text-white shadow-lift',
  danger: 'border border-coral-500/30 bg-white/80 text-coral-500 hover:bg-coral-500/10',
}

export function IconActionButton({ label, shortLabel, icon, tone = 'default', onClick, disabled, ref }: IconActionButtonProps) {
  const sizeClass = shortLabel ? 'px-4 py-2 sm:px-5' : 'h-10 w-10 justify-center sm:h-auto sm:w-auto sm:px-5 sm:py-2'
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center gap-2 rounded-full text-sm font-semibold transition disabled:opacity-60 ${sizeClass} ${toneClass[tone]}`}
    >
      <span aria-hidden="true" className="h-4 w-4 shrink-0">{icon}</span>
      {shortLabel ? (
        <>
          <span className="sm:hidden">{shortLabel}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        <span className="hidden sm:inline">{label}</span>
      )}
    </button>
  )
}

const svgProps = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'h-4 w-4',
}

export const AiSparkleIcon = () => (
  <svg {...svgProps}>
    <path d="M8.5 4.5l1.3 4.2 4.2 1.3-4.2 1.3-1.3 4.2-1.3-4.2L3 10l4.2-1.3z" />
    <path d="M15 2.5l.6 1.5 1.4.5-1.4.5-.6 1.5-.6-1.5-1.4-.5 1.4-.5z" />
    <path d="M15.5 13.2l.45 1.05 1.05.45-1.05.45-.45 1.05-.45-1.05-1.05-.45 1.05-.45z" />
  </svg>
)

export const PlusIcon = () => (
  <svg {...svgProps}>
    <path d="M10 4v12M4 10h12" />
  </svg>
)

export const CheckIcon = () => (
  <svg {...svgProps}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </svg>
)

export const TrashIcon = () => (
  <svg {...svgProps}>
    <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" />
    <path d="M8.5 9v4M11.5 9v4" />
  </svg>
)

export const CloseIcon = () => (
  <svg {...svgProps}>
    <path d="M5 5l10 10M15 5L5 15" />
  </svg>
)
