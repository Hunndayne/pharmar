import { useCallback, useEffect, useState } from 'react'
import { inventoryApi, type InventoryAlertEntry, type InventoryAlerts } from '../api/inventoryService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { exportToExcel } from '../utils/exportFile'

type FilterGroup = 'all' | 'expired' | 'expiring_soon' | 'near_date'

const formatDate = (value: string) => {
  try {
    return new Date(value).toLocaleDateString('vi-VN')
  } catch {
    return value
  }
}

const formatCurrency = (value: number) => `${Math.round(Math.max(0, value)).toLocaleString('vi-VN')}đ`

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
  const [disposingBatchId, setDisposingBatchId] = useState<string | null>(null)

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

  useEffect(() => {
    void loadAlerts()
  }, [loadAlerts])

  const getFilteredEntries = (): InventoryAlertEntry[] => {
    if (!alerts) return []

    let entries: InventoryAlertEntry[] = []
    if (filter === 'expired' || filter === 'all') entries = [...entries, ...alerts.expired]
    if (filter === 'expiring_soon' || filter === 'all') entries = [...entries, ...alerts.expiring_soon]
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

  const handleDispose = async (entry: InventoryAlertEntry) => {
    if (!accessToken) return
    if (!window.confirm(`Tiêu hủy lô ${entry.batch.batch_code} (${entry.batch.drug_name})? Tồn kho sẽ được đặt về 0.`)) return

    setDisposingBatchId(entry.batch.id)
    setError(null)
    try {
      await inventoryApi.adjustStock(accessToken, {
        batch_id: entry.batch.id,
        reason: 'expired_disposal',
        note: `Tiêu hủy lô hết hạn ${entry.batch.batch_code}`,
        new_quantity: 0,
      })
      setNotice(`Đã tiêu hủy lô ${entry.batch.batch_code}`)
      await loadAlerts()
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError('Không thể tiêu hủy.')
    } finally {
      setDisposingBatchId(null)
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

  const filteredEntries = getFilteredEntries()

  const daysLabel = (days: number) => {
    if (days < 0) return `Hết hạn ${Math.abs(days)} ngày`
    if (days === 0) return 'Hết hạn hôm nay'
    return `Còn ${days} ngày`
  }

  const daysStyle = (days: number) => {
    if (days < 0) return 'text-coral-500 font-semibold'
    if (days < 30) return 'text-sun-600 font-semibold'
    return 'text-ink-700'
  }

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
          <button type="button" onClick={handleExport} disabled={filteredEntries.length === 0} className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            Xuất Excel
          </button>
        </div>
      </header>

      {notice ? <p className="text-sm text-brand-600">{notice}</p> : null}
      {error ? <p className="text-sm text-coral-500">{error}</p> : null}

      {/* Stat cards */}
      {alerts ? (
        <section className="grid gap-3 grid-cols-2 xl:grid-cols-4">
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
            <p className="mt-3 text-2xl font-semibold text-sun-600">{alerts.totals.expiring_soon}</p>
          </button>
          <button
            type="button"
            onClick={() => setFilter('near_date')}
            className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'near_date' ? 'ring-2 ring-amber-400' : ''}`}
          >
            <p className="text-xs uppercase tracking-[0.25em] text-amber-600">Cận date</p>
            <p className="mt-3 text-2xl font-semibold text-amber-600">{alerts.totals.near_date}</p>
          </button>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`glass-card rounded-3xl p-5 text-left transition ${filter === 'all' ? 'ring-2 ring-ink-900' : ''}`}
          >
            <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Tất cả</p>
            <p className="mt-3 text-2xl font-semibold text-ink-900">
              {alerts.totals.expired + alerts.totals.expiring_soon + alerts.totals.near_date}
            </p>
          </button>
        </section>
      ) : null}

      {/* Filters + Table */}
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
                  const rowBg = days < 0 ? 'bg-coral-500/5' : days < 30 ? 'bg-sun-500/5' : ''

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
                            disabled={disposingBatchId === entry.batch.id}
                            onClick={() => void handleDispose(entry)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-700 disabled:opacity-60"
                          >
                            {disposingBatchId === entry.batch.id ? 'Đang xử lý...' : 'Tiêu hủy'}
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
    </div>
  )
}
