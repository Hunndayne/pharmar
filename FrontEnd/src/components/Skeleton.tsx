import type { CSSProperties } from 'react'

interface SkeletonProps {
  className?: string
  rounded?: string
  style?: CSSProperties
  /** Dùng `span` khi đặt trong thẻ `<p>` để HTML hợp lệ. */
  as?: 'div' | 'span'
}

export function Skeleton({ className = '', rounded = 'rounded-2xl', style, as: Tag = 'div' }: SkeletonProps) {
  return (
    <Tag aria-hidden="true" className={`relative overflow-hidden bg-ink-200/60 ${rounded} ${className}`} style={style}>
      <span className="skeleton-shimmer pointer-events-none absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </Tag>
  )
}

/** Thay con số lớn của thẻ thống kê khi đang tải lần đầu (đặt trong thẻ `<p>` giữ nguyên chiều cao dòng). */
export function SkeletonStatValue({ className = 'my-0.5' }: { className?: string }) {
  return <Skeleton as="span" rounded="rounded-lg" className={`block h-7 w-16 ${className}`} />
}

/** Thay dòng chú thích nhỏ dưới con số của thẻ thống kê. */
export function SkeletonStatCaption({ className = '' }: { className?: string }) {
  return <Skeleton as="span" rounded="rounded-full" className={`block h-3 w-20 ${className}`} />
}

const LINE_WIDTHS = ['100%', '82%', '64%', '90%', '72%']

interface SkeletonTextProps {
  lines?: number
  className?: string
}

