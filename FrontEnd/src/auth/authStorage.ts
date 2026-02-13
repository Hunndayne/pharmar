export const AUTH_STORAGE_KEY = 'pharmar_auth_v1'

export type StoredAuth = {
  token: {
    access_token: string
    refresh_token: string
    token_type: string
  } | null
  user: {
    id: number
    username: string
    full_name: string | null
    role: 'owner' | 'manager' | 'staff'
    email?: string | null
    phone?: string | null
    is_active?: boolean
  } | null
}

export const readAuthStorage = (): StoredAuth | null => {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredAuth
  } catch {
    return null
  }
}

export const writeAuthStorage = (payload: StoredAuth | null) => {
  if (!payload) {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    return
  }
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload))
}
