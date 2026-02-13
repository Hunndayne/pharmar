import { useMemo, useState } from 'react'
import { LotLabelPrintPage, type LabelPrintLot } from '../components/labels/LotLabelPrintPage'

type UnitConfig = {
  importUnit: { name: string; ratio: number } | null
  middleUnit: { name: string; ratio: number } | null
  retailUnit: { name: string; ratio: 1 }
}

type InventoryLot = {
  id: string
  lotCode: string
  mfgDate: string
  expDate: string
  quantityRetail: number
  highestUnitPrice: number
  distributor: string
  distributorContact: string
  qrCode: string
}

type InventoryDrug = {
  id: string
  code: string
  name: string
  units: UnitConfig
  lots: InventoryLot[]
}

type QuickFilter = 'all' | 'out' | 'near'

type AdjustModalState = {
  drugId: string
  lotId: string
  operation: 'add' | 'subtract'
  importQty: string
  middleQty: string
  retailQty: string
}

const NEAR_EXPIRY_DAYS = 60
const STORE_NAME = 'Nhà thuốc Thanh Huy'

const initialInventory: InventoryDrug[] = [
  {
    id: 'd1',
    code: 'T0001',
    name: 'Panadol Extra',
    units: {
      importUnit: { name: 'Hộp', ratio: 100 },
      middleUnit: { name: 'Vỉ', ratio: 10 },
      retailUnit: { name: 'Viên', ratio: 1 },
    },
    lots: [
      {
        id: 'lot-1',
        lotCode: 'LO20260205001',
        mfgDate: '2025-11-15',
        expDate: '2027-11-15',
        quantityRetail: 189,
        highestUnitPrice: 320000,
        distributor: 'Phương Đông',
        distributorContact: 'Nguyễn Minh Hà - 028 3838 8899',
        qrCode: 'LO20260205001',
      },
      {
        id: 'lot-2',
        lotCode: 'LO20260101003',
        mfgDate: '2025-07-01',
        expDate: '2026-03-20',
        quantityRetail: 0,
        highestUnitPrice: 320000,
        distributor: 'Phương Đông',
        distributorContact: 'Nguyễn Minh Hà - 028 3838 8899',
        qrCode: 'LO20260101003',
      },
    ],
  },
  {
    id: 'd2',
    code: 'T0034',
    name: 'Vitamin C 1000',
    units: {
      importUnit: { name: 'Chai', ratio: 30 },
      middleUnit: null,
      retailUnit: { name: 'Viên', ratio: 1 },
    },
    lots: [
      {
        id: 'lot-3',
        lotCode: 'LO20260205002',
        mfgDate: '2025-12-10',
        expDate: '2027-12-10',
        quantityRetail: 210,
        highestUnitPrice: 185000,
        distributor: 'Phương Đông',
        distributorContact: 'Nguyễn Minh Hà - 028 3838 8899',
        qrCode: 'LO20260205002',
      },
    ],
  },
  {
    id: 'd3',
    code: 'T0088',
    name: 'Amoxicillin 500mg',
    units: {
      importUnit: { name: 'Hộp', ratio: 200 },
      middleUnit: { name: 'Vỉ', ratio: 10 },
      retailUnit: { name: 'Viên', ratio: 1 },
    },
    lots: [
      {
        id: 'lot-4',
        lotCode: 'LO20260204001',
        mfgDate: '2025-09-01',
        expDate: '2027-09-01',
        quantityRetail: 540,
        highestUnitPrice: 420000,
        distributor: 'Phú Hưng',
        distributorContact: 'Trần Quốc Bảo - 028 3799 1166',
        qrCode: 'LO20260204001',
      },
    ],
  },
]

const today = new Date()

const toDate = (value: string) => new Date(`${value}T00:00:00`)

