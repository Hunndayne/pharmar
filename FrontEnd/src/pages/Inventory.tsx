import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { LotLabelPrintPage, type LabelPrintLot } from '../components/labels/LotLabelPrintPage'
import {
  inventoryApi,
  type InventoryBatch,
  type InventoryBatchPagedResponse,
  type InventoryMetaSupplier,
} from '../api/inventoryService'
import { storeApi } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { downloadCsv } from '../utils/csv'

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

const DEFAULT_EXPIRY_WARNING_DAYS = 30
const DEFAULT_NEAR_EXPIRY_DAYS = 90
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

const parseConfigInt = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.trunc(parsed)
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

export function Inventory() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canAdjust = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'

  const [batches, setBatches] = useState<InventoryBatch[]>([])
  const [metaSuppliers, setMetaSuppliers] = useState<InventoryMetaSupplier[]>([])
  const [batchSummary, setBatchSummary] = useState<InventoryBatchPagedResponse['summary']>({
    total_drugs: 0,
    out_of_stock: 0,
    near_date: 0,
    expired: 0,
  })

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

  const [expandedLotId, setExpandedLotId] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<AdjustModalState | null>(null)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  const [printingLot, setPrintingLot] = useState<LabelPrintLot | null>(null)

  const pageSize = useMemo(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
        ? 10
        : 20,
    [],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const loadInventory = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const statusFilter = quickFilter === 'expired'
        ? 'expired'
        : quickFilter === 'out'
          ? 'depleted'
          : undefined
      const hideZero = quickFilter !== 'out'

      const [batchPage, nextSuppliers, inventorySettings] = await Promise.all([
        inventoryApi.listBatchesPaged({
          page,
          size: pageSize,
          search: debouncedSearch || undefined,
          exp_from: expFrom || undefined,
          exp_to: expTo || undefined,
          status: statusFilter,
          hide_zero: hideZero,
        }),
        inventoryApi.getMetaSuppliers(accessToken || undefined),
        storeApi
          .getSettingsByGroup('inventory')
          .catch(() => ({} as Record<string, unknown>)),
      ])

      const nextExpiryWarningDays = parseConfigInt(
        inventorySettings['inventory.expiry_warning_days'],
        DEFAULT_EXPIRY_WARNING_DAYS,
      )
      const nextNearExpiryDaysRaw = parseConfigInt(
        inventorySettings['inventory.near_date_days'],
        DEFAULT_NEAR_EXPIRY_DAYS,
      )
      const nextNearExpiryDays = Math.max(nextExpiryWarningDays, nextNearExpiryDaysRaw)

      setBatches(batchPage.items)
      setBatchSummary(batchPage.summary)
      setTotalItems(batchPage.total)
      setTotalPages(Math.max(1, batchPage.pages))
      setPage(batchPage.page)
      setMetaSuppliers(nextSuppliers)
      setExpiryWarningDays(nextExpiryWarningDays)
      setNearExpiryDays(nextNearExpiryDays)
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải dữ liệu tồn kho.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, debouncedSearch, expFrom, expTo, page, pageSize, quickFilter])

  useEffect(() => {
    void loadInventory()
  }, [loadInventory])

  const supplierById = useMemo(() => new Map(metaSuppliers.map((item) => [item.id, item])), [metaSuppliers])

  const lotRows = useMemo<LotRow[]>(() => {
    return batches
      .map((batch) => {
        const supplier = supplierById.get(batch.supplier_id)
        const units = toUnitConfigFromBatch(batch)

        return {
          batch,
          drugCode: batch.drug_code,
          drugName: batch.drug_name,
          units,
          supplierContact:
            supplier ? `${supplier.contact_name} - ${supplier.phone}` : batch.supplier_contact,
          supplierAddress: supplier?.address ?? '-',
          highestUnitPrice: highestUnitPrice(batch),
          nearDays: daysUntil(batch.exp_date),
        }
      })
      .filter((row) => {
        if (quickFilter === 'all') return row.batch.qty_remaining > 0
        if (quickFilter === 'out') return row.batch.qty_remaining <= 0
        if (quickFilter === 'near') {
          return row.nearDays >= 0 && row.nearDays <= nearExpiryDays && row.batch.qty_remaining > 0
        }
        return row.nearDays < 0 && row.batch.qty_remaining > 0
      })
      .sort((a, b) => {
        const expCompare = a.batch.exp_date.localeCompare(b.batch.exp_date)
        if (expCompare !== 0) return expCompare
        return a.batch.batch_code.localeCompare(b.batch.batch_code)
      })
  }, [batches, nearExpiryDays, quickFilter, supplierById])

  const stats = useMemo(
    () => ({
      totalDrugs: batchSummary.total_drugs,
      outOfStock: batchSummary.out_of_stock,
      nearDate: batchSummary.near_date,
      expired: batchSummary.expired,
    }),
    [batchSummary],
  )
  const rangeStart = totalItems === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = totalItems === 0 ? 0 : Math.min(page * pageSize, totalItems)

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
      setAdjusting(null)
      setAdjustError(null)
    } catch (adjustStockError) {
      if (adjustStockError instanceof ApiError) setAdjustError(adjustStockError.message)
      else setAdjustError('Không thể điều chỉnh tồn kho. Vui lòng thử lại.')
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
    downloadCsv(`ton-kho-theo-lo-${dateKey}.csv`, headers, rows)
  }

  const resetFilters = () => {
    setSearch('')
    setQuickFilter('all')
    setExpFrom('')
    setExpTo('')
    setPage(1)
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Kho</p>
          <h2 className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">Tồn kho theo lô</h2>
        </div>
        <button
          type="button"
          onClick={exportInventoryExcel}
          disabled={loading || lotRows.length === 0}
          className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
        >
          Xuất Excel
        </button>
      </header>

      {error ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-coral-500">
          {error}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            setQuickFilter('all')
            setPage(1)
          }}
          className={`glass-card min-w-0 rounded-2xl p-4 text-left sm:rounded-3xl sm:p-5 ${quickFilter === 'all' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.24em]">Tổng mặt hàng</p>
          <p className="mt-2 text-2xl font-semibold text-ink-900 sm:text-3xl">{stats.totalDrugs}</p>
        </button>
        <button
          type="button"
          onClick={() => {
            setQuickFilter('out')
            setPage(1)
          }}
          className={`glass-card min-w-0 rounded-2xl p-4 text-left sm:rounded-3xl sm:p-5 ${quickFilter === 'out' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.24em]">Hết hàng</p>
          <p className="mt-2 text-2xl font-semibold text-coral-500 sm:text-3xl">{stats.outOfStock}</p>
        </button>
        <button
          type="button"
          onClick={() => {
            setQuickFilter('near')
            setPage(1)
          }}
          className={`glass-card min-w-0 rounded-2xl p-4 text-left sm:rounded-3xl sm:p-5 ${quickFilter === 'near' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.24em]">Cận date</p>
          <p className="mt-2 text-2xl font-semibold text-sun-500 sm:text-3xl">{stats.nearDate}</p>
        </button>
        <button
          type="button"
          onClick={() => {
            setQuickFilter('expired')
            setPage(1)
          }}
          className={`glass-card min-w-0 rounded-2xl p-4 text-left sm:rounded-3xl sm:p-5 ${quickFilter === 'expired' ? 'ring-2 ring-ink-900/20' : ''}`}
        >
          <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.24em]">Hết hạn</p>
          <p className="mt-2 text-2xl font-semibold text-coral-500 sm:text-3xl">{stats.expired}</p>
        </button>
      </section>

      {stats.expired > 0 ? (
        <div className="glass-card rounded-2xl border border-coral-500/30 bg-coral-500/10 px-4 py-3 text-sm text-coral-600">
          Cảnh báo: hiện có {stats.expired.toLocaleString('vi-VN')} mặt hàng đã hết hạn, nên xử lý sớm.
        </div>
      ) : null}

      <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-1">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            placeholder="Tìm theo mã thuốc, tên thuốc, số lô, nhà phân phối"
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-3 md:hidden">
          <button
            type="button"
            onClick={() => setMobileFiltersOpen((prev) => !prev)}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            {mobileFiltersOpen ? 'Ẩn bộ lọc' : 'Bộ lọc nâng cao'}
          </button>
          <button
            type="button"
            onClick={() => void loadInventory()}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Tải lại
          </button>
        </div>

        <div className="hidden gap-3 md:grid md:grid-cols-[1fr,1fr,auto,auto]">
          <input
            type="date"
            value={expFrom}
            onChange={(event) => {
              setExpFrom(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <input
            type="date"
            value={expTo}
            onChange={(event) => {
              setExpTo(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <button
            type="button"
            onClick={resetFilters}
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

        {mobileFiltersOpen ? (
          <div className="grid grid-cols-1 gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={expFrom}
                onChange={(event) => {
                  setExpFrom(event.target.value)
                  setPage(1)
                }}
                className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-xs"
              />
              <input
                type="date"
                value={expTo}
                onChange={(event) => {
                  setExpTo(event.target.value)
                  setPage(1)
                }}
                className="w-full rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-xs"
              />
            </div>
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Reset
            </button>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="hidden overflow-x-auto md:block">
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
                    const isExpiringSoon =
                      row.nearDays >= 0 && row.nearDays < expiryWarningDays && row.batch.qty_remaining > 0
                    const isNearDate =
                      row.nearDays >= 0 && row.nearDays <= nearExpiryDays && row.batch.qty_remaining > 0
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
                              {!isExpired && isExpiringSoon ? (
                                <span className="text-xs font-semibold text-coral-500">Sắp hết hạn: còn {row.nearDays} ngày</span>
                              ) : null}
                              {!isExpired && !isExpiringSoon && isNearDate ? (
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

        <div className="space-y-3 p-3 md:hidden">
          {loading ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">
              Đang tải dữ liệu tồn kho...
            </div>
          ) : null}
          {!loading && lotRows.length === 0 ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">
              Không có dữ liệu phù hợp bộ lọc.
            </div>
          ) : null}

          {!loading
            ? lotRows.map((row) => {
                const isExpired = row.nearDays < 0
                const isExpiringSoon =
                  row.nearDays >= 0 && row.nearDays < expiryWarningDays && row.batch.qty_remaining > 0
                const isNearDate =
                  row.nearDays >= 0 && row.nearDays <= nearExpiryDays && row.batch.qty_remaining > 0
                const breakdown = quantityBreakdown(row.batch.qty_remaining, row.units)
                const isExpanded = expandedLotId === row.batch.id
                return (
                  <article key={row.batch.id} className="rounded-2xl border border-ink-900/10 bg-white/80 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold tracking-wide text-ink-600">{row.drugCode}</p>
                        <h4 className="mt-1 text-base font-semibold text-ink-900">{row.drugName}</h4>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpandedLotId((prev) => (prev === row.batch.id ? null : row.batch.id))}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                      >
                        {isExpanded ? 'Ẩn' : 'Chi tiết'}
                      </button>
                    </div>

                    <div className="mt-3 space-y-1 text-xs text-ink-700">
                      <p><span className="font-semibold text-ink-900">Số lô:</span> {row.batch.batch_code}</p>
                      <p><span className="font-semibold text-ink-900">HSD:</span> {formatDate(row.batch.exp_date)}</p>
                      {isExpired ? (
                        <p className="font-semibold text-coral-500">Đã hết hạn {Math.abs(row.nearDays)} ngày</p>
                      ) : null}
                      {!isExpired && isExpiringSoon ? (
                        <p className="font-semibold text-coral-500">Sắp hết hạn: còn {row.nearDays} ngày</p>
                      ) : null}
                      {!isExpired && !isExpiringSoon && isNearDate ? (
                        <p className="font-semibold text-sun-500">Còn {row.nearDays} ngày</p>
                      ) : null}
                    </div>

                    <div className="mt-3 rounded-xl bg-fog-50 px-3 py-2 text-xs text-ink-700">
                      <p>
                        <span className="font-semibold text-ink-900">Tồn:</span>{' '}
                        {row.batch.qty_remaining.toLocaleString('vi-VN')} {row.units.retailUnit.name}
                      </p>
                      <p className="mt-1 text-ink-600">
                        {breakdown.map((item) => `${item.value} ${item.label}`).join(' · ')}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
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

                    {isExpanded ? (
                      <div className="mt-3 rounded-xl border border-ink-900/10 bg-white p-3 text-xs text-ink-700">
                        <div className="space-y-1.5">
                          <p><span className="font-semibold text-ink-900">Mã thuốc:</span> {row.drugCode}</p>
                          <p><span className="font-semibold text-ink-900">Số lô:</span> {row.batch.batch_code}</p>
                          <p><span className="font-semibold text-ink-900">Nhà phân phối:</span> {row.batch.supplier_name}</p>
                          <p><span className="font-semibold text-ink-900">Liên hệ NPP:</span> {row.supplierContact}</p>
                          <p><span className="font-semibold text-ink-900">Địa chỉ:</span> {row.supplierAddress}</p>
                          <p><span className="font-semibold text-ink-900">Mã QR:</span> {row.batch.batch_code}</p>
                        </div>
                        <div className="mt-3 rounded-lg bg-fog-50 px-3 py-2">
                          {quantityBreakdown(row.batch.qty_remaining, row.units).map((item) => (
                            <p key={item.label} className="flex items-center justify-between">
                              <span>{item.label}</span>
                              <span className="font-semibold text-ink-900">{item.value.toLocaleString('vi-VN')}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </article>
                )
              })
            : null}
        </div>
      </section>

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>
          Hiển thị {rangeStart} - {rangeEnd} trong {totalItems} lô
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900"
            disabled={page <= 1}
          >
            Trước
          </button>
          <span>{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900"
            disabled={page >= totalPages}
          >
            Sau
          </button>
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
