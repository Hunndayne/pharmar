import { useCallback, useEffect, useRef, useState } from 'react'
import {
  catalogApi,
  type PrescriptionTemplate,
  type PrescriptionTemplateItemPayload,
  type ProductDetailItem,
  type ProductListItem,
} from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type ModalMode = 'create' | 'edit'

type FormItem = {
  product_unit_id: string
  product_name: string
  unit_name: string
  quantity: number
  sort_order: number
}

type Form = {
  id?: string
  name: string
  description: string
  isActive: boolean
  items: FormItem[]
}

const emptyForm: Form = {
  name: '',
  description: '',
  isActive: true,
  items: [],
}

const pageSize = 10

export function PrescriptionTemplates() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [rows, setRows] = useState<PrescriptionTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<Form>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)

  const [pickerSearch, setPickerSearch] = useState('')
  const [pickerResults, setPickerResults] = useState<ProductListItem[]>([])
  const [pickerSearching, setPickerSearching] = useState(false)
  const [pickerSelected, setPickerSelected] = useState<ProductDetailItem | null>(null)
  const [pickerUnitId, setPickerUnitId] = useState('')
  const [pickerQty, setPickerQty] = useState('1')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const pickerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadRows = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const res = await catalogApi.listPrescriptionTemplates(accessToken, {
        search: search.trim() || undefined,
        is_active: statusFilter === 'all' ? undefined : statusFilter === 'active',
        page,
        size: pageSize,
      })
      setRows(res.items)
      setTotal(res.total)
      setTotalPages(Math.max(1, res.pages))
      if (res.pages > 0 && page > res.pages) setPage(res.pages)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không thể tải danh sách đơn thuốc mẫu.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, search, statusFilter, page])

  useEffect(() => { void loadRows() }, [loadRows])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const openCreate = () => {
    setModalMode('create')
    setForm(emptyForm)
    setFormError(null)
    resetPicker()
    setModalOpen(true)
  }

  const openEdit = (item: PrescriptionTemplate) => {
    setModalMode('edit')
    setFormError(null)
    resetPicker()
    setForm({
      id: item.id,
      name: item.name,
      description: item.description ?? '',
      isActive: item.is_active,
      items: item.items.map((it, idx) => ({
        product_unit_id: it.product_unit_id,
        product_name: it.product_name,
        unit_name: it.unit_name,
        quantity: it.quantity,
        sort_order: it.sort_order ?? idx,
      })),
    })
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!accessToken || !canManage) return
    if (!form.name.trim()) { setFormError('Tên đơn thuốc mẫu là bắt buộc.'); return }
    if (form.items.length === 0) { setFormError('Đơn thuốc mẫu phải có ít nhất một loại thuốc.'); return }

    setFormSubmitting(true)
    setFormError(null)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        is_active: form.isActive,
        items: form.items.map((item, idx): PrescriptionTemplateItemPayload => ({
          product_unit_id: item.product_unit_id,
          quantity: item.quantity,
          sort_order: idx,
        })),
      }
      if (modalMode === 'create') {
        await catalogApi.createPrescriptionTemplate(accessToken, payload)
      } else if (form.id) {
        await catalogApi.updatePrescriptionTemplate(accessToken, form.id, payload)
      }
      setModalOpen(false)
      await loadRows()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Không thể lưu đơn thuốc mẫu.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const handleDelete = async (item: PrescriptionTemplate) => {
    if (!accessToken || !canManage) return
    if (!window.confirm(`Vô hiệu hóa đơn thuốc mẫu "${item.name}"?`)) return
    try {
      await catalogApi.deletePrescriptionTemplate(accessToken, item.id)
      await loadRows()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Không thể xóa đơn thuốc mẫu.')
    }
  }

  const resetPicker = () => {
    setPickerSearch('')
    setPickerResults([])
    setPickerSelected(null)
    setPickerUnitId('')
    setPickerQty('1')
    setPickerOpen(false)
  }

  const handlePickerSearchChange = (value: string) => {
    setPickerSearch(value)
    setPickerSelected(null)
    setPickerUnitId('')
    if (pickerSearchTimer.current) clearTimeout(pickerSearchTimer.current)
    if (!value.trim()) { setPickerResults([]); setPickerOpen(false); return }
    pickerSearchTimer.current = setTimeout(async () => {
      setPickerSearching(true)
      try {
        const res = await catalogApi.listProducts(accessToken, { search: value.trim(), is_active: true, size: 8 })
        setPickerResults(res.items)
        setPickerOpen(true)
      } catch {
        setPickerResults([])
      } finally {
        setPickerSearching(false)
      }
    }, 300)
  }

  const handlePickerSelect = async (product: ProductListItem) => {
    setPickerOpen(false)
    setPickerSearch(product.name)
    try {
      const detail = await catalogApi.getProduct(accessToken, product.id)
      const retailUnits = detail.units.filter((u) => u.conversion_rate === 1 && u.is_active)
      setPickerSelected(detail)
      setPickerUnitId(retailUnits[0]?.id ?? '')
    } catch {
      setPickerSelected(null)
    }
  }

  const handleAddItem = () => {
    if (!pickerSelected || !pickerUnitId) return
    const qty = Math.max(1, parseInt(pickerQty, 10) || 1)
    const unit = pickerSelected.units.find((u) => u.id === pickerUnitId)
    if (!unit) return
    if (form.items.some((i) => i.product_unit_id === pickerUnitId)) {
      setFormError(`"${pickerSelected.name} (${unit.unit_name})" đã có trong đơn thuốc mẫu.`)
      return
    }
    setFormError(null)
    setForm((prev) => ({
      ...prev,
      items: [...prev.items, {
        product_unit_id: pickerUnitId,
        product_name: pickerSelected!.name,
        unit_name: unit.unit_name,
        quantity: qty,
        sort_order: prev.items.length,
      }],
    }))
    resetPicker()
  }

  const handleRemoveItem = (idx: number) => {
    setForm((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }))
  }

  const handleItemQtyChange = (idx: number, value: string) => {
    const qty = Math.max(1, parseInt(value, 10) || 1)
    setForm((prev) => ({ ...prev, items: prev.items.map((item, i) => i === idx ? { ...item, quantity: qty } : item) }))
  }

  const retailUnits = pickerSelected
    ? pickerSelected.units.filter((u) => u.conversion_rate === 1 && u.is_active)
    : []

  const start = rows.length === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Page header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-1.5 text-2xl font-semibold text-ink-900 sm:text-3xl">Đơn thuốc mẫu</h2>
          <p className="mt-1 text-xs text-ink-600 sm:text-sm">
            Bộ thuốc cố định theo bệnh — áp dụng nhanh khi bán hàng (tắt bán theo lô).
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            className="shrink-0 rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-lift sm:px-5"
          >
            + Tạo đơn mẫu
          </button>
        )}
      </header>

      {/* Filters */}
      <section className="glass-card rounded-2xl p-4 space-y-3 sm:rounded-3xl sm:p-6">
        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="min-w-0 flex-1 rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm sm:rounded-2xl sm:px-4"
            placeholder="Tìm tên hoặc mã đơn mẫu"
          />
          <button
            type="button"
            onClick={() => void loadRows()}
            className="shrink-0 rounded-xl border border-ink-900/10 bg-ink-900 px-3 py-2 text-sm font-semibold text-white sm:rounded-2xl sm:px-4"
          >
            Tải lại
          </button>
        </div>
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1) }}
            className="min-w-0 flex-1 rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm sm:rounded-2xl sm:px-4"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang hoạt động</option>
            <option value="inactive">Ngừng hoạt động</option>
          </select>
          <button
            type="button"
            onClick={() => { setSearch(''); setStatusFilter('active'); setPage(1) }}
            className="shrink-0 rounded-xl border border-ink-900/10 bg-white/80 px-3 py-2 text-sm font-semibold text-ink-900 sm:rounded-2xl sm:px-4"
          >
            Reset
          </button>
        </div>
        {error && <p className="text-sm text-coral-500">{error}</p>}
      </section>

      {/* List — card view on mobile, table on desktop */}
      {loading && (
        <p className="py-6 text-center text-sm text-ink-600">Đang tải...</p>
      )}
      {!loading && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-ink-600">Không có đơn thuốc mẫu.</p>
      )}

      {!loading && rows.length > 0 && (
        <>
          {/* Mobile: card list */}
          <div className="space-y-3 md:hidden">
            {rows.map((item) => (
              <div key={item.id} className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-ink-500">{item.code}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          item.is_active
                            ? 'bg-brand-500/15 text-brand-600 border border-brand-500/30'
                            : 'bg-ink-600/10 text-ink-600 border border-ink-600/20'
                        }`}
                      >
                        {item.is_active ? 'Hoạt động' : 'Ngừng'}
                      </span>
                    </div>
                    <p className="mt-1 font-semibold text-ink-900">{item.name}</p>
                    {item.description && (
                      <p className="mt-0.5 text-xs text-ink-600 line-clamp-2">{item.description}</p>
                    )}
                    <p className="mt-1.5 text-xs text-ink-500">{item.items.length} loại thuốc</p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                      >
                        Vô hiệu
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <section className="hidden overflow-hidden rounded-3xl border border-white/60 bg-white/70 md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                <tr>
                  <th className="px-6 py-4">Mã</th>
                  <th className="px-6 py-4">Tên đơn mẫu</th>
                  <th className="px-6 py-4">Mô tả</th>
                  <th className="px-6 py-4">Số loại thuốc</th>
                  <th className="px-6 py-4">Trạng thái</th>
                  {canManage && <th className="px-6 py-4">Thao tác</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/70">
                {rows.map((item) => (
                  <tr key={item.id} className="hover:bg-white/80">
                    <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                    <td className="px-6 py-4 text-ink-900">{item.name}</td>
                    <td className="px-6 py-4 text-ink-600">{item.description || '-'}</td>
                    <td className="px-6 py-4 text-ink-900">{item.items.length} loại</td>
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
                    {canManage && (
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => openEdit(item)}
                            className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            Sửa
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(item)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                          >
                            Vô hiệu
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {/* Pagination */}
      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span className="text-xs sm:text-sm">
          {start}–{end} / {total} đơn mẫu
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            Trước
          </button>
          <span className="text-xs">{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
          >
            Sau
          </button>
        </div>
      </section>

      {/* Modal — full screen on mobile, centered dialog on desktop */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white sm:items-center sm:justify-center sm:bg-ink-900/40 sm:p-4">
          <div className="flex h-full w-full flex-col overflow-hidden sm:h-auto sm:max-h-[92vh] sm:max-w-xl sm:rounded-3xl sm:shadow-lift">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-ink-900/10 bg-white px-4 py-4 sm:px-6 sm:py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Tạo đơn thuốc mẫu' : 'Cập nhật đơn thuốc mẫu'}
                </p>
                <h3 className="mt-1 text-lg font-semibold text-ink-900 sm:mt-2 sm:text-2xl">
                  {form.name || 'Thông tin đơn mẫu'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 p-2 text-ink-900 sm:px-4 sm:py-2 sm:text-sm sm:font-semibold"
                aria-label="Đóng"
              >
                <span className="hidden sm:inline text-sm font-semibold">Đóng</span>
                <svg className="h-5 w-5 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto bg-white px-4 py-4 sm:px-6 sm:py-5" style={{ WebkitOverflowScrolling: 'touch' }}>
              <div className="space-y-5">
                {/* Basic info */}
                <div className="space-y-3">
                  <label className="block space-y-1 text-sm text-ink-700">
                    <span>Tên đơn mẫu *</span>
                    <input
                      value={form.name}
                      onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-4 py-2.5 text-base sm:rounded-2xl sm:text-sm"
                      placeholder="Ví dụ: Thuốc cảm sốt"
                      autoComplete="off"
                    />
                  </label>

                  <label className="block space-y-1 text-sm text-ink-700">
                    <span>Mô tả</span>
                    <input
                      value={form.description}
                      onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-4 py-2.5 text-base sm:rounded-2xl sm:text-sm"
                      placeholder="Ghi chú ngắn"
                      autoComplete="off"
                    />
                  </label>

                  <label className="flex items-center gap-3 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                      className="h-5 w-5 rounded border-ink-900/20 sm:h-4 sm:w-4"
                    />
                    Đang hoạt động
                  </label>
                </div>

                {/* Drug picker */}
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-ink-900">Thêm thuốc vào đơn mẫu</p>
                  <div className="rounded-xl border border-ink-900/10 bg-fog-50 p-3 space-y-3 sm:rounded-2xl sm:p-4">
                    {/* Search */}
                    <div className="relative" ref={pickerRef}>
                      <input
                        value={pickerSearch}
                        onChange={(e) => handlePickerSearchChange(e.target.value)}
                        onFocus={() => pickerResults.length > 0 && setPickerOpen(true)}
                        className="w-full rounded-xl border border-ink-900/10 bg-white px-4 py-2.5 text-base sm:text-sm"
                        placeholder="Tìm thuốc theo tên hoặc mã..."
                        autoComplete="off"
                      />
                      {pickerSearching && (
                        <span className="absolute right-3 top-3 text-xs text-ink-500">Đang tìm...</span>
                      )}
                      {pickerOpen && pickerResults.length > 0 && (
                        <ul className="absolute z-10 mt-1 w-full rounded-2xl border border-ink-900/10 bg-white shadow-lift max-h-52 overflow-y-auto">
                          {pickerResults.map((p) => (
                            <li key={p.id}>
                              <button
                                type="button"
                                className="w-full px-4 py-3 text-left hover:bg-fog-50 active:bg-fog-100"
                                onClick={() => void handlePickerSelect(p)}
                              >
                                <span className="block font-semibold text-ink-900 text-sm">{p.name}</span>
                                <span className="text-xs text-ink-500">{p.code}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Unit + qty */}
                    {pickerSelected && (
                      retailUnits.length === 0 ? (
                        <p className="text-sm text-coral-500">
                          Thuốc này không có đơn vị lẻ. Không thể thêm vào đơn mẫu.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-sm text-ink-700">
                              <span>Đơn vị</span>
                              <select
                                value={pickerUnitId}
                                onChange={(e) => setPickerUnitId(e.target.value)}
                                className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2.5 text-base sm:text-sm"
                              >
                                {retailUnits.map((u) => (
                                  <option key={u.id} value={u.id}>{u.unit_name}</option>
                                ))}
                              </select>
                            </label>
                            <label className="space-y-1 text-sm text-ink-700">
                              <span>Số lượng</span>
                              <input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={pickerQty}
                                onChange={(e) => setPickerQty(e.target.value)}
                                className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2.5 text-base sm:text-sm"
                              />
                            </label>
                          </div>
                          <button
                            type="button"
                            onClick={handleAddItem}
                            disabled={!pickerUnitId}
                            className="w-full rounded-xl bg-ink-900 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto sm:px-5"
                          >
                            Thêm vào đơn
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* Items list */}
                {form.items.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-ink-900">
                      Danh sách thuốc ({form.items.length} loại)
                    </p>
                    <div className="space-y-2">
                      {form.items.map((item, idx) => (
                        <div key={item.product_unit_id} className="flex items-center gap-3 rounded-xl border border-ink-900/10 bg-white px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink-900">{item.product_name}</p>
                            <p className="text-xs text-ink-500">{item.unit_name}</p>
                          </div>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={item.quantity}
                            onChange={(e) => handleItemQtyChange(idx, e.target.value)}
                            className="w-16 rounded-lg border border-ink-900/10 bg-white px-2 py-1.5 text-center text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(idx)}
                            className="shrink-0 text-coral-500 active:text-coral-700"
                            aria-label="Xóa"
                          >
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {formError && <p className="rounded-xl bg-coral-50 px-4 py-3 text-sm text-coral-600">{formError}</p>}
              </div>
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-ink-900/10 bg-white px-4 py-4 sm:px-6">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={formSubmitting}
                  className="flex-1 rounded-xl bg-ink-900 py-3 text-sm font-semibold text-white shadow-lift disabled:opacity-60 sm:flex-none sm:rounded-full sm:px-6 sm:py-2"
                >
                  {formSubmitting ? 'Đang lưu...' : 'Lưu đơn mẫu'}
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="flex-1 rounded-xl border border-ink-900/10 bg-white/80 py-3 text-sm font-semibold text-ink-900 sm:flex-none sm:rounded-full sm:px-6 sm:py-2"
                >
                  Hủy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
