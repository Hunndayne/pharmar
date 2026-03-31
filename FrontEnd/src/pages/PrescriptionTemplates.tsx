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

  // List state
  const [rows, setRows] = useState<PrescriptionTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>('create')
  const [form, setForm] = useState<Form>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)

  // Drug picker state (inside modal)
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

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  // Close picker dropdown on outside click
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

  const openEdit = async (item: PrescriptionTemplate) => {
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
    if (!form.name.trim()) {
      setFormError('Tên đơn thuốc mẫu là bắt buộc.')
      return
    }
    if (form.items.length === 0) {
      setFormError('Đơn thuốc mẫu phải có ít nhất một loại thuốc.')
      return
    }

    setFormSubmitting(true)
    setFormError(null)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        is_active: form.isActive,
        items: form.items.map(
          (item, idx): PrescriptionTemplateItemPayload => ({
            product_unit_id: item.product_unit_id,
            quantity: item.quantity,
            sort_order: idx,
          }),
        ),
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

  // Drug picker helpers
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
    if (!value.trim()) {
      setPickerResults([])
      setPickerOpen(false)
      return
    }
    pickerSearchTimer.current = setTimeout(async () => {
      setPickerSearching(true)
      try {
        const res = await catalogApi.listProducts(accessToken, {
          search: value.trim(),
          is_active: true,
          size: 8,
        })
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

    // Prevent duplicate unit
    if (form.items.some((i) => i.product_unit_id === pickerUnitId)) {
      setFormError(`"${pickerSelected.name} (${unit.unit_name})" đã có trong đơn thuốc mẫu.`)
      return
    }

    setFormError(null)
    setForm((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          product_unit_id: pickerUnitId,
          product_name: pickerSelected!.name,
          unit_name: unit.unit_name,
          quantity: qty,
          sort_order: prev.items.length,
        },
      ],
    }))
    resetPicker()
  }

  const handleRemoveItem = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== idx),
    }))
  }

  const handleItemQtyChange = (idx: number, value: string) => {
    const qty = Math.max(1, parseInt(value, 10) || 1)
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, i) => (i === idx ? { ...item, quantity: qty } : item)),
    }))
  }

  const retailUnits = pickerSelected
    ? pickerSelected.units.filter((u) => u.conversion_rate === 1 && u.is_active)
    : []

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Đơn thuốc mẫu</h2>
          <p className="mt-2 text-sm text-ink-600">
            Tạo bộ thuốc cố định theo bệnh để áp dụng nhanh khi bán hàng (chỉ dùng khi tắt bán theo lô).
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift"
          >
            Tạo đơn mẫu
          </button>
        )}
      </header>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tìm theo tên hoặc mã đơn mẫu"
          />
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1) }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang hoạt động</option>
            <option value="inactive">Ngừng hoạt động</option>
          </select>
          <button
            type="button"
            onClick={() => { setSearch(''); setStatusFilter('active'); setPage(1) }}
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
        {error && <p className="text-sm text-coral-500">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã</th>
                <th className="px-6 py-4">Tên đơn mẫu</th>
                <th className="px-6 py-4">Mô tả</th>
                <th className="px-6 py-4">Số loại thuốc</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading && (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={6}>Đang tải...</td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={6}>Không có đơn thuốc mẫu.</td>
                </tr>
              )}
              {!loading && rows.map((item) => (
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
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {canManage && (
                        <>
                          <button
                            type="button"
                            onClick={() => void openEdit(item)}
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
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>
          Hiển thị {rows.length === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} trong {total} đơn mẫu
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
          <span>{page}/{totalPages}</span>
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

      {/* Create / Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {modalMode === 'create' ? 'Tạo đơn thuốc mẫu' : 'Cập nhật đơn thuốc mẫu'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">
                  {form.name || 'Thông tin đơn mẫu'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* Basic info */}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 text-sm text-ink-700">
                  <span>Tên đơn mẫu *</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Ví dụ: Thuốc cảm sốt"
                  />
                </label>

                <label className="flex items-center gap-3 text-sm text-ink-700 self-end pb-2">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                    className="h-4 w-4 rounded border-ink-900/20"
                  />
                  Đang hoạt động
                </label>

                <label className="space-y-1 text-sm text-ink-700 md:col-span-2">
                  <span>Mô tả</span>
                  <input
                    value={form.description}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Ghi chú ngắn về đơn thuốc mẫu này"
                  />
                </label>
              </div>

              {/* Drug picker */}
              <div className="space-y-2">
                <p className="text-sm font-semibold text-ink-900">Thêm thuốc vào đơn mẫu</p>
                <div className="rounded-2xl border border-ink-900/10 bg-fog-50 p-4 space-y-3">
                  {/* Search */}
                  <div className="relative" ref={pickerRef}>
                    <input
                      value={pickerSearch}
                      onChange={(e) => handlePickerSearchChange(e.target.value)}
                      onFocus={() => pickerResults.length > 0 && setPickerOpen(true)}
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                      placeholder="Tìm thuốc theo tên hoặc mã..."
                    />
                    {pickerSearching && (
                      <span className="absolute right-3 top-2 text-xs text-ink-600">Đang tìm...</span>
                    )}
                    {pickerOpen && pickerResults.length > 0 && (
                      <ul className="absolute z-10 mt-1 w-full rounded-2xl border border-ink-900/10 bg-white shadow-lift max-h-52 overflow-y-auto">
                        {pickerResults.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              className="w-full px-4 py-2.5 text-left text-sm hover:bg-fog-50"
                              onClick={() => void handlePickerSelect(p)}
                            >
                              <span className="font-semibold text-ink-900">{p.name}</span>
                              <span className="ml-2 text-xs text-ink-600">{p.code}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Unit + qty selector */}
                  {pickerSelected && (
                    <div className="flex flex-wrap gap-2 items-end">
                      {retailUnits.length === 0 ? (
                        <p className="text-sm text-coral-500">
                          Thuốc này không có đơn vị lẻ (conversion = 1). Không thể thêm vào đơn mẫu.
                        </p>
                      ) : (
                        <>
                          <label className="space-y-1 text-sm text-ink-700 flex-1 min-w-[120px]">
                            <span>Đơn vị</span>
                            <select
                              value={pickerUnitId}
                              onChange={(e) => setPickerUnitId(e.target.value)}
                              className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                            >
                              {retailUnits.map((u) => (
                                <option key={u.id} value={u.id}>{u.unit_name}</option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1 text-sm text-ink-700 w-24">
                            <span>Số lượng</span>
                            <input
                              type="number"
                              min={1}
                              value={pickerQty}
                              onChange={(e) => setPickerQty(e.target.value)}
                              className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={handleAddItem}
                            disabled={!pickerUnitId}
                            className="rounded-xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                          >
                            Thêm
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Items list */}
              {form.items.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-ink-900">
                    Danh sách thuốc trong đơn ({form.items.length} loại)
                  </p>
                  <div className="rounded-2xl overflow-hidden border border-ink-900/10">
                    <table className="w-full text-sm">
                      <thead className="bg-ink-900/5 text-xs uppercase tracking-wider text-ink-600">
                        <tr>
                          <th className="px-4 py-3 text-left">Thuốc</th>
                          <th className="px-4 py-3 text-left">Đơn vị</th>
                          <th className="px-4 py-3 text-center w-24">Số lượng</th>
                          <th className="px-4 py-3 w-12"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-900/5">
                        {form.items.map((item, idx) => (
                          <tr key={item.product_unit_id} className="bg-white">
                            <td className="px-4 py-3 font-medium text-ink-900">{item.product_name}</td>
                            <td className="px-4 py-3 text-ink-600">{item.unit_name}</td>
                            <td className="px-4 py-3">
                              <input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) => handleItemQtyChange(idx, e.target.value)}
                                className="w-full rounded-lg border border-ink-900/10 bg-white px-2 py-1 text-center text-sm"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(idx)}
                                className="text-coral-500 hover:text-coral-700 text-xs font-semibold"
                              >
                                Xóa
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {formError && <p className="text-sm text-coral-500">{formError}</p>}
            </div>

            {/* Footer */}
            <div className="flex flex-wrap gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={formSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
              >
                {formSubmitting ? 'Đang lưu...' : 'Lưu đơn mẫu'}
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
      )}
    </div>
  )
}
