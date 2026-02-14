import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  type LoginHistoryRecord,
  type UserProfile,
  type UserRole,
  usersApi,
} from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type ActiveFilter = 'all' | 'active' | 'inactive'
type HistorySuccessFilter = 'all' | 'success' | 'failed'

type CreateForm = {
  username: string
  password: string
  fullName: string
  email: string
  phone: string
  role: UserRole
  isActive: boolean
}

type UpdateForm = {
  fullName: string
  email: string
  phone: string
  role: UserRole
  isActive: boolean
}

type HistoryFilters = {
  username: string
  userId: string
  success: HistorySuccessFilter
  limit: number
}

const emptyCreateForm: CreateForm = {
  username: '',
  password: '',
  fullName: '',
  email: '',
  phone: '',
  role: 'staff',
  isActive: true,
}

const emptyUpdateForm: UpdateForm = {
  fullName: '',
  email: '',
  phone: '',
  role: 'staff',
  isActive: true,
}

const defaultHistoryFilters: HistoryFilters = {
  username: '',
  userId: '',
  success: 'all',
  limit: 50,
}

const formatDateTime = (value: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const mapUserToUpdateForm = (user: UserProfile): UpdateForm => ({
  fullName: user.full_name ?? '',
  email: user.email ?? '',
  phone: user.phone ?? '',
  role: user.role,
  isActive: user.is_active,
})

export function UsersManagement() {
  const { user, token } = useAuth()
  const accessToken = token?.access_token ?? ''
  const currentUserId = user?.id

  const [rows, setRows] = useState<UserProfile[]>([])
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all')
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm)
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editTargetId, setEditTargetId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<UpdateForm>(emptyUpdateForm)
  const [editLoading, setEditLoading] = useState(false)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [resetTarget, setResetTarget] = useState<UserProfile | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<LoginHistoryRecord[]>([])
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(defaultHistoryFilters)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const loadUsers = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const users = await usersApi.listUsers(accessToken, {
        search: search.trim() || undefined,
        role: roleFilter === 'all' ? undefined : roleFilter,
        is_active: activeFilter === 'all' ? undefined : activeFilter === 'active',
      })
      setRows(users)
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải danh sách tài khoản.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, search, roleFilter, activeFilter])

  const loadHistory = useCallback(async () => {
    if (!accessToken) return
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const records = await usersApi.listLoginHistory(accessToken, {
        username: historyFilters.username.trim() || undefined,
        user_id: (() => {
          const raw = historyFilters.userId.trim()
          if (!raw) return undefined
          const parsed = Number(raw)
          return Number.isFinite(parsed) ? parsed : undefined
        })(),
        success:
          historyFilters.success === 'all'
            ? undefined
            : historyFilters.success === 'success',
        limit: historyFilters.limit,
      })
      setHistoryRows(records)
    } catch (historyLoadError) {
      if (historyLoadError instanceof ApiError) setHistoryError(historyLoadError.message)
      else setHistoryError('Không thể tải lịch sử đăng nhập.')
    } finally {
      setHistoryLoading(false)
    }
  }, [accessToken, historyFilters])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  const summary = useMemo(() => {
    const total = rows.length
    const active = rows.filter((item) => item.is_active).length
    const inactive = total - active
    return { total, active, inactive }
  }, [rows])

  const handleCreateUser = async () => {
    if (!accessToken) return
    if (!createForm.username.trim() || !createForm.password.trim() || !createForm.fullName.trim()) {
      setCreateError('Tên đăng nhập, mật khẩu và họ tên là bắt buộc.')
      return
    }
    if (createForm.password.length < 4) {
      setCreateError('Mật khẩu phải có ít nhất 4 ký tự.')
      return
    }

    setCreateSubmitting(true)
    setCreateError(null)
    try {
      await usersApi.createUser(accessToken, {
        username: createForm.username.trim(),
        password: createForm.password,
        full_name: createForm.fullName.trim(),
        email: createForm.email.trim() || null,
        phone: createForm.phone.trim() || null,
        role: createForm.role,
        is_active: createForm.isActive,
      })
      setCreateOpen(false)
      setCreateForm(emptyCreateForm)
      await loadUsers()
    } catch (createUserError) {
      if (createUserError instanceof ApiError) setCreateError(createUserError.message)
      else setCreateError('Không thể tạo tài khoản mới.')
    } finally {
      setCreateSubmitting(false)
    }
  }

  const openEditModal = async (target: UserProfile) => {
    if (!accessToken) return
    setEditOpen(true)
    setEditTargetId(target.id)
    setEditForm(mapUserToUpdateForm(target))
    setEditLoading(true)
    setEditError(null)

    try {
      const detail = await usersApi.getUserById(accessToken, target.id)
      setEditForm(mapUserToUpdateForm(detail))
    } catch (detailError) {
      if (detailError instanceof ApiError) setEditError(detailError.message)
      else setEditError('Không thể tải chi tiết tài khoản.')
    } finally {
      setEditLoading(false)
    }
  }

  const handleUpdateUser = async () => {
    if (!accessToken || editTargetId == null) return
    if (!editForm.fullName.trim()) {
      setEditError('Họ tên là bắt buộc.')
      return
    }

    setEditSubmitting(true)
    setEditError(null)
    try {
      await usersApi.updateUser(accessToken, editTargetId, {
        full_name: editForm.fullName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        role: editForm.role,
        is_active: editForm.isActive,
      })
      setEditOpen(false)
      setEditTargetId(null)
      await loadUsers()
    } catch (updateError) {
      if (updateError instanceof ApiError) setEditError(updateError.message)
      else setEditError('Không thể cập nhật tài khoản.')
    } finally {
      setEditSubmitting(false)
    }
  }

  const handleToggleLock = async (target: UserProfile) => {
    if (!accessToken) return
    try {
      if (target.is_active) await usersApi.lockUser(accessToken, target.id)
      else await usersApi.unlockUser(accessToken, target.id)
      await loadUsers()
    } catch (toggleError) {
      if (toggleError instanceof ApiError) setError(toggleError.message)
      else setError('Không thể cập nhật trạng thái tài khoản.')
    }
  }

  const handleDelete = async (target: UserProfile) => {
    if (!accessToken) return
    if (!window.confirm(`Xóa tài khoản ${target.username}?`)) return
    try {
      await usersApi.deleteUser(accessToken, target.id)
      await loadUsers()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa tài khoản.')
    }
  }

  const handleResetPassword = async () => {
    if (!accessToken || !resetTarget) return
    if (newPassword.length < 4) {
      setResetError('Mật khẩu mới phải có ít nhất 4 ký tự.')
      return
    }
    setResetSubmitting(true)
    setResetError(null)
    try {
      await usersApi.resetUserPassword(accessToken, resetTarget.id, newPassword)
      setResetTarget(null)
      setNewPassword('')
    } catch (resetPasswordError) {
      if (resetPasswordError instanceof ApiError) setResetError(resetPasswordError.message)
      else setResetError('Không thể reset mật khẩu.')
    } finally {
      setResetSubmitting(false)
    }
  }

  const openHistoryModal = () => {
    setHistoryOpen(true)
    void loadHistory()
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 tablet:flex-row tablet:items-center tablet:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Quản trị</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Quản lý tài khoản</h2>
          <p className="mt-2 text-sm text-ink-600">Chỉ owner/admin mới có quyền truy cập trang này.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openHistoryModal}
            className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
          >
            Lịch sử đăng nhập
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift"
          >
            Thêm tài khoản
          </button>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tổng tài khoản</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Đang hoạt động</p>
          <p className="mt-2 text-2xl font-semibold">{summary.active}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Đã khóa</p>
          <p className="mt-2 text-2xl font-semibold">{summary.inactive}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,1fr,auto]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm username / tên / email"
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as 'all' | UserRole)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả vai trò</option>
            <option value="owner">Owner</option>
            <option value="manager">Manager</option>
            <option value="staff">Staff</option>
          </select>
          <select
            value={activeFilter}
            onChange={(event) => setActiveFilter(event.target.value as ActiveFilter)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang hoạt động</option>
            <option value="inactive">Đã khóa</option>
          </select>
          <button type="button" onClick={() => void loadUsers()} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
            Lọc
          </button>
        </div>
        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.25em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Username</th>
                <th className="px-6 py-4">Họ tên</th>
                <th className="px-6 py-4">Vai trò</th>
                <th className="px-6 py-4">Liên hệ</th>
                <th className="px-6 py-4">Lần đăng nhập cuối</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>Đang tải dữ liệu...</td>
                </tr>
              ) : null}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>Không có tài khoản phù hợp.</td>
                </tr>
              ) : null}
              {!loading
                ? rows.map((item) => (
                    <tr key={item.id} className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">
                        {item.username}
                        {item.id === currentUserId ? ' (bạn)' : ''}
                      </td>
                      <td className="px-6 py-4 text-ink-900">{item.full_name || '-'}</td>
                      <td className="px-6 py-4 text-ink-700">{item.role}</td>
                      <td className="px-6 py-4 text-ink-700">{item.email || item.phone || '-'}</td>
                      <td className="px-6 py-4 text-ink-700">{formatDateTime(item.last_login_at)}</td>
                      <td className="px-6 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${item.is_active ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30' : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'}`}>
                          {item.is_active ? 'Hoạt động' : 'Đã khóa'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void openEditModal(item)}
                            className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            Sửa
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleLock(item)}
                            className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            {item.is_active ? 'Khóa' : 'Mở khóa'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setResetTarget(item)
                              setNewPassword('')
                              setResetError(null)
                            }}
                            className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            Reset mật khẩu
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(item)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </section>

      {createOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <h3 className="text-xl font-semibold text-ink-900">Tạo tài khoản mới</h3>
            </div>
            <div className="grid gap-4 px-6 py-5 md:grid-cols-2">
              <input placeholder="Username *" value={createForm.username} onChange={(event) => setCreateForm((prev) => ({ ...prev, username: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              <input placeholder="Mật khẩu *" type="password" value={createForm.password} onChange={(event) => setCreateForm((prev) => ({ ...prev, password: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              <input placeholder="Họ và tên *" value={createForm.fullName} onChange={(event) => setCreateForm((prev) => ({ ...prev, fullName: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              <input placeholder="Email" value={createForm.email} onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              <input placeholder="Số điện thoại" value={createForm.phone} onChange={(event) => setCreateForm((prev) => ({ ...prev, phone: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              <select value={createForm.role} onChange={(event) => setCreateForm((prev) => ({ ...prev, role: event.target.value as UserRole }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm">
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
              </select>
              <label className="md:col-span-2 flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" checked={createForm.isActive} onChange={(event) => setCreateForm((prev) => ({ ...prev, isActive: event.target.checked }))} />
                Kích hoạt ngay
              </label>
              {createError ? <p className="md:col-span-2 text-sm text-coral-500">{createError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button type="button" onClick={() => void handleCreateUser()} disabled={createSubmitting} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {createSubmitting ? 'Đang tạo...' : 'Tạo tài khoản'}
              </button>
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <h3 className="text-xl font-semibold text-ink-900">Cập nhật tài khoản</h3>
            </div>
            <div className="grid gap-4 px-6 py-5 md:grid-cols-2">
              {editLoading ? <p className="md:col-span-2 text-sm text-ink-600">Đang tải chi tiết...</p> : null}
              <input placeholder="Họ và tên *" value={editForm.fullName} onChange={(event) => setEditForm((prev) => ({ ...prev, fullName: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" disabled={editLoading} />
              <input placeholder="Email" value={editForm.email} onChange={(event) => setEditForm((prev) => ({ ...prev, email: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" disabled={editLoading} />
              <input placeholder="Số điện thoại" value={editForm.phone} onChange={(event) => setEditForm((prev) => ({ ...prev, phone: event.target.value }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" disabled={editLoading} />
              <select value={editForm.role} onChange={(event) => setEditForm((prev) => ({ ...prev, role: event.target.value as UserRole }))} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" disabled={editLoading || editTargetId === currentUserId}>
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
              </select>
              <label className="md:col-span-2 flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" checked={editForm.isActive} onChange={(event) => setEditForm((prev) => ({ ...prev, isActive: event.target.checked }))} disabled={editLoading || editTargetId === currentUserId} />
                Trạng thái hoạt động
              </label>
              {editError ? <p className="md:col-span-2 text-sm text-coral-500">{editError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button type="button" onClick={() => void handleUpdateUser()} disabled={editSubmitting || editLoading} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {editSubmitting ? 'Đang cập nhật...' : 'Lưu thay đổi'}
              </button>
              <button type="button" onClick={() => setEditOpen(false)} className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-6xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <h3 className="text-xl font-semibold text-ink-900">Lịch sử đăng nhập</h3>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="grid gap-3 md:grid-cols-[1.2fr,1fr,1fr,1fr,auto]">
                <input
                  value={historyFilters.username}
                  onChange={(event) => setHistoryFilters((prev) => ({ ...prev, username: event.target.value }))}
                  placeholder="Lọc theo username"
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                />
                <input
                  type="number"
                  min={1}
                  value={historyFilters.userId}
                  onChange={(event) => setHistoryFilters((prev) => ({ ...prev, userId: event.target.value }))}
                  placeholder="Lọc theo user id"
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                />
                <select
                  value={historyFilters.success}
                  onChange={(event) => setHistoryFilters((prev) => ({ ...prev, success: event.target.value as HistorySuccessFilter }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                >
                  <option value="all">Tất cả</option>
                  <option value="success">Thành công</option>
                  <option value="failed">Thất bại</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={historyFilters.limit}
                  onChange={(event) =>
                    setHistoryFilters((prev) => ({
                      ...prev,
                      limit: Number(event.target.value) > 0 ? Number(event.target.value) : 1,
                    }))
                  }
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void loadHistory()}
                  className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  Lọc
                </button>
              </div>

              {historyError ? <p className="text-sm text-coral-500">{historyError}</p> : null}

              <div className="max-h-[55vh] overflow-auto rounded-2xl border border-ink-900/10">
                <table className="min-w-[1050px] w-full text-left text-sm">
                  <thead className="bg-fog-50 text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Thời gian</th>
                      <th className="px-4 py-3">Username</th>
                      <th className="px-4 py-3">User ID</th>
                      <th className="px-4 py-3">IP</th>
                      <th className="px-4 py-3">User Agent</th>
                      <th className="px-4 py-3">Kết quả</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/5">
                    {historyLoading ? (
                      <tr>
                        <td className="px-4 py-4 text-ink-600" colSpan={6}>Đang tải lịch sử...</td>
                      </tr>
                    ) : null}
                    {!historyLoading && historyRows.length === 0 ? (
                      <tr>
                        <td className="px-4 py-4 text-ink-600" colSpan={6}>Không có dữ liệu.</td>
                      </tr>
                    ) : null}
                    {!historyLoading
                      ? historyRows.map((row) => (
                          <tr key={row.id} className="hover:bg-fog-50">
                            <td className="px-4 py-3 text-ink-900">{formatDateTime(row.created_at)}</td>
                            <td className="px-4 py-3 text-ink-900">{row.username ?? '-'}</td>
                            <td className="px-4 py-3 text-ink-700">{row.user_id ?? '-'}</td>
                            <td className="px-4 py-3 text-ink-700">{row.ip_address ?? '-'}</td>
                            <td className="px-4 py-3 text-ink-700">{row.user_agent ?? '-'}</td>
                            <td className="px-4 py-3">
                              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.success ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30' : 'bg-coral-500/10 text-coral-500 border border-coral-500/30'}`}>
                                {row.success ? 'Thành công' : 'Thất bại'}
                              </span>
                            </td>
                          </tr>
                        ))
                      : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button type="button" onClick={() => setHistoryOpen(false)} className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">
                Đóng
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resetTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-md flex-col rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <h3 className="text-xl font-semibold text-ink-900">Reset mật khẩu</h3>
              <p className="mt-1 text-sm text-ink-600">{resetTarget.username}</p>
            </div>
            <div className="space-y-3 px-6 py-5">
              <input type="password" placeholder="Mật khẩu mới" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
              {resetError ? <p className="text-sm text-coral-500">{resetError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button type="button" onClick={() => void handleResetPassword()} disabled={resetSubmitting} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {resetSubmitting ? 'Đang xử lý...' : 'Xác nhận'}
              </button>
              <button type="button" onClick={() => setResetTarget(null)} className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
