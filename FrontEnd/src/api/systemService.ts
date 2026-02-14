import { ApiError, buildUsersApiUrl } from './usersService'

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
  getHealth: async (): Promise<SystemHealthResponse> => {
    const response = await fetch(buildUsersApiUrl('/system/health'), { method: 'GET' })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(
        payload?.detail ?? `Y\u00eau c\u1ea7u th\u1ea5t b\u1ea1i (${response.status})`,
        response.status,
      )
    }
    return payload as SystemHealthResponse
  },
}
