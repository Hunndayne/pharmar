import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { LotLabelPrintPage, type LabelPrintLot } from '../components/labels/LotLabelPrintPage'
import {
  inventoryApi,
  type InventoryBatch,
  type InventoryMetaUnit,
  type InventoryStockDrugDetail,
  type InventoryStockDrugPagedResponse,
  type InventoryStockListItem,
  type InventoryStockStatus,
} from '../api/inventoryService'
import { storeApi } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { downloadCsv } from '../utils/csv'
import { exportToExcel } from '../utils/exportFile'
import { formatDateInAppTimeZone as formatDate } from '../utils/timezone'

type UnitConfig = {
  importUnit: { name: string; ratio: number } | null
  middleUnit: { name: string; ratio: number } | null
  retailUnit: { name: string; ratio: 1 }
}

type QuickFilter = 'all' | 'out' | 'near' | 'expired'
type AdjustModalState = { batchId: string; operation: 'add' | 'subtract'; importQty: string; middleQty: string; retailQty: string }
type StockDrugRow = { item: InventoryStockListItem; units: UnitConfig; nearDays: number | null }
type StockBatchContext = { batch: InventoryBatch; drugName: string; units: UnitConfig }
type LotExportRow = {
  drugCode: string
  drugName: string
  batch: InventoryBatch
  units: UnitConfig
  nearDays: number
  supplierContact: string
  supplierAddress: string
  highestUnitPrice: number
}

const DEFAULT_EXPIRY_WARNING_DAYS = 30
const DEFAULT_NEAR_EXPIRY_DAYS = 90
const STORE_NAME = 'Nhà thuốc Thanh Huy'
const defaultUnitConfig: UnitConfig = { importUnit: null, middleUnit: null, retailUnit: { name: 'Đơn vị', ratio: 1 } }

