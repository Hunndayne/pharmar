import { useState, type FormEvent } from 'react'
import { ApiError, buildUsersApiUrl } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

export function UserSettings() {
  const { user, token } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!token?.access_token) return
    if (!currentPassword || newPassword.length < 6) {
      setError('Mật khẩu mới cần ít nhất 6 ký tự.')
      return
    }
    setSubmitting(true)
    setError(null)
    setMessage(null)
    try {
      await fetch(buildUsersApiUrl('/auth/change-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.access_token}`,
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      }).then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new ApiError(data?.detail ?? 'Không thể đổi mật khẩu.', response.status)
        }
      })
      setCurrentPassword('')
      setNewPassword('')
      setMessage('Đổi mật khẩu thành công.')
    } catch (submitError) {
      if (submitError instanceof ApiError) setError(submitError.message)
      else setError('Không thể đổi mật khẩu.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Tài khoản</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Cài đặt người dùng</h2>
      </header>

      <section className="glass-card rounded-3xl p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-ink-900/10 bg-white/70 p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Username</p>
            <p className="mt-2 text-lg font-semibold text-ink-900">{user?.username ?? '-'}</p>
          </div>
          <div className="rounded-2xl border border-ink-900/10 bg-white/70 p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Vai trò</p>
            <p className="mt-2 text-lg font-semibold text-ink-900">{user?.role ?? '-'}</p>
          </div>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-6">
        <h3 className="text-xl font-semibold text-ink-900">Đổi mật khẩu</h3>
        <form onSubmit={onSubmit} className="mt-4 grid gap-4 md:max-w-xl">
          <label className="space-y-2 text-sm text-ink-700">
            <span>Mật khẩu hiện tại</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Mật khẩu mới</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
            />
          </label>

          {error ? <p className="text-sm text-coral-500">{error}</p> : null}
          {message ? <p className="text-sm text-brand-600">{message}</p> : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
          </button>
        </form>
      </section>
    </div>
  )
}
