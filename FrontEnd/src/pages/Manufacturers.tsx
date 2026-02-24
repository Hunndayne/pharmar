import { useCallback, useEffect, useMemo, useState } from 'react'
import { catalogApi, type ManufacturerItem } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'

type StatusFilter = 'all' | 'active' | 'inactive'
type ModalMode = 'create' | 'edit'

type ManufacturerForm = {
  id?: string
  code: string
  name: string
  country: string
  address: string
  phone: string
  isActive: boolean
}

const emptyForm: ManufacturerForm = {
  code: '',
  name: '',
  country: '',
  address: '',
  phone: '',
  isActive: true,
}

const pageSize = 10

export function Manufacturers() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'
  const canDelete = isOwnerOrAdmin(user)

  const [rows, setRows] = useState<ManufacturerItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<ManufacturerForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)

    try {
      const response = await catalogApi.listManufacturers(accessToken, {
        search: search.trim() || undefined,
        is_active:
          statusFilter === 'all' ? undefined : statusFilter === 'active',
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
      else setError('Không thể tải danh sách nhà sản xuất.')
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

  const openEdit = async (item: ManufacturerItem) => {
    if (!accessToken) return

    setModalMode('edit')
    setFormError(null)
    setModalOpen(true)
    setDetailLoading(true)

    setForm({
      id: item.id,
      code: item.code,
      name: item.name,
      country: item.country ?? '',
      address: item.address ?? '',
      phone: item.phone ?? '',
      isActive: item.is_active,
    })

    try {
      const detail = await catalogApi.getManufacturer(accessToken, item.id)
      setForm({
        id: detail.id,
        code: detail.code,
        name: detail.name,
        country: detail.country ?? '',
        address: detail.address ?? '',
        phone: detail.phone ?? '',
        isActive: detail.is_active,
      })
    } catch (detailError) {
      if (detailError instanceof ApiError) setFormError(detailError.message)
      else setFormError('Không thể tải chi tiết nhà sản xuất.')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    if (!form.name.trim()) {
      setFormError('Tên nhà sản xuất là bắt buộc.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)

    try {
      const payload = {
        name: form.name.trim(),
        country: form.country.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        is_active: form.isActive,
      }

      if (modalMode === 'create') {
        await catalogApi.createManufacturer(accessToken, payload)
      } else if (form.id) {
        await catalogApi.updateManufacturer(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu nhà sản xuất.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: ManufacturerItem) => {
    if (!accessToken || !canDelete) return

    if (!window.confirm(`Xóa nhà sản xuất ${item.name}?`)) return

    try {
      await catalogApi.deleteManufacturer(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa nhà sản xuất.')
    }
  }

  const summary = useMemo(
    () => ({
      total,
      active: rows.filter((item) => item.is_active).length,
      inactive: rows.filter((item) => !item.is_active).length,
    }),
    [rows, total],
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Nhà sản xuất</h2>
          <p className="mt-2 text-sm text-ink-600">Quản lý hồ sơ công ty sản xuất thuốc.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
        >
          Thêm NSX
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">Bạn chỉ có quyền xem danh sách nhà sản xuất.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tổng nhà sản xuất</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Đang hoạt động</p>
          <p className="mt-2 text-2xl font-semibold text-brand-600">{summary.active}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Ngừng hoạt động</p>
          <p className="mt-2 text-2xl font-semibold text-ink-600">{summary.inactive}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-[1.4fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tìm theo mã hoặc tên nhà sản xuất"
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
        <div className="space-y-3 p-3 md:hidden">
          {loading ? <p className="rounded-2xl bg-white px-4 py-3 text-sm text-ink-600">Äang táº£i dá»¯ liá»‡u...</p> : null}
          {!loading && rows.length === 0 ? (
            <p className="rounded-2xl bg-white px-4 py-3 text-sm text-ink-600">KhÃ´ng cÃ³ dá»¯ liá»‡u nhÃ  sáº£n xuáº¥t.</p>
          ) : null}

          {!loading
            ? rows.map((item) => (
                <article key={item.id} className="rounded-2xl bg-white p-4 text-sm text-ink-700 shadow-[0_1px_0_rgba(17,24,39,0.04)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-ink-900">{item.name}</p>
                      <p className="text-xs text-ink-600">{item.code}</p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        item.is_active
                          ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30'
                          : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'
                      }`}
                    >
                      {item.is_active ? 'Äang hoáº¡t Ä‘á»™ng' : 'Ngá»«ng hoáº¡t Ä‘á»™ng'}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-ink-600">
                    <p>Quá»‘c gia: {item.country || '-'}</p>
                    <p>SÄT: {item.phone || '-'}</p>
                    <p>Äá»‹a chá»‰: {item.address || '-'}</p>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!canManage}
                      onClick={() => void openEdit(item)}
                      className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                    >
                      Sá»­a
                    </button>
                    <button
                      type="button"
                      disabled={!canDelete}
                      onClick={() => void handleDelete(item)}
                      className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                    >
                      XÃ³a
                    </button>
                  </div>
                </article>
              ))
            : null}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[940px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã</th>
                <th className="px-6 py-4">Tên công ty</th>
                <th className="px-6 py-4">Quốc gia</th>
                <th className="px-6 py-4">SĐT</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={6}>Đang tải dữ liệu...</td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={6}>Không có dữ liệu nhà sản xuất.</td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => (
                    <tr key={item.id} className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                      <td className="px-6 py-4 text-ink-900">
                        <p>{item.name}</p>
                        <p className="mt-1 text-xs text-ink-600">{item.address || '-'}</p>
                      </td>
                      <td className="px-6 py-4 text-ink-700">{item.country || '-'}</td>
                      <td className="px-6 py-4 text-ink-700">{item.phone || '-'}</td>
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
                            onClick={() => void openEdit(item)}
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

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} nhà sản xuất
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            Trước
          </button>
          <span>{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            Sau
          </button>
        </div>
      </section>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Thêm nhà sản xuất' : 'Cập nhật nhà sản xuất'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thông tin nhà sản xuất'}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {detailLoading ? <p className="text-sm text-ink-600">Đang tải chi tiết...</p> : null}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã NSX</span>
                  <div className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-ink-700">
                    {form.code || 'Tự động sinh khi lưu'}
                  </div>
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên công ty *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Quốc gia</span>
                  <input
                    value={form.country}
                    onChange={(event) => setForm((prev) => ({ ...prev, country: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Số điện thoại</span>
                  <input
                    value={form.phone}
                    onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Địa chỉ</span>
                  <textarea
                    rows={3}
                    value={form.address}
                    onChange={(event) => setForm((prev) => ({ ...prev, address: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="flex items-center gap-3 text-sm text-ink-700 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Đang hoạt động
                </label>

                {formError ? <p className="text-sm text-coral-500 md:col-span-2">{formError}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={formSubmitting || !canManage}
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
