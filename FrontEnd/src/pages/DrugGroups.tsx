import { useCallback, useEffect, useMemo, useState } from 'react'
import { catalogApi, type DrugGroupItem } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { readLocalDraft, removeLocalDraft, writeLocalDraft } from '../utils/localDraft'

type StatusFilter = 'all' | 'active' | 'inactive'
type ModalMode = 'create' | 'edit'

type DrugGroupForm = {
  id?: string
  code: string
  name: string
  description: string
  isActive: boolean
}

const emptyForm: DrugGroupForm = {
  code: '',
  name: '',
  description: '',
  isActive: true,
}

const pageSize = 10
const DRUG_GROUP_FORM_DRAFT_STORAGE_KEY = 'pharmar.drug-groups.form.draft.v1'

export function DrugGroups() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'
  const canDelete = isOwnerOrAdmin(user)

  const [rows, setRows] = useState<DrugGroupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<DrugGroupForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadCreateDraft = useCallback(() => {
    const draft = readLocalDraft<Partial<DrugGroupForm>>(DRUG_GROUP_FORM_DRAFT_STORAGE_KEY)
    if (!draft) return emptyForm
    return {
      ...emptyForm,
      ...draft,
      id: undefined,
      code: '',
    }
  }, [])

  const clearCreateDraft = useCallback(() => {
    removeLocalDraft(DRUG_GROUP_FORM_DRAFT_STORAGE_KEY)
  }, [])

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)

    try {
      const response = await catalogApi.listDrugGroups(accessToken, {
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
      else setError('Không thể tải danh sách nhóm thuốc.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, page, search, statusFilter])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const openCreate = () => {
    setModalMode('create')
    setForm(loadCreateDraft())
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = async (item: DrugGroupItem) => {
    if (!accessToken) return

    setModalMode('edit')
    setFormError(null)
    setModalOpen(true)
    setDetailLoading(true)

    setForm({
      id: item.id,
      code: item.code,
      name: item.name,
      description: item.description ?? '',
      isActive: item.is_active,
    })

    try {
      const detail = await catalogApi.getDrugGroup(accessToken, item.id)
      setForm({
        id: detail.id,
        code: detail.code,
        name: detail.name,
        description: detail.description ?? '',
        isActive: detail.is_active,
      })
    } catch (detailError) {
      if (detailError instanceof ApiError) setFormError(detailError.message)
      else setFormError('Không thể tải chi tiết nhóm thuốc.')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    if (!form.name.trim()) {
      setFormError('Tên nhóm thuốc là bắt buộc.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)

    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        is_active: form.isActive,
      }

      if (modalMode === 'create') {
        await catalogApi.createDrugGroup(accessToken, payload)
        clearCreateDraft()
      } else if (form.id) {
        await catalogApi.updateDrugGroup(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu nhóm thuốc.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: DrugGroupItem) => {
    if (!accessToken || !canDelete) return

    if (!window.confirm(`Xóa nhóm thuốc ${item.name}?`)) return

    try {
      await catalogApi.deleteDrugGroup(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa nhóm thuốc.')
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

  useEffect(() => {
    if (!modalOpen || modalMode !== 'create') return
    writeLocalDraft(DRUG_GROUP_FORM_DRAFT_STORAGE_KEY, form)
  }, [form, modalMode, modalOpen])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Nhóm thuốc</h2>
          <p className="mt-2 text-sm text-ink-600">Quản lý nhóm thuốc phục vụ khai báo sản phẩm.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
        >
          Thêm nhóm
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">Bạn chỉ có quyền xem danh sách nhóm thuốc.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tổng nhóm thuốc</p>
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

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tìm theo mã hoặc tên nhóm thuốc"
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã nhóm</th>
                <th className="px-6 py-4">Tên nhóm</th>
                <th className="px-6 py-4">Mô tả</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={5}>Đang tải dữ liệu...</td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={5}>Không có dữ liệu nhóm thuốc.</td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => (
                    <tr key={item.id} className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                      <td className="px-6 py-4 text-ink-900">{item.name}</td>
                      <td className="px-6 py-4 text-ink-700">{item.description || '-'}</td>
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
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} nhóm thuốc
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
                  {modalMode === 'create' ? 'Thêm nhóm thuốc' : 'Cập nhật nhóm thuốc'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thông tin nhóm thuốc'}</h3>
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
                  <span>Mã nhóm</span>
                  <div className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-ink-700">
                    {form.code || 'Tự động sinh khi lưu'}
                  </div>
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên nhóm thuốc *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Mô tả</span>
                  <textarea
                    value={form.description}
                    onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    rows={3}
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

              {formError ? <p className="mt-4 text-sm text-coral-500">{formError}</p> : null}
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
