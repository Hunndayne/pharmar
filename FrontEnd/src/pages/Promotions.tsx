import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  customerApi,
  type PromotionDiscountType,
  type PromotionRecord,
  type TierConfigRecord,
} from '../api/customerService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type StatusFilter = 'all' | 'active' | 'inactive'
type AutoApplyFilter = 'all' | 'auto' | 'manual'
type ModalMode = 'create' | 'edit'

type PromotionForm = {
  id?: string
  code: string
  name: string
  description: string
  discountType: PromotionDiscountType
  discountValue: string
  maxDiscount: string
  minOrderAmount: string
  startDate: string
  endDate: string
  usageLimit: string
  usagePerCustomer: string
  isActive: boolean
  autoApply: boolean
  applicableTiers: string[]
}

const pageSize = 10

const emptyForm: PromotionForm = {
  code: '',
  name: '',
  description: '',
  discountType: 'percent',
  discountValue: '',
  maxDiscount: '',
  minOrderAmount: '',
  startDate: '',
  endDate: '',
  usageLimit: '',
  usagePerCustomer: '',
  isActive: true,
  autoApply: false,
  applicableTiers: [],
}

const toNumber = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatCurrency = (value: string | number | null | undefined) => {
  const parsed = toNumber(value)
  return `${parsed.toLocaleString('vi-VN')}d`
}

const formatDate = (value: string) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('vi-VN')
}

const formatDiscount = (row: PromotionRecord) => {
  const discount = toNumber(row.discount_value)
  if (row.discount_type === 'percent') {
    const maxText = row.max_discount != null ? ` (toi da ${formatCurrency(row.max_discount)})` : ''
    return `${discount}%${maxText}`
  }
  return formatCurrency(discount)
}

const parseOptionalNumber = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const parseOptionalInt = (value: string) => {
  const parsed = parseOptionalNumber(value)
  if (parsed === null) return null
  return Math.max(0, Math.trunc(parsed))
}

const getPromotionStatus = (row: PromotionRecord) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const start = new Date(row.start_date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(row.end_date)
  end.setHours(0, 0, 0, 0)

  if (!row.is_active) return { label: 'Tam dung', className: 'bg-ink-600/10 text-ink-600 border border-ink-600/20' }
  if (!Number.isNaN(end.getTime()) && end < today) {
    return { label: 'Het han', className: 'bg-coral-500/10 text-coral-500 border border-coral-500/30' }
  }
  if (!Number.isNaN(start.getTime()) && start > today) {
    return { label: 'Sap ap dung', className: 'bg-amber-500/10 text-amber-700 border border-amber-500/30' }
  }
  return { label: 'Dang ap dung', className: 'bg-brand-500/15 text-brand-600 border border-brand-500/30' }
}

