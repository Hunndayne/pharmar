import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { LotLabelPrintPage, type LabelPrintLot } from '../components/labels/LotLabelPrintPage'
import {
  inventoryApi,
  type InventoryBatch,
  type InventoryMetaSupplier,
  type InventoryStockSummary,
} from '../api/inventoryService'
import { catalogApi, type ProductListItem } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type UnitConfig = {
  importUnit: { name: string; ratio: number } | null
  middleUnit: { name: string; ratio: number } | null
  retailUnit: { name: string; ratio: 1 }
}

type QuickFilter = 'all' | 'out' | 'near' | 'expired'

type AdjustModalState = {
  batchId: string
  operation: 'add' | 'subtract'
  importQty: string
  middleQty: string
  retailQty: string
}

type LotRow = {
  batch: InventoryBatch
  drugCode: string
  drugName: string
  units: UnitConfig
  supplierContact: string
  supplierAddress: string
  highestUnitPrice: number
  nearDays: number
}

const NEAR_EXPIRY_DAYS = 60
const STORE_NAME = 'Nhà thuốc Thanh Huy'
const defaultUnitConfig: UnitConfig = {
  importUnit: null,
  middleUnit: null,
  retailUnit: { name: 'Đơn vị', ratio: 1 },
}

const toDate = (value: string) => new Date(`${value}T00:00:00`)

const daysUntil = (value: string) => {
  const target = toDate(value).getTime()
  const now = new Date(new Date().toDateString()).getTime()
  return Math.floor((target - now) / (1000 * 60 * 60 * 24))
}

const formatDate = (value: string) => {
  const [y, m, d] = value.split('-')
  if (!y || !m || !d) return value
  return `${d}/${m}/${y}`
}

const parseSafeInt = (value: string) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const normalizeRatio = (conversion: number, retailConversion: number) => {
  const ratio = Math.round(conversion / retailConversion)
  return Math.max(1, Number.isFinite(ratio) ? ratio : 1)
}

const toUnitConfigFromBatch = (batch: InventoryBatch): UnitConfig => {
  const rawUnits = (batch.unit_prices ?? [])
    .map((item) => ({
      name: item.unit_name,
      conversion: Math.max(1, item.conversion),
    }))
    .filter((item) => Boolean(item.name))

  if (rawUnits.length === 0) return defaultUnitConfig

  const uniqueByConversion = new Map<number, { name: string; conversion: number }>()
  rawUnits.forEach((item) => {
    if (!uniqueByConversion.has(item.conversion)) {
      uniqueByConversion.set(item.conversion, item)
    }
  })

  const sorted = Array.from(uniqueByConversion.values()).sort((a, b) => a.conversion - b.conversion)
  const retailRaw = sorted[0]
  const retailConversion = retailRaw.conversion

  if (sorted.length === 1) {
    return {
      importUnit: null,
      middleUnit: null,
      retailUnit: { name: retailRaw.name, ratio: 1 },
    }
  }

  if (sorted.length === 2) {
    const importRaw = sorted[1]
    return {
      importUnit: {
        name: importRaw.name,
        ratio: normalizeRatio(importRaw.conversion, retailConversion),
      },
      middleUnit: null,
      retailUnit: { name: retailRaw.name, ratio: 1 },
    }
  }

  const importRaw = sorted[sorted.length - 1]
  const middleRaw = sorted[sorted.length - 2]

  return {
    importUnit: {
      name: importRaw.name,
      ratio: normalizeRatio(importRaw.conversion, retailConversion),
    },
    middleUnit: {
      name: middleRaw.name,
      ratio: normalizeRatio(middleRaw.conversion, retailConversion),
    },
    retailUnit: { name: retailRaw.name, ratio: 1 },
  }
}

const quantityBreakdown = (quantityRetail: number, units: UnitConfig) => {
  let remaining = Math.max(0, Math.floor(quantityRetail))
  const parts: { label: string; value: number }[] = []

  if (units.importUnit) {
    const count = Math.floor(remaining / units.importUnit.ratio)
    parts.push({ label: units.importUnit.name, value: count })
    remaining -= count * units.importUnit.ratio
  }

  if (units.middleUnit) {
    const count = Math.floor(remaining / units.middleUnit.ratio)
    parts.push({ label: units.middleUnit.name, value: count })
    remaining -= count * units.middleUnit.ratio
  }

  parts.push({ label: units.retailUnit.name, value: remaining })
  return parts
}

