import { useCallback, useEffect, useState } from 'react'
import { inventoryApi, type DisposalLogEntry, type InventoryAlertEntry, type InventoryAlerts } from '../api/inventoryService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { exportToExcel } from '../utils/exportFile'
import {
  formatDateInAppTimeZone as formatDate,
  formatDateTimeInAppTimeZone,
} from '../utils/timezone'

type FilterGroup = 'all' | 'expired' | 'expiring_soon' | 'warning' | 'near_date'
type ActiveTab = 'alerts' | 'disposal_log'

const formatDateTime = (value: string) => formatDateTimeInAppTimeZone(value)

const formatCurrency = (value: number) => `${Math.round(Math.max(0, value)).toLocaleString('vi-VN')}đ`

type DisposalFormState = {
  entry: InventoryAlertEntry
  disposal_method: string
  witness: string
  note: string
}

export function ExpiryManagement() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canAdjust = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [alerts, setAlerts] = useState<InventoryAlerts | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterGroup>('all')
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('alerts')

  // Disposal confirmation form
  const [disposalForm, setDisposalForm] = useState<DisposalFormState | null>(null)
  const [disposing, setDisposing] = useState(false)

  // Disposal log tab
  const [disposalLog, setDisposalLog] = useState<DisposalLogEntry[] | null>(null)
  const [loadingLog, setLoadingLog] = useState(false)

  const loadAlerts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await inventoryApi.getInventoryAlerts(accessToken || undefined)
      setAlerts(result)
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tải dữ liệu hạn sử dụng.')
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  const loadDisposalLog = useCallback(async () => {
    if (!accessToken) return
    setLoadingLog(true)
    try {
      const result = await inventoryApi.getDisposalLog(accessToken)
      setDisposalLog(result.entries)
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
    } finally {
      setLoadingLog(false)
    }
  }, [accessToken])

  useEffect(() => {
    void loadAlerts()
  }, [loadAlerts])

  useEffect(() => {
    if (activeTab === 'disposal_log') void loadDisposalLog()
  }, [activeTab, loadDisposalLog])

  const getFilteredEntries = (): InventoryAlertEntry[] => {
    if (!alerts) return []

    let entries: InventoryAlertEntry[] = []
    if (filter === 'expired' || filter === 'all') entries = [...entries, ...alerts.expired]
    if (filter === 'expiring_soon' || filter === 'all') entries = [...entries, ...alerts.expiring_soon]
    if (filter === 'warning' || filter === 'all') entries = [...entries, ...(alerts.warning ?? [])]
    if (filter === 'near_date' || filter === 'all') entries = [...entries, ...alerts.near_date]

    if (search.trim()) {
      const q = search.toLowerCase()
      entries = entries.filter(
        (e) =>
          (e.batch.drug_name ?? '').toLowerCase().includes(q) ||
          (e.batch.batch_code ?? '').toLowerCase().includes(q) ||
          (e.batch.drug_code ?? '').toLowerCase().includes(q),
      )
    }

    entries.sort((a, b) => a.days_to_expiry - b.days_to_expiry)
    return entries
  }

  const openDisposalForm = (entry: InventoryAlertEntry) => {
    setDisposalForm({ entry, disposal_method: 'Tiêu hủy thông thường', witness: '', note: '' })
  }

  const handleDispose = async () => {
    if (!accessToken || !disposalForm) return
    const { entry, disposal_method, witness, note } = disposalForm
    setDisposing(true)
    setError(null)
    try {
      await inventoryApi.adjustStock(accessToken, {
        batch_id: entry.batch.id,
        reason: 'expired_disposal',
        note: note || `Tiêu hủy lô hết hạn ${entry.batch.batch_code}`,
        new_quantity: 0,
        disposal_method,
        witness: witness || null,
      })
      setNotice(`Đã tiêu hủy lô ${entry.batch.batch_code}`)
      setDisposalForm(null)
      await loadAlerts()
      if (activeTab === 'disposal_log') await loadDisposalLog()
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tiêu hủy.')
    } finally {
      setDisposing(false)
    }
  }

  const handleExport = () => {
    const entries = getFilteredEntries()
    const headers = ['Mã thuốc', 'Tên thuốc', 'Mã lô', 'Ngày hết hạn', 'Số ngày còn lại', 'Tồn kho', 'Giá nhập', 'Nhà phân phối']
    const rows = entries.map((e) => [
      e.batch.drug_code,
      e.batch.drug_name,
      e.batch.batch_code,
      formatDate(e.batch.exp_date),
      e.days_to_expiry,
      e.batch.qty_remaining,
      e.batch.import_price,
      e.batch.supplier_name,
    ])
    const dateKey = new Date().toISOString().slice(0, 10)
    exportToExcel(`han-su-dung-${dateKey}`, 'Hạn sử dụng', headers, rows)
  }

  const handleExportDisposalLog = () => {
    if (!disposalLog) return
    const headers = ['Mã tiêu hủy', 'Mã thuốc', 'Tên thuốc', 'Mã lô', 'Ngày hết hạn', 'SL tiêu hủy', 'Phương thức', 'Người chứng kiến', 'Người thực hiện', 'Thời gian', 'Ghi chú']
    const rows = disposalLog.map((e) => [
      e.id, e.drug_code, e.drug_name, e.batch_code,
      formatDate(e.exp_date), e.qty_disposed, e.disposal_method,
      e.witness ?? '', e.actor, formatDateTime(e.disposed_at), e.note ?? '',
    ])
    const dateKey = new Date().toISOString().slice(0, 10)
    exportToExcel(`so-tieu-huy-${dateKey}`, 'Sổ tiêu hủy GPP', headers, rows)
  }

  const filteredEntries = getFilteredEntries()

  const daysLabel = (days: number) => {
    if (days < 0) return `Hết hạn ${Math.abs(days)} ngày`
    if (days === 0) return 'Hết hạn hôm nay'
    return `Còn ${days} ngày`
  }

  const daysStyle = (days: number) => {
    if (days < 0) return 'text-coral-500 font-semibold'
    if (days < 30) return 'text-sun-600 font-semibold'
    if (days < 60) return 'text-amber-600 font-semibold'
    return 'text-ink-700'
  }

  const warningCount = alerts?.totals.warning ?? 0

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Kho</p>
          <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">Quản lý hạn sử dụng</h2>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void loadAlerts()} className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">
            Tải lại
          </button>
          {activeTab === 'alerts' ? (
            <button type="button" onClick={handleExport} disabled={filteredEntries.length === 0} className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              Xuất Excel
            </button>
          ) : (
            <button type="button" onClick={handleExportDisposalLog} disabled={!disposalLog?.length} className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              Xuất sổ tiêu hủy
            </button>
          )}
        </div>
      </header>

      {notice ? <p className="text-sm text-brand-600">{notice}</p> : null}
      {error ? <p className="text-sm text-coral-500">{error}</p> : null}

      {/* Tabs */}
      <div className="flex gap-1 rounded-2xl bg-white/60 p-1 w-fit border border-ink-900/10">
        <button
          type="button"
          onClick={() => setActiveTab('alerts')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeTab === 'alerts' ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-900/5'}`}
        >
          Cảnh báo hạn dùng
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('disposal_log')}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeTab === 'disposal_log' ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-900/5'}`}
        >
          Sổ tiêu hủy (GPP)
        </button>
      </div>

      {activeTab === 'alerts' ? (
        <>
          {/* Stat cards - 5 tiers */}
          {alerts ? (
            <section className="grid gap-3 grid-cols-2 xl:grid-cols-5">
              <button
                type="button"
                onClick={() => setFilter('expired')}
                className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'expired' ? 'ring-2 ring-coral-500' : ''}`}
              >
                <p className="text-xs uppercase tracking-[0.25em] text-coral-500">Đã hết hạn</p>
                <p className="mt-3 text-2xl font-semibold text-coral-500">{alerts.totals.expired}</p>
              </button>
              <button
                type="button"
                onClick={() => setFilter('expiring_soon')}
                className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'expiring_soon' ? 'ring-2 ring-sun-500' : ''}`}
              >
                <p className="text-xs uppercase tracking-[0.25em] text-sun-600">Sắp hết hạn</p>
                <p className="text-xs text-sun-600/70">&lt; 30 ngày</p>
                <p className="mt-2 text-2xl font-semibold text-sun-600">{alerts.totals.expiring_soon}</p>
              </button>
              <button
                type="button"
                onClick={() => setFilter('warning')}
                className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'warning' ? 'ring-2 ring-amber-500' : ''}`}
              >
                <p className="text-xs uppercase tracking-[0.25em] text-amber-600">Cảnh báo</p>
                <p className="text-xs text-amber-600/70">30 – 60 ngày</p>
                <p className="mt-2 text-2xl font-semibold text-amber-600">{warningCount}</p>
              </button>
              <button
                type="button"
                onClick={() => setFilter('near_date')}
                className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'near_date' ? 'ring-2 ring-amber-400' : ''}`}
              >
                <p className="text-xs uppercase tracking-[0.25em] text-amber-700">Cận date</p>
                <p className="text-xs text-amber-700/70">60 – 90 ngày</p>
                <p className="mt-2 text-2xl font-semibold text-amber-700">{alerts.totals.near_date}</p>
              </button>
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'all' ? 'ring-2 ring-ink-900' : ''}`}
              >
                <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Tất cả</p>
                <p className="mt-3 text-2xl font-semibold text-ink-900">
                  {alerts.totals.expired + alerts.totals.expiring_soon + warningCount + alerts.totals.near_date}
                </p>
              </button>
            </section>
          ) : null}

          {/* Table */}
          <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
            <div className="flex flex-wrap gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full max-w-sm rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                placeholder="Tìm theo tên thuốc, mã lô..."
              />
            </div>

            {loading ? <p className="text-sm text-ink-600">Đang tải...</p> : null}

            {!loading && filteredEntries.length === 0 ? (
              <p className="text-sm text-ink-600">
                {alerts ? 'Không có lô nào trong nhóm đã chọn.' : 'Chưa có dữ liệu.'}
              </p>
            ) : null}

            {!loading && filteredEntries.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] text-left text-sm">
                  <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Mã thuốc</th>
                      <th className="px-4 py-3">Tên thuốc</th>
                      <th className="px-4 py-3">Mã lô</th>
                      <th className="px-4 py-3">Ngày hết hạn</th>
                      <th className="px-4 py-3">Thời gian</th>
                      <th className="px-4 py-3 text-right">Tồn kho</th>
                      <th className="px-4 py-3 text-right">Giá nhập</th>
                      <th className="px-4 py-3">NPP</th>
                      <th className="px-4 py-3">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/70">
                    {filteredEntries.map((entry) => {
                      const days = entry.days_to_expiry
                      const rowBg = days < 0 ? 'bg-coral-500/5' : days < 30 ? 'bg-sun-500/5' : days < 60 ? 'bg-amber-500/5' : ''

                      return (
                        <tr key={entry.batch.id} className={`${rowBg} hover:bg-white/80`}>
                          <td className="px-4 py-3 font-mono text-xs">{entry.batch.drug_code}</td>
                          <td className="px-4 py-3 text-ink-900">{entry.batch.drug_name}</td>
                          <td className="px-4 py-3 font-mono text-xs">{entry.batch.batch_code}</td>
                          <td className="px-4 py-3 text-ink-700">{formatDate(entry.batch.exp_date)}</td>
                          <td className="px-4 py-3">
                            <span className={daysStyle(days)}>{daysLabel(days)}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-semibold">{entry.batch.qty_remaining}</td>
                          <td className="px-4 py-3 text-right text-ink-700">{formatCurrency(entry.batch.import_price)}</td>
                          <td className="px-4 py-3 text-ink-700">{entry.batch.supplier_name}</td>
                          <td className="px-4 py-3">
                            {canAdjust && days < 0 ? (
                              <button
                                type="button"
                                onClick={() => openDisposalForm(entry)}
                                className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-700"
                              >
                                Tiêu hủy
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </>
      ) : (
        /* Disposal Log Tab */
        <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
          <div>
            <h3 className="font-semibold text-ink-900">Sổ tiêu hủy thuốc (GPP)</h3>
            <p className="text-xs text-ink-600 mt-1">Lưu trữ theo tiêu chuẩn GPP - Bộ Y tế Việt Nam</p>
          </div>

          {loadingLog ? <p className="text-sm text-ink-600">Đang tải...</p> : null}

          {!loadingLog && disposalLog !== null && disposalLog.length === 0 ? (
            <p className="text-sm text-ink-600">Chưa có bản ghi tiêu hủy nào.</p>
          ) : null}

          {!loadingLog && disposalLog && disposalLog.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                  <tr>
                    <th className="px-4 py-3">Mã</th>
                    <th className="px-4 py-3">Tên thuốc</th>
                    <th className="px-4 py-3">Mã lô</th>
                    <th className="px-4 py-3">Ngày HSD</th>
                    <th className="px-4 py-3 text-right">SL tiêu hủy</th>
                    <th className="px-4 py-3">Phương thức</th>
                    <th className="px-4 py-3">Người chứng kiến</th>
                    <th className="px-4 py-3">Người thực hiện</th>
                    <th className="px-4 py-3">Thời gian</th>
                    <th className="px-4 py-3">Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/70">
                  {disposalLog.map((e) => (
                    <tr key={e.id} className="hover:bg-white/80">
                      <td className="px-4 py-3 font-mono text-xs text-ink-600">{e.id}</td>
                      <td className="px-4 py-3 text-ink-900">{e.drug_name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{e.batch_code}</td>
                      <td className="px-4 py-3 text-ink-700">{formatDate(e.exp_date)}</td>
                      <td className="px-4 py-3 text-right font-semibold text-coral-600">{e.qty_disposed}</td>
                      <td className="px-4 py-3 text-ink-700">{e.disposal_method}</td>
                      <td className="px-4 py-3 text-ink-700">{e.witness ?? '—'}</td>
                      <td className="px-4 py-3 text-ink-700">{e.actor}</td>
                      <td className="px-4 py-3 text-ink-600 text-xs">{formatDateTime(e.disposed_at)}</td>
                      <td className="px-4 py-3 text-ink-600 text-xs">{e.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      )}

      {/* Disposal confirmation modal */}
      {disposalForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-semibold text-ink-900">Xác nhận tiêu hủy lô thuốc</h3>
            <p className="text-sm text-ink-700">
              Lô <span className="font-semibold">{disposalForm.entry.batch.batch_code}</span> —{' '}
              {disposalForm.entry.batch.drug_name}
              <br />
              <span className="text-coral-600">Tồn kho: {disposalForm.entry.batch.qty_remaining} | Hết hạn: {formatDate(disposalForm.entry.batch.exp_date)}</span>
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-ink-700 mb-1">Phương thức tiêu hủy <span className="text-coral-500">*</span></label>
                <select
                  value={disposalForm.disposal_method}
                  onChange={(e) => setDisposalForm((f) => f ? { ...f, disposal_method: e.target.value } : f)}
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                >
                  <option>Tiêu hủy thông thường</option>
                  <option>Đốt</option>
                  <option>Chôn lấp</option>
                  <option>Trả nhà sản xuất</option>
                  <option>Trả nhà phân phối</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-700 mb-1">Người chứng kiến</label>
                <input
                  type="text"
                  value={disposalForm.witness}
                  onChange={(e) => setDisposalForm((f) => f ? { ...f, witness: e.target.value } : f)}
                  placeholder="Tên người chứng kiến..."
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-700 mb-1">Ghi chú</label>
                <textarea
                  value={disposalForm.note}
                  onChange={(e) => setDisposalForm((f) => f ? { ...f, note: e.target.value } : f)}
                  rows={2}
                  placeholder="Ghi chú thêm..."
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm resize-none"
                />
              </div>
            </div>

            {error ? <p className="text-sm text-coral-500">{error}</p> : null}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setDisposalForm(null)}
                className="rounded-full border border-ink-900/10 px-4 py-2 text-sm font-semibold text-ink-700"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={disposing}
                onClick={() => void handleDispose()}
                className="rounded-full bg-coral-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {disposing ? 'Đang xử lý...' : 'Xác nhận tiêu hủy'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
