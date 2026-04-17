import {
  ApiError,
  createApiUrlBuilder,
  requestJson,
  type ApiFetchOptions,
  type ApiValidationDetailItem,
} from './httpClient'

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

export { ApiError }
export type { ApiValidationDetailItem }

export const buildUsersApiUrl = createApiUrlBuilder({
  envPrefix: import.meta.env.VITE_USERS_API_PREFIX,
  fallbackPrefix: '/api/v1',
  devGatewayPort: 8000,
})

const requestUsersJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
  fetchOptions?: ApiFetchOptions,
): Promise<T> =>
  requestJson<T>(buildUsersApiUrl, path, {
    init,
    token,
    params,
    fetchMode: 'controlled',
    fetchOptions,
    includeValidationDetail: true,
  })

export const usersApi = {
  login: (username: string, password: string) =>
    requestUsersJson<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: (token: string) =>
    requestUsersJson<UserProfile>('/auth/me', { method: 'GET' }, token, undefined, {
      getCacheMs: 3000,
      max429Retries: 2,
    }),

  logout: (token: string, refreshToken?: string | null) =>
    requestUsersJson<void>(
      '/auth/logout',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken ?? null }),
      },
      token,
    ),

  refresh: (refreshToken: string) =>
    requestUsersJson<AuthToken>(
      '/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      undefined,
      undefined,
      {
        dedupe: true,
        dedupeKey: `POST::/auth/refresh::${refreshToken}`,
        retryOn429: true,
        max429Retries: 2,
      },
    ),

  changePassword: (token: string, payload: ChangePasswordPayload) =>
    requestUsersJson<{ message: string }>(
      '/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  listUsers: (token: string, params?: ListUsersParams) =>
    requestUsersJson<UserProfile[]>('/users', { method: 'GET' }, token, params),

  getUserById: (token: string, userId: number) =>
    requestUsersJson<UserProfile>(`/users/${userId}`, { method: 'GET' }, token),

  createUser: (token: string, payload: CreateUserPayload) =>
    requestUsersJson<UserProfile>(
      '/users',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateUser: (token: string, userId: number, payload: UpdateUserPayload) =>
    requestUsersJson<UserProfile>(
      `/users/${userId}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  lockUser: (token: string, userId: number) =>
    requestUsersJson<void>(`/users/${userId}/lock`, { method: 'POST' }, token),

  unlockUser: (token: string, userId: number) =>
    requestUsersJson<void>(`/users/${userId}/unlock`, { method: 'POST' }, token),

  resetUserPassword: (token: string, userId: number, newPassword: string) =>
    requestUsersJson<void>(
      `/users/${userId}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      },
      token,
    ),

  deleteUser: (token: string, userId: number) =>
    requestUsersJson<void>(`/users/${userId}`, { method: 'DELETE' }, token),

  listLoginHistory: (token: string, params?: ListLoginHistoryParams) =>
    requestUsersJson<LoginHistoryRecord[]>('/users/login-history', { method: 'GET' }, token, params),
}
