import { useCallback, useEffect, useRef, useState } from 'react'
import { inventoryApi, type DrugRecall, type DrugRecallCreatePayload } from '../api/inventoryService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { exportToExcel } from '../utils/exportFile'

type DateMode = 'all' | 'range' | 'today'

type FormState = {
  drug_name: string
  official_doc_number: string
  issued_date: string
  concentration: string
  content: string
  unit: string
  registration_number: string
  lot_number: string
  expiry_date: string
  qty_purchased: string
  qty_sold: string
  qty_remaining: string
  qty_recalled_from_customers: string
  manufacturer: string
  customer_name: string
  customer_address: string
  recipient: string
  facility_handling: string
  reason: string
}

const emptyForm = (): FormState => ({
  drug_name: '',
  official_doc_number: '',
  issued_date: new Date().toISOString().slice(0, 10),
  concentration: '',
  content: '',
  unit: '',
  registration_number: '',
  lot_number: '',
  expiry_date: '',
  qty_purchased: '',
  qty_sold: '',
  qty_remaining: '',
  qty_recalled_from_customers: '',
  manufacturer: '',
  customer_name: '',
  customer_address: '',
  recipient: '',
  facility_handling: '',
  reason: '',
})

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('vi-VN')
}

function fmtQty(v: number | null | undefined) {
  if (v == null) return '—'
  return v.toLocaleString('vi-VN')
}