const daysUntil = (value: string) => Math.floor((new Date(`${value}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / (1000 * 60 * 60 * 24))
const parseSafeInt = (value: string) => { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0 }
const parseConfigInt = (value: unknown, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback }
const normalizeRatio = (conversion: number, retailConversion: number) => Math.max(1, Math.round(conversion / retailConversion) || 1)
const isVisibleBatchInDrugDetail = (batch: InventoryBatch) => batch.status !== 'cancelled' && batch.qty_remaining > 0
const highestUnitPrice = (batch: InventoryBatch) => !batch.unit_prices.length ? batch.import_price : batch.unit_prices.slice().sort((a, b) => b.conversion - a.conversion)[0]?.price ?? batch.import_price
const formatStockStatusLabel = (status: InventoryStockStatus) => status === 'out_of_stock' ? 'Hết hàng' : status === 'expired' ? 'Hết hạn' : status === 'expiring_soon' ? 'Sắp hết hạn' : status === 'near_date' ? 'Cận date' : status === 'low_stock' ? 'Tồn thấp' : 'Bình thường'
const stockStatusBadgeClass = (status: InventoryStockStatus) => status === 'out_of_stock' || status === 'expired' ? 'bg-coral-500/10 text-coral-500' : status === 'expiring_soon' || status === 'low_stock' ? 'bg-amber-500/10 text-amber-700' : status === 'near_date' ? 'bg-sun-500/10 text-sun-500' : 'bg-brand-500/10 text-brand-700'
const expiryToneClass = (days: number | null, warningDays: number, nearDays: number) => days === null ? 'text-ink-500' : days < warningDays ? 'text-coral-500' : days <= nearDays ? 'text-sun-500' : 'text-ink-500'
const formatDaysLeft = (days: number) => days < 0 ? `Quá hạn ${Math.abs(days)} ngày` : `Còn ${days.toLocaleString('vi-VN')} ngày`
const formatBreakdown = (quantityRetail: number, units: UnitConfig) => quantityBreakdown(quantityRetail, units).map((item) => `${item.value} ${item.label}`).join(' · ')

const toUnitConfigFromUnits = (rawUnits: Array<Pick<InventoryMetaUnit, 'name' | 'conversion'>>): UnitConfig => {
  const deduped = new Map<number, { name: string; conversion: number }>()
  rawUnits.map((item) => ({ name: item.name, conversion: Math.max(1, item.conversion) })).filter((item) => Boolean(item.name)).forEach((item) => { if (!deduped.has(item.conversion)) deduped.set(item.conversion, item) })
  const sorted = Array.from(deduped.values()).sort((a, b) => a.conversion - b.conversion)
  if (!sorted.length) return defaultUnitConfig
  const retailRaw = sorted[0]
  if (sorted.length === 1) return { importUnit: null, middleUnit: null, retailUnit: { name: retailRaw.name, ratio: 1 } }
  if (sorted.length === 2) return { importUnit: { name: sorted[1].name, ratio: normalizeRatio(sorted[1].conversion, retailRaw.conversion) }, middleUnit: null, retailUnit: { name: retailRaw.name, ratio: 1 } }
  return {
    importUnit: { name: sorted[sorted.length - 1].name, ratio: normalizeRatio(sorted[sorted.length - 1].conversion, retailRaw.conversion) },
    middleUnit: { name: sorted[sorted.length - 2].name, ratio: normalizeRatio(sorted[sorted.length - 2].conversion, retailRaw.conversion) },
    retailUnit: { name: retailRaw.name, ratio: 1 },
  }
}

const quantityBreakdown = (quantityRetail: number, units: UnitConfig) => {
  let remaining = Math.max(0, Math.floor(quantityRetail))
  const parts: { label: string; value: number }[] = []
  if (units.importUnit) { const count = Math.floor(remaining / units.importUnit.ratio); parts.push({ label: units.importUnit.name, value: count }); remaining -= count * units.importUnit.ratio }
  if (units.middleUnit) { const count = Math.floor(remaining / units.middleUnit.ratio); parts.push({ label: units.middleUnit.name, value: count }); remaining -= count * units.middleUnit.ratio }
  parts.push({ label: units.retailUnit.name, value: remaining })
  return parts
}

export function Inventory() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canAdjust = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [stockItems, setStockItems] = useState<InventoryStockListItem[]>([])
  const [stockSummary, setStockSummary] = useState<InventoryStockDrugPagedResponse['summary']>({ total_drugs: 0, out_of_stock: 0, near_date: 0, expired: 0 })
  const [stockDetailsByDrugId, setStockDetailsByDrugId] = useState<Record<string, InventoryStockDrugDetail>>({})
  const [loadingDetailDrugId, setLoadingDetailDrugId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expiryWarningDays, setExpiryWarningDays] = useState(DEFAULT_EXPIRY_WARNING_DAYS)
  const [nearExpiryDays, setNearExpiryDays] = useState(DEFAULT_NEAR_EXPIRY_DAYS)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [totalItems, setTotalItems] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [expandedDrugId, setExpandedDrugId] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<AdjustModalState | null>(null)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [printingLot, setPrintingLot] = useState<LabelPrintLot | null>(null)

  const pageSize = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 10 : 20, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const loadInventory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [stockPage, inventorySettings] = await Promise.all([
        inventoryApi.listStockDrugsPaged({ page, size: pageSize, search: debouncedSearch || undefined, exp_from: expFrom || undefined, exp_to: expTo || undefined, quick_filter: quickFilter }),
        storeApi.getSettingsByGroup(accessToken, 'inventory').catch(() => ({} as Record<string, unknown>)),
      ])
      setStockItems(stockPage.items)
      setStockSummary(stockPage.summary)
      setTotalItems(stockPage.total)
      setTotalPages(Math.max(1, stockPage.pages))
      setPage(stockPage.page)
      const nextExpiryWarningDays = parseConfigInt(inventorySettings['inventory.expiry_warning_days'], DEFAULT_EXPIRY_WARNING_DAYS)
      setExpiryWarningDays(nextExpiryWarningDays)
      setNearExpiryDays(Math.max(nextExpiryWarningDays, parseConfigInt(inventorySettings['inventory.near_date_days'], DEFAULT_NEAR_EXPIRY_DAYS)))
    } catch (loadError) {
      setError(loadError instanceof ApiError ? loadError.message : 'Không thể tải dữ liệu tồn kho.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, debouncedSearch, expFrom, expTo, page, pageSize, quickFilter])

  useEffect(() => { void loadInventory() }, [loadInventory])

  const stockRows = useMemo<StockDrugRow[]>(() => stockItems.map((item) => ({ item, units: toUnitConfigFromUnits(item.units), nearDays: item.days_to_nearest_expiry })), [stockItems])
  const lotRows = useMemo<LotExportRow[]>(
    () => Object.values(stockDetailsByDrugId).flatMap((detail) => {
      const units = toUnitConfigFromUnits(detail.drug.units)
      return detail.batches
        .filter(isVisibleBatchInDrugDetail)
        .map((batch) => ({
          drugCode: detail.drug.code,
          drugName: detail.drug.name,
          batch,
          units,
          nearDays: daysUntil(batch.exp_date),
          supplierContact: batch.supplier_contact || '-',
          supplierAddress: '-',
          highestUnitPrice: highestUnitPrice(batch),
        }))
    }),
    [stockDetailsByDrugId],
  )

  const loadDrugDetail = useCallback(async (drugId: string) => {
    if (stockDetailsByDrugId[drugId]) return
    setLoadingDetailDrugId(drugId)
    try {
      const detail = await inventoryApi.getStockDrugDetail(drugId, accessToken || undefined)
      setStockDetailsByDrugId((prev) => ({ ...prev, [drugId]: detail }))
    } catch (detailError) {
      setError(detailError instanceof ApiError ? detailError.message : 'Không thể tải chi tiết tồn kho theo lô.')
    } finally {
      setLoadingDetailDrugId((prev) => (prev === drugId ? null : prev))
    }
  }, [accessToken, stockDetailsByDrugId])

  const toggleDrugDetail = useCallback((drugId: string) => {
    const nextExpanded = expandedDrugId === drugId ? null : drugId
    setExpandedDrugId(nextExpanded)
    if (nextExpanded && !stockDetailsByDrugId[drugId]) void loadDrugDetail(drugId)
  }, [expandedDrugId, loadDrugDetail, stockDetailsByDrugId])

  useEffect(() => { if (expandedDrugId && !stockRows.some((row) => row.item.drug_id === expandedDrugId)) setExpandedDrugId(null) }, [expandedDrugId, stockRows])

  const currentAdjustContext = useMemo<StockBatchContext | null>(() => {
    if (!adjusting) return null
    for (const detail of Object.values(stockDetailsByDrugId)) {
      const batch = detail.batches.find((item) => item.id === adjusting.batchId && isVisibleBatchInDrugDetail(item))
      if (batch) return { batch, drugName: detail.drug.name, units: toUnitConfigFromUnits(detail.drug.units) }
    }
    return null
  }, [adjusting, stockDetailsByDrugId])

  const applyAdjustment = async () => {
    if (!adjusting || !currentAdjustContext) return
    if (!accessToken) { setAdjustError('Bạn cần đăng nhập để điều chỉnh tồn kho.'); return }
    const deltaRetail = parseSafeInt(adjusting.importQty) * (currentAdjustContext.units.importUnit?.ratio ?? 0) + parseSafeInt(adjusting.middleQty) * (currentAdjustContext.units.middleUnit?.ratio ?? 0) + parseSafeInt(adjusting.retailQty)
    if (deltaRetail <= 0) { setAdjustError('Cần nhập số lượng điều chỉnh lớn hơn 0.'); return }
    if (adjusting.operation === 'subtract' && deltaRetail > currentAdjustContext.batch.qty_remaining) { setAdjustError('Số lượng trừ vượt quá tồn hiện tại của lô.'); return }
    setAdjustSubmitting(true); setAdjustError(null)
    try {
      const response = await inventoryApi.adjustStock(accessToken, { batch_id: currentAdjustContext.batch.id, reason: 'inventory_count', note: 'Điều chỉnh tồn kho từ giao diện', quantity_delta: adjusting.operation === 'add' ? deltaRetail : -deltaRetail })
      await loadInventory()
      try {
        const refreshedDetail = await inventoryApi.getStockDrugDetail(response.batch.drug_id, accessToken || undefined)
        setStockDetailsByDrugId((prev) => ({ ...prev, [response.batch.drug_id]: refreshedDetail }))
      } catch {
        setStockDetailsByDrugId((prev) => { const next = { ...prev }; delete next[response.batch.drug_id]; return next })
      }
      setAdjusting(null)
    } catch (adjustStockError) {
      setAdjustError(adjustStockError instanceof ApiError ? adjustStockError.message : 'Không thể điều chỉnh tồn kho.')
    } finally {
      setAdjustSubmitting(false)
    }
  }

  const exportInventoryExcel = () => {
    const headers = [
      'Mã thuốc',
      'Tên thuốc',
      'Mã lô',
      'Số lô NCC',
      'HSD',
      'Số ngày đến hạn',
      'Tồn (đơn vị bán lẻ)',
      'Quy đổi tồn',
      'Nhà phân phối',
      'Liên hệ NPP',
      'Địa chỉ NPP',
      'Giá đơn vị cao nhất',
      'Trạng thái',
    ]

    const rows = lotRows.map((row) => {
      const isExpired = row.nearDays < 0
      const isNearDate = row.nearDays >= 0 && row.nearDays <= nearExpiryDays && row.batch.qty_remaining > 0
      const isExpiringSoon =
        row.nearDays >= 0 && row.nearDays < expiryWarningDays && row.batch.qty_remaining > 0
      const status = row.batch.qty_remaining <= 0
        ? 'Hết hàng'
        : isExpired
          ? 'Hết hạn'
          : isExpiringSoon
            ? 'Sắp hết hạn'
            : isNearDate
              ? 'Cận date'
              : 'Bình thường'

      return [
        row.drugCode,
        row.drugName,
        row.batch.batch_code,
        row.batch.lot_number,
        formatDate(row.batch.exp_date),
        row.nearDays,
        `${row.batch.qty_remaining} ${row.units.retailUnit.name}`,
        quantityBreakdown(row.batch.qty_remaining, row.units)
          .map((item) => `${item.value} ${item.label}`)
          .join(' · '),
        row.batch.supplier_name,
        row.supplierContact,
        row.supplierAddress,
        row.highestUnitPrice,
        status,
      ]
    })

    const dateKey = new Date().toISOString().slice(0, 10)
    if (rows.length > 0) {
      exportToExcel(`ton-kho-theo-lo-${dateKey}`, 'Tồn kho theo lô', headers, rows)
    }
    downloadCsv(`ton-kho-theo-thuoc-${new Date().toISOString().slice(0, 10)}.csv`, ['Mã thuốc', 'Tên thuốc', 'Số lô đang có', 'HSD gần nhất', 'Số ngày đến hạn', 'Tồn', 'Quy đổi tồn', 'Trạng thái'], stockRows.map((row) => [row.item.drug_code, row.item.drug_name, row.item.active_batch_count, row.item.nearest_expiry ? formatDate(row.item.nearest_expiry) : '-', row.nearDays ?? '-', `${row.item.total_qty} ${row.units.retailUnit.name}`, quantityBreakdown(row.item.total_qty, row.units).map((item) => `${item.value} ${item.label}`).join(' · '), formatStockStatusLabel(row.item.status)]))
  }

  const openAdjust = (batchId: string) => { setAdjustError(null); setAdjusting({ batchId, operation: 'subtract', importQty: '', middleQty: '', retailQty: '' }) }
  const openPrint = (row: StockDrugRow, batch: InventoryBatch) => setPrintingLot({ id: batch.id, code: batch.batch_code, qrValue: batch.batch_code, productName: row.item.drug_name, price: highestUnitPrice(batch), defaultCount: 1 })

  const renderDrugDetailContent = (row: StockDrugRow, layout: 'cards' | 'table') => {
    const detail = stockDetailsByDrugId[row.item.drug_id]
    if (loadingDetailDrugId === row.item.drug_id && !detail) return <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-4 text-sm text-ink-600">Đang tải chi tiết các lô...</div>
    if (!detail) return <div className="rounded-2xl border border-ink-900/10 bg-white px-4 py-4 text-sm text-ink-600">Chưa tải chi tiết lô.</div>
    const detailUnits = toUnitConfigFromUnits(detail.drug.units)
    const visibleBatches = detail.batches.filter(isVisibleBatchInDrugDetail)
    if (!visibleBatches.length) return <div className="rounded-2xl border border-dashed border-ink-900/15 bg-white px-4 py-4 text-sm text-ink-600">Thuốc hiện không còn lô còn tồn.</div>
    if (layout === 'table') {
      return (
        <div className="overflow-hidden rounded-2xl border border-ink-900/10 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-ink-900/10 bg-fog-50 text-xs text-ink-500">
                <th className="px-4 py-2 font-medium">Số lô</th>
                <th className="px-4 py-2 font-medium">Lô NCC</th>
                <th className="px-4 py-2 font-medium">Hạn dùng</th>
                <th className="px-4 py-2 text-right font-medium">Tồn</th>
                <th className="px-4 py-2 font-medium">Nhà phân phối</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {visibleBatches.map((batch) => {
                const batchNearDays = daysUntil(batch.exp_date)
                return (
                  <tr key={batch.id} className="border-b border-ink-900/5 last:border-0">
                    <td className="px-4 py-3 font-semibold text-ink-900">{batch.batch_code}</td>
                    <td className="px-4 py-3 text-ink-700">{batch.lot_number || '-'}</td>
                    <td className="px-4 py-3">
                      <p className="text-ink-900">{formatDate(batch.exp_date)}</p>
                      <p className={`text-xs ${expiryToneClass(batchNearDays, expiryWarningDays, nearExpiryDays)}`}>{formatDaysLeft(batchNearDays)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p className="font-semibold tabular-nums text-ink-900">{batch.qty_remaining.toLocaleString('vi-VN')} {detailUnits.retailUnit.name}</p>
                      {detailUnits.importUnit ? <p className="text-xs text-ink-500">{formatBreakdown(batch.qty_remaining, detailUnits)}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-ink-900">{batch.supplier_name || '-'}</p>
                      {batch.supplier_contact ? <p className="text-xs text-ink-500">{batch.supplier_contact}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => openAdjust(batch.id)} disabled={!canAdjust} className="whitespace-nowrap rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 transition hover:border-ink-900/25 disabled:opacity-50">Điều chỉnh</button>
                        <button type="button" onClick={() => openPrint(row, batch)} className="whitespace-nowrap rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 transition hover:border-ink-900/25">In QR</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )
    }
    return (
      <div className="grid gap-3 lg:grid-cols-2">
        {visibleBatches.map((batch) => {
          const batchNearDays = daysUntil(batch.exp_date)
          const breakdown = quantityBreakdown(batch.qty_remaining, detailUnits)
          return (
            <article key={batch.id} className="rounded-2xl border border-ink-900/10 bg-white p-4 text-sm text-ink-700">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-xs uppercase tracking-[0.2em] text-ink-600">Số lô</p><h4 className="mt-1 text-base font-semibold text-ink-900">{batch.batch_code}</h4></div>
                <div className="text-right"><p className="text-xs uppercase tracking-[0.2em] text-ink-600">HSD</p><p className="mt-1 font-semibold text-ink-900">{formatDate(batch.exp_date)}</p></div>
              </div>
              <div className="mt-3 space-y-1 text-xs">
                <p><span className="font-semibold text-ink-900">Nhà phân phối:</span> {batch.supplier_name || '-'}</p>
                <p><span className="font-semibold text-ink-900">Liên hệ:</span> {batch.supplier_contact || '-'}</p>
                {batchNearDays < 0 ? <p className="font-semibold text-coral-500">Đã hết hạn {Math.abs(batchNearDays)} ngày</p> : null}
                {batchNearDays >= 0 && batchNearDays < expiryWarningDays ? <p className="font-semibold text-coral-500">Sắp hết hạn: còn {batchNearDays} ngày</p> : null}
                {batchNearDays >= expiryWarningDays && batchNearDays <= nearExpiryDays ? <p className="font-semibold text-sun-500">Còn {batchNearDays} ngày</p> : null}
              </div>
              <div className="mt-3 rounded-xl bg-fog-50 px-3 py-3 text-xs">
                <p><span className="font-semibold text-ink-900">Tồn:</span> {batch.qty_remaining.toLocaleString('vi-VN')} {detailUnits.retailUnit.name}</p>
                <p className="mt-1 text-ink-600">{breakdown.map((item) => `${item.value} ${item.label}`).join(' · ')}</p>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => openAdjust(batch.id)} disabled={!canAdjust} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50">Điều chỉnh tồn kho</button>
                <button type="button" onClick={() => openPrint(row, batch)} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">In QR</button>
              </div>
            </article>
          )
        })}
      </div>
    )
  }

  const rangeStart = totalItems === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = totalItems === 0 ? 0 : Math.min(page * pageSize, totalItems)

  if (printingLot) {
    return <LotLabelPrintPage title={`In QR lô ${printingLot.code}`} subtitle="Tem in từ trang tồn kho" storeName={STORE_NAME} labelWidthMm={50.8} labelHeightMm={25.4} lots={[printingLot]} onBack={() => setPrintingLot(null)} backLabel="Quay lại tồn kho" />
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs uppercase tracking-[0.35em] text-ink-600">Kho</p><h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">Tồn kho theo thuốc</h2></div>
        <button type="button" onClick={exportInventoryExcel} disabled={loading || stockRows.length === 0} className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60">Xuất Excel</button>
      </header>

      {error ? <div className="glass-card rounded-2xl px-4 py-3 text-sm text-coral-500">{error}</div> : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([
          ['all', 'Tổng mặt hàng', stockSummary.total_drugs, 'text-ink-900'],
          ['out', 'Hết hàng', stockSummary.out_of_stock, 'text-coral-500'],
          ['near', 'Cận date', stockSummary.near_date, 'text-sun-500'],
          ['expired', 'Hết hạn', stockSummary.expired, 'text-coral-500'],
        ] as const).map(([value, label, count, tone]) => (
          <button key={value} type="button" onClick={() => { setQuickFilter(value); setPage(1) }} className={`glass-card min-w-0 rounded-2xl p-4 text-left transition sm:rounded-3xl sm:p-5 ${quickFilter === value ? 'ring-2 ring-brand-500/50' : 'hover:ring-1 hover:ring-ink-900/10'}`}>
            <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.24em]">{label}</p>
            <p className={`mt-2 text-2xl font-semibold sm:text-3xl ${tone}`}>{count.toLocaleString('vi-VN')}</p>
          </button>
        ))}
      </section>

      <section className="glass-card space-y-4 rounded-3xl p-4 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="block min-w-0 md:flex-1">
            <span className="mb-1 hidden text-xs font-medium text-ink-500 md:block">Tìm kiếm</span>
            <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Mã thuốc, tên thuốc, số lô, nhà phân phối" className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm" />
          </label>
          <label className="hidden md:block md:w-44">
            <span className="mb-1 block text-xs font-medium text-ink-500">HSD từ ngày</span>
            <input type="date" value={expFrom} onChange={(event) => { setExpFrom(event.target.value); setPage(1) }} className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-sm" />
          </label>
          <label className="hidden md:block md:w-44">
            <span className="mb-1 block text-xs font-medium text-ink-500">đến ngày</span>
            <input type="date" value={expTo} onChange={(event) => { setExpTo(event.target.value); setPage(1) }} className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-sm" />
          </label>
          <div className="hidden gap-2 md:flex">
            <button type="button" onClick={() => { setSearch(''); setQuickFilter('all'); setExpFrom(''); setExpTo(''); setPage(1) }} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-700 transition hover:border-ink-900/25">Xóa lọc</button>
            <button type="button" onClick={() => void loadInventory()} disabled={loading} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition hover:border-ink-900/25 disabled:opacity-60">{loading ? 'Đang tải' : 'Tải lại'}</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 md:hidden">
          <button type="button" onClick={() => setMobileFiltersOpen((prev) => !prev)} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">{mobileFiltersOpen ? 'Ẩn bộ lọc' : 'Bộ lọc nâng cao'}</button>
          <button type="button" onClick={() => void loadInventory()} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">Tải lại</button>
        </div>
        {mobileFiltersOpen ? (
          <div className="grid grid-cols-1 gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={expFrom} onChange={(event) => { setExpFrom(event.target.value); setPage(1) }} className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-xs" />
              <input type="date" value={expTo} onChange={(event) => { setExpTo(event.target.value); setPage(1) }} className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-xs" />
            </div>
            <button type="button" onClick={() => { setSearch(''); setQuickFilter('all'); setExpFrom(''); setExpTo(''); setPage(1) }} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">Reset</button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        {loading && stockRows.length === 0 ? <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">Đang tải dữ liệu tồn kho...</div> : null}
        {!loading && stockRows.length === 0 ? <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">Không có dữ liệu phù hợp bộ lọc.</div> : null}

        {stockRows.length > 0 ? (
          <div className={`glass-card hidden overflow-hidden rounded-3xl transition-opacity sm:block ${loading ? 'opacity-60' : ''}`}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ink-900/10 text-xs text-ink-500">
                    <th className="px-5 py-3 font-medium">Thuốc</th>
                    <th className="px-5 py-3 text-right font-medium">Tồn kho</th>
                    <th className="px-5 py-3 text-center font-medium">Số lô</th>
                    <th className="px-5 py-3 font-medium">HSD gần nhất</th>
                    <th className="px-5 py-3 font-medium">Trạng thái</th>
                    <th className="w-12 px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map((row) => {
                    const isExpanded = expandedDrugId === row.item.drug_id
                    return (
                      <Fragment key={row.item.drug_id}>
                        <tr onClick={() => toggleDrugDetail(row.item.drug_id)} className={`cursor-pointer border-b border-ink-900/5 transition-colors ${isExpanded ? 'bg-white/90' : 'hover:bg-white/60'}`}>
                          <td className="px-5 py-3">
                            <p className="font-semibold text-ink-900">{row.item.drug_name}</p>
                            <p className="text-xs text-ink-500">{row.item.drug_code}{row.item.drug_group ? ` · ${row.item.drug_group}` : ''}</p>
                          </td>
                          <td className="px-5 py-3 text-right">
                            <p className="font-semibold tabular-nums text-ink-900">{row.item.total_qty.toLocaleString('vi-VN')} {row.units.retailUnit.name}</p>
                            {row.units.importUnit && row.item.total_qty > 0 ? <p className="text-xs text-ink-500">{formatBreakdown(row.item.total_qty, row.units)}</p> : null}
                          </td>
                          <td className="px-5 py-3 text-center tabular-nums text-ink-700">{row.item.active_batch_count}</td>
                          <td className="px-5 py-3">
                            {row.item.nearest_expiry ? (
                              <>
                                <p className="text-ink-900">{formatDate(row.item.nearest_expiry)}</p>
                                {row.nearDays !== null ? <p className={`text-xs ${expiryToneClass(row.nearDays, expiryWarningDays, nearExpiryDays)}`}>{formatDaysLeft(row.nearDays)}</p> : null}
                              </>
                            ) : <span className="text-ink-400">-</span>}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${stockStatusBadgeClass(row.item.status)}`}>{formatStockStatusLabel(row.item.status)}</span>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <button type="button" onClick={(event) => { event.stopPropagation(); toggleDrugDetail(row.item.drug_id) }} aria-expanded={isExpanded} aria-label={isExpanded ? 'Ẩn chi tiết lô' : 'Xem chi tiết lô'} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-500 transition hover:bg-ink-900/5 hover:text-ink-900">
                              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} aria-hidden="true"><path d="M5 7.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            </button>
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="border-b border-ink-900/5 bg-white/90">
                            <td colSpan={6} className="px-5 pb-4 pt-1">{renderDrugDetailContent(row, 'table')}</td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className={`space-y-3 sm:hidden ${loading ? 'opacity-60' : ''}`}>
        {stockRows.map((row) => {
          const breakdown = quantityBreakdown(row.item.total_qty, row.units)
          const isExpanded = expandedDrugId === row.item.drug_id
          return (
            <article key={row.item.drug_id} className="rounded-2xl border border-ink-900/10 bg-white/80 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold tracking-wide text-ink-600">{row.item.drug_code}</p>
                  <h4 className="mt-1 text-base font-semibold text-ink-900">{row.item.drug_name}</h4>
                </div>
                <button type="button" onClick={() => toggleDrugDetail(row.item.drug_id)} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">{isExpanded ? 'Ẩn' : 'Chi tiết'}</button>
              </div>

              <div className="mt-3 grid gap-3 text-xs text-ink-700 sm:grid-cols-3">
                <div><span className="font-semibold text-ink-900">Số lô đang có:</span> {row.item.active_batch_count}</div>
                <div><span className="font-semibold text-ink-900">HSD gần nhất:</span> {row.item.nearest_expiry ? formatDate(row.item.nearest_expiry) : '-'}</div>
                <div><span className="font-semibold text-ink-900">Trạng thái:</span> {formatStockStatusLabel(row.item.status)}</div>
              </div>

              <div className="mt-3 rounded-xl bg-fog-50 px-3 py-3 text-xs text-ink-700">
                <p><span className="font-semibold text-ink-900">Tồn:</span> {row.item.total_qty.toLocaleString('vi-VN')} {row.units.retailUnit.name}</p>
                <p className="mt-1 text-ink-600">{breakdown.map((item) => `${item.value} ${item.label}`).join(' · ')}</p>
              </div>

              {isExpanded ? <div className="mt-3 rounded-xl border border-ink-900/10 bg-white p-3 text-xs text-ink-700">{renderDrugDetailContent(row, 'cards')}</div> : null}
            </article>
          )
        })}
        </div>
      </section>

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>Hiển thị {rangeStart} - {rangeEnd} trong {totalItems} thuốc</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900" disabled={page <= 1}>Trước</button>
          <span>{page}/{totalPages}</span>
          <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900" disabled={page >= totalPages}>Sau</button>
        </div>
      </section>

      {adjusting && currentAdjustContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5"><p className="text-xs uppercase tracking-[0.24em] text-ink-600">Điều chỉnh tồn kho</p><h3 className="mt-2 text-2xl font-semibold text-ink-900">{currentAdjustContext.drugName} · {currentAdjustContext.batch.batch_code}</h3></div>
            <div className="space-y-4 px-6 py-5">
              <div className="grid gap-3 md:grid-cols-[1fr,1fr]">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Thao tác</span>
                  <select value={adjusting.operation} onChange={(event) => setAdjusting((prev) => prev ? { ...prev, operation: event.target.value as 'add' | 'subtract' } : prev)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2">
                    <option value="subtract">Trừ tồn</option>
                    <option value="add">Cộng tồn</option>
                  </select>
                </label>
                <div className="rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-3 text-sm text-ink-700">Tồn hiện tại: <span className="font-semibold text-ink-900">{currentAdjustContext.batch.qty_remaining.toLocaleString('vi-VN')} {currentAdjustContext.units.retailUnit.name}</span></div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                {currentAdjustContext.units.importUnit ? <label className="space-y-1 text-xs text-ink-600">{currentAdjustContext.units.importUnit.name}<input value={adjusting.importQty} onChange={(event) => setAdjusting((prev) => prev ? { ...prev, importQty: event.target.value.replace(/\D+/g, '') } : prev)} className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" placeholder="0" /></label> : <div />}
                {currentAdjustContext.units.middleUnit ? <label className="space-y-1 text-xs text-ink-600">{currentAdjustContext.units.middleUnit.name}<input value={adjusting.middleQty} onChange={(event) => setAdjusting((prev) => prev ? { ...prev, middleQty: event.target.value.replace(/\D+/g, '') } : prev)} className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" placeholder="0" /></label> : <div />}
                <label className="space-y-1 text-xs text-ink-600">{currentAdjustContext.units.retailUnit.name}<input value={adjusting.retailQty} onChange={(event) => setAdjusting((prev) => prev ? { ...prev, retailQty: event.target.value.replace(/\D+/g, '') } : prev)} className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" placeholder="0" /></label>
              </div>
              {adjustError ? <p className="text-sm text-coral-500">{adjustError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button type="button" onClick={() => void applyAdjustment()} disabled={adjustSubmitting} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">{adjustSubmitting ? 'Đang xử lý...' : 'Xác nhận'}</button>
              <button type="button" onClick={() => { setAdjustError(null); setAdjusting(null) }} className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">Hủy</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
