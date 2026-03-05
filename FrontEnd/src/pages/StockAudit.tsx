import { Fragment, useCallback, useEffect, useState } from 'react'
import { inventoryApi, type StockAudit as StockAuditType, type StockAuditItem } from '../api/inventoryService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { exportToExcel } from '../utils/exportFile'

type View = 'list' | 'detail'

const formatDateTime = (value: string) => {
  try {
    return new Date(value).toLocaleString('vi-VN')
  } catch {
    return value
  }
}

const statusLabel = (status: string) => {
  switch (status) {
    case 'draft': return 'Nháp'
    case 'completed': return 'Hoàn thành'
    case 'cancelled': return 'Đã hủy'
    default: return status
  }
}

const statusStyle = (status: string) => {
  switch (status) {
    case 'draft': return 'bg-sun-500/10 text-sun-700'
    case 'completed': return 'bg-brand-500/10 text-brand-700'
    case 'cancelled': return 'bg-ink-900/5 text-ink-600'
    default: return 'bg-ink-900/5 text-ink-600'
  }
}

export function StockAudit() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [view, setView] = useState<View>('list')
  const [audits, setAudits] = useState<StockAuditType[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [selectedAudit, setSelectedAudit] = useState<StockAuditType | null>(null)
  const [editItems, setEditItems] = useState<Record<string, { actual_qty: string; note: string }>>({})
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)

  const loadAudits = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number | undefined> = { page, size: 20 }
      if (statusFilter) params.status = statusFilter
      const result = await inventoryApi.listStockAudits(accessToken, params)
      setAudits(result.items)
      setTotal(result.total)
      setTotalPages(result.total_pages)
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tải danh sách kiểm kê.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, page, statusFilter])

  useEffect(() => {
    void loadAudits()
  }, [loadAudits])

  const handleCreate = async () => {
    if (!accessToken) return
    setError(null)
    setNotice(null)
    try {
      const result = await inventoryApi.createStockAudit(accessToken)
      setNotice(`Đã tạo phiếu kiểm kê ${result.audit.code}`)
      setSelectedAudit(result.audit)
      initEditItems(result.audit.items)
      setView('detail')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tạo phiếu kiểm kê.')
    }
  }

  const openDetail = async (audit: StockAuditType) => {
    if (!accessToken) return
    setError(null)
    try {
      const full = await inventoryApi.getStockAudit(accessToken, audit.id)
      setSelectedAudit(full)
      initEditItems(full.items)
      setView('detail')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tải chi tiết phiếu.')
    }
  }

  const initEditItems = (items: StockAuditItem[]) => {
    const map: Record<string, { actual_qty: string; note: string }> = {}
    for (const item of items) {
      map[item.batch_id] = {
        actual_qty: item.actual_qty !== null ? String(item.actual_qty) : '',
        note: item.note || '',
      }
    }
    setEditItems(map)
  }

  const handleSave = async () => {
    if (!accessToken || !selectedAudit) return
    setSaving(true)
    setError(null)
    try {
      const items = Object.entries(editItems)
        .filter(([, v]) => v.actual_qty !== '')
        .map(([batchId, v]) => ({
          batch_id: batchId,
          actual_qty: parseInt(v.actual_qty, 10),
          note: v.note || undefined,
        }))
      if (items.length === 0) {
        setError('Vui lòng nhập số lượng thực tế cho ít nhất 1 dòng.')
        setSaving(false)
        return
      }
      const result = await inventoryApi.updateStockAuditItems(accessToken, selectedAudit.id, items)
      setSelectedAudit(result.audit)
      setNotice('Đã lưu số liệu kiểm kê.')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể lưu.')
    } finally {
      setSaving(false)
    }
  }

  const handleComplete = async () => {
    if (!accessToken || !selectedAudit) return
    if (!window.confirm('Hoàn thành kiểm kê sẽ tự động điều chỉnh tồn kho cho các dòng có chênh lệch. Tiếp tục?')) return
    setCompleting(true)
    setError(null)
    try {
      const result = await inventoryApi.completeStockAudit(accessToken, selectedAudit.id)
      setSelectedAudit(result.audit)
      setNotice('Đã hoàn thành kiểm kê và điều chỉnh tồn kho.')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể hoàn thành.')
    } finally {
      setCompleting(false)
    }
  }

  const handleCancel = async () => {
    if (!accessToken || !selectedAudit) return
    if (!window.confirm('Hủy phiếu kiểm kê này?')) return
    setError(null)
    try {
      const result = await inventoryApi.cancelStockAudit(accessToken, selectedAudit.id)
      setSelectedAudit(result.audit)
      setNotice('Đã hủy phiếu kiểm kê.')
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể hủy.')
    }
  }

  const handleExportAudit = () => {
    if (!selectedAudit) return
    const headers = ['Mã thuốc', 'Tên thuốc', 'Mã lô', 'Tồn hệ thống', 'Tồn thực tế', 'Chênh lệch', 'Ghi chú']
    const rows = selectedAudit.items.map((item) => [
      item.drug_code,
      item.drug_name,
      item.batch_code,
      item.system_qty,
      item.actual_qty ?? '',
      item.diff_qty ?? '',
      item.note,
    ])
    exportToExcel(`kiem-ke-${selectedAudit.code}`, 'Kiểm kê', headers, rows)
  }

  const goBack = () => {
    setView('list')
    setSelectedAudit(null)
    setNotice(null)
    setError(null)
    void loadAudits()
  }

  // ── Detail View ────────────────────────────────────────────────────────────

  if (view === 'detail' && selectedAudit) {
    const isDraft = selectedAudit.status === 'draft'
    const itemsWithDiff = selectedAudit.items.filter((i) => i.diff_qty !== null && i.diff_qty !== 0)

    return (
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <button type="button" onClick={goBack} className="text-sm text-brand-600 hover:underline">
              &larr; Quay lại danh sách
            </button>
            <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">
              Phiếu kiểm kê {selectedAudit.code}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-ink-600">
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle(selectedAudit.status)}`}>
                {statusLabel(selectedAudit.status)}
              </span>
              <span>Tạo: {formatDateTime(selectedAudit.created_at)}</span>
              {selectedAudit.completed_at ? <span>Hoàn thành: {formatDateTime(selectedAudit.completed_at)}</span> : null}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={handleExportAudit} className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">
              Xuất Excel
            </button>
            {isDraft && canManage ? (
              <>
                <button type="button" onClick={() => void handleSave()} disabled={saving} className="rounded-full border border-brand-500/30 bg-brand-500/10 px-4 py-2 text-sm font-semibold text-brand-700 disabled:opacity-60">
                  {saving ? 'Đang lưu...' : 'Lưu'}
                </button>
                <button type="button" onClick={() => void handleComplete()} disabled={completing} className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {completing ? 'Đang xử lý...' : 'Hoàn thành kiểm kê'}
                </button>
                <button type="button" onClick={() => void handleCancel()} className="rounded-full border border-coral-500/30 bg-coral-500/10 px-4 py-2 text-sm font-semibold text-coral-700">
                  Hủy phiếu
                </button>
              </>
            ) : null}
          </div>
        </header>

        {notice ? <p className="text-sm text-brand-600">{notice}</p> : null}
        {error ? <p className="text-sm text-coral-500">{error}</p> : null}

        {!isDraft && itemsWithDiff.length > 0 ? (
          <section className="glass-card rounded-2xl p-4">
            <p className="text-sm font-semibold text-ink-900">Tổng kết chênh lệch: {itemsWithDiff.length} dòng</p>
            <p className="text-xs text-ink-600 mt-1">
              Thiếu: {itemsWithDiff.filter((i) => (i.diff_qty ?? 0) < 0).length} | Thừa: {itemsWithDiff.filter((i) => (i.diff_qty ?? 0) > 0).length}
            </p>
          </section>
        ) : null}

        <section className="glass-card rounded-3xl p-4 sm:p-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                <tr>
                  <th className="px-4 py-3">Mã thuốc</th>
                  <th className="px-4 py-3">Tên thuốc</th>
                  <th className="px-4 py-3">Mã lô</th>
                  <th className="px-4 py-3 text-right">Tồn HT</th>
                  <th className="px-4 py-3 text-right">Tồn thực tế</th>
                  <th className="px-4 py-3 text-right">Chênh lệch</th>
                  <th className="px-4 py-3">Ghi chú</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/70">
                {selectedAudit.items.map((item) => {
                  const diff = item.diff_qty
                  const rowClass = diff !== null && diff < 0
                    ? 'bg-coral-500/5'
                    : diff !== null && diff > 0
                      ? 'bg-sun-500/5'
                      : ''
                  const edit = editItems[item.batch_id] ?? { actual_qty: '', note: '' }

                  return (
                    <tr key={item.batch_id} className={rowClass}>
                      <td className="px-4 py-3 font-mono text-xs">{item.drug_code}</td>
                      <td className="px-4 py-3 text-ink-900">{item.drug_name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{item.batch_code}</td>
                      <td className="px-4 py-3 text-right font-semibold">{item.system_qty}</td>
                      <td className="px-4 py-3 text-right">
                        {isDraft ? (
                          <input
                            type="number"
                            min={0}
                            value={edit.actual_qty}
                            onChange={(e) =>
                              setEditItems((prev) => ({
                                ...prev,
                                [item.batch_id]: { ...prev[item.batch_id], actual_qty: e.target.value },
                              }))
                            }
                            className="w-20 rounded-lg border border-ink-900/10 px-2 py-1 text-right text-sm"
                            placeholder="—"
                          />
                        ) : (
                          <span className="font-semibold">{item.actual_qty ?? '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {diff !== null ? (
                          <span className={`font-semibold ${diff < 0 ? 'text-coral-500' : diff > 0 ? 'text-sun-600' : 'text-brand-600'}`}>
                            {diff > 0 ? '+' : ''}{diff}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {isDraft ? (
                          <input
                            type="text"
                            value={edit.note}
                            onChange={(e) =>
                              setEditItems((prev) => ({
                                ...prev,
                                [item.batch_id]: { ...prev[item.batch_id], note: e.target.value },
                              }))
                            }
                            className="w-full min-w-[120px] rounded-lg border border-ink-900/10 px-2 py-1 text-sm"
                            placeholder="Ghi chú"
                          />
                        ) : (
                          <span className="text-xs text-ink-600">{item.note || '—'}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    )
  }

  // ── List View ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Kho</p>
          <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">Kiểm kê kho</h2>
        </div>
        {canManage ? (
          <button type="button" onClick={() => void handleCreate()} className="rounded-full bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white">
            Tạo phiếu kiểm kê
          </button>
        ) : null}
      </header>

      {notice ? <p className="text-sm text-brand-600">{notice}</p> : null}
      {error ? <p className="text-sm text-coral-500">{error}</p> : null}

      <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap gap-3">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="">Tất cả trạng thái</option>
            <option value="draft">Nháp</option>
            <option value="completed">Hoàn thành</option>
            <option value="cancelled">Đã hủy</option>
          </select>
          <button type="button" onClick={() => void loadAudits()} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
            Tải lại
          </button>
        </div>

        {loading ? <p className="text-sm text-ink-600">Đang tải...</p> : null}

        {!loading && audits.length === 0 ? (
          <p className="text-sm text-ink-600">Chưa có phiếu kiểm kê nào.</p>
        ) : null}

        {!loading && audits.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                <tr>
                  <th className="px-4 py-3">Mã phiếu</th>
                  <th className="px-4 py-3">Ngày tạo</th>
                  <th className="px-4 py-3">Số dòng</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3">Hoàn thành</th>
                  <th className="px-4 py-3">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/70">
                {audits.map((audit) => (
                  <tr key={audit.id} className="hover:bg-white/80">
                    <td className="px-4 py-3 font-semibold text-ink-900">{audit.code}</td>
                    <td className="px-4 py-3 text-ink-700">{formatDateTime(audit.created_at)}</td>
                    <td className="px-4 py-3 text-ink-700">{audit.items.length}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle(audit.status)}`}>
                        {statusLabel(audit.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{audit.completed_at ? formatDateTime(audit.completed_at) : '—'}</td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => void openDetail(audit)} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">
                        Chi tiết
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="flex items-center justify-between text-sm text-ink-600">
            <p>Trang {page}/{totalPages} ({total} phiếu)</p>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold disabled:opacity-50">
                Trước
              </button>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold disabled:opacity-50">
                Sau
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
