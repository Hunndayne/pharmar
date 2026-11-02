import { readAuthStorage } from '../auth/authStorage'
import { requestJson } from './httpClient'
import { buildUsersApiUrl } from './usersService'

export type SystemHealthService = {
  name: string
  url: string
  status: 'up' | 'degraded' | 'down' | string
  http_status: number | null
  latency_ms: number | null
  detail: string | null
  upstream: Record<string, unknown> | null
}

export type SystemHealthResponse = {
  status: 'up' | 'degraded' | 'down' | string
  generated_at: string
  services: SystemHealthService[]
  summary: {
    total: number
    up: number
    degraded: number
    down: number
  }
}

export const systemApi = {
  // The gateway only returns the per-service detail to an owner/manager token;
  // anonymous callers get just { status }.
  getHealth: (token?: string) =>
    requestJson<SystemHealthResponse>(buildUsersApiUrl, '/system/health', {
      init: { method: 'GET' },
      token: token ?? readAuthStorage()?.token?.access_token,
    }),
}

const CUSTOMER_DISPLAY_SCREEN_ID_KEY = 'pharmar:customer-display:screen_id'
let memoryScreenId: string | null = null

const generateScreenId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Per-browser unguessable id for the customer-display remote channel. The
 * gateway rejects "default" and anything shorter than 16 chars, so this id is
 * the read credential for the second screen.
 */
export const getCustomerDisplayScreenId = (): string => {
  if (memoryScreenId) return memoryScreenId
  try {
    const stored = window.localStorage.getItem(CUSTOMER_DISPLAY_SCREEN_ID_KEY)
    if (stored && /^[A-Za-z0-9_-]{16,64}$/.test(stored)) {
      memoryScreenId = stored
      return stored
    }
  } catch {
    // storage unavailable; fall through to an in-memory id
  }
  const created = generateScreenId()
  memoryScreenId = created
  try {
    window.localStorage.setItem(CUSTOMER_DISPLAY_SCREEN_ID_KEY, created)
  } catch {
    // keep the in-memory id
  }
  return created
}

/** URL to open on the second screen (same-browser windows also work without the query). */
export const buildCustomerDisplayUrl = (): string =>
  `${window.location.origin}/customer-display/index.html?screen_id=${encodeURIComponent(getCustomerDisplayScreenId())}`
