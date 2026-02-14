import { ApiError } from './usersService'

export type StoreInfo = {
  id: string
  name: string
  address: string | null
  phone: string | null
  email: string | null
  tax_code: string | null
  license_number: string | null
  owner_name: string | null
  logo_url: string | null
  bank_account: string | null
  bank_name: string | null
  bank_branch: string | null
  created_at: string
  updated_at: string
}

export type UpdateStoreInfoPayload = {
  name?: string
  address?: string | null
  phone?: string | null
  email?: string | null
  tax_code?: string | null
  license_number?: string | null
  owner_name?: string | null
  bank_account?: string | null
  bank_name?: string | null
  bank_branch?: string | null
}

export type StoreSettingItem = {
  key: string
  value: unknown
  group_name: string
  data_type: 'boolean' | 'number' | 'string' | 'json'
  description: string
  is_public: boolean
  updated_at: string
  updated_by: string | null
}

export type StoreSettingsMap = Record<string, unknown>

const sanitizePrefix = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

const sanitizeBase = (value: string) => value.trim().replace(/\/+$/, '')

const API_BASE = sanitizeBase(import.meta.env.VITE_API_BASE_URL ?? '')
const STORE_PREFIX = sanitizePrefix(import.meta.env.VITE_STORE_API_PREFIX ?? '/api/v1/store')

export const buildStoreApiUrl = (
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const target = `${API_BASE}${STORE_PREFIX}${normalizedPath}`
  const url = new URL(target, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      url.searchParams.set(key, String(value))
    })
  }
  return url.toString()
}

const requestStoreJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildStoreApiUrl(path, params), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail = payload?.detail ?? payload?.message ?? `Yeu cau that bai (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const storeApi = {
  health: () => requestStoreJson<{ service: string; status: string }>('/health', { method: 'GET' }),

  getInfo: () => requestStoreJson<StoreInfo>('/info', { method: 'GET' }),

  updateInfo: (token: string, payload: UpdateStoreInfoPayload) =>
    requestStoreJson<{ message: string; data: StoreInfo }>(
      '/info',
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  uploadLogo: async (token: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(buildStoreApiUrl('/info/logo'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(payload?.detail ?? `Yeu cau that bai (${response.status})`, response.status)
    }
    return payload as { message: string; logo_url: string; data: StoreInfo }
  },

  deleteLogo: (token: string) =>
    requestStoreJson<{ message: string; data: StoreInfo }>(
      '/info/logo',
      { method: 'DELETE' },
      token,
    ),

  getAllSettings: () => requestStoreJson<StoreSettingsMap>('/settings', { method: 'GET' }),

  getSettingsByGroup: (group: string) =>
    requestStoreJson<StoreSettingsMap>(`/settings/group/${encodeURIComponent(group)}`, {
      method: 'GET',
    }),

  getSetting: (key: string) =>
    requestStoreJson<StoreSettingItem>(`/settings/${encodeURIComponent(key)}`, { method: 'GET' }),

  updateSetting: (token: string, key: string, value: unknown) =>
    requestStoreJson<{ message: string; key: string; value: unknown }>(
      `/settings/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
      token,
    ),

  updateSettingsBulk: (token: string, settings: StoreSettingsMap) =>
    requestStoreJson<{ message: string; updated: number }>(
      '/settings',
      {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      },
      token,
    ),

  resetAllSettings: (token: string) =>
    requestStoreJson<{ message: string; updated: number }>(
      '/settings/reset',
      { method: 'POST' },
      token,
    ),

  resetSetting: (token: string, key: string) =>
    requestStoreJson<{ message: string; key: string; value: unknown }>(
      `/settings/reset/${encodeURIComponent(key)}`,
      { method: 'POST' },
      token,
    ),
}

