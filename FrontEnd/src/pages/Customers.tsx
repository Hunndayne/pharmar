import { useCallback, useEffect, useMemo, useState } from 'react'
import { customerApi, type CustomerRecord } from '../api/customerService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type StatusFilter = 'all' | 'active' | 'inactive'
type ModalMode = 'create' | 'edit'

type CustomerForm = {
  id?: string
  code?: string
  name: string
  phone: string
  email: string
  address: string
  note: string
  isActive: boolean
}

const pageSize = 10

const emptyForm: CustomerForm = {
  name: '',
  phone: '',
  email: '',
  address: '',
  note: '',
  isActive: true,
}

const formatCurrency = (value: string | number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '0đ'
  return `${parsed.toLocaleString('vi-VN')}đ`
}

const formatDate = (value: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('vi-VN')
}

const normalizePhone = (value: string) => value.replace(/[^0-9+]/g, '').trim()

export function Customers() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const canManage =
    user?.role === 'owner' ||
    user?.role === 'manager' ||
    user?.username === 'admin'
  const canDelete = canManage

  const [rows, setRows] = useState<CustomerRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<CustomerForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)

  const loadRows = useCallback(async () => {
    if (!accessToken) return

    setLoading(true)
    setError(null)

    try {
      const response = await customerApi.listCustomers(accessToken, {
        search: search.trim() || undefined,
        is_active: statusFilter === 'all' ? undefined : statusFilter === 'active',
        page,
        size: pageSize,
      })

      setRows(response.items)
      setTotal(response.total)
      setTotalPages(Math.max(1, response.pages))

      if (response.pages > 0 && page > response.pages) {
        setPage(response.pages)
      }
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải danh sách khách hàng.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, page, search, statusFilter])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const openCreate = () => {
    setModalMode('create')
    setForm(emptyForm)
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = (item: CustomerRecord) => {
    setModalMode('edit')
    setFormError(null)
    setForm({
      id: item.id,
      code: item.code,
      name: item.name,
      phone: item.phone,
      email: item.email ?? '',
      address: item.address ?? '',
      note: item.note ?? '',
      isActive: item.is_active,
    })
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    const name = form.name.trim()
    const phone = normalizePhone(form.phone)
    if (!name) {
      setFormError('Tên khách hàng là bắt buộc.')
      return
    }
    if (!phone) {
      setFormError('Số điện thoại là bắt buộc.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)

    try {
      const payload = {
        name,
        phone,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        note: form.note.trim() || null,
        is_active: form.isActive,
      }

      if (modalMode === 'create') {
        await customerApi.createCustomer(accessToken, payload)
      } else if (form.id) {
        await customerApi.updateCustomer(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu khách hàng.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: CustomerRecord) => {
    if (!accessToken || !canDelete) return
    if (!window.confirm(`Xóa khách hàng ${item.name}?`)) return

    try {
      await customerApi.deleteCustomer(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa khách hàng.')
    }
  }

  const summary = useMemo(
    () => ({
      total,
      activeOnPage: rows.filter((item) => item.is_active).length,
      inactiveOnPage: rows.filter((item) => !item.is_active).length,
    }),
    [rows, total],
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Khách hàng</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Quản lý khách hàng</h2>
          <p className="mt-2 text-sm text-ink-600">Dữ liệu đồng bộ từ Customer Service.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="w-full rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60 sm:w-auto"
        >
          Thêm khách hàng
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">Bạn chỉ có quyền xem danh sách khách hàng.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tổng khách hàng</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Đang hoạt động (trang này)</p>
          <p className="mt-2 text-2xl font-semibold text-brand-600">{summary.activeOnPage}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Ngừng hoạt động (trang này)</p>
          <p className="mt-2 text-2xl font-semibold text-ink-600">{summary.inactiveOnPage}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-4 space-y-4 sm:p-6">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tìm theo mã, tên, số điện thoại"
          />

          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang hoạt động</option>
            <option value="inactive">Ngừng hoạt động</option>
          </select>

          <button
            type="button"
            onClick={() => {
              setSearch('')
              setStatusFilter('all')
              setPage(1)
            }}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() => void loadRows()}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Tải lại
          </button>
        </div>

        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="space-y-3 p-4 md:hidden">
          {loading ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-600">
              ??ang t???i d??? li???u...
            </div>
          ) : null}

          {!loading && rows.length === 0 ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-600">
              Kh??ng c?? d??? li???u kh??ch h??ng.
            </div>
          ) : null}

          {!loading
            ? rows.map((item) => (
                <article key={item.id} className="rounded-2xl border border-ink-900/10 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-ink-900">{item.code}</p>
                      <p className="text-sm text-ink-900">{item.name}</p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        item.is_active
                          ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30'
                          : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'
                      }`}
                    >
                      {item.is_active ? 'Đang hoạt động' : 'Ngừng hoạt động'}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-ink-700">
                    <p>SDT: {item.phone}</p>
                    <p>Hạng: {item.tier}</p>
                    <p>Điểm: {item.current_points.toLocaleString('vi-VN')}</p>
                    <p>Tổng chi tiêu: {formatCurrency(item.total_spent)}</p>
                    <p>Ngày mua gần nhất: {formatDate(item.last_purchase_at)}</p>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!canManage}
                      onClick={() => openEdit(item)}
                      className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      disabled={!canDelete}
                      onClick={() => void handleDelete(item)}
                      className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                    >
                      Xóa
                    </button>
                  </div>
                </article>
              ))
            : null}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã KH</th>
                <th className="px-6 py-4">Tên KH</th>
                <th className="px-6 py-4">SDT</th>
                <th className="px-6 py-4">Hạng</th>
                <th className="px-6 py-4">Diem</th>
                <th className="px-6 py-4">Tổng chi tiêu</th>
                <th className="px-6 py-4">Lần mua gần nhất</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={9}>
                    Đang tải dữ liệu...
                  </td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={9}>
                    Không có dữ liệu khách hàng.
                  </td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => (
                    <tr key={item.id} className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                      <td className="px-6 py-4 text-ink-900">
                        <p>{item.name}</p>
                        <p className="mt-1 text-xs text-ink-600">{item.email || item.address || '-'}</p>
                      </td>
                      <td className="px-6 py-4 text-ink-700">{item.phone}</td>
                      <td className="px-6 py-4 text-ink-700">{item.tier}</td>
                      <td className="px-6 py-4 text-ink-700">{item.current_points.toLocaleString('vi-VN')}</td>
                      <td className="px-6 py-4 text-ink-700">{formatCurrency(item.total_spent)}</td>
                      <td className="px-6 py-4 text-ink-700">{formatDate(item.last_purchase_at)}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            item.is_active
                              ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30'
                              : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'
                          }`}
                        >
                          {item.is_active ? 'Đang hoạt động' : 'Ngừng hoạt động'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={!canManage}
                            onClick={() => openEdit(item)}
                            className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                          >
                            Sửa
                          </button>
                          <button
                            type="button"
                            disabled={!canDelete}
                            onClick={() => void handleDelete(item)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
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

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} khách hàng
        </span>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
          >
            Trước
          </button>
          <span>{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
          >
            Sau
          </button>
        </div>
      </section>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Thêm khách hàng' : 'Chỉnh sửa khách hàng'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thông tin khách hàng'}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              {form.code ? (
                <div className="rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-3 text-sm text-ink-700">
                  Mã khách hàng: <span className="font-semibold text-ink-900">{form.code}</span>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên khách hàng *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Số điện thoại *</span>
                  <input
                    value={form.phone}
                    onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Email</span>
                  <input
                    value={form.email}
                    onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Địa chỉ</span>
                  <input
                    value={form.address}
                    onChange={(event) => setForm((prev) => ({ ...prev, address: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Ghi chú</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    rows={2}
                  />
                </label>
                <label className="flex items-center gap-3 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Đang hoạt động
                </label>
              </div>

              {formError ? <p className="text-sm text-coral-500">{formError}</p> : null}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={formSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
              >
                {formSubmitting ? 'Đang lưu...' : 'Lưu'}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
