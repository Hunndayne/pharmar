import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { catalogApi, type SupplierItem } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'

type StatusFilter = 'all' | 'active' | 'inactive'
type ModalMode = 'create' | 'edit'

type DistributorForm = {
  id?: string
  code: string
  name: string
  contactPerson: string
  phone: string
  email: string
  taxCode: string
  address: string
  note: string
  isActive: boolean
}

type DebtPaymentForm = {
  amount: string
  note: string
}

const TEXT = {
  category: 'Danh mục',
  title: 'Nhà phân phối',
  subtitle: 'Quản lý đối tác nhập hàng và công nợ nhà phân phối.',
  add: 'Thêm NPP',
  readOnly: 'Bạn chỉ có quyền xem danh sách nhà phân phối.',
  total: 'Tổng NPP',
  active: 'Đang hoạt động',
  inactive: 'Ngừng hoạt động',
  debt: 'Công nợ (trang hiện tại)',
  loading: 'Đang tải dữ liệu...',
  noData: 'Không có dữ liệu nhà phân phối.',
  detail: 'Chi tiết',
  hideDetail: 'Ẩn chi tiết',
  edit: 'Sửa',
  delete: 'Xóa',
  payDebt: 'Thanh toán nợ',
  reload: 'Tải lại',
  reset: 'Reset',
  prev: 'Trước',
  next: 'Sau',
  close: 'Đóng',
  cancel: 'Hủy',
  save: 'Lưu',
  saving: 'Đang lưu...',
  autoCode: 'Tự động sinh khi lưu',
  payDebtTitle: 'Thanh toán công nợ',
  confirm: 'Xác nhận',
  processing: 'Đang xử lý...',
  debtNow: 'Dư nợ hiện tại',
}

const emptyForm: DistributorForm = {
  code: '',
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  taxCode: '',
  address: '',
  note: '',
  isActive: true,
}

const emptyPaymentForm: DebtPaymentForm = {
  amount: '',
  note: '',
}

const pageSize = 10

const parseMoneyValue = (value: string | number | null | undefined) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const formatCurrency = (value: string | number | null | undefined) => {
  const amount = parseMoneyValue(value)
  return `${Math.round(amount).toLocaleString('vi-VN')}đ`
}

const tryDecodeUtf8FromLatin1 = (value: string) => {
  try {
    const bytes = Uint8Array.from(Array.from(value).map((char) => char.charCodeAt(0) & 0xff))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return value
  }
}

const normalizeText = (value: string | null | undefined) => {
  if (!value) return ''
  let current = value
  for (let index = 0; index < 2; index += 1) {
    const decoded = tryDecodeUtf8FromLatin1(current)
    if (decoded === current) break
    current = decoded
  }
  return current
}

const mapSupplierToForm = (item: SupplierItem): DistributorForm => ({
  id: item.id,
  code: normalizeText(item.code),
  name: normalizeText(item.name),
  contactPerson: normalizeText(item.contact_person ?? ''),
  phone: normalizeText(item.phone),
  email: normalizeText(item.email ?? ''),
  taxCode: normalizeText(item.tax_code ?? ''),
  address: normalizeText(item.address ?? ''),
  note: normalizeText(item.note ?? ''),
  isActive: item.is_active,
})

