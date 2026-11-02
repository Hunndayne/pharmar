import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { setAuthHooks } from '../api/httpClient'
import { usersApi, type AuthToken, type UserProfile } from '../api/usersService'
import { WHATS_NEW_STORAGE_KEY } from '../constants/changelog'
import { APP_TIME_ZONE_STORAGE_KEY } from '../utils/timezone'
import { readAuthStorage, writeAuthStorage } from './authStorage'

type LoginPayload = {
  username: string
  password: string
}

type AuthContextValue = {
  user: UserProfile | null
  token: AuthToken | null
  loading: boolean
  login: (payload: LoginPayload) => Promise<void>
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
}

// Device-level settings that must survive logout. The screen id key mirrors CUSTOMER_DISPLAY_SCREEN_ID_KEY in api/systemService.ts.
const PERSISTENT_STORAGE_KEYS = new Set([
  APP_TIME_ZONE_STORAGE_KEY,
  'pharmar:customer-display:screen_id',
  WHATS_NEW_STORAGE_KEY,
])

const clearLocalSessionData = () => {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && key.startsWith('pharmar') && !PERSISTENT_STORAGE_KEYS.has(key)) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    // ignore storage errors
  }
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null)
  const [token, setToken] = useState<AuthToken | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshPromiseRef = useRef<Promise<AuthToken | null> | null>(null)
  const userRef = useRef<UserProfile | null>(null)
  const tokenRef = useRef<AuthToken | null>(null)

  const persistAuth = useCallback((nextUser: UserProfile | null, nextToken: AuthToken | null) => {
    userRef.current = nextUser
    tokenRef.current = nextToken
    setUser(nextUser)
    setToken(nextToken)
    writeAuthStorage({
      user: nextUser
        ? {
            id: nextUser.id,
            username: nextUser.username,
            role: nextUser.role,
            full_name: nextUser.full_name,
            email: nextUser.email,
            phone: nextUser.phone,
            is_active: nextUser.is_active,
          }
        : null,
      token: nextToken,
    })
  }, [])

  const tryRefreshToken = useCallback(async (currentToken: AuthToken | null) => {
    if (!currentToken?.refresh_token) return null
    if (refreshPromiseRef.current) return refreshPromiseRef.current

    const task = usersApi
      .refresh(currentToken.refresh_token)
      .then((refreshed) => ({
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? currentToken.refresh_token,
      }))
      .finally(() => {
        refreshPromiseRef.current = null
      })

    refreshPromiseRef.current = task
    return task
  }, [])

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const saved = readAuthStorage()
        if (!saved?.token?.access_token) {
          setLoading(false)
          return
        }
        tokenRef.current = saved.token
        setToken(saved.token)
        try {
          const me = await usersApi.me(saved.token.access_token)
          persistAuth(me, saved.token)
        } catch {
          const refreshed = await tryRefreshToken(saved.token)
          if (!refreshed) {
            persistAuth(null, null)
            return
          }
          const me = await usersApi.me(refreshed.access_token)
          persistAuth(me, refreshed)
        }
      } catch {
        persistAuth(null, null)
      } finally {
        setLoading(false)
      }
    }
    void bootstrap()
  }, [persistAuth, tryRefreshToken])

  useEffect(() => {
    setAuthHooks({
      refresh: async (failedToken) => {
        const current = tokenRef.current
        if (!current) return null
        // Another request already rotated the token; reuse it instead of refreshing again.
        if (current.access_token !== failedToken) return current.access_token
        const refreshed = await tryRefreshToken(current)
        if (!refreshed) return null
        persistAuth(userRef.current, refreshed)
        return refreshed.access_token
      },
      logout: () => {
        persistAuth(null, null)
      },
    })
    return () => setAuthHooks(null)
  }, [persistAuth, tryRefreshToken])

  const login = useCallback(
    async ({ username, password }: LoginPayload) => {
      const response = await usersApi.login(username, password)
      persistAuth(response.user, response.token)
    },
    [persistAuth],
  )

  const logout = useCallback(async () => {
    const accessToken = token?.access_token
    const refreshToken = token?.refresh_token
    try {
      if (accessToken) await usersApi.logout(accessToken, refreshToken)
    } catch {
      // Ignore remote logout error and clear local session.
    } finally {
      persistAuth(null, null)
      clearLocalSessionData()
    }
  }, [persistAuth, token])

  const refreshMe = useCallback(async () => {
    if (!token?.access_token) return
    try {
      const me = await usersApi.me(token.access_token)
      persistAuth(me, token)
      return
    } catch {
      const refreshed = await tryRefreshToken(token)
      if (!refreshed) {
        persistAuth(null, null)
        return
      }
      const me = await usersApi.me(refreshed.access_token)
      persistAuth(me, refreshed)
    }
  }, [persistAuth, token, tryRefreshToken])

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, loading, login, logout, refreshMe }),
    [user, token, loading, login, logout, refreshMe],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
