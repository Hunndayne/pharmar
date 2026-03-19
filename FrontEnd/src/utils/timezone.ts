export const DEFAULT_APP_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const APP_TIME_ZONE_STORAGE_KEY = 'pharmar.system.timezone'

type TimeZoneCatalogItem = {
  value: string
  label: string
}

export type TimeZoneSuggestion = TimeZoneCatalogItem & {
  offsetLabel: string
  displayLabel: string
}

const TIME_ZONE_CATALOG: TimeZoneCatalogItem[] = [
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh City' },
  { value: 'Asia/Bangkok', label: 'Bangkok' },
  { value: 'Asia/Jakarta', label: 'Jakarta' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'America/Denver', label: 'Denver' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'Australia/Sydney', label: 'Sydney' },
]

const dateKeyFormatterCache = new Map<string, Intl.DateTimeFormat>()
const dateShortFormatterCache = new Map<string, Intl.DateTimeFormat>()
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>()

const getDateKeyFormatter = (timeZone: string) => {
  const normalized = normalizeTimeZone(timeZone)
  const cached = dateKeyFormatterCache.get(normalized)
  if (cached) return cached
  const next = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalized,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  dateKeyFormatterCache.set(normalized, next)
  return next
}

const getDateShortFormatter = (timeZone: string) => {
  const normalized = normalizeTimeZone(timeZone)
  const cached = dateShortFormatterCache.get(normalized)
  if (cached) return cached
  const next = new Intl.DateTimeFormat('vi-VN', {
    timeZone: normalized,
    day: '2-digit',
    month: '2-digit',
  })
  dateShortFormatterCache.set(normalized, next)
  return next
}

const getDateTimeFormatter = (timeZone: string) => {
  const normalized = normalizeTimeZone(timeZone)
  const cached = dateTimeFormatterCache.get(normalized)
  if (cached) return cached
  const next = new Intl.DateTimeFormat('vi-VN', {
    timeZone: normalized,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  dateTimeFormatterCache.set(normalized, next)
  return next
}

const toDate = (value: string | Date) => (value instanceof Date ? value : new Date(value))

const getDateParts = (date: Date, timeZone: string) => {
  const parts = getDateKeyFormatter(timeZone).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  return { year, month, day }
}

const resolveTimeZoneOffsetLabel = (timeZone: string) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
    }).formatToParts(new Date())
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value?.replace('UTC', 'GMT')
    return offset || 'GMT'
  } catch {
    return 'GMT'
  }
}

export const isValidTimeZone = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  try {
    new Intl.DateTimeFormat('vi-VN', { timeZone: raw }).format(new Date())
    return true
  } catch {
    return false
  }
}

export const normalizeTimeZone = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  return isValidTimeZone(raw) ? raw : DEFAULT_APP_TIME_ZONE
}

export const readStoredAppTimeZone = () => {
  if (typeof window === 'undefined') return DEFAULT_APP_TIME_ZONE
  try {
    return normalizeTimeZone(window.localStorage.getItem(APP_TIME_ZONE_STORAGE_KEY))
  } catch {
    return DEFAULT_APP_TIME_ZONE
  }
}

export const persistAppTimeZone = (value: string | null | undefined) => {
  const next = normalizeTimeZone(value)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APP_TIME_ZONE_STORAGE_KEY, next)
    } catch {
      // ignore storage errors
    }
  }
  return next
}

export const toDateKeyInTimeZone = (value: string | Date, timeZone: string) => {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized
  }
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) {
    return typeof value === 'string' ? value.slice(0, 10) : ''
  }
  const { year, month, day } = getDateParts(date, timeZone)
  return year && month && day ? `${year}-${month}-${day}` : ''
}

export const shiftDateKey = (value: string, days: number) => {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return value.trim()
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

export const getCurrentDateKeyInTimeZone = (timeZone: string, reference = new Date()) =>
  toDateKeyInTimeZone(reference, timeZone)

export const getMonthStartDateKeyInTimeZone = (timeZone: string, reference = new Date()) => {
  const { year, month } = getDateParts(reference, timeZone)
  return year && month ? `${year}-${month}-01` : ''
}

export const formatDateShortInTimeZone = (value: string | Date, timeZone: string) => {
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value.slice(5) : ''
  return getDateShortFormatter(timeZone).format(date)
}

export const formatDateTimeInTimeZone = (
  value: string | Date | null | undefined,
  timeZone: string,
) => {
  if (!value) return '-'
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '-'
  return getDateTimeFormatter(timeZone).format(date)
}

export const getTimeZoneDisplayLabel = (value: string | null | undefined) => {
  const normalized = normalizeTimeZone(value)
  const found = TIME_ZONE_CATALOG.find((item) => item.value === normalized)
  const suffix = found ? found.label : normalized
  return `${resolveTimeZoneOffsetLabel(normalized)} - ${suffix}`
}

export const TIMEZONE_SUGGESTIONS: TimeZoneSuggestion[] = TIME_ZONE_CATALOG.map((item) => {
  const offsetLabel = resolveTimeZoneOffsetLabel(item.value)
  return {
    ...item,
    offsetLabel,
    displayLabel: `${offsetLabel} - ${item.label}`,
  }
})