const daysUntil = (value: string) => {
  const target = toDate(value).getTime()
  const now = new Date(today.toDateString()).getTime()
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

export function Inventory() {
  const [inventory, setInventory] = useState<InventoryDrug[]>(initialInventory)
  const [search, setSearch] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expandedLotId, setExpandedLotId] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<AdjustModalState | null>(null)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [printingLot, setPrintingLot] = useState<LabelPrintLot | null>(null)

  const lotRows = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const rows = inventory.flatMap((drug) =>
      drug.lots.map((lot) => ({
        drug,
        lot,
        nearDays: daysUntil(lot.expDate),
      })),
    )

    return rows.filter(({ drug, lot, nearDays }) => {
      const matchKeyword =
        !keyword ||
        drug.code.toLowerCase().includes(keyword) ||
        drug.name.toLowerCase().includes(keyword) ||
        lot.lotCode.toLowerCase().includes(keyword) ||
        lot.distributor.toLowerCase().includes(keyword)

      const matchQuick =
        quickFilter === 'all'
          ? true
          : quickFilter === 'out'
            ? lot.quantityRetail === 0
            : nearDays >= 0 && nearDays <= NEAR_EXPIRY_DAYS

      const matchFrom = !expFrom || lot.expDate >= expFrom
      const matchTo = !expTo || lot.expDate <= expTo

      return matchKeyword && matchQuick && matchFrom && matchTo
    })
  }, [inventory, search, quickFilter, expFrom, expTo])

  const stats = useMemo(() => {
    const allLots = inventory.flatMap((item) => item.lots)
    const outOfStock = allLots.filter((lot) => lot.quantityRetail === 0).length
    const nearDate = allLots.filter((lot) => {
      const days = daysUntil(lot.expDate)
      return days >= 0 && days <= NEAR_EXPIRY_DAYS
    }).length
    return {
      totalDrugs: inventory.length,
      outOfStock,
      nearDate,
    }
  }, [inventory])

  const currentAdjustContext = useMemo(() => {
    if (!adjusting) return null
    const drug = inventory.find((item) => item.id === adjusting.drugId)
    const lot = drug?.lots.find((item) => item.id === adjusting.lotId)
    if (!drug || !lot) return null
    return { drug, lot }
  }, [adjusting, inventory])

  const applyAdjustment = () => {
    if (!adjusting || !currentAdjustContext) return
    const { drug, lot } = currentAdjustContext

    const importBase = adjusting.importQty ? parseSafeInt(adjusting.importQty) : 0
    const middleBase = adjusting.middleQty ? parseSafeInt(adjusting.middleQty) : 0
    const retailBase = adjusting.retailQty ? parseSafeInt(adjusting.retailQty) : 0

    const importRetail = importBase * (drug.units.importUnit?.ratio ?? 0)
    const middleRetail = middleBase * (drug.units.middleUnit?.ratio ?? 0)
    const deltaRetail = importRetail + middleRetail + retailBase

    if (deltaRetail <= 0) {
      setAdjustError('Cần nhập số lượng điều chỉnh lớn hơn 0.')
      return
    }

    const nextQuantity =
      adjusting.operation === 'add'
        ? lot.quantityRetail + deltaRetail
        : lot.quantityRetail - deltaRetail

    if (nextQuantity < 0) {
      setAdjustError('Số lượng trừ vượt quá tồn hiện tại của lô.')
      return
    }

    setInventory((prev) =>
      prev.map((item) => {
        if (item.id !== drug.id) return item
        return {
          ...item,
          lots: item.lots.map((entry) =>
            entry.id === lot.id ? { ...entry, quantityRetail: nextQuantity } : entry,
          ),
        }
      }),
    )
    setAdjustError(null)
    setAdjusting(null)
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

      <section className="grid gap-4 sm:grid-cols-3">
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
      </section>

      <section className="glass-card rounded-3xl p-6">
        <div className="grid gap-3 md:grid-cols-[1.4fr,1fr,1fr,auto]">
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
              {lotRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-sm text-ink-600">
                    Không có dữ liệu phù hợp bộ lọc.
                  </td>
                </tr>
              ) : null}

              {lotRows.map(({ drug, lot, nearDays }) => {
                const isNearDate = nearDays >= 0 && nearDays <= NEAR_EXPIRY_DAYS
                const breakdown = quantityBreakdown(lot.quantityRetail, drug.units)

                return (
                  <tr key={lot.id} className="hover:bg-white/80 align-top">
                    <td className="px-6 py-4 font-semibold text-ink-900">{drug.code}</td>
                    <td className="px-6 py-4 text-ink-900">{drug.name}</td>
                    <td className="px-6 py-4 text-ink-700">{lot.lotCode}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-1">
                        <span className="text-ink-900">{formatDate(lot.expDate)}</span>
                        {isNearDate ? (
                          <span className="text-xs font-semibold text-sun-500">
                            Còn {nearDays} ngày
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-ink-700">
                      <p>{lot.quantityRetail.toLocaleString('vi-VN')} {drug.units.retailUnit.name}</p>
                      <p className="text-xs text-ink-600">
                        {breakdown.map((item) => `${item.value} ${item.label}`).join(' · ')}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedLotId((prev) => (prev === lot.id ? null : lot.id))}
                          className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                        >
                          Chi tiết
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setAdjusting({
                              drugId: drug.id,
                              lotId: lot.id,
                              operation: 'subtract',
                              importQty: '',
                              middleQty: '',
                              retailQty: '',
                            })
                          }
                          className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                        >
                          Điều chỉnh tồn kho
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPrintingLot({
                              id: lot.id,
                              code: lot.lotCode,
                              qrValue: lot.qrCode,
                              productName: drug.name,
                              price: lot.highestUnitPrice,
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
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {expandedLotId ? (
        <section className="glass-card rounded-3xl p-6">
          {(() => {
            const row = lotRows.find((item) => item.lot.id === expandedLotId)
            if (!row) return null
            const breakdown = quantityBreakdown(row.lot.quantityRetail, row.drug.units)
            return (
              <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
                <div className="space-y-2 text-sm text-ink-700">
                  <p><span className="font-semibold text-ink-900">Mã thuốc:</span> {row.drug.code}</p>
                  <p><span className="font-semibold text-ink-900">Số lô:</span> {row.lot.lotCode}</p>
                  <p><span className="font-semibold text-ink-900">Nhà phân phối:</span> {row.lot.distributor}</p>
                  <p><span className="font-semibold text-ink-900">Liên hệ nhà phân phối:</span> {row.lot.distributorContact}</p>
                  <p><span className="font-semibold text-ink-900">Mã QR:</span> {row.lot.qrCode}</p>
                </div>
                <div className="rounded-2xl bg-white p-4 text-sm text-ink-700">
                  <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Tồn theo đơn vị</p>
                  <div className="mt-3 space-y-2">
                    {breakdown.map((item) => (
                      <p key={item.label} className="flex items-center justify-between">
                        <span>{item.label}</span>
                        <span className="font-semibold text-ink-900">{item.value.toLocaleString('vi-VN')}</span>
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}
        </section>
      ) : null}

      {adjusting && currentAdjustContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Điều chỉnh tồn kho</p>
              <h3 className="mt-2 text-2xl font-semibold text-ink-900">
                {currentAdjustContext.drug.name} · {currentAdjustContext.lot.lotCode}
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
                  Tồn hiện tại: <span className="font-semibold text-ink-900">{currentAdjustContext.lot.quantityRetail.toLocaleString('vi-VN')} {currentAdjustContext.drug.units.retailUnit.name}</span>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {currentAdjustContext.drug.units.importUnit ? (
                  <label className="space-y-1 text-xs text-ink-600">
                    {currentAdjustContext.drug.units.importUnit.name}
                    <input
                      value={adjusting.importQty}
                      onChange={(event) =>
                        setAdjusting((prev) => (prev ? { ...prev, importQty: event.target.value.replace(/\D+/g, '') } : prev))
                      }
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                      placeholder="0"
                    />
                  </label>
                ) : <div />}

                {currentAdjustContext.drug.units.middleUnit ? (
                  <label className="space-y-1 text-xs text-ink-600">
                    {currentAdjustContext.drug.units.middleUnit.name}
                    <input
                      value={adjusting.middleQty}
                      onChange={(event) =>
                        setAdjusting((prev) => (prev ? { ...prev, middleQty: event.target.value.replace(/\D+/g, '') } : prev))
                      }
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                      placeholder="0"
                    />
                  </label>
                ) : <div />}

                <label className="space-y-1 text-xs text-ink-600">
                  {currentAdjustContext.drug.units.retailUnit.name}
                  <input
                    value={adjusting.retailQty}
                    onChange={(event) =>
                      setAdjusting((prev) => (prev ? { ...prev, retailQty: event.target.value.replace(/\D+/g, '') } : prev))
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
                onClick={applyAdjustment}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white"
              >
                Xác nhận
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