const roleLabel = (value: string) => {
  const lower = value.toLowerCase()
  if (!lower) return value
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export function Promotions() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const role = user?.role ?? ''
  const isOwner = role === 'owner' || user?.username === 'admin'
  const canManage = isOwner || role === 'manager'
  const canDelete = isOwner

  const [rows, setRows] = useState<PromotionRecord[]>([])
  const [tiers, setTiers] = useState<TierConfigRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [autoApplyFilter, setAutoApplyFilter] = useState<AutoApplyFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<PromotionForm>(emptyForm)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const response = await customerApi.listPromotions(accessToken, {
        search: search.trim() || undefined,
        is_active: statusFilter === 'all' ? undefined : statusFilter === 'active',
        auto_apply: autoApplyFilter === 'all' ? undefined : autoApplyFilter === 'auto',
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
      else setError('Khong the tai danh sach khuyen mai.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, autoApplyFilter, page, search, statusFilter])

  const loadTiers = useCallback(async () => {
    if (!accessToken) return
    try {
      const response = await customerApi.listTiers(accessToken)
      setTiers(response)
    } catch {
      setTiers([])
    }
  }, [accessToken])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  useEffect(() => {
    void loadTiers()
  }, [loadTiers])

  const openCreate = () => {
    setModalMode('create')
    setForm(emptyForm)
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = (item: PromotionRecord) => {
    setModalMode('edit')
    setFormError(null)
    setForm({
      id: item.id,
      code: item.code,
      name: item.name,
      description: item.description ?? '',
      discountType: item.discount_type,
      discountValue: String(item.discount_value ?? ''),
      maxDiscount: item.max_discount == null ? '' : String(item.max_discount),
      minOrderAmount: item.min_order_amount == null ? '' : String(item.min_order_amount),
      startDate: item.start_date,
      endDate: item.end_date,
      usageLimit: item.usage_limit == null ? '' : String(item.usage_limit),
      usagePerCustomer: item.usage_per_customer == null ? '' : String(item.usage_per_customer),
      isActive: item.is_active,
      autoApply: item.auto_apply,
      applicableTiers: item.applicable_tiers ?? [],
    })
    setModalOpen(true)
  }

  const resetFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setAutoApplyFilter('all')
    setPage(1)
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    const code = form.code.trim().toUpperCase()
    const name = form.name.trim()
    const discountValue = parseOptionalNumber(form.discountValue)

    if (!code) {
      setFormError('Ma khuyen mai la bat buoc.')
      return
    }
    if (!name) {
      setFormError('Ten chuong trinh la bat buoc.')
      return
    }
    if (discountValue === null || discountValue < 0) {
      setFormError('Gia tri giam khong hop le.')
      return
    }
    if (form.discountType === 'percent' && discountValue > 100) {
      setFormError('Khuyen mai phan tram khong duoc vuot qua 100%.')
      return
    }
    if (!form.startDate || !form.endDate) {
      setFormError('Can nhap thoi gian bat dau va ket thuc.')
      return
    }
    if (new Date(form.endDate).getTime() < new Date(form.startDate).getTime()) {
      setFormError('Ngay ket thuc phai lon hon hoac bang ngay bat dau.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)

    try {
      const payload = {
        code,
        name,
        description: form.description.trim() || null,
        discount_type: form.discountType,
        discount_value: discountValue,
        max_discount: parseOptionalNumber(form.maxDiscount),
        min_order_amount: parseOptionalNumber(form.minOrderAmount),
        start_date: form.startDate,
        end_date: form.endDate,
        applicable_tiers: form.applicableTiers.length ? form.applicableTiers : null,
        usage_limit: parseOptionalInt(form.usageLimit),
        usage_per_customer: parseOptionalInt(form.usagePerCustomer),
        is_active: form.isActive,
        auto_apply: form.autoApply,
      }

      if (modalMode === 'create') {
        await customerApi.createPromotion(accessToken, payload)
      } else if (form.id) {
        await customerApi.updatePromotion(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Khong the luu chuong trinh khuyen mai.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleToggleStatus = async (item: PromotionRecord) => {
    if (!accessToken || !canManage) return

    try {
      await customerApi.updatePromotion(accessToken, item.id, { is_active: !item.is_active })
      await loadRows()
    } catch (toggleError) {
      if (toggleError instanceof ApiError) setError(toggleError.message)
      else setError('Khong the cap nhat trang thai khuyen mai.')
    }
  }

  const handleDelete = async (item: PromotionRecord) => {
    if (!accessToken || !canDelete) return
    if (!window.confirm(`Xoa khuyen mai ${item.code} - ${item.name}?`)) return

    try {
      await customerApi.deletePromotion(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Khong the xoa khuyen mai.')
    }
  }

  const summary = useMemo(
    () => ({
      total,
      activeOnPage: rows.filter((item) => item.is_active).length,
      autoApplyOnPage: rows.filter((item) => item.auto_apply).length,
    }),
    [rows, total],
  )

  const renderTierBadges = (applicableTiers: string[] | null) => {
    if (!applicableTiers || applicableTiers.length === 0) {
      return <span className="text-xs text-ink-500">Tat ca hang</span>
    }

    return (
      <div className="flex flex-wrap gap-1">
        {applicableTiers.slice(0, 3).map((tier) => (
          <span key={tier} className="rounded-full bg-fog-100 px-2 py-0.5 text-[11px] font-semibold text-ink-700">
            {roleLabel(tier)}
          </span>
        ))}
        {applicableTiers.length > 3 ? (
          <span className="rounded-full bg-fog-100 px-2 py-0.5 text-[11px] font-semibold text-ink-700">
            +{applicableTiers.length - 3}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Marketing</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Khuyen mai</h2>
          <p className="mt-2 text-sm text-ink-600">Quan ly chuong trinh khuyen mai tu Customer Service.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
        >
          Tao chuong trinh
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">Ban chi co quyen xem danh sach khuyen mai.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tong chuong trinh</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Dang bat (trang nay)</p>
          <p className="mt-2 text-2xl font-semibold text-brand-600">{summary.activeOnPage}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tu ap dung (trang nay)</p>
          <p className="mt-2 text-2xl font-semibold text-ink-900">{summary.autoApplyOnPage}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tim theo ma hoac ten chuong trinh"
          />

          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tat ca trang thai</option>
            <option value="active">Dang bat</option>
            <option value="inactive">Da tat</option>
          </select>

          <select
            value={autoApplyFilter}
            onChange={(event) => {
              setAutoApplyFilter(event.target.value as AutoApplyFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tat ca kieu ap dung</option>
            <option value="auto">Tu ap dung</option>
            <option value="manual">Ap dung thu cong</option>
          </select>

          <button
            type="button"
            onClick={resetFilters}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() => void loadRows()}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Tai lai
          </button>
        </div>

        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="min-w-[1140px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.24em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Ma / Ten</th>
                <th className="px-6 py-4">Giam gia</th>
                <th className="px-6 py-4">Thoi gian</th>
                <th className="px-6 py-4">Dieu kien</th>
                <th className="px-6 py-4">Ap dung</th>
                <th className="px-6 py-4">Trang thai</th>
                <th className="px-6 py-4">Thao tac</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>
                    Dang tai du lieu...
                  </td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>
                    Khong co du lieu khuyen mai.
                  </td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => {
                    const status = getPromotionStatus(item)
                    return (
                      <tr key={item.id} className="hover:bg-white/80">
                        <td className="px-6 py-4 text-ink-900">
                          <p className="font-semibold">{item.code}</p>
                          <p className="mt-1">{item.name}</p>
                          {item.description ? <p className="mt-1 text-xs text-ink-600">{item.description}</p> : null}
                        </td>
                        <td className="px-6 py-4 text-ink-700">{formatDiscount(item)}</td>
                        <td className="px-6 py-4 text-ink-700">
                          {formatDate(item.start_date)} - {formatDate(item.end_date)}
                        </td>
                        <td className="px-6 py-4 text-ink-700">
                          <p>Don toi thieu: {item.min_order_amount == null ? '-' : formatCurrency(item.min_order_amount)}</p>
                          <p className="mt-1 text-xs text-ink-600">
                            Gioi han: {item.usage_limit ?? '-'} / Khach: {item.usage_per_customer ?? '-'}
                          </p>
                        </td>
                        <td className="px-6 py-4 text-ink-700">
                          <p className="mb-2 text-xs uppercase tracking-[0.16em] text-ink-500">
                            {item.auto_apply ? 'Tu ap dung' : 'Thu cong'}
                          </p>
                          {renderTierBadges(item.applicable_tiers)}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.className}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={!canManage}
                              onClick={() => openEdit(item)}
                              className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                            >
                              Sua
                            </button>
                            <button
                              type="button"
                              disabled={!canManage}
                              onClick={() => void handleToggleStatus(item)}
                              className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                            >
                              {item.is_active ? 'Tam dung' : 'Kich hoat'}
                            </button>
                            <button
                              type="button"
                              disabled={!canDelete}
                              onClick={() => void handleDelete(item)}
                              className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                            >
                              Xoa
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>
          Hien thi {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} khuyen mai
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
          >
            Truoc
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
          <div className="flex w-full max-w-4xl max-h-[92vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Tao khuyen mai' : 'Chinh sua khuyen mai'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thong tin chuong trinh'}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Dong
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ma khuyen mai *</span>
                  <input
                    value={form.code}
                    onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ten chuong trinh *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Mo ta</span>
                  <textarea
                    value={form.description}
                    onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    rows={2}
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Loai giam *</span>
                  <select
                    value={form.discountType}
                    onChange={(event) => setForm((prev) => ({ ...prev, discountType: event.target.value as PromotionDiscountType }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  >
                    <option value="percent">Phan tram (%)</option>
                    <option value="fixed">So tien co dinh</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Gia tri giam *</span>
                  <input
                    type="number"
                    min="0"
                    value={form.discountValue}
                    onChange={(event) => setForm((prev) => ({ ...prev, discountValue: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder={form.discountType === 'percent' ? 'Vi du: 20' : 'Vi du: 50000'}
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Giam toi da</span>
                  <input
                    type="number"
                    min="0"
                    value={form.maxDiscount}
                    onChange={(event) => setForm((prev) => ({ ...prev, maxDiscount: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Khong gioi han neu de trong"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Don toi thieu</span>
                  <input
                    type="number"
                    min="0"
                    value={form.minOrderAmount}
                    onChange={(event) => setForm((prev) => ({ ...prev, minOrderAmount: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Bat dau *</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ket thuc *</span>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, endDate: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Gioi han luot dung</span>
                  <input
                    type="number"
                    min="0"
                    value={form.usageLimit}
                    onChange={(event) => setForm((prev) => ({ ...prev, usageLimit: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Luot dung / khach</span>
                  <input
                    type="number"
                    min="0"
                    value={form.usagePerCustomer}
                    onChange={(event) => setForm((prev) => ({ ...prev, usagePerCustomer: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <div className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Ap dung cho hang thanh vien</span>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {tiers.length === 0 ? (
                      <p className="text-xs text-ink-500">Khong co du lieu hang. De trong se ap dung cho tat ca.</p>
                    ) : (
                      tiers.map((tier) => {
                        const checked = form.applicableTiers.includes(tier.tier_name)
                        return (
                          <label key={tier.tier_name} className="flex items-center gap-2 rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setForm((prev) => {
                                  const next = new Set(prev.applicableTiers)
                                  if (event.target.checked) next.add(tier.tier_name)
                                  else next.delete(tier.tier_name)
                                  return { ...prev, applicableTiers: Array.from(next) }
                                })
                              }}
                              className="h-4 w-4 rounded border-ink-900/20"
                            />
                            <span>{roleLabel(tier.tier_name)}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </div>

                <label className="flex items-center gap-3 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Kich hoat chuong trinh
                </label>
                <label className="flex items-center gap-3 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={form.autoApply}
                    onChange={(event) => setForm((prev) => ({ ...prev, autoApply: event.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Tu dong ap dung khi du dieu kien
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
                {formSubmitting ? 'Dang luu...' : 'Luu'}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
              >
                Huy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