export function Distributors() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'
  const canDelete = isOwnerOrAdmin(user)

  const [rows, setRows] = useState<SupplierItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<DistributorForm>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  const [paymentTarget, setPaymentTarget] = useState<SupplierItem | null>(null)
  const [paymentForm, setPaymentForm] = useState<DebtPaymentForm>(emptyPaymentForm)
  const [paymentSubmitting, setPaymentSubmitting] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)

    try {
      const response = await catalogApi.listSuppliers(accessToken, {
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
      if (loadError instanceof ApiError) setError(normalizeText(loadError.message))
      else setError('Không thể tải danh sách nhà phân phối.')
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

  const openEdit = async (item: SupplierItem) => {
    if (!accessToken) return

    setModalMode('edit')
    setFormError(null)
    setModalOpen(true)
    setDetailLoading(true)
    setForm(mapSupplierToForm(item))

    try {
      const detail = await catalogApi.getSupplier(accessToken, item.id)
      setForm(mapSupplierToForm(detail))
    } catch (detailError) {
      if (detailError instanceof ApiError) setFormError(normalizeText(detailError.message))
      else setFormError('Không thể tải chi tiết nhà phân phối.')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return

    if (!form.name.trim()) {
      setFormError('Tên nhà phân phối là bắt buộc.')
      return
    }

    if (!form.phone.trim()) {
      setFormError('Số điện thoại là bắt buộc.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)

    try {
      const payload = {
        name: form.name.trim(),
        address: form.address.trim() || null,
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        tax_code: form.taxCode.trim() || null,
        contact_person: form.contactPerson.trim() || null,
        is_active: form.isActive,
        note: form.note.trim() || null,
      }

      if (modalMode === 'create') {
        await catalogApi.createSupplier(accessToken, payload)
      } else if (form.id) {
        await catalogApi.updateSupplier(accessToken, form.id, payload)
      }

      setModalOpen(false)
      await loadRows()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(normalizeText(saveError.message))
      else setFormError('Không thể lưu nhà phân phối.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: SupplierItem) => {
    if (!accessToken || !canDelete) return

    if (!window.confirm(`Xóa nhà phân phối ${normalizeText(item.name)}?`)) return

    try {
      await catalogApi.deleteSupplier(accessToken, item.id)
      await loadRows()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(normalizeText(deleteError.message))
      else setError('Không thể xóa nhà phân phối.')
    }
  }

  const openPayment = (item: SupplierItem) => {
    const debt = parseMoneyValue(item.current_debt)
    setPaymentTarget(item)
    setPaymentError(null)
    setPaymentForm({ amount: debt > 0 ? Math.round(debt).toString() : '', note: '' })
  }

  const handlePayDebt = async () => {
    if (!accessToken || !paymentTarget || !canManage) return

    const amount = Number(paymentForm.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentError('Số tiền thanh toán phải lớn hơn 0.')
      return
    }

    setPaymentSubmitting(true)
    setPaymentError(null)

    try {
      await catalogApi.paySupplierDebt(accessToken, paymentTarget.id, {
        amount,
        note: paymentForm.note.trim() || null,
      })

      setPaymentTarget(null)
      await loadRows()
    } catch (payError) {
      if (payError instanceof ApiError) setPaymentError(normalizeText(payError.message))
      else setPaymentError('Không thể thanh toán công nợ.')
    } finally {
      setPaymentSubmitting(false)
    }
  }

  const summary = useMemo(
    () => ({
      total,
      active: rows.filter((item) => item.is_active).length,
      inactive: rows.filter((item) => !item.is_active).length,
      debt: rows.reduce((sum, item) => sum + parseMoneyValue(item.current_debt), 0),
    }),
    [rows, total],
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">{TEXT.category}</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">{TEXT.title}</h2>
          <p className="mt-2 text-sm text-ink-600">{TEXT.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManage}
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
        >
          {TEXT.add}
        </button>
      </header>

      {!canManage ? <p className="text-sm text-amber-700">{TEXT.readOnly}</p> : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">{TEXT.total}</p>
          <p className="mt-2 text-3xl font-semibold text-ink-900">{summary.total}</p>
        </article>
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">{TEXT.active}</p>
          <p className="mt-2 text-3xl font-semibold text-brand-600">{summary.active}</p>
        </article>
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">{TEXT.inactive}</p>
          <p className="mt-2 text-3xl font-semibold text-ink-600">{summary.inactive}</p>
        </article>
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">{TEXT.debt}</p>
          <p className="mt-2 text-3xl font-semibold text-coral-500">{formatCurrency(summary.debt)}</p>
        </article>
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
            placeholder="Tìm theo mã, tên hoặc số điện thoại"
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
            <option value="active">{TEXT.active}</option>
            <option value="inactive">{TEXT.inactive}</option>
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
            {TEXT.reset}
          </button>

          <button
            type="button"
            onClick={() => void loadRows()}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            {TEXT.reload}
          </button>
        </div>

        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã NPP</th>
                <th className="px-6 py-4">Tên</th>
                <th className="px-6 py-4">Liên hệ NPP</th>
                <th className="px-6 py-4">SĐT</th>
                <th className="px-6 py-4">Công nợ</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>{TEXT.loading}</td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={7}>{TEXT.noData}</td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => {
                  const debt = parseMoneyValue(item.current_debt)
                  const supplierName = normalizeText(item.name)
                  const supplierContactPerson = normalizeText(item.contact_person || '-')
                  const supplierPhone = normalizeText(item.phone || '-')
                  const supplierEmail = normalizeText(item.email || '-')
                  const supplierTaxCode = normalizeText(item.tax_code || '-')
                  const supplierAddress = normalizeText(item.address || '-')
                  const supplierNote = normalizeText(item.note || '-')
                    return (
                      <Fragment key={item.id}>
                        <tr className="hover:bg-white/80">
                          <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                          <td className="px-6 py-4 text-ink-900">{supplierName}</td>
                          <td className="px-6 py-4 text-ink-700">{supplierContactPerson}</td>
                          <td className="px-6 py-4 text-ink-700">{supplierPhone}</td>
                          <td className="px-6 py-4 font-semibold text-coral-500">{formatCurrency(item.current_debt)}</td>
                          <td className="px-6 py-4">
                            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${item.is_active ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30' : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'}`}>
                              {item.is_active ? TEXT.active : TEXT.inactive}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                              >
                                {expandedId === item.id ? TEXT.hideDetail : TEXT.detail}
                              </button>
                              <button
                                type="button"
                                disabled={!canManage}
                                onClick={() => void openEdit(item)}
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                              >
                                {TEXT.edit}
                              </button>
                              <button
                                type="button"
                                disabled={!canManage || debt <= 0}
                                onClick={() => openPayment(item)}
                                className="rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-700 disabled:opacity-60"
                              >
                                {TEXT.payDebt}
                              </button>
                              <button
                                type="button"
                                disabled={!canDelete}
                                onClick={() => void handleDelete(item)}
                                className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                              >
                                {TEXT.delete}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {expandedId === item.id ? (
                          <tr>
                            <td colSpan={7} className="px-6 pb-6">
                              <div className="rounded-2xl bg-white p-4 text-sm text-ink-700">
                                <div className="grid gap-4 lg:grid-cols-2">
                                  <div className="space-y-2">
                                    <p><span className="font-semibold text-ink-900">Nhà phân phối:</span> {supplierName}</p>
                                    <p><span className="font-semibold text-ink-900">Liên hệ nhà phân phối:</span> {supplierContactPerson}</p>
                                    <p><span className="font-semibold text-ink-900">Số điện thoại:</span> {supplierPhone}</p>
                                    <p><span className="font-semibold text-ink-900">Email:</span> {supplierEmail}</p>
                                  </div>
                                  <div className="space-y-2">
                                    <p><span className="font-semibold text-ink-900">Mã số thuế:</span> {supplierTaxCode}</p>
                                    <p><span className="font-semibold text-ink-900">Địa chỉ:</span> {supplierAddress}</p>
                                    <p><span className="font-semibold text-ink-900">Ghi chú:</span> {supplierNote}</p>
                                    <p><span className="font-semibold text-ink-900">{TEXT.debtNow}:</span> <span className="text-coral-500">{formatCurrency(item.current_debt)}</span></p>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })
                : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} trong {total} nhà phân phối
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            {TEXT.prev}
          </button>
          <span>{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            {TEXT.next}
          </button>
        </div>
      </section>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Thêm nhà phân phối' : 'Cập nhật nhà phân phối'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thông tin nhà phân phối'}</h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                {TEXT.close}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {detailLoading ? <p className="text-sm text-ink-600">Đang tải chi tiết...</p> : null}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã NPP</span>
                  <div className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-ink-700">
                    {form.code || TEXT.autoCode}
                  </div>
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên nhà phân phối *</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  />
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Liên hệ nhà phân phối</span>
                  <input
                    value={form.contactPerson}
                    onChange={(event) => setForm((prev) => ({ ...prev, contactPerson: event.target.value }))}
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
                  <span>Mã số thuế</span>
                  <input
                    value={form.taxCode}
                    onChange={(event) => setForm((prev) => ({ ...prev, taxCode: event.target.value }))}
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

                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Ghi chú</span>
                  <textarea
                    rows={2}
                    value={form.note}
                    onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
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
                  {TEXT.active}
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
                {formSubmitting ? TEXT.saving : TEXT.save}
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
              >
                {TEXT.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {paymentTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-lg flex-col rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <p className="text-xs uppercase tracking-[0.3em] text-ink-600">{TEXT.payDebtTitle}</p>
              <h3 className="mt-2 text-xl font-semibold text-ink-900">{normalizeText(paymentTarget.name)}</h3>
              <p className="mt-1 text-sm text-ink-600">
                {TEXT.debtNow}: <span className="font-semibold text-coral-500">{formatCurrency(paymentTarget.current_debt)}</span>
              </p>
            </div>
            <div className="space-y-3 px-6 py-5">
              <label className="space-y-2 text-sm text-ink-700">
                <span>Số tiền thanh toán *</span>
                <input
                  type="number"
                  min="1"
                  step="1000"
                  value={paymentForm.amount}
                  onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>

              <label className="space-y-2 text-sm text-ink-700">
                <span>Ghi chú</span>
                <textarea
                  rows={2}
                  value={paymentForm.note}
                  onChange={(event) => setPaymentForm((prev) => ({ ...prev, note: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>

              {paymentError ? <p className="text-sm text-coral-500">{paymentError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void handlePayDebt()}
                disabled={paymentSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {paymentSubmitting ? TEXT.processing : TEXT.confirm}
              </button>
              <button
                type="button"
                onClick={() => setPaymentTarget(null)}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900"
              >
                {TEXT.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
