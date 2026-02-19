export type UserRole = 'owner' | 'manager' | 'staff'

export type UserProfile = {
  id: number
  username: string
  email: string | null
  full_name: string | null
  phone: string | null
  role: UserRole
  is_active: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export type AuthToken = {
  access_token: string
  refresh_token: string | null
  token_type: string
}

export type LoginResponse = {
  user: UserProfile
  token: AuthToken
}

export type CreateUserPayload = {
  username: string
  password: string
  full_name: string
  email?: string | null
  phone?: string | null
  role: UserRole
  is_active?: boolean
}

export type UpdateUserPayload = {
  full_name?: string | null
  email?: string | null
  phone?: string | null
  role?: UserRole
  is_active?: boolean
}

export type ChangePasswordPayload = {
  current_password: string
  new_password: string
}

type ListUsersParams = {
  search?: string
  role?: UserRole
  is_active?: boolean
}

type ListLoginHistoryParams = {
  username?: string
  user_id?: number
  success?: boolean
  limit?: number
}

export type LoginHistoryRecord = {
  id: number
  user_id: number | null
  username: string | null
  ip_address: string | null
  user_agent: string | null
  success: boolean
  created_at: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const sanitizePrefix = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

const sanitizeBase = (value: string) => value.trim().replace(/\/+$/, '')

const API_PREFIX = sanitizePrefix(import.meta.env.VITE_USERS_API_PREFIX ?? '/api/v1')
const API_BASE = sanitizeBase(import.meta.env.VITE_API_BASE_URL ?? '')

const buildApiRoot = () => {
  const isLikelyDevFrontendPort =
    typeof window !== 'undefined' &&
    ['3000', '4173', '5173', '5174'].includes(window.location.port)

  if (!API_BASE && import.meta.env.DEV && isLikelyDevFrontendPort) {
    const protocol = window.location.protocol || 'http:'
    const hostname = window.location.hostname || 'localhost'
    return `${protocol}//${hostname}:8000${API_PREFIX}`
  }

  if (!API_BASE) return API_PREFIX
  if (!API_PREFIX) return API_BASE

  const lowerBase = API_BASE.toLowerCase()
  const lowerPrefix = API_PREFIX.toLowerCase()
  if (lowerBase.endsWith(lowerPrefix)) return API_BASE

  return `${API_BASE}${API_PREFIX}`
}

export const buildUsersApiUrl = (
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const root = buildApiRoot()
  const target = root ? `${root}${normalizedPath}` : normalizedPath
  const url = new URL(target, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      url.searchParams.set(key, String(value))
    })
  }
  return url.toString()
}

const requestJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detailMessage = Array.isArray(payload?.detail)
      ? payload.detail
          .map((item: { msg?: string; loc?: (string | number)[] }) => {
            const loc = Array.isArray(item?.loc) ? item.loc.join('.') : ''
            return loc ? `${loc}: ${item?.msg ?? 'Dữ liệu không hợp lệ'}` : (item?.msg ?? 'Dữ liệu không hợp lệ')
          })
          .join('; ')
      : undefined
    const detail =
      detailMessage ??
      payload?.detail ??
      payload?.message ??
      `Yeu cau that bai (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const usersApi = {
  login: (username: string, password: string) =>
    requestJson<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: (token: string) => requestJson<UserProfile>('/auth/me', { method: 'GET' }, token),

  logout: (token: string, refreshToken?: string | null) =>
    requestJson<void>(
      '/auth/logout',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken ?? null }),
      },
      token,
    ),

  refresh: (refreshToken: string) =>
    requestJson<AuthToken>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),

  changePassword: (token: string, payload: ChangePasswordPayload) =>
    requestJson<{ message: string }>(
      '/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  listUsers: (token: string, params?: ListUsersParams) =>
    requestJson<UserProfile[]>('/users', { method: 'GET' }, token, params),

  getUserById: (token: string, userId: number) =>
    requestJson<UserProfile>(`/users/${userId}`, { method: 'GET' }, token),

  createUser: (token: string, payload: CreateUserPayload) =>
    requestJson<UserProfile>(
      '/users',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateUser: (token: string, userId: number, payload: UpdateUserPayload) =>
    requestJson<UserProfile>(
      `/users/${userId}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  lockUser: (token: string, userId: number) =>
    requestJson<void>(`/users/${userId}/lock`, { method: 'POST' }, token),

  unlockUser: (token: string, userId: number) =>
    requestJson<void>(`/users/${userId}/unlock`, { method: 'POST' }, token),

  resetUserPassword: (token: string, userId: number, newPassword: string) =>
    requestJson<void>(
      `/users/${userId}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      },
      token,
    ),

  deleteUser: (token: string, userId: number) =>
    requestJson<void>(`/users/${userId}`, { method: 'DELETE' }, token),

  listLoginHistory: (token: string, params?: ListLoginHistoryParams) =>
    requestJson<LoginHistoryRecord[]>('/users/login-history', { method: 'GET' }, token, params),
}
