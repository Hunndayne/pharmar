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
  getHealth: () =>
    requestJson<SystemHealthResponse>(buildUsersApiUrl, '/system/health', {
      init: { method: 'GET' },
    }),
}
