import { useCallback, useEffect, useMemo, useState } from 'react'
import { catalogApi, type DrugGroupItem } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'

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
      else setError('Kh?ng th? t?i danh s?ch nh?m thu?c.')
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
      else setFormError('Kh?ng th? t?i chi ti?t nh?m thu?c.')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    if (!form.name.trim()) {
      setFormError('T?n nh?m thu?c l? b?t bu?c.')
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
      } else if (form.id) {
        await catalogApi.updateDrugGroup(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Kh?ng th? l?u nh?m thu?c.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: DrugGroupItem) => {
    if (!accessToken || !canDelete) return

    if (!window.confirm(`X?a nh?m thu?c ${item.name}?`)) return

    try {
      await catalogApi.deleteDrugGroup(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Kh?ng th? x?a nh?m thu?c.')
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
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh m?c</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Nh?m thu?c</h2>
          <p className="mt-2 text-sm text-ink-600">Qu?n l? nh?m thu?c ph?c v? khai b?o s?n ph?m.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
        >
          Th?m nh?m
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">B?n ch? c? quy?n xem danh s?ch nh?m thu?c.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">T?ng nh?m thu?c</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">?ang ho?t ??ng</p>
          <p className="mt-2 text-2xl font-semibold text-brand-600">{summary.active}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Ng?ng ho?t ??ng</p>
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
            placeholder="T?m theo m? ho?c t?n nh?m thu?c"
          />

          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">T?t c? tr?ng th?i</option>
            <option value="active">?ang ho?t ??ng</option>
            <option value="inactive">Ng?ng ho?t ??ng</option>
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
            T?i l?i
          </button>
        </div>

        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">M? nh?m</th>
                <th className="px-6 py-4">T?n nh?m</th>
                <th className="px-6 py-4">M? t?</th>
                <th className="px-6 py-4">Tr?ng th?i</th>
                <th className="px-6 py-4">Thao t?c</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={5}>?ang t?i d? li?u...</td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={5}>Kh?ng c? d? li?u nh?m thu?c.</td>
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
                          {item.is_active ? '?ang ho?t ??ng' : 'Ng?ng ho?t ??ng'}
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
                            S?a
                          </button>
                          <button
                            type="button"
                            disabled={!canDelete}
                            onClick={() => void handleDelete(item)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                          >
                            X?a
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
          Hi?n th? {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} nh?m thu?c
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            Tr??c
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
                  {modalMode === 'create' ? 'Th?m nh?m thu?c' : 'C?p nh?t nh?m thu?c'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Th?ng tin nh?m thu?c'}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                ??ng
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {detailLoading ? <p className="text-sm text-ink-600">?ang t?i chi ti?t...</p> : null}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>M? nh?m</span>
                  <div className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-ink-700">
                    {form.code || 'T? ??ng sinh khi l?u'}
                  </div>
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>T?n nh?m thu?c *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>M? t?</span>
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
                  ?ang ho?t ??ng
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
                {formSubmitting ? '?ang l?u...' : 'L?u'}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
              >
                H?y
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