export function DrugRecall() {
  const { token } = useAuth()
  const accessToken = token?.access_token ?? ''

  const [dateMode, setDateMode] = useState<DateMode>('range')
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(todayIso)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize] = useState(10)

  const [rows, setRows] = useState<DrugRecall[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DrugRecall | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<DrugRecall | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadRows = useCallback(async (pg = 1) => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number> = { page: pg, size: pageSize, sort: sortOrder }
      if (dateMode === 'range') {
        if (dateFrom) params.date_from = dateFrom
        if (dateTo) params.date_to = dateTo
      } else if (dateMode === 'today') {
        const t = todayIso()
        params.date_from = t
        params.date_to = t
      }
      const res = await inventoryApi.listDrugRecalls(accessToken, params)
      setRows(res.items)
      setTotal(res.total)
      setPage(pg)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Không tải được dữ liệu')
    } finally {
      setLoading(false)
    }
  }, [accessToken, dateMode, dateFrom, dateTo, sortOrder, pageSize])

  useEffect(() => { void loadRows(1) }, [loadRows])

  const openCreate = () => {
    setEditTarget(null)
    setForm(emptyForm())
    setFormError(null)
    setModalOpen(true)
  }

  const openEdit = (r: DrugRecall) => {
    setEditTarget(r)
    setForm({
      drug_name: r.drug_name,
      official_doc_number: r.official_doc_number,
      issued_date: r.issued_date,
      concentration: r.concentration,
      content: r.content,
      unit: r.unit,
      registration_number: r.registration_number,
      lot_number: r.lot_number,
      expiry_date: r.expiry_date,
      qty_purchased: r.qty_purchased != null ? String(r.qty_purchased) : '',
      qty_sold: r.qty_sold != null ? String(r.qty_sold) : '',
      qty_remaining: r.qty_remaining != null ? String(r.qty_remaining) : '',
      qty_recalled_from_customers: r.qty_recalled_from_customers != null ? String(r.qty_recalled_from_customers) : '',
      manufacturer: r.manufacturer,
      customer_name: r.customer_name,
      customer_address: r.customer_address,
      recipient: r.recipient,
      facility_handling: r.facility_handling,
      reason: r.reason,
    })
    setFormError(null)
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!form.drug_name.trim()) {
      setFormError('Vui lòng nhập tên thuốc thu hồi')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const payload: DrugRecallCreatePayload = {
        drug_name: form.drug_name.trim(),
        official_doc_number: form.official_doc_number || null,
        issued_date: form.issued_date || null,
        concentration: form.concentration || null,
        content: form.content || null,
        unit: form.unit || null,
        registration_number: form.registration_number || null,
        lot_number: form.lot_number || null,
        expiry_date: form.expiry_date || null,
        qty_purchased: form.qty_purchased !== '' ? Number(form.qty_purchased) : null,
        qty_sold: form.qty_sold !== '' ? Number(form.qty_sold) : null,
        qty_remaining: form.qty_remaining !== '' ? Number(form.qty_remaining) : null,
        qty_recalled_from_customers: form.qty_recalled_from_customers !== '' ? Number(form.qty_recalled_from_customers) : null,
        manufacturer: form.manufacturer || null,
        customer_name: form.customer_name || null,
        customer_address: form.customer_address || null,
        recipient: form.recipient || null,
        facility_handling: form.facility_handling || null,
        reason: form.reason || null,
      }
      if (editTarget) {
        await inventoryApi.updateDrugRecall(accessToken, editTarget.id, payload)
      } else {
        await inventoryApi.createDrugRecall(accessToken, payload)
      }
      setModalOpen(false)
      void loadRows(editTarget ? page : 1)
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Lưu thất bại')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await inventoryApi.deleteDrugRecall(accessToken, deleteTarget.id)
      setDeleteTarget(null)
      void loadRows(1)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Xoá thất bại')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  const handleExportExcel = async () => {
    if (!accessToken) return
    try {
      const res = await inventoryApi.listDrugRecalls(accessToken, {
        ...(dateMode === 'range' ? { date_from: dateFrom, date_to: dateTo } : dateMode === 'today' ? { date_from: todayIso(), date_to: todayIso() } : {}),
        sort: sortOrder,
        page: 1,
        size: 1000,
      })
      const headers = ['STT', 'Số công văn', 'Ngày ban hành', 'Thuốc bị thu hồi', 'Số đăng ký', 'Số lô', 'Hạn dùng', 'Công ty SX/NK', 'SL đã mua', 'SL đã bán', 'SL tồn', 'SL thu hồi từ KH', 'Khách hàng', 'Người nhận', 'Xử lý của cơ sở', 'Lý do thu hồi']
      const dataRows = res.items.map((r, i) => [
        i + 1,
        r.official_doc_number,
        formatDate(r.issued_date),
        r.drug_name,
        r.registration_number,
        r.lot_number,
        formatDate(r.expiry_date),
        r.manufacturer,
        r.qty_purchased ?? '',
        r.qty_sold ?? '',
        r.qty_remaining ?? '',
        r.qty_recalled_from_customers ?? '',
        r.customer_name,
        r.recipient,
        r.facility_handling,
        r.reason,
      ])
      exportToExcel('So_theo_doi_thuoc_thu_hoi.xlsx', 'Thu hồi thuốc', headers, dataRows)
    } catch {
      // silent
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const field = (key: keyof FormState, label: string, required = false, type: 'text' | 'date' | 'number' = 'text') => (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-600">
        {label}{required && <span className="ml-0.5 text-coral-500">*</span>}
      </label>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="w-full rounded-lg border border-ink-900/15 px-3 py-2 text-sm text-ink-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200"
        placeholder={`Nhập ${label.toLowerCase()}`}
      />
    </div>
  )

  const textarea = (key: keyof FormState, label: string) => (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-600">{label}</label>
      <textarea
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        rows={2}
        className="w-full rounded-lg border border-ink-900/15 px-3 py-2 text-sm text-ink-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200"
        placeholder={`Nhập ${label.toLowerCase()}`}
      />
    </div>
  )

  return (
    <div className="flex min-h-full gap-6">
      {/* Left filter panel */}
      <aside className="w-52 shrink-0 space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">Thời gian</p>
          {(['all', 'range', 'today'] as DateMode[]).map((m) => (
            <label key={m} className="flex items-center gap-2 py-0.5 text-sm text-ink-700 cursor-pointer">
              <input type="radio" checked={dateMode === m} onChange={() => setDateMode(m)} className="accent-sky-500" />
              {m === 'all' ? 'Tất cả' : m === 'range' ? 'Theo ngày' : 'Ngày hiện tại'}
            </label>
          ))}
        </div>

        {dateMode === 'range' && (
          <div className="space-y-2">
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-lg border border-ink-900/15 px-2.5 py-2 text-sm text-ink-700 focus:border-sky-400 focus:outline-none" />
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-ink-900/15 px-2.5 py-2 text-sm text-ink-700 focus:border-sky-400 focus:outline-none" />
          </div>
        )}

        <button type="button" onClick={() => loadRows(1)}
          className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600">
          Xem
        </button>

        <button type="button" onClick={handleExportExcel}
          className="w-full rounded-lg border border-ink-900/15 bg-white px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-fog-50">
          Xuất Excel
        </button>

        <div>
          <p className="mb-1 text-xs font-medium text-ink-500">Sắp xếp</p>
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')}
            className="w-full rounded-lg border border-ink-900/15 px-2.5 py-2 text-sm text-ink-700 focus:outline-none">
            <option value="desc">Mới nhất trước</option>
            <option value="asc">Cũ nhất trước</option>
          </select>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold uppercase tracking-wide text-ink-800">
            Sổ theo dõi thuốc bị thu hồi, đình chỉ lưu hành
          </h2>
          <button type="button" onClick={openCreate}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600">
            Thêm mới
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-coral-50 px-4 py-2 text-sm text-coral-600">{error}</div>
        )}

        {/* Rows per page */}
        <div className="mb-3 flex items-center gap-2 text-sm text-ink-600">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); void loadRows(1) }}
            className="rounded border border-ink-900/15 px-2 py-1 text-sm focus:outline-none">
            {[10, 20, 50, 100].map((n) => <option key={n}>{n}</option>)}
          </select>
          <span>Dòng / Trang</span>
          <span className="ml-auto text-ink-400">{loading ? 'Đang tải...' : `${total} bản ghi`}</span>
        </div>

        {/* Table — horizontally scrollable */}
        <div className="overflow-x-auto rounded-xl border border-ink-900/8 bg-white shadow-sm">
          <table className="min-w-[1800px] w-full text-sm">
            <thead>
              <tr className="border-b border-ink-900/8 bg-fog-50 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                <th className="px-3 py-3 w-10">STT</th>
                <th className="px-3 py-3">Số công văn</th>
                <th className="px-3 py-3">Ngày ban hành</th>
                <th className="px-3 py-3">Thuốc bị thu hồi</th>
                <th className="px-3 py-3">Số đăng ký</th>
                <th className="px-3 py-3">Số lô, hạn dùng</th>
                <th className="px-3 py-3">Công ty SX/NK</th>
                <th className="px-3 py-3 text-right">SL đã mua</th>
                <th className="px-3 py-3 text-right">SL đã bán</th>
                <th className="px-3 py-3 text-right">SL tồn</th>
                <th className="px-3 py-3 text-right">SL thu hồi từ KH</th>
                <th className="px-3 py-3">Khách hàng</th>
                <th className="px-3 py-3">Người nhận</th>
                <th className="px-3 py-3">Xử lý của cơ sở</th>
                <th className="px-3 py-3">Lý do thu hồi</th>
                <th className="px-3 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={16} className="px-4 py-8 text-center text-ink-400">
                    {loading ? 'Đang tải...' : 'Không có dữ liệu'}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.id} className="border-b border-ink-900/5 hover:bg-fog-50 cursor-pointer" onClick={() => openEdit(r)}>
                  <td className="px-3 py-2.5 text-ink-500">{(page - 1) * pageSize + i + 1}</td>
                  <td className="px-3 py-2.5 font-medium text-ink-800">{r.official_doc_number || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-700 whitespace-nowrap">{formatDate(r.issued_date)}</td>
                  <td className="px-3 py-2.5 font-semibold text-ink-900">{r.drug_name}</td>
                  <td className="px-3 py-2.5 text-ink-600">{r.registration_number || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-600">
                    {r.lot_number ? <span>{r.lot_number}</span> : null}
                    {r.lot_number && r.expiry_date ? <span className="text-ink-400"> / </span> : null}
                    {r.expiry_date ? <span>{formatDate(r.expiry_date)}</span> : null}
                    {!r.lot_number && !r.expiry_date ? '—' : null}
                  </td>
                  <td className="px-3 py-2.5 text-ink-600">{r.manufacturer || '—'}</td>
                  <td className="px-3 py-2.5 text-right text-ink-700">{fmtQty(r.qty_purchased)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-700">{fmtQty(r.qty_sold)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-700">{fmtQty(r.qty_remaining)}</td>
                  <td className="px-3 py-2.5 text-right text-ink-700">{fmtQty(r.qty_recalled_from_customers)}</td>
                  <td className="px-3 py-2.5 text-ink-600">{r.customer_name || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-600">{r.recipient || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-600 max-w-[160px] truncate" title={r.facility_handling}>{r.facility_handling || '—'}</td>
                  <td className="px-3 py-2.5 text-ink-600 max-w-[160px] truncate" title={r.reason}>{r.reason || '—'}</td>
                  <td className="px-3 py-2.5">
                    <button type="button" onClick={(e) => { e.stopPropagation(); setDeleteTarget(r) }}
                      className="rounded px-2 py-1 text-xs text-coral-500 hover:bg-coral-50">
                      Xoá
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-1">
            <button type="button" disabled={page <= 1} onClick={() => loadRows(page - 1)}
              className="rounded px-3 py-1.5 text-sm text-ink-600 hover:bg-fog-100 disabled:opacity-40">‹</button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, idx) => {
              const p = idx + 1
              return (
                <button key={p} type="button" onClick={() => loadRows(p)}
                  className={`rounded px-3 py-1.5 text-sm ${page === p ? 'bg-sky-500 font-semibold text-white' : 'text-ink-600 hover:bg-fog-100'}`}>
                  {p}
                </button>
              )
            })}
            <button type="button" disabled={page >= totalPages} onClick={() => loadRows(page + 1)}
              className="rounded px-3 py-1.5 text-sm text-ink-600 hover:bg-fog-100 disabled:opacity-40">›</button>
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8">
          <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-900/8 px-6 py-4">
              <h3 className="text-base font-semibold text-ink-900">
                {editTarget ? 'Cập nhật thông tin thu hồi thuốc' : 'Thêm thông tin thu hồi thuốc'}
              </h3>
              <button type="button" onClick={() => setModalOpen(false)} className="text-ink-400 hover:text-ink-700 text-xl leading-none">×</button>
            </div>

            <div className="grid grid-cols-3 gap-4 px-6 py-5">
              {field('official_doc_number', 'Số công văn')}
              {field('lot_number', 'Số lô')}
              {field('manufacturer', 'Công ty sản xuất/nhập khẩu')}

              {field('issued_date', 'Ngày ban hành', false, 'date')}
              {field('expiry_date', 'Hạn dùng', false, 'date')}
              {field('customer_name', 'Khách hàng trả lại')}

              {field('drug_name', 'Thuốc thu hồi', true)}
              {field('qty_purchased', 'Số lượng đã mua', false, 'number')}
              {field('customer_address', 'Địa chỉ khách hàng')}

              {field('concentration', 'Nồng độ')}
              {field('qty_sold', 'Số lượng đã bán', false, 'number')}
              {field('recipient', 'Người nhận')}

              {field('content', 'Hàm lượng')}
              {field('qty_remaining', 'Số lượng tồn', false, 'number')}
              <div>
                {textarea('facility_handling', 'Xử lý của cơ sở')}
              </div>

              {field('unit', 'Đơn vị')}
              {field('qty_recalled_from_customers', 'Số lượng thu hồi từ khách hàng', false, 'number')}
              <div>
                {textarea('reason', 'Lý do thu hồi/đình chỉ')}
              </div>

              {field('registration_number', 'Số đăng ký')}
            </div>

            {formError && (
              <div className="mx-6 mb-2 rounded-lg bg-coral-50 px-4 py-2 text-sm text-coral-600">{formError}</div>
            )}

            <div className="flex justify-end gap-3 border-t border-ink-900/8 px-6 py-4">
              <button type="button" onClick={() => setModalOpen(false)}
                className="rounded-lg border border-ink-900/15 px-4 py-2 text-sm text-ink-700 hover:bg-fog-50">
                Đóng
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-60">
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-ink-900">Xác nhận xoá</h3>
            <p className="mt-2 text-sm text-ink-600">
              Xoá bản ghi thu hồi thuốc <strong>{deleteTarget.drug_name}</strong>? Hành động này không thể hoàn tác.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-ink-900/15 px-4 py-2 text-sm text-ink-700 hover:bg-fog-50">
                Huỷ
              </button>
              <button type="button" onClick={handleDelete} disabled={deleting}
                className="rounded-lg bg-coral-500 px-4 py-2 text-sm font-semibold text-white hover:bg-coral-600 disabled:opacity-60">
                {deleting ? 'Đang xoá...' : 'Xoá'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