const highestUnitPrice = (batch: InventoryBatch) => {
  if (!Array.isArray(batch.unit_prices) || batch.unit_prices.length === 0) {
    return batch.import_price
  }

  const sorted = batch.unit_prices.slice().sort((a, b) => b.conversion - a.conversion)
  return sorted[0]?.price ?? batch.import_price
}

const loadCatalogProducts = async (accessToken: string) => {
  const size = 200
  let page = 1
  let pages = 1
  const result: ProductListItem[] = []

  while (page <= pages) {
    const response = await catalogApi.listProducts(accessToken, { page, size })
    result.push(...response.items)
    pages = Math.max(1, response.pages)
    page += 1
  }

  return result
}

export function Inventory() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canAdjust = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [batches, setBatches] = useState<InventoryBatch[]>([])
  const [stockSummary, setStockSummary] = useState<InventoryStockSummary[]>([])
  const [metaSuppliers, setMetaSuppliers] = useState<InventoryMetaSupplier[]>([])
  const [catalogProducts, setCatalogProducts] = useState<ProductListItem[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')

  const [expandedLotId, setExpandedLotId] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<AdjustModalState | null>(null)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [printingLot, setPrintingLot] = useState<LabelPrintLot | null>(null)

  const loadInventory = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [nextBatches, nextSummary, nextSuppliers, nextProducts] = await Promise.all([
        inventoryApi.listBatches(),
        inventoryApi.getStockSummary(accessToken || undefined),
        inventoryApi.getMetaSuppliers(),
        accessToken ? loadCatalogProducts(accessToken) : Promise.resolve([] as ProductListItem[]),
      ])

      setBatches(nextBatches)
      setStockSummary(nextSummary)
      setMetaSuppliers(nextSuppliers)
      setCatalogProducts(nextProducts)
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải dữ liệu tồn kho.')
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void loadInventory()
  }, [loadInventory])

  const productByCode = useMemo(
    () => new Map(catalogProducts.map((item) => [item.code.toUpperCase(), item])),
    [catalogProducts],
  )
  const supplierById = useMemo(() => new Map(metaSuppliers.map((item) => [item.id, item])), [metaSuppliers])

  const lotRows = useMemo<LotRow[]>(() => {
    const keyword = search.trim().toLowerCase()

    return batches
      .map((batch) => {
        const product = productByCode.get(batch.drug_code.toUpperCase())
        const supplier = supplierById.get(batch.supplier_id)
        const units = toUnitConfigFromBatch(batch)

        return {
          batch,
          drugCode: product?.code ?? batch.drug_code,
          drugName: product?.name ?? batch.drug_name,
          units,
          supplierContact:
            supplier ? `${supplier.contact_name} - ${supplier.phone}` : batch.supplier_contact,
          supplierAddress: supplier?.address ?? '-',
          highestUnitPrice: highestUnitPrice(batch),
          nearDays: daysUntil(batch.exp_date),
        }
      })
      .filter((row) => {
        const matchKeyword =
          !keyword ||
          row.drugCode.toLowerCase().includes(keyword) ||
          row.drugName.toLowerCase().includes(keyword) ||
          row.batch.batch_code.toLowerCase().includes(keyword) ||
          row.batch.lot_number.toLowerCase().includes(keyword) ||
          row.batch.supplier_name.toLowerCase().includes(keyword)

        const matchQuick =
          quickFilter === 'all'
            ? true
            : quickFilter === 'out'
              ? row.batch.qty_remaining <= 0
              : quickFilter === 'near'
                ? row.nearDays >= 0 && row.nearDays <= NEAR_EXPIRY_DAYS && row.batch.qty_remaining > 0
                : row.nearDays < 0 && row.batch.qty_remaining > 0

        const matchFrom = !expFrom || row.batch.exp_date >= expFrom
        const matchTo = !expTo || row.batch.exp_date <= expTo

        return matchKeyword && matchQuick && matchFrom && matchTo
      })
      .sort((a, b) => {
        const expCompare = a.batch.exp_date.localeCompare(b.batch.exp_date)
        if (expCompare !== 0) return expCompare
        return a.batch.batch_code.localeCompare(b.batch.batch_code)
      })
  }, [batches, expFrom, expTo, productByCode, quickFilter, search, supplierById])

  const stats = useMemo(() => {
    if (stockSummary.length > 0) {
      return {
        totalDrugs: stockSummary.length,
        outOfStock: stockSummary.filter((row) => row.status === 'out_of_stock').length,
        nearDate: stockSummary.filter((row) => row.status === 'near_date' || row.status === 'expiring_soon').length,
        expired: stockSummary.filter((row) => row.status === 'expired').length,
      }
    }

    const uniqueDrugIds = new Set(batches.map((batch) => batch.drug_id))
    const outOfStock = batches.filter((batch) => batch.qty_remaining <= 0).length
    const nearDate = batches.filter((batch) => {
      const days = daysUntil(batch.exp_date)
      return days >= 0 && days <= NEAR_EXPIRY_DAYS
    }).length
    const expired = batches.filter((batch) => daysUntil(batch.exp_date) < 0 && batch.qty_remaining > 0).length

    return {
      totalDrugs: uniqueDrugIds.size,
      outOfStock,
      nearDate,
      expired,
    }
  }, [batches, stockSummary])

  const currentAdjustContext = useMemo(() => {
    if (!adjusting) return null
    return lotRows.find((row) => row.batch.id === adjusting.batchId) ?? null
  }, [adjusting, lotRows])

  const applyAdjustment = async () => {
    if (!adjusting || !currentAdjustContext) return
    if (!accessToken) {
      setAdjustError('Bạn cần đăng nhập để điều chỉnh tồn kho.')
      return
    }

    const importBase = adjusting.importQty ? parseSafeInt(adjusting.importQty) : 0
    const middleBase = adjusting.middleQty ? parseSafeInt(adjusting.middleQty) : 0
    const retailBase = adjusting.retailQty ? parseSafeInt(adjusting.retailQty) : 0

    const importRetail = importBase * (currentAdjustContext.units.importUnit?.ratio ?? 0)
    const middleRetail = middleBase * (currentAdjustContext.units.middleUnit?.ratio ?? 0)
    const deltaRetail = importRetail + middleRetail + retailBase

    if (deltaRetail <= 0) {
      setAdjustError('Cần nhập số lượng điều chỉnh lớn hơn 0.')
      return
    }

    if (
      adjusting.operation === 'subtract' &&
      deltaRetail > currentAdjustContext.batch.qty_remaining
    ) {
      setAdjustError('Số lượng trừ vượt quá tồn hiện tại của lô.')
      return
    }

    setAdjustSubmitting(true)
    setAdjustError(null)

    try {
      const quantityDelta = adjusting.operation === 'add' ? deltaRetail : -deltaRetail
      const response = await inventoryApi.adjustStock(accessToken, {
        batch_id: currentAdjustContext.batch.id,
        reason: 'inventory_count',
        note: 'Điều chỉnh tồn kho từ giao diện',
        quantity_delta: quantityDelta,
      })

      setBatches((prev) =>
        prev.map((item) => (item.id === response.batch.id ? response.batch : item)),
      )

      try {
        const summary = await inventoryApi.getStockSummary(accessToken)
        setStockSummary(summary)
      } catch {
        // Bỏ qua lỗi phụ, dữ liệu lô đã được cập nhật cục bộ.
      }

      setAdjusting(null)
      setAdjustError(null)
    } catch (adjustStockError) {
      if (adjustStockError instanceof ApiError) setAdjustError(adjustStockError.message)
      else setAdjustError('Không thể điều chỉnh tồn kho. Vui lòng thử lại.')
    } finally {
      setAdjustSubmitting(false)
    }
  }

  if (printingLot) {
    return (
      <LotLabelPrintPage
        title={`In QR lô ${printingLot.code}`}
        subtitle="Tem in từ trang tồn kho"
        storeName={STORE_NAME}
        labelWidthMm={50.8}
        labelHeightMm={25.4}
        lots={[printingLot]}
        onBack={() => setPrintingLot(null)}
        backLabel="Quay lại tồn kho"
      />
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Kho</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Tồn kho theo lô</h2>
      </header>

      {error ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-coral-500">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          onClick={() => setQuickFilter('all')}
          className={`glass-card rounded-3xl p-5 text-left ${quickFilter === 'all' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Tổng mặt hàng</p>
          <p className="mt-2 text-3xl font-semibold text-ink-900">{stats.totalDrugs}</p>
        </button>
        <button
          type="button"
          onClick={() => setQuickFilter('out')}
          className={`glass-card rounded-3xl p-5 text-left ${quickFilter === 'out' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Hết hàng</p>
          <p className="mt-2 text-3xl font-semibold text-coral-500">{stats.outOfStock}</p>
        </button>
        <button
          type="button"
          onClick={() => setQuickFilter('near')}
          className={`glass-card rounded-3xl p-5 text-left ${quickFilter === 'near' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Cận date</p>
          <p className="mt-2 text-3xl font-semibold text-sun-500">{stats.nearDate}</p>
        </button>
        <button
          type="button"
          onClick={() => setQuickFilter('expired')}
          className={`glass-card rounded-3xl p-5 text-left ${quickFilter === 'expired' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Hết hạn</p>
          <p className="mt-2 text-3xl font-semibold text-coral-500">{stats.expired}</p>
        </button>
      </section>

      {stats.expired > 0 ? (
        <div className="glass-card rounded-2xl border border-coral-500/30 bg-coral-500/10 px-4 py-3 text-sm text-coral-600">
          Cảnh báo: hiện có {stats.expired.toLocaleString('vi-VN')} mặt hàng đã hết hạn, nên xử lý sớm.
        </div>
      ) : null}

      <section className="glass-card rounded-3xl p-6">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,1fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm theo mã thuốc, tên thuốc, số lô, nhà phân phối"
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <input
            type="date"
            value={expFrom}
            onChange={(event) => setExpFrom(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <input
            type="date"
            value={expTo}
            onChange={(event) => setExpTo(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setQuickFilter('all')
              setExpFrom('')
              setExpTo('')
            }}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => void loadInventory()}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Tải lại
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="min-w-[1120px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.24em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã thuốc</th>
                <th className="px-6 py-4">Tên thuốc</th>
                <th className="px-6 py-4">Số lô</th>
                <th className="px-6 py-4">HSD</th>
                <th className="px-6 py-4">Tồn (đơn vị nhỏ nhất)</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {!loading && lotRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-sm text-ink-600">
                    Không có dữ liệu phù hợp bộ lọc.
                  </td>
                </tr>
              ) : null}

              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-sm text-ink-600">
                    Đang tải dữ liệu tồn kho...
                  </td>
                </tr>
              ) : null}

              {!loading
                ? lotRows.map((row) => {
                    const isExpired = row.nearDays < 0
                    const isNearDate = row.nearDays >= 0 && row.nearDays <= NEAR_EXPIRY_DAYS
                    const breakdown = quantityBreakdown(row.batch.qty_remaining, row.units)
                    return (
                      <Fragment key={row.batch.id}>
                        <tr className="hover:bg-white/80 align-top">
                          <td className="px-6 py-4 font-semibold text-ink-900">{row.drugCode}</td>
                          <td className="px-6 py-4 text-ink-900">{row.drugName}</td>
                          <td className="px-6 py-4 text-ink-700">{row.batch.batch_code}</td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-ink-900">{formatDate(row.batch.exp_date)}</span>
                              {isExpired ? (
                                <span className="text-xs font-semibold text-coral-500">
                                  Đã hết hạn {Math.abs(row.nearDays)} ngày
                                </span>
                              ) : null}
                              {!isExpired && isNearDate ? (
                                <span className="text-xs font-semibold text-sun-500">Còn {row.nearDays} ngày</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-ink-700">
                            <p>
                              {row.batch.qty_remaining.toLocaleString('vi-VN')} {row.units.retailUnit.name}
                            </p>
                            <p className="text-xs text-ink-600">
                              {breakdown.map((item) => `${item.value} ${item.label}`).join(' · ')}
                            </p>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedLotId((prev) => (prev === row.batch.id ? null : row.batch.id))
                                }
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                              >
                                Chi tiết
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setAdjustError(null)
                                  setAdjusting({
                                    batchId: row.batch.id,
                                    operation: 'subtract',
                                    importQty: '',
                                    middleQty: '',
                                    retailQty: '',
                                  })
                                }}
                                disabled={!canAdjust}
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
                              >
                                Điều chỉnh tồn kho
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setPrintingLot({
                                    id: row.batch.id,
                                    code: row.batch.batch_code,
                                    qrValue: row.batch.batch_code,
                                    productName: row.drugName,
                                    price: row.highestUnitPrice,
                                    defaultCount: 1,
                                  })
                                }
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                              >
                                In QR
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedLotId === row.batch.id ? (
                          <tr>
                            <td colSpan={6} className="px-6 pb-6">
                              <div className="rounded-2xl bg-white/85 p-4">
                                <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
                                  <div className="space-y-2 text-sm text-ink-700">
                                    <p>
                                      <span className="font-semibold text-ink-900">Mã thuốc:</span> {row.drugCode}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-ink-900">Số lô:</span> {row.batch.batch_code}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-ink-900">Nhà phân phối:</span> {row.batch.supplier_name}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-ink-900">Liên hệ nhà phân phối:</span> {row.supplierContact}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-ink-900">Địa chỉ:</span> {row.supplierAddress}
                                    </p>
                                    <p>
                                      <span className="font-semibold text-ink-900">Mã QR:</span> {row.batch.batch_code}
                                    </p>
                                  </div>
                                  <div className="rounded-2xl bg-white p-4 text-sm text-ink-700">
                                    <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Tồn theo đơn vị</p>
                                    <div className="mt-3 space-y-2">
                                      {quantityBreakdown(row.batch.qty_remaining, row.units).map((item) => (
                                        <p key={item.label} className="flex items-center justify-between">
                                          <span>{item.label}</span>
                                          <span className="font-semibold text-ink-900">
                                            {item.value.toLocaleString('vi-VN')}
                                          </span>
                                        </p>
                                      ))}
                                    </div>
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

      {adjusting && currentAdjustContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Điều chỉnh tồn kho</p>
              <h3 className="mt-2 text-2xl font-semibold text-ink-900">
                {currentAdjustContext.drugName} · {currentAdjustContext.batch.batch_code}
              </h3>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div className="grid gap-3 md:grid-cols-[1fr,1fr]">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Thao tác</span>
                  <select
                    value={adjusting.operation}
                    onChange={(event) =>
                      setAdjusting((prev) =>
                        prev ? { ...prev, operation: event.target.value as 'add' | 'subtract' } : prev,
                      )
                    }
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  >
                    <option value="subtract">Trừ tồn</option>
                    <option value="add">Cộng tồn</option>
                  </select>
                </label>
                <div className="rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-3 text-sm text-ink-700">
                  Tồn hiện tại:{' '}
                  <span className="font-semibold text-ink-900">
                    {currentAdjustContext.batch.qty_remaining.toLocaleString('vi-VN')} {currentAdjustContext.units.retailUnit.name}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {currentAdjustContext.units.importUnit ? (
                  <label className="space-y-1 text-xs text-ink-600">
                    {currentAdjustContext.units.importUnit.name}
                    <input
                      value={adjusting.importQty}
                      onChange={(event) =>
                        setAdjusting((prev) =>
                          prev ? { ...prev, importQty: event.target.value.replace(/\D+/g, '') } : prev,
                        )
                      }
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                      placeholder="0"
                    />
                  </label>
                ) : (
                  <div />
                )}

                {currentAdjustContext.units.middleUnit ? (
                  <label className="space-y-1 text-xs text-ink-600">
                    {currentAdjustContext.units.middleUnit.name}
                    <input
                      value={adjusting.middleQty}
                      onChange={(event) =>
                        setAdjusting((prev) =>
                          prev ? { ...prev, middleQty: event.target.value.replace(/\D+/g, '') } : prev,
                        )
                      }
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                      placeholder="0"
                    />
                  </label>
                ) : (
                  <div />
                )}

                <label className="space-y-1 text-xs text-ink-600">
                  {currentAdjustContext.units.retailUnit.name}
                  <input
                    value={adjusting.retailQty}
                    onChange={(event) =>
                      setAdjusting((prev) =>
                        prev ? { ...prev, retailQty: event.target.value.replace(/\D+/g, '') } : prev,
                      )
                    }
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                    placeholder="0"
                  />
                </label>
              </div>

              {adjustError ? <p className="text-sm text-coral-500">{adjustError}</p> : null}
            </div>

            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void applyAdjustment()}
                disabled={adjustSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {adjustSubmitting ? 'Đang xử lý...' : 'Xác nhận'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdjustError(null)
                  setAdjusting(null)
                }}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900"
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
