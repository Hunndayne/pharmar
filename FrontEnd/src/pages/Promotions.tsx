import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  customerApi,
  type PromotionDiscountType,
  type PromotionRecord,
  type TierConfigRecord,
} from '../api/customerService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { readLocalDraft, removeLocalDraft, writeLocalDraft } from '../utils/localDraft'

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
const PROMOTION_FORM_DRAFT_STORAGE_KEY = 'pharmar.promotions.form.draft.v1'

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

  if (!row.is_active) return { label: 'Tạm dừng', className: 'bg-ink-600/10 text-ink-600 border border-ink-600/20' }
  if (!Number.isNaN(end.getTime()) && end < today) {
    return { label: 'Hết hạn', className: 'bg-coral-500/10 text-coral-500 border border-coral-500/30' }
  }
  if (!Number.isNaN(start.getTime()) && start > today) {
    return { label: 'Sắp áp dụng', className: 'bg-amber-500/10 text-amber-700 border border-amber-500/30' }
  }
  return { label: 'Đang áp dụng', className: 'bg-brand-500/15 text-brand-600 border border-brand-500/30' }
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

  const loadCreateDraft = useCallback(() => {
    const draft = readLocalDraft<Partial<PromotionForm>>(PROMOTION_FORM_DRAFT_STORAGE_KEY)
    if (!draft) return emptyForm
    return {
      ...emptyForm,
      ...draft,
      id: undefined,
    }
  }, [])

  const clearCreateDraft = useCallback(() => {
    removeLocalDraft(PROMOTION_FORM_DRAFT_STORAGE_KEY)
  }, [])

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
      else setError('Không thể tải danh sách khuyến mãi.')
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
    setForm(loadCreateDraft())
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
      setFormError('Mã khuyến mãi là bắt buộc.')
      return
    }
    if (!name) {
      setFormError('Tên chương trình là bắt buộc.')
      return
    }
    if (discountValue === null || discountValue < 0) {
      setFormError('Giá trị giảm không hợp lệ.')
      return
    }
    if (form.discountType === 'percent' && discountValue > 100) {
      setFormError('Khuyến mãi phần trăm không được vượt quá 100%.')
      return
    }
    if (!form.startDate || !form.endDate) {
      setFormError('Cần nhập thời gian bắt đầu và kết thúc.')
      return
    }
    if (new Date(form.endDate).getTime() < new Date(form.startDate).getTime()) {
      setFormError('Ngày kết thúc phải lớn hơn hoặc bằng ngày bắt đầu.')
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
        clearCreateDraft()
      } else if (form.id) {
        await customerApi.updatePromotion(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu chương trình khuyến mãi.')
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
      else setError('Không thể cập nhật trạng thái khuyến mãi.')
    }
  }

  const handleDelete = async (item: PromotionRecord) => {
    if (!accessToken || !canDelete) return
    if (!window.confirm(`Xóa khuyến mãi ${item.code} - ${item.name}?`)) return

    try {
      await customerApi.deletePromotion(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa khuyến mãi.')
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

  useEffect(() => {
    if (!modalOpen || modalMode !== 'create') return
    writeLocalDraft(PROMOTION_FORM_DRAFT_STORAGE_KEY, form)
  }, [form, modalMode, modalOpen])

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
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Khuyến mãi</h2>
          <p className="mt-2 text-sm text-ink-600">Quản lý chương trình khuyến mãi từ Customer Service.</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="w-full rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60 sm:w-auto"
        >
          Tạo chương trình
        </button>
      </header>

      {!canManage ? (
        <p className="text-sm text-amber-700">Bạn không có quyền quản lý khuyến mãi.</p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tổng số chương trình</p>
          <p className="mt-2 text-2xl font-semibold">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Đang bật (trang này)</p>
          <p className="mt-2 text-2xl font-semibold text-brand-600">{summary.activeOnPage}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs text-ink-600">Tự áp dụng (trang này)</p>
          <p className="mt-2 text-2xl font-semibold text-ink-900">{summary.autoApplyOnPage}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-4 space-y-4 sm:p-6">
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
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang bật</option>
            <option value="inactive">Đã tắt</option>
          </select>

          <select
            value={autoApplyFilter}
            onChange={(event) => {
              setAutoApplyFilter(event.target.value as AutoApplyFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả kiểu áp dụng</option>
            <option value="auto">Tự áp dụng</option>
            <option value="manual">Áp dụng thủ công</option>
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
            Tải lại
          </button>
        </div>

        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="space-y-3 p-4 md:hidden">
          {loading ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-600">
              Đang tải dữ liệu...
            </div>
          ) : null}

          {!loading && rows.length === 0 ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-600">
              Không có dữ liệu khuyến mãi.
            </div>
          ) : null}

          {!loading
            ? rows.map((item) => {
                const status = getPromotionStatus(item)
                return (
                  <article key={item.id} className="rounded-2xl border border-ink-900/10 bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-ink-900">{item.code}</p>
                        <p className="text-sm text-ink-900">{item.name}</p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${status.className}`}>
                        {status.label}
                      </span>
                    </div>

                    <div className="mt-3 space-y-1 text-xs text-ink-700">
                      <p>Giảm giá: {formatDiscount(item)}</p>
                      <p>
                        Thời gian: {formatDate(item.start_date)} - {formatDate(item.end_date)}
                      </p>
                      <p>Đơn tối thiểu: {item.min_order_amount == null ? '-' : formatCurrency(item.min_order_amount)}</p>
                      <p>
                        Áp dụng: {item.auto_apply ? 'Tự động' : 'Thủ công'} | Lượt: {item.usage_limit ?? '-'} / Khách: {item.usage_per_customer ?? '-'}
                      </p>
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
                        Xóa
                      </button>
                    </div>
                  </article>
                )
              })
            : null}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[1140px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.24em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã / tên</th>
                <th className="px-6 py-4">Giảm giá</th>
                <th className="px-6 py-4">Thời gian</th>
                <th className="px-6 py-4">Điều kiện</th>
                <th className="px-6 py-4">Áp dụng</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>
                    Đang tải dữ liệu...
                  </td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>
                    Không có dữ liệu khuyến mãi.
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
                          <p>Đơn tối thiểu: {item.min_order_amount == null ? '-' : formatCurrency(item.min_order_amount)}</p>
                          <p className="mt-1 text-xs text-ink-600">
                            Giới hạn: {item.usage_limit ?? '-'} / Khách: {item.usage_per_customer ?? '-'}
                          </p>
                        </td>
                        <td className="px-6 py-4 text-ink-700">
                          <p className="mb-2 text-xs uppercase tracking-[0.16em] text-ink-500">
                            {item.auto_apply ? 'Tự áp dụng' : 'Thủ công'}
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
                              Sửa
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
                              Xóa
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

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} khuyến mãi
        </span>
        <div className="flex items-center gap-2 self-end sm:self-auto">
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
                  <span>Mã khuyến mãi *</span>
                  <input
                    value={form.code}
                    onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên chương trình *</span>
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
                    rows={2}
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Loại giảm *</span>
                  <select
                    value={form.discountType}
                    onChange={(event) => setForm((prev) => ({ ...prev, discountType: event.target.value as PromotionDiscountType }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  >
                    <option value="percent">Phần trăm (%)</option>
                    <option value="fixed">Số tiền cố định</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Giá trị giảm *</span>
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
                  <span>Giảm tối đa</span>
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
                  <span>Đơn tối thiểu</span>
                  <input
                    type="number"
                    min="0"
                    value={form.minOrderAmount}
                    onChange={(event) => setForm((prev) => ({ ...prev, minOrderAmount: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Bắt đầu *</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Kết thúc *</span>
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, endDate: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Giới hạn lượt dùng</span>
                  <input
                    type="number"
                    min="0"
                    value={form.usageLimit}
                    onChange={(event) => setForm((prev) => ({ ...prev, usageLimit: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Lượt dùng / khách</span>
                  <input
                    type="number"
                    min="0"
                    value={form.usagePerCustomer}
                    onChange={(event) => setForm((prev) => ({ ...prev, usagePerCustomer: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <div className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Áp dụng cho hạng thành viên</span>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {tiers.length === 0 ? (
                      <p className="text-xs text-ink-500">Không có dữ liệu hạng. Để trống sẽ áp dụng cho tất cả.</p>
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
                  Kích hoạt chương trình
                </label>
                <label className="flex items-center gap-3 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={form.autoApply}
                    onChange={(event) => setForm((prev) => ({ ...prev, autoApply: event.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Tự động áp dụng khi đủ điều kiện
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
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
