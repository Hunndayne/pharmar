import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { usersApi, type AuthToken, type UserProfile } from '../api/usersService'
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

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null)
  const [token, setToken] = useState<AuthToken | null>(null)
  const [loading, setLoading] = useState(true)

  const persistAuth = useCallback((nextUser: UserProfile | null, nextToken: AuthToken | null) => {
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
    const refreshed = await usersApi.refresh(currentToken.refresh_token)
    return {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? currentToken.refresh_token,
    }
  }, [])

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const saved = readAuthStorage()
        if (!saved?.token?.access_token) {
          setLoading(false)
          return
        }
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
