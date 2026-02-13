import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type LocationState = {
  from?: {
    pathname?: string
  }
}

export function Login() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as LocationState | null

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (user) return <Navigate to="/" replace />

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login({ username: username.trim(), password })
      const redirectTo = state?.from?.pathname || '/'
      navigate(redirectTo, { replace: true })
    } catch (loginError) {
      if (loginError instanceof ApiError) setError(loginError.message)
      else setError('Không thể đăng nhập. Vui lòng thử lại.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="glass-card w-full max-w-md rounded-3xl p-6 sm:p-8">
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">PHARMAR</p>
        <h1 className="mt-3 text-3xl font-semibold text-ink-900">Đăng nhập</h1>
        <p className="mt-2 text-sm text-ink-600">
          Nhập tài khoản để truy cập hệ thống quản lý nhà thuốc.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block space-y-2 text-sm text-ink-700">
            <span>Tên đăng nhập</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2.5 text-sm text-ink-900"
            />
          </label>

          <label className="block space-y-2 text-sm text-ink-700">
            <span>Mật khẩu</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2.5 text-sm text-ink-900"
            />
          </label>

          {error ? <p className="text-sm text-coral-500">{error}</p> : null}

          <button
            type="submit"
            disabled={submitting || !username.trim() || !password}
            className="w-full rounded-2xl bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Đang đăng nhập...' : 'Đăng nhập'}
          </button>
        </form>
      </div>
    </div>
  )
}