export function SkeletonText({ lines = 3, className = '' }: SkeletonTextProps) {
  return (
    <div role="status" aria-label="Đang tải" className={`space-y-2.5 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          rounded="rounded-full"
          className="h-3"
          style={{ width: LINE_WIDTHS[index % LINE_WIDTHS.length] }}
        />
      ))}
    </div>
  )
}

interface SkeletonCardProps {
  lines?: number
  className?: string
  /** `glass` khớp các thẻ glass-card; `plain` khớp thẻ trắng trong danh sách mobile. */
  variant?: 'glass' | 'plain'
}

export function SkeletonCard({ lines = 2, className = '', variant = 'glass' }: SkeletonCardProps) {
  const surface =
    variant === 'glass' ? 'glass-card rounded-3xl p-5' : 'rounded-2xl border border-ink-900/10 bg-white p-4'
  return (
    <div className={`${surface} ${className}`}>
      <Skeleton rounded="rounded-full" className="h-4 w-2/5" />
      <SkeletonText lines={lines} className="mt-4" />
    </div>
  )
}

interface SkeletonCardListProps {
  count?: number
  lines?: number
  className?: string
}

/** Danh sách thẻ xếp dọc cho dạng xem mobile (thay cho bảng). */
export function SkeletonCardList({ count = 4, lines = 3, className = '' }: SkeletonCardListProps) {
  return (
    <div role="status" aria-label="Đang tải" className={`space-y-3 ${className}`}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} variant="plain" lines={lines} />
      ))}
    </div>
  )
}

interface SkeletonTableRowsProps {
  rows?: number
  cols: number
}

/** Các dòng `<tr>` placeholder đặt trong `<tbody>`, thay cho dòng "Đang tải...". */
export function SkeletonTableRows({ rows = 6, cols }: SkeletonTableRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true">
          {Array.from({ length: cols }, (_, colIndex) => (
            <td key={colIndex} className="px-6 py-4">
              <Skeleton
                rounded="rounded-full"
                className="h-3.5"
                style={{ width: `${colIndex === 0 ? 70 : 50 + ((rowIndex * 7 + colIndex * 13) % 40)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

const MOBILE_ONLY = { sm: 'sm:hidden', md: 'md:hidden', lg: 'lg:hidden' } as const
const DESKTOP_ONLY = { sm: 'hidden sm:block', md: 'hidden md:block', lg: 'hidden lg:block' } as const

interface SkeletonTableProps {
  rows?: number
  cols?: number
  className?: string
  /** Mốc chuyển từ thẻ xếp dọc sang bảng; mặc định `sm` như các bảng dữ liệu khác. */
  breakpoint?: 'sm' | 'md' | 'lg'
}

/** Bảng độc lập: thẻ xếp dọc ở mobile, bảng đầy đủ từ mốc `breakpoint` trở lên. */
export function SkeletonTable({ rows = 6, cols = 5, className = '', breakpoint = 'sm' }: SkeletonTableProps) {
  const mobileOnly = MOBILE_ONLY[breakpoint]
  const desktopOnly = DESKTOP_ONLY[breakpoint]
  return (
    <div role="status" aria-label="Đang tải" className={className}>
      <SkeletonCardList count={Math.min(rows, 4)} className={`p-4 ${mobileOnly}`} />
      <div className={`${desktopOnly} overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-white/70">
            <tr>
              {Array.from({ length: cols }, (_, index) => (
                <th key={index} className="px-6 py-4">
                  <Skeleton rounded="rounded-full" className="h-3 w-16" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/70">
            <SkeletonTableRows rows={rows} cols={cols} />
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function SkeletonKpi({ className = '' }: { className?: string }) {
  return (
    <div role="status" aria-label="Đang tải" className={`glass-card flex h-[118px] flex-col justify-between rounded-3xl p-4 sm:p-5 ${className}`}>
      <Skeleton rounded="rounded-full" className="h-3 w-1/2" />
      <Skeleton rounded="rounded-xl" className="h-8 w-3/4" />
      <Skeleton rounded="rounded-full" className="h-2.5 w-2/5" />
    </div>
  )
}

const CHART_BAR_HEIGHTS = [38, 55, 44, 70, 52, 82, 60, 46, 74, 58, 90, 64, 50, 78]

interface SkeletonChartProps {
  className?: string
  bars?: number
}

export function SkeletonChart({ className = 'h-48', bars = CHART_BAR_HEIGHTS.length }: SkeletonChartProps) {
  return (
    <div role="status" aria-label="Đang tải" className={`relative overflow-hidden rounded-2xl bg-ink-50/70 ${className}`}>
      <div className="absolute inset-0 flex items-end gap-1.5 px-3 pb-3 sm:gap-2.5 sm:px-4">
        {Array.from({ length: bars }, (_, index) => (
          <div
            key={index}
            className="flex-1 rounded-t-lg bg-ink-200/60"
            style={{ height: `${CHART_BAR_HEIGHTS[index % CHART_BAR_HEIGHTS.length]}%` }}
          />
        ))}
      </div>
      <span className="skeleton-shimmer pointer-events-none absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  )
}

interface SkeletonListProps {
  rows?: number
  /** `dot`: chấm tròn nhỏ; `rank`: huy hiệu số thứ tự; `none`: không có phần đầu. */
  leading?: 'dot' | 'rank' | 'none'
  /** Hiện khối số/nhãn ở cuối mỗi dòng. */
  trailing?: boolean
  className?: string
}

export function SkeletonList({ rows = 4, leading = 'dot', trailing = true, className = '' }: SkeletonListProps) {
  return (
    <div role="status" aria-label="Đang tải" className={`divide-y divide-ink-900/5 ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 py-3">
          {leading === 'dot' ? <Skeleton rounded="rounded-full" className="h-2.5 w-2.5 shrink-0" /> : null}
          {leading === 'rank' ? <Skeleton rounded="rounded-full" className="h-7 w-7 shrink-0" /> : null}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton rounded="rounded-full" className="h-3.5" style={{ width: `${60 + ((index * 11) % 30)}%` }} />
            <Skeleton rounded="rounded-full" className="h-2.5" style={{ width: `${35 + ((index * 17) % 25)}%` }} />
          </div>
          {trailing ? <Skeleton rounded="rounded-full" className="h-5 w-10 shrink-0" /> : null}
        </div>
      ))}
    </div>
  )
}
