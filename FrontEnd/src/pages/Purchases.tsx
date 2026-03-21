import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Quagga from '@ericblade/quagga2'
import QRCode from 'qrcode'
import {
  inventoryApi,
  type InventoryCreateReceiptPayload,
  type InventoryMetaDrug,
  type InventoryPaymentMethod,
  type InventoryPaymentStatus,
  type InventoryMetaSupplier,
  type InventoryReceipt,
  type InventoryReceiptLine,
  type InventoryReceiptLineUnitPrice,
} from '../api/inventoryService'
import { catalogApi } from '../api/catalogService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { downloadCsv } from '../utils/csv'
import { readLocalDraft, removeLocalDraft, writeLocalDraft } from '../utils/localDraft'

type Unit = {
  id: string
  name: string
  conversion: number
  barcode: string
}

type Drug = {
  id: string
  code: string
  name: string
  regNo: string
  group: string
  maker: string
  barcode: string
  units: Unit[]
}

type Supplier = {
  id: string
  name: string
  contactName: string
  phone: string
  address: string
}

type PaymentStatus = 'Đã thanh toán' | 'Còn nợ'
type PaymentMethod = 'Ngân hàng' | 'Ví điện tử Momo/ZaloPay' | 'Thanh toán thẻ'
type ShippingCarrier = string
type PromoType = 'none' | 'buy_x_get_y' | 'discount_percent'

type LineRetailPrice = {
  unitId: string
  unitName: string
  conversion: number
  price: string
}

type LineItemForm = {
  id: string
  batchId: string
  batchCode: string
  originalBatchCode: string
  drugId: string
  lotNumber: string
  quantity: string
  mfgDate: string
  expDate: string
  price: string
  promoType: PromoType
  promoBuyQty: string
  promoGetQty: string
  promoDiscountPercent: string
  barcode: string
  unitRetailPrices: LineRetailPrice[]
}

type OrderFormState = {
  id?: string
  code: string
  date: string
  supplierId: string
  shippingCarrier: ShippingCarrier
  note: string
  paymentStatus: PaymentStatus
  paymentMethod: PaymentMethod
  lines: LineItemForm[]
}

type PurchaseOrder = OrderFormState & {
  id: string
  createdAt: number
  canEdit?: boolean
  receiptStatus?: 'confirmed' | 'cancelled'
}

type ScanTarget = { type: 'line'; id: string }

type ReceiptLineExtra = {
  promoType: PromoType
  promoBuyQty: string
  promoGetQty: string
  promoDiscountPercent: string
  barcode: string
  unitRetailPrices: LineRetailPrice[]
}

type ReceiptExtra = {
  shippingCarrier: ShippingCarrier
  paymentStatus: PaymentStatus
  paymentMethod: PaymentMethod
  lineExtras: Record<string, ReceiptLineExtra>
}

const suppliers: Supplier[] = [
  {
    id: 's1',
    name: 'Phương Đông',
    contactName: 'Nguyễn Minh Hà',
    phone: '028 3838 8899',
    address: 'Q.1, TP.HCM',
  },
  {
    id: 's2',
    name: 'Phú Hưng',
    contactName: 'Trần Quốc Bảo',
    phone: '028 3799 1166',
    address: 'Bình Thạnh, TP.HCM',
  },
  {
    id: 's3',
    name: 'Mediphar',
    contactName: 'Lê Mỹ Anh',
    phone: '028 3877 5555',
    address: 'Thủ Đức, TP.HCM',
  },
  {
    id: 's4',
    name: 'An Khang',
    contactName: 'Phạm Thanh Tùng',
    phone: '028 3666 3322',
    address: 'Tân Bình, TP.HCM',
  },
]

const drugCatalog: Drug[] = [
  {
    id: 'd1',
    code: 'T0001',
    name: 'Panadol Extra',
    regNo: 'VD-12345-21',
    group: 'Giảm đau',
    maker: 'GSK',
    barcode: '8936012345678',
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936012345001' },
      { id: 'u2', name: 'Vỉ', conversion: 10, barcode: '8936012345002' },
      { id: 'u3', name: 'Hộp', conversion: 120, barcode: '8936012345003' },
    ],
  },
  {
    id: 'd2',
    code: 'T0034',
    name: 'Vitamin C 1000 test them chu cho dai',
    regNo: 'VN-98765-19',
    group: 'Vitamin',
    maker: 'DHC',
    barcode: '8936017777777',
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936017777001' },
      { id: 'u2', name: 'Chai', conversion: 30, barcode: '8936017777002' },
    ],
  },
  {
    id: 'd3',
    code: 'T0088',
    name: 'Amoxicillin 500mg',
    regNo: 'VD-55544-18',
    group: 'Kháng sinh',
    maker: 'Imexpharm',
    barcode: '8936011111111',
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936011111001' },
      { id: 'u2', name: 'Vỉ', conversion: 10, barcode: '8936011111002' },
    ],
  },
  {
    id: 'd4',
    code: 'T0104',
    name: 'Oresol',
    regNo: 'VN-11223-17',
    group: 'Tiêu hóa',
    maker: 'DHG',
    barcode: '8936013333333',
    units: [{ id: 'u1', name: 'Gói', conversion: 1, barcode: '8936013333001' }],
  },
]

const defaultRetailPricesByDrug: Record<string, Record<string, string>> = {
  d1: { u1: '3000', u2: '28000', u3: '320000' },
  d2: { u1: '6000', u2: '185000' },
  d3: { u1: '4200', u2: '42000' },
  d4: { u1: '6000' },
}

const buildLineRetailPrices = (
  drugId: string,
  existing: LineRetailPrice[] | undefined = undefined,
  sourceDrugs: Drug[] = drugCatalog,
  sourceDefaults: Record<string, Record<string, string>> = defaultRetailPricesByDrug,
) => {
  const drug = sourceDrugs.find((item) => item.id === drugId)
  if (!drug) return []
  const sortedUnits = drug.units.slice().sort((a, b) => b.conversion - a.conversion)
  const existingMap = new Map((existing ?? []).map((item) => [item.unitId, item.price]))
  return sortedUnits.map((unit) => ({
    unitId: unit.id,
    unitName: unit.name,
    conversion: unit.conversion,
    price:
      existingMap.get(unit.id) ??
      sourceDefaults[drugId]?.[unit.id] ??
      '',
  }))
}

const initialOrders: PurchaseOrder[] = []

const paymentStatusStyles: Record<PaymentStatus, string> = {
  'Đã thanh toán': 'bg-brand-500/15 text-brand-600 border border-brand-500/30',
  'Còn nợ': 'bg-sun-500/15 text-sun-500 border border-sun-500/30',
}

const todayISO = () => new Date().toISOString().slice(0, 10)
const toDateKey = (value: string) => (value ? value.replace(/-/g, '') : todayISO().replace(/-/g, ''))

const formatDate = (value: string) => {
  if (!value) return '-'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}/${month}/${year}`
}

const parseNumber = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatCurrency = (value: number) => `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`
const paymentMethods: PaymentMethod[] = ['Ngân hàng', 'Ví điện tử Momo/ZaloPay', 'Thanh toán thẻ']
const shippingCarriers: ShippingCarrier[] = ['GHN', 'J&T']
const STORE_NAME = 'Nhà thuốc Thanh Huy'
const LABEL_WIDTH_MM = 50.8
const LABEL_HEIGHT_MM = 25.4

const sanitizeDigits = (value: string) => value.replace(/\D+/g, '')
const normalizeBatchCode = (value: string) => value.trim().toUpperCase()
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const paymentStatusToApi = (value: PaymentStatus): InventoryPaymentStatus =>
  value === 'Đã thanh toán' ? 'paid' : 'debt'

const paymentStatusFromApi = (
  value: InventoryPaymentStatus | undefined,
): PaymentStatus => (value === 'debt' ? 'Còn nợ' : 'Đã thanh toán')

const paymentMethodToApi = (value: PaymentMethod): InventoryPaymentMethod => {
  if (value === 'Ví điện tử Momo/ZaloPay') return 'ewallet'
  if (value === 'Thanh toán thẻ') return 'card'
  return 'bank'
}

const paymentMethodFromApi = (
  value: InventoryPaymentMethod | undefined,
): PaymentMethod => {
  if (value === 'ewallet') return 'Ví điện tử Momo/ZaloPay'
  if (value === 'card') return 'Thanh toán thẻ'
  return 'Ngân hàng'
}

const createOrderCode = (orders: PurchaseOrder[], date: string) => {
  const key = toDateKey(date)
  const sameDayCount = orders.filter((order) => order.code.includes(key)).length
  return `PN${key}${String(sameDayCount + 1).padStart(3, '0')}`
}

const createLine = (
  index: number,
): LineItemForm => {
  const runningIndex = Math.max(1, index)
  return {
    id: `line-${Date.now()}-${runningIndex}`,
    batchId: '',
    batchCode: '',
    originalBatchCode: '',
    drugId: '',
    lotNumber: '',
    quantity: '',
    mfgDate: '',
    expDate: '',
    price: '',
    promoType: 'none',
    promoBuyQty: '',
    promoGetQty: '',
    promoDiscountPercent: '',
    barcode: '',
    unitRetailPrices: [],
  }
}

const createEmptyOrder = (
  orders: PurchaseOrder[],
  date = todayISO(),
  supplierSource: Supplier[] = suppliers,
): OrderFormState => ({
  code: createOrderCode(orders, date),
  date,
  supplierId: supplierSource[0]?.id ?? '',
  shippingCarrier: 'GHN',
  note: '',
  paymentStatus: 'Còn nợ',
  paymentMethod: 'Ngân hàng',
  lines: [createLine(1)],
})

const calcLinePricing = (line: LineItemForm) => {
  const baseQty = Math.max(0, parseNumber(line.quantity))
  const basePrice = Math.max(0, parseNumber(line.price))

  if (line.promoType === 'buy_x_get_y') {
    const buyQty = Math.max(0, Math.floor(parseNumber(line.promoBuyQty)))
    const getQty = Math.max(0, Math.floor(parseNumber(line.promoGetQty)))
    if (buyQty > 0 && getQty > 0 && baseQty > 0) {
      const bonusQty = Math.floor(baseQty / buyQty) * getQty
      const quantityAfterPromo = baseQty + bonusQty
      const unitPriceAfterPromo = quantityAfterPromo > 0 ? (baseQty * basePrice) / quantityAfterPromo : basePrice
      return {
        quantityAfterPromo,
        unitPriceAfterPromo,
        lineTotal: quantityAfterPromo * unitPriceAfterPromo,
      }
    }
  }

  if (line.promoType === 'discount_percent') {
    const discount = Math.min(100, Math.max(0, parseNumber(line.promoDiscountPercent)))
    const unitPriceAfterPromo = basePrice * (1 - discount / 100)
    return {
      quantityAfterPromo: baseQty,
      unitPriceAfterPromo,
      lineTotal: baseQty * unitPriceAfterPromo,
    }
  }

  return {
    quantityAfterPromo: baseQty,
    unitPriceAfterPromo: basePrice,
    lineTotal: baseQty * basePrice,
  }
}

const calcLineTotal = (line: LineItemForm) => calcLinePricing(line).lineTotal
const calcOrderTotal = (lines: LineItemForm[]) => lines.reduce((sum, line) => sum + calcLineTotal(line), 0)

const describePromo = (line: LineItemForm) => {
  if (line.promoType === 'buy_x_get_y') {
    const buyQty = line.promoBuyQty || '0'
    const getQty = line.promoGetQty || '0'
    return `Mua ${buyQty} tặng ${getQty}`
  }
  if (line.promoType === 'discount_percent') {
    const discount = line.promoDiscountPercent || '0'
    return `Giảm ${discount}%`
  }
  return 'Không khuyến mãi'
}

const formatRetailPrices = (line: LineItemForm) =>
  line.unitRetailPrices
    .map((item) => `${item.unitName}: ${formatCurrency(parseNumber(item.price))}`)
    .join(' · ')

const ReceiptMetaItem = ({
  label,
  value,
}: {
  label: string
  value: string
}) => (
  <div className="rounded-2xl border border-ink-900/10 bg-fog-50/80 px-3 py-3">
    <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">{label}</p>
    <p className="mt-1 text-sm font-medium text-ink-900 break-words">{value || '-'}</p>
  </div>
)

const ReceiptStatCard = ({
  label,
  value,
  helper,
  tone = 'default',
}: {
  label: string
  value: string
  helper?: string
  tone?: 'default' | 'primary'
}) => (
  <div
    className={`rounded-2xl border px-4 py-4 ${
      tone === 'primary'
        ? 'border-brand-500/20 bg-brand-500/10'
        : 'border-ink-900/10 bg-white'
    }`}
  >
    <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">{label}</p>
    <p className="mt-2 text-lg font-semibold text-ink-900">{value}</p>
    {helper ? <p className="mt-1 text-xs text-ink-600">{helper}</p> : null}
  </div>
)

const ReceiptLineCard = ({
  line,
  drug,
  index,
}: {
  line: LineItemForm
  drug: Drug | undefined
  index: number
}) => {
  const pricing = calcLinePricing(line)

  return (
    <div className="rounded-2xl border border-ink-900/10 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">Dòng {index}</p>
          <p className="mt-1 text-sm font-semibold text-ink-900">{drug?.name ?? '-'}</p>
          <p className="mt-1 text-xs text-ink-600">
            {[drug?.code, drug?.maker].filter(Boolean).join(' · ') || 'Chưa có thông tin thuốc'}
          </p>
        </div>
        <div className="min-w-[128px] rounded-2xl bg-fog-50 px-3 py-2 text-right">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">Giá trị dòng</p>
          <p className="mt-1 text-base font-semibold text-ink-900">{formatCurrency(calcLineTotal(line))}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <ReceiptMetaItem label="Số lô" value={line.lotNumber || '-'} />
        <ReceiptMetaItem label="QR lô" value={line.batchCode || '-'} />
        <ReceiptMetaItem label="HSD" value={formatDate(line.expDate)} />
        <ReceiptMetaItem label="SL sau KM" value={pricing.quantityAfterPromo.toLocaleString('vi-VN')} />
        <ReceiptMetaItem label="Giá sau KM" value={formatCurrency(pricing.unitPriceAfterPromo)} />
        <ReceiptMetaItem label="Khuyến mãi" value={describePromo(line)} />
      </div>

      <div className="mt-3 rounded-2xl bg-fog-50/80 px-3 py-3">
        <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">Giá bán theo đơn vị</p>
        <p className="mt-1 text-xs leading-6 text-ink-700 break-words">{formatRetailPrices(line) || '-'}</p>
      </div>
    </div>
  )
}

const getLotLabelPrice = (line: LineItemForm) => {
  const highestUnit = line.unitRetailPrices
    .slice()
    .sort((a, b) => b.conversion - a.conversion)[0]
  const unitPrice = parseNumber(highestUnit?.price ?? '')
  if (unitPrice > 0) return unitPrice
  return calcLinePricing(line).unitPriceAfterPromo
}

const RECEIPT_EXTRAS_STORAGE_KEY = 'pharmar.receipt.extras.v1'
const PURCHASE_FORM_DRAFT_STORAGE_KEY = 'pharmar.purchases.form.draft.v1'

const loadReceiptExtras = (): Record<string, ReceiptExtra> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(RECEIPT_EXTRAS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, ReceiptExtra>
  } catch {
    return {}
  }
}

const loadPurchaseFormDraft = (): Partial<OrderFormState> | null =>
  readLocalDraft<Partial<OrderFormState>>(PURCHASE_FORM_DRAFT_STORAGE_KEY)

const toPromoNote = (line: LineItemForm) => {
  if (line.promoType === 'none') return null
  if (line.promoType === 'buy_x_get_y') {
    return `Mua ${line.promoBuyQty || '0'} tặng ${line.promoGetQty || '0'}`
  }
  return `Giảm ${line.promoDiscountPercent || '0'}%`
}

const parsePromoNote = (note: string | null | undefined) => {
  if (!note) {
    return {
      promoType: 'none' as PromoType,
      promoBuyQty: '',
      promoGetQty: '',
      promoDiscountPercent: '',
    }
  }

  const buyGetMatch = note.match(/mua\s*(\d+)\s*tặng\s*(\d+)/i)
  if (buyGetMatch) {
    return {
      promoType: 'buy_x_get_y' as PromoType,
      promoBuyQty: buyGetMatch[1],
      promoGetQty: buyGetMatch[2],
      promoDiscountPercent: '',
    }
  }

  const discountMatch = note.match(/giảm\s*(\d+(?:\.\d+)?)\s*%/i)
  if (discountMatch) {
    return {
      promoType: 'discount_percent' as PromoType,
      promoBuyQty: '',
      promoGetQty: '',
      promoDiscountPercent: discountMatch[1],
    }
  }

  return {
    promoType: 'none' as PromoType,
    promoBuyQty: '',
    promoGetQty: '',
    promoDiscountPercent: '',
  }
}

const normalizeLookupKey = (value: string) => value.trim().toLocaleLowerCase('vi-VN')

const mapMetaDrugToUiDrug = (drug: InventoryMetaDrug): Drug => {
  const sortedUnits = drug.units.slice().sort((a, b) => b.conversion - a.conversion)
  return {
    id: drug.id,
    code: drug.code,
    name: drug.name,
    regNo: '',
    group: drug.group || '',
    maker: '',
    barcode: sortedUnits[0]?.barcode ?? '',
    units: sortedUnits.map((unit) => ({
      id: unit.id,
      name: unit.name,
      conversion: unit.conversion,
      barcode: unit.barcode,
    })),
  }
}

const buildDefaultPricesFromMeta = (drugs: InventoryMetaDrug[]) => {
  const result: Record<string, Record<string, string>> = {}
  drugs.forEach((drug) => {
    const priceMap: Record<string, string> = {}
    drug.unit_prices.forEach((item) => {
      priceMap[item.unit_id] = String(item.price ?? '')
    })
    result[drug.id] = priceMap
  })
  return result
}

function mapMetaSupplierToUiSupplier(supplier: InventoryMetaSupplier): Supplier {
  return {
    id: supplier.id,
    name: supplier.name,
    contactName: supplier.contact_name,
    phone: supplier.phone,
    address: supplier.address,
  }
}

const defaultReceiptLineExtra = (
  unitRetailPrices: LineRetailPrice[],
): ReceiptLineExtra => ({
  promoType: 'none',
  promoBuyQty: '',
  promoGetQty: '',
  promoDiscountPercent: '',
  barcode: '',
  unitRetailPrices,
})

const normalizeReceiptLineExtra = (
  extra: Partial<ReceiptLineExtra> | undefined,
  fallback: ReceiptLineExtra,
): ReceiptLineExtra => ({
  promoType: extra?.promoType ?? fallback.promoType,
  promoBuyQty: extra?.promoBuyQty ?? fallback.promoBuyQty,
  promoGetQty: extra?.promoGetQty ?? fallback.promoGetQty,
  promoDiscountPercent: extra?.promoDiscountPercent ?? fallback.promoDiscountPercent,
  barcode: extra?.barcode ?? fallback.barcode,
  unitRetailPrices: Array.isArray(extra?.unitRetailPrices)
    ? extra.unitRetailPrices
    : fallback.unitRetailPrices,
})

const mapInventoryLineUnitPricesToRetail = (
  items: InventoryReceiptLineUnitPrice[] | undefined,
): LineRetailPrice[] =>
  (items ?? []).map((item) => ({
    unitId: item.unit_id,
    unitName: item.unit_name,
    conversion: item.conversion,
    price: String(item.price),
  }))

const mapInventoryReceiptLineToFormLine = (
  line: InventoryReceiptLine,
  drugs: Drug[],
  defaults: Record<string, Record<string, string>>,
  extraByBatchCode: Record<string, ReceiptLineExtra>,
): LineItemForm => {
  const matchedDrug =
    drugs.find((item) => item.id === line.drug_id) ??
    drugs.find((item) => normalizeLookupKey(item.code) === normalizeLookupKey(line.drug_code))
  const resolvedDrugId = matchedDrug?.id ?? line.drug_id

  const promoFromApi = line.promo_type
    ? {
        promoType: line.promo_type as PromoType,
        promoBuyQty: line.promo_buy_qty ? String(line.promo_buy_qty) : '',
        promoGetQty: line.promo_get_qty ? String(line.promo_get_qty) : '',
        promoDiscountPercent: line.promo_discount_percent
          ? String(line.promo_discount_percent)
          : '',
      }
    : parsePromoNote(line.promo_note)
  const apiRetailPrices = mapInventoryLineUnitPricesToRetail(line.unit_prices)
  const fallbackRetailPrices = buildLineRetailPrices(
    resolvedDrugId,
    apiRetailPrices.length ? apiRetailPrices : undefined,
    drugs,
    defaults,
  )
  const fallbackExtra = defaultReceiptLineExtra(
    apiRetailPrices.length ? apiRetailPrices : fallbackRetailPrices,
  )
  const storedExtra = extraByBatchCode[line.batch_code]
  const mergedExtra = normalizeReceiptLineExtra(storedExtra, fallbackExtra)

  const lineRetailPrices = buildLineRetailPrices(
    resolvedDrugId,
    mergedExtra.unitRetailPrices,
    drugs,
    defaults,
  )

  const drug = matchedDrug
  const fallbackBarcode = drug?.barcode ?? ''

  return {
    id: line.id,
    batchId: line.batch_id,
    batchCode: line.batch_code,
    originalBatchCode: line.batch_code,
    drugId: resolvedDrugId,
    lotNumber: line.lot_number,
    quantity: String(line.quantity),
    mfgDate: line.mfg_date,
    expDate: line.exp_date,
    price: String(line.import_price),
    promoType: storedExtra ? mergedExtra.promoType : promoFromApi.promoType,
    promoBuyQty: storedExtra ? mergedExtra.promoBuyQty : promoFromApi.promoBuyQty,
    promoGetQty: storedExtra ? mergedExtra.promoGetQty : promoFromApi.promoGetQty,
    promoDiscountPercent: storedExtra
      ? mergedExtra.promoDiscountPercent
      : promoFromApi.promoDiscountPercent,
    barcode: line.barcode || mergedExtra.barcode || fallbackBarcode,
    unitRetailPrices: lineRetailPrices,
  }
}

const mapInventoryReceiptToPurchaseOrder = (
  receipt: InventoryReceipt,
  drugs: Drug[],
  defaults: Record<string, Record<string, string>>,
  extras?: ReceiptExtra,
): PurchaseOrder => {
  const extra = extras
  const lineExtras = extra?.lineExtras ?? {}
  const shippingCarrier = receipt.shipping_carrier?.trim() || extra?.shippingCarrier || 'GHN'

  return {
    id: receipt.id,
    code: receipt.code,
    date: receipt.receipt_date,
    supplierId: receipt.supplier_id,
    shippingCarrier,
    note: receipt.note ?? '',
    paymentStatus: receipt.payment_status
      ? paymentStatusFromApi(receipt.payment_status)
      : extra?.paymentStatus ?? 'Đã thanh toán',
    paymentMethod: receipt.payment_method
      ? paymentMethodFromApi(receipt.payment_method)
      : extra?.paymentMethod ?? 'Ngân hàng',
    lines: receipt.lines.map((line) =>
      mapInventoryReceiptLineToFormLine(line, drugs, defaults, lineExtras),
    ),
    createdAt: Number.isFinite(Date.parse(receipt.created_at))
      ? Date.parse(receipt.created_at)
      : Date.now(),
    canEdit: receipt.can_edit,
    receiptStatus: receipt.status,
  }
}

const buildReceiptExtraFromOrder = (order: OrderFormState): ReceiptExtra => ({
  shippingCarrier: order.shippingCarrier,
  paymentStatus: order.paymentStatus,
  paymentMethod: order.paymentMethod,
  lineExtras: order.lines.reduce<Record<string, ReceiptLineExtra>>((acc, line) => {
    const key = line.batchCode.trim() || line.originalBatchCode.trim()
    if (!key) return acc
    acc[key] = {
      promoType: line.promoType,
      promoBuyQty: line.promoBuyQty.trim(),
      promoGetQty: line.promoGetQty.trim(),
      promoDiscountPercent: line.promoDiscountPercent.trim(),
      barcode: line.barcode.trim(),
      unitRetailPrices: line.unitRetailPrices.map((unitPrice) => ({
        ...unitPrice,
        price: unitPrice.price.trim(),
      })),
    }
    return acc
  }, {}),
})

const buildInventoryPayloadFromForm = (
  order: OrderFormState,
  drugMap: Map<string, Drug>,
  options?: { includeBatchCode?: boolean },
): InventoryCreateReceiptPayload => ({
  receipt_date: order.date,
  supplier_id: order.supplierId,
  shipping_carrier: order.shippingCarrier.trim(),
  payment_status: paymentStatusToApi(order.paymentStatus),
  payment_method: paymentMethodToApi(order.paymentMethod),
  note: order.note.trim() || null,
  lines: order.lines.map((line) => {
    const selectedDrug = drugMap.get(line.drugId)
    const resolvedBatchCode = options?.includeBatchCode
      ? normalizeBatchCode(line.batchCode) || normalizeBatchCode(line.originalBatchCode) || undefined
      : undefined
    return {
      drug_id: line.drugId || undefined,
      drug_code: selectedDrug?.code || undefined,
      batch_code: resolvedBatchCode,
      lot_number: line.lotNumber.trim(),
      quantity: Math.max(1, Math.floor(parseNumber(line.quantity))),
      mfg_date: line.mfgDate,
      exp_date: line.expDate,
      import_price: Math.max(0, parseNumber(line.price)),
      barcode: line.barcode.trim() || null,
      promo_type: line.promoType,
      promo_buy_qty:
        line.promoType === 'buy_x_get_y'
          ? Math.max(1, Math.floor(parseNumber(line.promoBuyQty)))
          : null,
      promo_get_qty:
        line.promoType === 'buy_x_get_y'
          ? Math.max(1, Math.floor(parseNumber(line.promoGetQty)))
          : null,
      promo_discount_percent:
        line.promoType === 'discount_percent'
          ? Math.max(0, parseNumber(line.promoDiscountPercent))
          : null,
      unit_prices: line.unitRetailPrices.map((unitPrice) => ({
        unit_id: unitPrice.unitId,
        unit_name: unitPrice.unitName,
        conversion: unitPrice.conversion,
        price: Math.max(0, parseNumber(unitPrice.price)),
      })),
      promo_note: toPromoNote(line),
    }
  }),
})

// ============================================================
// Barcode Scanning Engine (Quagga2)
//
// Ưu tiên: Quagga2 (nhạy với barcode 1D, nhiều tuỳ chỉnh)
// - Live stream + locate: true
// - Có nút "Chụp & quét" để chủ động quét khi cần
// ============================================================

const QUAGGA_READERS = ['ean_reader', 'upc_reader']
const getQuaggaArea = (isMobile: boolean) =>
  isMobile
    ? { top: '25%', right: '8%', left: '8%', bottom: '25%' }
    : { top: '35%', right: '10%', left: '10%', bottom: '35%' }
const QUAGGA_CONFIDENCE_THRESHOLD = 0.2

const GTIN_LENGTHS = new Set([8, 12, 13, 14])
const isDigitsOnly = (value: string) => /^\d+$/.test(value)

const normalizeBarcodeText = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/[a-z]/i.test(trimmed)) return trimmed.replace(/\s+/g, '')
  return trimmed.replace(/\D+/g, '')
}

const computeGtinCheckDigit = (body: string) => {
  let sum = 0
  let weight = 3
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * weight
    weight = weight === 3 ? 1 : 3
  }
  return (10 - (sum % 10)) % 10
}

const isValidGtin = (value: string) => {
  if (!isDigitsOnly(value) || !GTIN_LENGTHS.has(value.length)) return false
  const body = value.slice(0, -1)
  const check = Number(value[value.length - 1])
  return computeGtinCheckDigit(body) === check
}

// --- Quagga helpers ---
let _manualCanvas: HTMLCanvasElement | null = null
let _manualCtx: CanvasRenderingContext2D | null = null

const getManualCanvas = () => {
  if (!_manualCanvas) {
    _manualCanvas = document.createElement('canvas')
    _manualCtx = _manualCanvas.getContext('2d', { willReadFrequently: true })
  }
  return { canvas: _manualCanvas, ctx: _manualCtx }
}

const quaggaConfig = (target: HTMLElement, deviceId?: string, fallback = false) => {
  const isMobile =
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)')?.matches
  const width = fallback ? 1280 : isMobile ? 1280 : 1920
  const height = fallback ? 720 : isMobile ? 720 : 1080
  const baseConstraints: MediaTrackConstraints = {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    facingMode: deviceId ? undefined : { ideal: 'environment' },
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: isMobile ? 24 : 30 },
    advanced: [{ focusMode: 'continuous' } as any],
  }

  return {
    inputStream: {
      type: 'LiveStream',
      target,
      ...(fallback ? {} : { area: getQuaggaArea(isMobile) }),
      constraints: baseConstraints,
    },
    locator: {
      halfSample: false,
      patchSize: 'large',
    },
    decoder: {
      readers: QUAGGA_READERS,
    },
    locate: true,
    numOfWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
    frequency: isMobile ? 6 : 10,
  }
}

export function Purchases() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canOverrideReceiptLock = isOwnerOrAdmin(user)

  const [supplierOptions, setSupplierOptions] = useState<Supplier[]>(suppliers)
  const [drugOptions, setDrugOptions] = useState<Drug[]>(drugCatalog)
  const [defaultRetailPrices, setDefaultRetailPrices] = useState<Record<string, Record<string, string>>>(
    defaultRetailPricesByDrug,
  )
  const [receiptExtras, setReceiptExtras] = useState<Record<string, ReceiptExtra>>(() => loadReceiptExtras())
  const [apiMismatchNotice, setApiMismatchNotice] = useState<string | null>(null)

  const [orders, setOrders] = useState<PurchaseOrder[]>(initialOrders)
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [savingOrder, setSavingOrder] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('Tất cả')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('Tất cả')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [totalOrders, setTotalOrders] = useState(0)
  const [orderPages, setOrderPages] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState<OrderFormState>(() => createEmptyOrder(initialOrders, todayISO(), suppliers))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [lineDrugSearch, setLineDrugSearch] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [labelConfirmOrder, setLabelConfirmOrder] = useState<PurchaseOrder | null>(null)
  const [labelCounts, setLabelCounts] = useState<Record<string, string>>({})
  const [labelPrintError, setLabelPrintError] = useState<string | null>(null)
  const [labelPrinting, setLabelPrinting] = useState(false)

  const [scanOpen, setScanOpen] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanTarget, setScanTarget] = useState<ScanTarget | null>(null)
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [scanMessage, setScanMessage] = useState<string>('Đang khởi tạo camera...')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [focusSupported, setFocusSupported] = useState(false)
  const [focusRange, setFocusRange] = useState<{ min: number; max: number; step: number } | null>(null)
  const [focusDistance, setFocusDistance] = useState<number | null>(null)
  const [scanEngine, setScanEngine] = useState<'quagga' | ''>('')

  const quaggaContainerRef = useRef<HTMLDivElement | null>(null)
  const scanTargetRef = useRef<ScanTarget | null>(null)
  const scanActiveRef = useRef(false)
  const scanStabilityRef = useRef<{ value: string; count: number; lastSeen: number } | null>(null)
  const receiptExtrasRef = useRef(receiptExtras)
  const formFieldRefs = useRef<Record<string, HTMLElement | null>>({})
  const lineCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const pendingNewLineIdRef = useRef<string | null>(null)

  const clearPurchaseFormDraft = useCallback(() => {
    removeLocalDraft(PURCHASE_FORM_DRAFT_STORAGE_KEY)
  }, [])

  useEffect(() => {
    receiptExtrasRef.current = receiptExtras
  }, [receiptExtras])

  const persistReceiptExtras = useCallback((next: Record<string, ReceiptExtra>) => {
    setReceiptExtras(next)
    receiptExtrasRef.current = next
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(RECEIPT_EXTRAS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore local storage errors
    }
  }, [])

  const setFormFieldRef = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) formFieldRefs.current[key] = element
      else delete formFieldRefs.current[key]
    },
    [],
  )

  const focusAndScrollField = useCallback((key: string) => {
    const target = formFieldRefs.current[key]
    if (!target) return false
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if ('focus' in target && typeof target.focus === 'function') {
      target.focus()
    }
    return true
  }, [])

  const setLineCardRef = useCallback(
    (lineId: string) => (element: HTMLDivElement | null) => {
      if (element) lineCardRefs.current[lineId] = element
      else delete lineCardRefs.current[lineId]
    },
    [],
  )

  const scrollToLineCard = useCallback((lineId: string) => {
    const target = lineCardRefs.current[lineId]
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const firstFocusable = target.querySelector('select, input, textarea, button') as HTMLElement | null
    firstFocusable?.focus()
  }, [])

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

  const getApiErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError) {
      if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
      if (error.status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
      if (error.status === 409) return error.message
      if (error.status === 422) return `Dữ liệu chưa hợp lệ: ${error.message}`
      return error.message || fallback
    }
    return fallback
  }, [])

  const getLockedReceiptConflictMessage = useCallback((detail: string) => {
    if (detail.includes('requires existing batch_code for every line')) {
      return 'Không thể cập nhật vì một số lô cũ thiếu mã batch để đối chiếu.'
    }
    if (detail.includes('cannot add/remove lines')) {
      return 'Phiếu đã phát sinh giao dịch nên không thể thêm hoặc xóa dòng thuốc.'
    }
    if (detail.includes('cannot remove existing lines')) {
      return 'Phiếu đã phát sinh giao dịch nên không thể xóa các dòng thuốc cũ.'
    }
    if (detail.includes('cannot change drug of existing line')) {
      return 'Phiếu đã phát sinh giao dịch nên không thể đổi thuốc của dòng đã có.'
    }
    if (detail.includes('cannot change quantity')) {
      return 'Phiếu đã phát sinh giao dịch nên không thể thay đổi số lượng nhập.'
    }
    return detail
  }, [])

  const loadPurchasesData = useCallback(
    async (extrasOverride?: Record<string, ReceiptExtra>) => {
      setLoadingOrders(true)
      try {
        const [apiSuppliers, apiDrugs, receiptPage] = await Promise.all([
          inventoryApi.getMetaSuppliers(accessToken || undefined),
          inventoryApi.getMetaDrugs(accessToken || undefined),
          inventoryApi.listImportReceiptsPaged({
            page,
            size: pageSize,
            search: debouncedSearch || undefined,
            supplier_id: supplierFilter === 'Tất cả' ? undefined : supplierFilter,
            payment_status: paymentStatusFilter === 'Tất cả'
              ? undefined
              : paymentStatusToApi(paymentStatusFilter as PaymentStatus),
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
          }),
        ])

        const nextSupplierOptions = apiSuppliers
          .map(mapMetaSupplierToUiSupplier)
          .sort((a, b) => a.name.localeCompare(b.name, 'vi-VN'))

        const nextDrugOptions = apiDrugs
          .map(mapMetaDrugToUiDrug)
          .sort((a, b) => a.name.localeCompare(b.name, 'vi-VN'))

        const nextDefaultRetailPrices = buildDefaultPricesFromMeta(apiDrugs)
        const extras = extrasOverride ?? receiptExtrasRef.current

        const receiptDetails = await Promise.all(
          receiptPage.items.map(async (item) => {
            try {
              return await inventoryApi.getImportReceipt(item.id)
            } catch {
              return null
            }
          }),
        )

        const nextOrders = receiptDetails
          .filter((receipt): receipt is InventoryReceipt => receipt !== null)
          .map((receipt) =>
          mapInventoryReceiptToPurchaseOrder(
            receipt,
            nextDrugOptions,
            nextDefaultRetailPrices,
            extras[receipt.id],
          ))

        setSupplierOptions(nextSupplierOptions)
        setDrugOptions(nextDrugOptions)
        setDefaultRetailPrices(nextDefaultRetailPrices)
        setOrders(nextOrders)
        setTotalOrders(receiptPage.total)
        setOrderPages(Math.max(1, receiptPage.pages))
        setPage(receiptPage.page)
        setAlert(null)
        const hasStructuredFields = nextOrders.every((order) => {
          const matchingReceipt = receiptDetails.find((item) => item?.id === order.id)
          if (!matchingReceipt) return false
          const receipt = matchingReceipt as InventoryReceipt
          const rawReceipt = receipt as unknown as Record<string, unknown>
          const hasReceiptFields =
            'payment_status' in rawReceipt &&
            'payment_method' in rawReceipt &&
            'shipping_carrier' in rawReceipt
          const hasLineFields = receipt.lines.every((line: InventoryReceiptLine) => {
            const rawLine = line as unknown as Record<string, unknown>
            return (
              'barcode' in rawLine &&
              'promo_type' in rawLine &&
              'unit_prices' in rawLine
            )
          })
          return hasReceiptFields && hasLineFields
        })

        setApiMismatchNotice(
          hasStructuredFields
            ? null
            : 'API chưa trả đủ trường mở rộng cho trang nhập hàng. Hệ thống đang fallback bằng dữ liệu cục bộ để không mất dữ liệu thao tác.',
        )
      } catch (error) {
        setAlert(getApiErrorMessage(error, 'Không tải được dữ liệu nhập hàng từ API.'))
      } finally {
        setLoadingOrders(false)
      }
    },
    [
      accessToken,
      dateFrom,
      dateTo,
      getApiErrorMessage,
      page,
      pageSize,
      paymentStatusFilter,
      debouncedSearch,
      supplierFilter,
    ],
  )

  useEffect(() => {
    void loadPurchasesData()
  }, [loadPurchasesData])

  const supplierMap = useMemo(
    () => new Map(supplierOptions.map((supplier) => [supplier.id, supplier])),
    [supplierOptions]
  )

  const drugMap = useMemo(() => new Map(drugOptions.map((drug) => [drug.id, drug])), [drugOptions])

  const normalizeDrugName = useCallback((value: string) => value.trim().toLocaleLowerCase('vi-VN'), [])
  const normalizeBarcodeLookupKey = useCallback(
    (value: string) => normalizeBarcodeText(value).toLocaleUpperCase('vi-VN'),
    [],
  )

  const buildLineDrugSearch = useCallback(
    (lines: LineItemForm[]) => {
      const next: Record<string, string> = {}
      lines.forEach((line) => {
        const selectedDrug = drugMap.get(line.drugId)
        if (selectedDrug) {
          next[line.id] = selectedDrug.name
        }
      })
      return next
    },
    [drugMap],
  )

  const getLineDrugOptions = useCallback(
    (lineId: string, selectedDrugId: string) => {
      const keyword = normalizeDrugName(lineDrugSearch[lineId] ?? '')
      const filtered = keyword
        ? drugOptions.filter((item) => normalizeDrugName(item.name).includes(keyword))
        : drugOptions

      if (!selectedDrugId) return filtered
      if (filtered.some((item) => item.id === selectedDrugId)) return filtered

      const selected = drugOptions.find((item) => item.id === selectedDrugId)
      return selected ? [selected, ...filtered] : filtered
    },
    [drugOptions, lineDrugSearch, normalizeDrugName],
  )

  const barcodeIndex = useMemo(() => {
    const index = new Map<string, string>()
    drugOptions.forEach((drug) => {
      const drugBarcodeKey = normalizeBarcodeLookupKey(drug.barcode)
      if (drugBarcodeKey) index.set(drugBarcodeKey, drug.id)
      drug.units.forEach((unit) => {
        const unitBarcodeKey = normalizeBarcodeLookupKey(unit.barcode)
        if (unitBarcodeKey) index.set(unitBarcodeKey, drug.id)
      })
    })
    return index
  }, [drugOptions, normalizeBarcodeLookupKey])

  const editingOrder = useMemo(
    () => (editingId ? orders.find((order) => order.id === editingId) ?? null : null),
    [editingId, orders],
  )
  const isLockedReceiptEdit = Boolean(editingId && editingOrder?.canEdit === false)
  const isLockedExistingLine = useCallback(
    (lineId: string) =>
      Boolean(
        isLockedReceiptEdit &&
        form.lines.some(
          (line) =>
            line.id === lineId &&
            Boolean(line.batchId.trim() || line.originalBatchCode.trim()),
        ),
      ),
    [form.lines, isLockedReceiptEdit],
  )

  const buildRetailPrices = useCallback(
    (drugId: string, existing?: LineRetailPrice[]) =>
      buildLineRetailPrices(drugId, existing, drugOptions, defaultRetailPrices),
    [drugOptions, defaultRetailPrices],
  )
  const resolveDrugIdByBarcode = useCallback(
    async (rawBarcode: string) => {
      const barcodeKey = normalizeBarcodeLookupKey(rawBarcode)
      if (!barcodeKey) return ''

      const localMatch = barcodeIndex.get(barcodeKey)
      if (localMatch) return localMatch
      if (!accessToken) return ''

      try {
        const lookup = await catalogApi.getProductByBarcode(accessToken, barcodeKey)
        const byId = drugOptions.find((item) => item.id === lookup.product.id)
        if (byId) return byId.id
        const byCode = drugOptions.find(
          (item) => normalizeLookupKey(item.code) === normalizeLookupKey(lookup.product.code),
        )
        return byCode?.id ?? ''
      } catch (productError) {
        try {
          const lookup = await catalogApi.getUnitByBarcode(accessToken, barcodeKey)
          const byId = drugOptions.find((item) => item.id === lookup.product.id)
          if (byId) return byId.id
          const byCode = drugOptions.find(
            (item) => normalizeLookupKey(item.code) === normalizeLookupKey(lookup.product.code),
          )
          return byCode?.id ?? ''
        } catch {
          if (productError instanceof ApiError && productError.status === 404) return ''
          return ''
        }
      }
    },
    [accessToken, barcodeIndex, drugOptions, normalizeBarcodeLookupKey],
  )
  const applyBarcodeToLine = useCallback(
    async (lineId: string, rawBarcode: string) => {
      const barcodeKey = normalizeBarcodeLookupKey(rawBarcode)
      const matchedDrugId = barcodeKey ? await resolveDrugIdByBarcode(barcodeKey) : ''
      if (matchedDrugId && !isLockedExistingLine(lineId)) {
        const matchedDrugName = drugMap.get(matchedDrugId)?.name
        if (matchedDrugName) {
          setLineDrugSearch((prev) => ({
            ...prev,
            [lineId]: matchedDrugName,
          }))
        }
      }
      setForm((prev) => ({
        ...prev,
        lines: prev.lines.map((line) => {
          if (line.id !== lineId) return line
          const nextLine = { ...line, barcode: barcodeKey || rawBarcode.trim() }
          if (matchedDrugId && !isLockedExistingLine(lineId)) {
            nextLine.drugId = matchedDrugId
            nextLine.unitRetailPrices = buildRetailPrices(matchedDrugId, line.unitRetailPrices)
          }
          return nextLine
        }),
      }))
      return matchedDrugId
    },
    [buildRetailPrices, drugMap, isLockedExistingLine, normalizeBarcodeLookupKey, resolveDrugIdByBarcode],
  )

  const stats = useMemo(() => {
    const currentMonth = todayISO().slice(0, 7)
    const ordersInMonth = orders.filter((order) => order.date.startsWith(currentMonth))
    const totalValue = orders.reduce((sum, order) => sum + calcOrderTotal(order.lines), 0)
    const pendingValue = orders
      .filter((order) => order.paymentStatus === 'Còn nợ')
      .reduce((sum, order) => sum + calcOrderTotal(order.lines), 0)
    const dayMs = 24 * 60 * 60 * 1000
    const recentLines = orders.reduce((sum, order) => {
      const orderTime = new Date(order.date).getTime()
      if (Date.now() - orderTime <= 30 * dayMs) {
        return sum + order.lines.length
      }
      return sum
    }, 0)

    return [
      {
        label: 'Phiếu nhập tháng này',
        value: ordersInMonth.length.toString(),
        note: `${ordersInMonth.length} phiếu`,
      },
      {
        label: 'Tổng giá trị nhập',
        value: formatCurrency(totalValue),
        note: 'chưa VAT',
      },
      {
        label: 'Công nợ NPP',
        value: formatCurrency(pendingValue),
        note: `${supplierOptions.length} nhà cung cấp`,
      },
      {
        label: 'Lô mới',
        value: recentLines.toString(),
        note: 'trong 30 ngày',
      },
    ]
  }, [orders, supplierOptions.length])

  const shippingCarrierSuggestions = useMemo(() => {
    const next = new Set<string>()
    shippingCarriers.forEach((item) => next.add(item))
    orders.forEach((order) => {
      const value = order.shippingCarrier.trim()
      if (value) next.add(value)
    })
    const current = form.shippingCarrier.trim()
    if (current) next.add(current)
    return Array.from(next)
  }, [orders, form.shippingCarrier])

  const selectedLinePills = useMemo(() => {
    const seenDrugIds = new Set<string>()
    const pills: Array<{ drugId: string; name: string; lineId: string }> = []
    form.lines.forEach((line) => {
      const drugId = line.drugId?.trim()
      if (!drugId || seenDrugIds.has(drugId)) return
      const name = drugMap.get(drugId)?.name?.trim()
      if (!name) return
      seenDrugIds.add(drugId)
      pills.push({ drugId, name, lineId: line.id })
    })
    return pills
  }, [drugMap, form.lines])

  const paged = orders
  const totalPages = orderPages
  const rangeStart = totalOrders === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = totalOrders === 0 ? 0 : Math.min(page * pageSize, totalOrders)

  const resetFilters = () => {
    setSearch('')
    setSupplierFilter('Tất cả')
    setPaymentStatusFilter('Tất cả')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  const exportOrdersExcel = () => {
    const headers = [
      'Mã phiếu',
      'Ngày',
      'Nhà phân phối',
      'Liên hệ NPP',
      'Đơn vị vận chuyển',
      'Trạng thái thanh toán',
      'PT thanh toán',
      'Ghi chú',
      'Số mặt hàng',
      'Tổng tiền phiếu',
      'Mã thuốc',
      'Tên thuốc',
      'Mã lô',
      'Số lô NCC',
      'Số lượng nhập',
      'Đơn giá nhập',
      'Khuyến mãi',
      'SL sau khuyến mãi',
      'Giá sau khuyến mãi',
      'Thành tiền dòng',
    ]

    const rows = paged.flatMap((order) => {
      const supplier = supplierMap.get(order.supplierId)
      const orderTotal = calcOrderTotal(order.lines)

      if (order.lines.length === 0) {
        return [[
          order.code,
          formatDate(order.date),
          supplier?.name ?? '-',
          supplier ? `${supplier.contactName} - ${supplier.phone}` : '-',
          order.shippingCarrier || '-',
          order.paymentStatus,
          order.paymentMethod,
          order.note || '',
          0,
          orderTotal,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]]
      }

      return order.lines.map((line) => {
        const pricing = calcLinePricing(line)
        const selectedDrug = drugMap.get(line.drugId)
        return [
          order.code,
          formatDate(order.date),
          supplier?.name ?? '-',
          supplier ? `${supplier.contactName} - ${supplier.phone}` : '-',
          order.shippingCarrier || '-',
          order.paymentStatus,
          order.paymentMethod,
          order.note || '',
          order.lines.length,
          orderTotal,
          selectedDrug?.code ?? '',
          selectedDrug?.name ?? '',
          line.batchCode,
          line.lotNumber,
          line.quantity,
          parseNumber(line.price),
          describePromo(line),
          pricing.quantityAfterPromo,
          pricing.unitPriceAfterPromo,
          pricing.lineTotal,
        ]
      })
    })

    const dateKey = new Date().toISOString().slice(0, 10)
    downloadCsv(`nhap-hang-${dateKey}.csv`, headers, rows)
  }

  const openCreate = () => {
    setErrors({})
    setEditingId(null)
    const fallback = createEmptyOrder(orders, todayISO(), supplierOptions)
    const draft = loadPurchaseFormDraft()
    if (!draft) {
      setForm(fallback)
      setLineDrugSearch(buildLineDrugSearch(fallback.lines))
      setModalOpen(true)
      return
    }

    const nextLines =
      Array.isArray(draft.lines) && draft.lines.length
        ? draft.lines.map((line, index) => ({
            ...createLine(index + 1),
            ...line,
            id: line.id || `line-${Date.now()}-${index + 1}`,
            unitRetailPrices: Array.isArray(line.unitRetailPrices) ? line.unitRetailPrices : [],
          }))
        : fallback.lines

    const nextForm = {
      ...fallback,
      ...draft,
      id: undefined,
      lines: nextLines,
    }
    setForm(nextForm)
    setLineDrugSearch(buildLineDrugSearch(nextForm.lines))
    setModalOpen(true)
  }

  const openEdit = (order: PurchaseOrder) => {
    if (order.receiptStatus === 'cancelled') {
      setAlert('Phiếu đã hủy không thể chỉnh sửa.')
      return
    }
    if (order.canEdit === false && !canOverrideReceiptLock) {
      setAlert('Phiếu này đã phát sinh giao dịch nên chỉ owner/admin mới được chỉnh sửa.')
      return
    }
    setErrors({})
    setEditingId(order.id)
    const nextForm = {
      id: order.id,
      code: order.code,
      date: order.date,
      supplierId: order.supplierId,
      shippingCarrier: order.shippingCarrier,
      note: order.note,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      lines: order.lines.map((line) => ({
        ...line,
        batchId: line.batchId ?? '',
        batchCode: line.batchCode ?? '',
        originalBatchCode: line.originalBatchCode ?? line.batchCode ?? '',
        promoType: line.promoType ?? 'none',
        promoBuyQty: line.promoBuyQty ?? '',
        promoGetQty: line.promoGetQty ?? '',
        promoDiscountPercent: line.promoDiscountPercent ?? '',
        unitRetailPrices: buildRetailPrices(line.drugId, line.unitRetailPrices),
      })),
    }
    setForm(nextForm)
    setLineDrugSearch(buildLineDrugSearch(nextForm.lines))
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditingId(null)
    setLineDrugSearch({})
    setScanOpen(false)
  }

  const updateForm = (field: keyof OrderFormState, value: OrderFormState[keyof OrderFormState]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleDateChange = (value: string) => {
    setForm((prev) => {
      if (editingId) return { ...prev, date: value }
      return {
        ...prev,
        date: value,
        code: createOrderCode(orders, value),
      }
    })
  }

  const updateLine = (id: string, field: keyof LineItemForm, value: string) => {
    if (field === 'quantity' && isLockedExistingLine(id)) return
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    }))
  }
  const handleLineBarcodeBlur = useCallback(
    (lineId: string, rawBarcode: string) => {
      void applyBarcodeToLine(lineId, rawBarcode)
    },
    [applyBarcodeToLine],
  )

  const handleLineDrugSearchChange = (lineId: string, value: string) => {
    if (isLockedExistingLine(lineId)) return
    setLineDrugSearch((prev) => ({
      ...prev,
      [lineId]: value,
    }))

    const keyword = normalizeDrugName(value)
    if (!keyword) {
      setForm((prev) => ({
        ...prev,
        lines: prev.lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                drugId: '',
                unitRetailPrices: [],
              }
            : line,
        ),
      }))
      return
    }

    const matchedDrug = drugOptions.find((item) => normalizeDrugName(item.name) === keyword)
    if (matchedDrug) {
      handleDrugChange(lineId, matchedDrug.id)
    }
  }

  const handleDrugChange = (id: string, drugId: string) => {
    if (isLockedExistingLine(id)) return
    const drug = drugMap.get(drugId)
    setLineDrugSearch((prev) => ({
      ...prev,
      [id]: drug ? drug.name : '',
    }))
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => {
        if (line.id !== id) return line
        return {
          ...line,
          drugId,
          barcode: line.barcode || drug?.barcode || '',
          unitRetailPrices: buildRetailPrices(drugId, line.unitRetailPrices),
        }
      }),
    }))
  }

  const updateLineRetailPrice = (lineId: string, unitId: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => {
        if (line.id !== lineId) return line
        return {
          ...line,
          unitRetailPrices: line.unitRetailPrices.map((item) =>
            item.unitId === unitId ? { ...item, price: value } : item
          ),
        }
      }),
    }))
  }

  const focusFirstInvalidField = useCallback(
    (nextErrors: Record<string, string>) => {
      const firstKey = Object.keys(nextErrors)[0]
      if (!firstKey) return

      if (firstKey === 'date') {
        void focusAndScrollField('field-date')
        return
      }
      if (firstKey === 'supplierId') {
        void focusAndScrollField('field-supplier')
        return
      }
      if (firstKey === 'shippingCarrier') {
        void focusAndScrollField('field-shippingCarrier')
        return
      }
      if (firstKey === 'lines') {
        void focusAndScrollField('action-add-line')
        return
      }

      const retailPriceMatch = firstKey.match(/^line-retail-price-(\d+)-(.+)$/)
      if (retailPriceMatch) {
        const lineIndex = Number(retailPriceMatch[1])
        const unitId = retailPriceMatch[2]
        const lineId = form.lines[lineIndex]?.id
        if (!lineId) return
        if (focusAndScrollField(`line-retail-${lineId}-${unitId}`)) return
        void focusAndScrollField(`line-retail-first-${lineId}`)
        return
      }

      const lineMatch = firstKey.match(/^line-(drug|lot|qty|mfg|exp|price|promo-buy|promo-get|promo-discount|retail-prices)-(\d+)$/)
      if (!lineMatch) return
      const field = lineMatch[1]
      const lineIndex = Number(lineMatch[2])
      const lineId = form.lines[lineIndex]?.id
      if (!lineId) return

      if (field === 'retail-prices') {
        void focusAndScrollField(`line-retail-first-${lineId}`)
        return
      }
      void focusAndScrollField(`line-${field}-${lineId}`)
    },
    [focusAndScrollField, form.lines],
  )

  const addLine = () => {
    const newLineId = `line-${Date.now()}-${Math.max(1, form.lines.length + 1)}`
    pendingNewLineIdRef.current = newLineId
    setForm((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        {
          ...createLine(prev.lines.length + 1),
          id: newLineId,
        },
      ],
    }))
  }

  const removeLine = (id: string) => {
    if (isLockedExistingLine(id)) return
    setLineDrugSearch((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.length > 1 ? prev.lines.filter((line) => line.id !== id) : prev.lines,
    }))
  }

  useEffect(() => {
    const pendingLineId = pendingNewLineIdRef.current
    if (!pendingLineId) return
    const exists = form.lines.some((line) => line.id === pendingLineId)
    if (!exists) {
      pendingNewLineIdRef.current = null
      return
    }
    const focused = focusAndScrollField(`line-drug-${pendingLineId}`)
    if (focused) pendingNewLineIdRef.current = null
  }, [focusAndScrollField, form.lines])

  useEffect(() => {
    if (!modalOpen || editingId) return
    writeLocalDraft(PURCHASE_FORM_DRAFT_STORAGE_KEY, form)
  }, [editingId, form, modalOpen])

  const validate = () => {
    const next: Record<string, string> = {}
    if (!form.date) next.date = 'Bắt buộc'
    if (!form.supplierId) next.supplierId = 'Bắt buộc'
    if (!form.shippingCarrier.trim()) next.shippingCarrier = 'Bắt buộc'
    if (!form.lines.length) next.lines = 'Cần ít nhất 1 dòng thuốc'

    form.lines.forEach((line, index) => {
      if (!line.drugId) next[`line-drug-${index}`] = 'Bắt buộc'
      if (!line.lotNumber.trim()) next[`line-lot-${index}`] = 'Bắt buộc'
      if (!line.quantity.trim()) next[`line-qty-${index}`] = 'Bắt buộc'
      if (line.quantity.trim() && parseNumber(line.quantity) <= 0) next[`line-qty-${index}`] = 'Phải lớn hơn 0'
      if (!line.mfgDate) next[`line-mfg-${index}`] = 'Bắt buộc'
      if (!line.expDate) next[`line-exp-${index}`] = 'Bắt buộc'
      if (!line.price.trim()) next[`line-price-${index}`] = 'Bắt buộc'
      if (line.price.trim() && parseNumber(line.price) <= 0) next[`line-price-${index}`] = 'Phải lớn hơn 0'
      if (!line.unitRetailPrices.length) {
        next[`line-retail-prices-${index}`] = 'Cần nhập giá bán lẻ theo đơn vị'
      } else {
        line.unitRetailPrices.forEach((unitPrice) => {
          const parsed = parseNumber(unitPrice.price)
          if (!unitPrice.price.trim() || parsed <= 0) {
            next[`line-retail-price-${index}-${unitPrice.unitId}`] = 'Giá phải lớn hơn 0'
          }
        })
      }
      if (line.promoType === 'buy_x_get_y') {
        if (!line.promoBuyQty.trim()) next[`line-promo-buy-${index}`] = 'Bắt buộc'
        if (!line.promoGetQty.trim()) next[`line-promo-get-${index}`] = 'Bắt buộc'
        const buyQty = parseNumber(line.promoBuyQty)
        const getQty = parseNumber(line.promoGetQty)
        if (buyQty <= 0) next[`line-promo-buy-${index}`] = 'Phải lớn hơn 0'
        if (getQty <= 0) next[`line-promo-get-${index}`] = 'Phải lớn hơn 0'
      }
      if (line.promoType === 'discount_percent') {
        if (!line.promoDiscountPercent.trim()) next[`line-promo-discount-${index}`] = 'Bắt buộc'
        const discount = parseNumber(line.promoDiscountPercent)
        if (discount <= 0 || discount > 100) {
          next[`line-promo-discount-${index}`] = 'Từ 0 đến 100'
        }
      }
    })

    setErrors(next)
    return {
      ok: Object.keys(next).length === 0,
      nextErrors: next,
    }
  }

  const hydrateBatchCodesForLockedReceipt = useCallback(
    async (order: OrderFormState) => {
      if (!isLockedReceiptEdit) return order

      const nextLines = await Promise.all(
        order.lines.map(async (line) => {
          const existingBatchCode = normalizeBatchCode(line.batchCode) || normalizeBatchCode(line.originalBatchCode)
          if (existingBatchCode || !line.batchId) return line

          try {
            const detail = await inventoryApi.getBatchDetail(line.batchId)
            const hydratedBatchCode = normalizeBatchCode(detail.batch.batch_code)
            if (!hydratedBatchCode) return line
            return {
              ...line,
              batchCode: hydratedBatchCode,
              originalBatchCode: hydratedBatchCode,
            }
          } catch {
            return line
          }
        }),
      )

      const missingBatchCode = nextLines.some(
        (line) =>
          Boolean(line.batchId.trim() || line.originalBatchCode.trim()) &&
          !normalizeBatchCode(line.batchCode) &&
          !normalizeBatchCode(line.originalBatchCode),
      )
      if (missingBatchCode) {
        setAlert('Không thể cập nhật vì một số lô cũ thiếu mã batch để đối chiếu.')
        return null
      }

      const hasHydratedChanges = nextLines.some(
        (line, index) =>
          line.batchCode !== order.lines[index]?.batchCode ||
          line.originalBatchCode !== order.lines[index]?.originalBatchCode,
      )

      if (hasHydratedChanges) {
        setForm((prev) => ({
          ...prev,
          lines: prev.lines.map((line) => {
            const hydrated = nextLines.find((item) => item.id === line.id)
            return hydrated ?? line
          }),
        }))
      }

      return hasHydratedChanges ? { ...order, lines: nextLines } : order
    },
    [isLockedReceiptEdit],
  )

  const saveOrder = async () => {
    const validation = validate()
    if (!validation.ok) {
      focusFirstInvalidField(validation.nextErrors)
      return
    }

    if (!accessToken) {
      setAlert('Bạn cần đăng nhập để lưu phiếu nhập.')
      return
    }

    const isCreating = !editingId
    setSavingOrder(true)
    try {
      const effectiveForm = editingId ? await hydrateBatchCodesForLockedReceipt(form) : form
      if (!effectiveForm) return

      const payload = buildInventoryPayloadFromForm(effectiveForm, drugMap, {
        includeBatchCode: Boolean(editingId),
      })
      const receipt = editingId
        ? await inventoryApi.updateImportReceipt(accessToken, editingId, payload)
        : await inventoryApi.createImportReceipt(accessToken, payload)

      const nextExtras = {
        ...receiptExtrasRef.current,
        [receipt.id]: buildReceiptExtraFromOrder(effectiveForm),
      }
      persistReceiptExtras(nextExtras)

      const mappedOrder = mapInventoryReceiptToPurchaseOrder(
        receipt,
        drugOptions,
        defaultRetailPrices,
        nextExtras[receipt.id],
      )

      setModalOpen(false)
      setEditingId(null)
      setErrors({})
      if (isCreating) {
        clearPurchaseFormDraft()
        openLabelConfirm(mappedOrder)
      }

      await loadPurchasesData(nextExtras)
      setAlert(isCreating ? 'Đã tạo phiếu nhập.' : 'Đã cập nhật phiếu nhập.')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        console.error('Update import receipt conflict', error)
      }
      setAlert(
        error instanceof ApiError && error.status === 409 && !isCreating
          ? getLockedReceiptConflictMessage(error.message)
          : getApiErrorMessage(
              error,
              isCreating ? 'Không thể tạo phiếu nhập.' : 'Không thể cập nhật phiếu nhập.',
            ),
      )
    } finally {
      setSavingOrder(false)
    }
  }

  const removeOrder = async (orderId: string) => {
    if (!accessToken) {
      setAlert('Bạn cần đăng nhập để hủy phiếu nhập.')
      return
    }
    const targetOrder = orders.find((order) => order.id === orderId)
    if (targetOrder?.canEdit === false) {
      setAlert('Phiếu này đã phát sinh giao dịch nên không thể hủy.')
      return
    }
    try {
      await inventoryApi.cancelImportReceipt(accessToken, orderId)
      setExpandedId((prev) => (prev === orderId ? null : prev))
      await loadPurchasesData()
      setAlert('Đã hủy phiếu nhập.')
    } catch (error) {
      setAlert(getApiErrorMessage(error, 'Không thể hủy phiếu nhập.'))
    }
  }

  const openLabelConfirm = (order: PurchaseOrder) => {
    const nextCounts: Record<string, string> = {}
    order.lines.forEach((line) => {
      const qty = Math.max(1, Math.floor(parseNumber(line.quantity)))
      nextCounts[line.id] = String(qty)
    })
    setLabelCounts(nextCounts)
    setLabelPrintError(null)
    setLabelConfirmOrder(order)
  }

  const closeLabelConfirm = () => {
    setLabelConfirmOrder(null)
    setLabelCounts({})
    setLabelPrintError(null)
  }

  const getPrintCount = (line: LineItemForm) => {
    const raw = labelCounts[line.id] ?? ''
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return Math.max(1, Math.floor(parseNumber(line.quantity)))
    return Math.max(0, Math.floor(parsed))
  }

  const buildLabelQrValue = (_order: PurchaseOrder, line: LineItemForm) => {
    return line.batchCode.trim()
  }

  const printLotLabels = async (lines: LineItemForm[]) => {
    if (!labelConfirmOrder) return
    setLabelPrintError(null)

    const selectedLines = lines
      .map((line) => ({
        line,
        count: getPrintCount(line),
        drugName: drugMap.get(line.drugId)?.name ?? 'Thuốc',
        labelPrice: getLotLabelPrice(line),
      }))
      .filter((item) => item.count > 0)

    if (!selectedLines.length) {
      setLabelPrintError('Số tem in phải lớn hơn 0.')
      return
    }

    setLabelPrinting(true)
    try {
      const qrByLine = new Map<string, string>()
      for (const { line } of selectedLines) {
        const qrValue = buildLabelQrValue(labelConfirmOrder, line)
        const qrDataUrl = await QRCode.toDataURL(qrValue, {
          width: 980,
          margin: 0,
          errorCorrectionLevel: 'M',
        })
        qrByLine.set(line.id, qrDataUrl)
      }

      const labelsHtml = selectedLines
        .flatMap(({ line, count, drugName, labelPrice }) => {
          const qrDataUrl = qrByLine.get(line.id) ?? ''
          const priceText = formatCurrency(labelPrice)
          return Array.from({ length: count }, () => `
            <section class="label">
              <div class="qr-wrap">
                <img class="qr" src="${qrDataUrl}" alt="QR ${escapeHtml(line.batchCode)}" />
              </div>
              <div class="content">
                <div class="store">${escapeHtml(STORE_NAME)}</div>
                <div class="drug">${escapeHtml(drugName)}</div>
                <div class="price">${escapeHtml(priceText)}</div>
              </div>
            </section>
          `)
        })
        .join('')

      const html = `
        <!doctype html>
        <html lang="vi">
          <head>
            <meta charset="utf-8" />
            <title>In nhãn QR lô nhập</title>
            <style>
              @page {
                size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
                margin: 0;
              }
              * { box-sizing: border-box; }
              html, body {
                margin: 0;
                padding: 0;
                font-family: "Segoe UI", Arial, sans-serif;
                background: #fff;
              }
              .label {
                width: ${LABEL_WIDTH_MM}mm;
                height: ${LABEL_HEIGHT_MM}mm;
                padding: 1.2mm;
                page-break-after: always;
                display: grid;
                grid-template-columns: 14.5mm 1fr;
                align-items: center;
                gap: 1mm;
                overflow: hidden;
              }
              .qr-wrap {
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 0;
                border-radius: 0;
                padding: 0;
              }
              .content {
                min-width: 0;
                height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 0.8mm;
                padding-left: 0.6mm;
              }
              .store {
                width: 100%;
                text-align: left;
                font-size: 2.3mm;
                font-weight: 700;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .drug {
                width: 100%;
                text-align: left;
                font-size: 2.7mm;
                font-weight: 600;
                line-height: 1.1;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
              }
              .meta {
                width: 100%;
                text-align: left;
                font-size: 1.8mm;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .qr {
                width: 11.8mm;
                height: 11.8mm;
                image-rendering: pixelated;
              }
              .price {
                width: 100%;
                text-align: left;
                font-size: 2.9mm;
                font-weight: 800;
                line-height: 1.15;
              }
            </style>
          </head>
          <body>
            ${labelsHtml}
          </body>
        </html>
      `

      const printWindow = window.open('', '_blank', 'width=760,height=420')
      if (!printWindow) {
        setLabelPrintError('Trình duyệt đang chặn cửa sổ in. Hãy bật popup và thử lại.')
        return
      }
      printWindow.document.open()
      printWindow.document.write(html)
      printWindow.document.close()
      printWindow.focus()
      setTimeout(() => {
        printWindow.print()
        printWindow.close()
      }, 350)
    } catch (error) {
      setLabelPrintError('Không thể tạo tem QR để in. Vui lòng thử lại.')
    } finally {
      setLabelPrinting(false)
    }
  }

  // applyScanResult — dùng useCallback + ref để tránh stale closure
  const applyScanResult = useCallback(
    async (text: string) => {
      const target = scanTargetRef.current
      if (!target) return
      if (target.type === 'line') {
        await applyBarcodeToLine(target.id, text)
      }
      setScanOpen(false)
      setScanMessage('Đã quét thành công.')
    },
    [applyBarcodeToLine]
  )

  const handleScanCandidate = useCallback(
    (raw: string, options?: { immediate?: boolean }) => {
      const normalized = normalizeBarcodeText(raw)
      if (!normalized || normalized.length < 6) return false

      const now = Date.now()
      const digitsOnly = isDigitsOnly(normalized)
      const isEanUpcLength = digitsOnly && (normalized.length === 12 || normalized.length === 13)
      if (digitsOnly && !isEanUpcLength) {
        setScanMessage('Chỉ nhận EAN-13 hoặc UPC-A.')
        return false
      }
      const validGtin = digitsOnly && isValidGtin(normalized)
      if (digitsOnly && isEanUpcLength && !validGtin) {
        setScanMessage('Mã vạch chưa hợp lệ, đang thử lại...')
        return false
      }
      const requiredCount = options?.immediate && validGtin ? 1 : validGtin ? 2 : 3
      const windowMs = 1200

      const current = scanStabilityRef.current
      if (!current || current.value !== normalized || now - current.lastSeen > windowMs) {
        scanStabilityRef.current = { value: normalized, count: 1, lastSeen: now }
      } else {
        current.count += 1
        current.lastSeen = now
      }

      const count = scanStabilityRef.current?.count ?? 1
      if (count >= requiredCount) {
        void applyScanResult(normalized)
        return true
      }

      setScanError(null)
      setScanMessage(validGtin ? 'Đã đọc được, đang xác nhận...' : 'Đang xác nhận barcode...')
      return false
    },
    [applyScanResult]
  )

  const openScan = (target: ScanTarget) => {
    setScanError(null)
    setScanMessage('Đang khởi tạo camera...')
    setScanTarget(target)
    scanTargetRef.current = target
    scanStabilityRef.current = null
    setScanOpen(true)
  }

  const scanTitle = scanTarget?.type === 'line' ? 'Quét barcode lô nhập' : 'Quét barcode'

  // captureAndDecode — chụp 1 frame rồi thử detect
  const captureAndDecode = useCallback(async () => {
    const container = quaggaContainerRef.current
    const video = container?.querySelector('video') as HTMLVideoElement | null
    if (!video || !video.videoWidth) {
      setScanError('Camera chưa sẵn sàng.')
      return
    }
    setScanError(null)
    setScanMessage('Đang xử lý...')

    const { canvas, ctx } = getManualCanvas()
    if (!canvas || !ctx) {
      setScanError('Không thể khởi tạo canvas.')
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const dataUrl = canvas.toDataURL('image/png')
    ;(Quagga as any).decodeSingle(
      {
        src: dataUrl,
        locator: { halfSample: false, patchSize: 'large' },
        decoder: { readers: QUAGGA_READERS },
        locate: true,
        numOfWorkers: 0,
      },
      (result: any) => {
        if (!scanActiveRef.current) return
        const text = result?.codeResult?.code
        if (text) {
          const accepted = handleScanCandidate(text, { immediate: true })
          if (!accepted) {
            setScanError('Đã đọc được nhưng chưa ổn định. Giữ yên và bấm lại.')
          }
          return
        }
        setScanError('Không nhận được barcode. Đưa barcode gần hơn, giữ yên, bấm lại.')
        setScanMessage('Đang quét...')
      }
    )
  }, [handleScanCandidate])

  const handleZoom = useCallback((newZoom: number) => {
    setZoomLevel(newZoom)
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (track) {
      try {
        track.applyConstraints({ advanced: [{ zoom: newZoom } as any] } as any)
      } catch {
        /* ignore */
      }
    }
  }, [])

  const handleTorch = useCallback(() => {
    const next = !torchOn
    setTorchOn(next)
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (track) {
      try {
        track.applyConstraints({ advanced: [{ torch: next } as any] } as any)
      } catch {
        /* ignore */
      }
    }
  }, [torchOn])

  const handleRefocus = useCallback(() => {
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (!track) return
    try {
      const caps = track.getCapabilities?.() as any
      const modes: string[] = Array.isArray(caps?.focusMode) ? caps.focusMode : []
      if (modes.includes('single-shot')) {
        track.applyConstraints({ advanced: [{ focusMode: 'single-shot' } as any] } as any)
        return
      }
      if (modes.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] } as any)
        return
      }
      if (caps?.focusDistance) {
        const near = caps.focusDistance.min ?? 0
        track.applyConstraints({ advanced: [{ focusMode: 'manual' } as any, { focusDistance: near } as any] } as any)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleFocusDistance = useCallback((value: number) => {
    setFocusDistance(value)
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (!track) return
    try {
      track.applyConstraints({ advanced: [{ focusMode: 'manual' } as any, { focusDistance: value } as any] } as any)
    } catch {
      /* ignore */
    }
  }, [])

  const handleDetected = useCallback(
    (result: any) => {
      const codeResult = result?.codeResult
      const text = codeResult?.code
      if (!text || !scanActiveRef.current) return

      const decoded = Array.isArray(codeResult?.decodedCodes) ? codeResult.decodedCodes : []
      const errors = decoded.map((item: any) => item?.error).filter((e: any) => typeof e === 'number')
      const avgError = errors.length ? errors.reduce((sum: number, e: number) => sum + e, 0) / errors.length : null
      const isHighConfidence = avgError !== null && avgError <= QUAGGA_CONFIDENCE_THRESHOLD

      handleScanCandidate(text, isHighConfidence ? { immediate: true } : undefined)
    },
    [handleScanCandidate]
  )

  const stopQuagga = useCallback(() => {
    try {
      ;(Quagga as any).offDetected?.(handleDetected)
    } catch {
      /* ignore */
    }
    try {
      ;(Quagga as any).stop?.()
    } catch {
      /* ignore */
    }
    if (quaggaContainerRef.current) {
      quaggaContainerRef.current.innerHTML = ''
    }
  }, [handleDetected])

  // ============================================================
  // Camera useEffect (Quagga2)
  //
  // FIX CHÍNH:
  //   1. Camera LUÔN mở
  //   2. Không trộn deviceId exact + facingMode (tránh conflict)
  //   3. Quagga tự quản lý stream + onDetected
  // ============================================================
  useEffect(() => {
    if (!scanOpen) {
      scanActiveRef.current = false
      stopQuagga()
      setScanError(null)
      setScanMessage('Đang khởi tạo camera...')
      setScanEngine('')
      setZoomLevel(1)
      setZoomRange(null)
      setTorchOn(false)
      setTorchSupported(false)
      setFocusSupported(false)
      setFocusRange(null)
      setFocusDistance(null)
      scanStabilityRef.current = null
      return
    }

    scanActiveRef.current = true
    scanStabilityRef.current = null

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setScanError('Trình duyệt không hỗ trợ camera.')
          return
        }
        if (!quaggaContainerRef.current) {
          setScanError('Không thể khởi tạo vùng camera.')
          return
        }

        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = devices.filter((d) => d.kind === 'videoinput')
        if (!videoDevices.length) {
          setScanError('Không tìm thấy camera trên thiết bị.')
          return
        }
        setCameraDevices(videoDevices)

        const backCam = videoDevices.find((d) => /back|rear|environment|camera\s?2/i.test(d.label))
        const selectedExists = selectedDeviceId
          ? videoDevices.some((d) => d.deviceId === selectedDeviceId)
          : false
        const preferredId = selectedExists ? selectedDeviceId : backCam?.deviceId || videoDevices[0].deviceId
        if (!selectedExists) setSelectedDeviceId(preferredId)
        if (!scanActiveRef.current) return

        stopQuagga()
        const initQuagga = (deviceId?: string, fallback = false) =>
          new Promise<void>((resolve, reject) => {
            ;(Quagga as any).init(quaggaConfig(quaggaContainerRef.current as HTMLElement, deviceId, fallback), (err: any) => {
              if (err) reject(err)
              else resolve()
            })
          })

        try {
          await initQuagga(preferredId)
        } catch (initErr: any) {
          try {
            await initQuagga(preferredId, true)
          } catch {
            if (preferredId) {
              await initQuagga(undefined, true)
            } else {
              throw initErr
            }
          }
        }

        if (!scanActiveRef.current) {
          stopQuagga()
          return
        }

        ;(Quagga as any).onDetected(handleDetected)
        ;(Quagga as any).start()

        setScanEngine('quagga')
        setScanMessage('Đang quét (Quagga)... Đưa barcode vào khung hình.')

        setTimeout(async () => {
          if (!scanActiveRef.current) return
          try {
            const updated = await navigator.mediaDevices.enumerateDevices()
            const updatedVideo = updated.filter((d) => d.kind === 'videoinput')
            if (updatedVideo.length) setCameraDevices(updatedVideo)
          } catch {
            /* ignore */
          }
        }, 300)

        const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
        if (track) {
          try {
            const caps = track.getCapabilities?.() as any
            if (caps?.zoom) {
              setZoomRange({
                min: caps.zoom.min ?? 1,
                max: caps.zoom.max ?? 1,
                step: caps.zoom.step ?? 0.1,
              })
            }
            if (caps?.torch) setTorchSupported(true)
            const focusModes: string[] = Array.isArray(caps?.focusMode) ? caps.focusMode : []
            if (focusModes.length || caps?.focusDistance) {
              setFocusSupported(true)
            }
            if (caps?.focusDistance) {
              setFocusRange({
                min: caps.focusDistance.min ?? 0,
                max: caps.focusDistance.max ?? 0,
                step: caps.focusDistance.step ?? 0.01,
              })
              const currentFocus = track.getSettings?.().focusDistance
              setFocusDistance(
                typeof currentFocus === 'number' ? currentFocus : caps.focusDistance.min ?? 0
              )
            } else {
              setFocusRange(null)
              setFocusDistance(null)
            }
            const advanced: any[] = []
            if (focusModes.includes('continuous')) {
              advanced.push({ focusMode: 'continuous' })
            } else if (focusModes.includes('single-shot')) {
              advanced.push({ focusMode: 'single-shot' })
            }
            if (caps?.exposureMode?.includes?.('continuous')) advanced.push({ exposureMode: 'continuous' })
            if (advanced.length) await track.applyConstraints({ advanced } as any)
          } catch {
            /* ignore */
          }
        }
      } catch (err: any) {
        if (!scanActiveRef.current) return
        const name = err?.name ?? ''
        const friendly =
          name === 'NotAllowedError'
            ? 'Bạn đã từ chối quyền camera. Hãy cho phép trong cài đặt trình duyệt.'
            : name === 'NotReadableError'
            ? 'Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó và thử lại.'
            : name === 'NotFoundError'
            ? 'Không tìm thấy camera trên thiết bị.'
            : name === 'OverconstrainedError'
            ? 'Camera không đáp ứng được yêu cầu. Thử chọn camera khác.'
            : null
        setScanError(friendly || `Không thể mở camera: ${err?.message || 'Lỗi không xác định'}`)
      }
    }

    start()

    return () => {
      scanActiveRef.current = false
      stopQuagga()
    }
  }, [scanOpen, selectedDeviceId, handleDetected, stopQuagga])

  if (labelConfirmOrder) {
    return (
      <div className="space-y-6">
        <header className="flex flex-col gap-4 tablet:flex-row tablet:items-center tablet:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Xác nhận in nhãn</p>
            <h2 className="mt-2 text-3xl font-semibold text-ink-900">In tem QR cho lô nhập</h2>
            <p className="mt-2 text-sm text-ink-600">
              Phiếu {labelConfirmOrder.code} vừa tạo. Kiểm tra số lượng tem trước khi in.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => printLotLabels(labelConfirmOrder.lines)}
              disabled={labelPrinting}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
            >
              {labelPrinting ? 'Đang xử lý...' : 'In tất cả tem'}
            </button>
            <button
              type="button"
              onClick={closeLabelConfirm}
              className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
            >
              Bỏ qua
            </button>
          </div>
        </header>

        <section className="glass-card rounded-3xl p-6 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
              <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Nhà thuốc</p>
              <p className="mt-2 font-semibold text-ink-900">{STORE_NAME}</p>
            </div>
            <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
              <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Máy in dự kiến</p>
              <p className="mt-2 font-semibold text-ink-900">Clabel 211B</p>
            </div>
            <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
              <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Kích thước tem</p>
              <p className="mt-2 font-semibold text-ink-900">{LABEL_WIDTH_MM}mm x {LABEL_HEIGHT_MM}mm (ngang)</p>
            </div>
          </div>

          {labelPrintError ? <p className="text-sm text-coral-500">{labelPrintError}</p> : null}

          <div className="space-y-3">
            {labelConfirmOrder.lines.map((line) => {
              const drugName = drugMap.get(line.drugId)?.name ?? 'Thuốc'
              const qty = Math.max(1, Math.floor(parseNumber(line.quantity)))
              const printCount = labelCounts[line.id] ?? String(qty)
              return (
                <div key={line.id} className="rounded-2xl bg-white p-4">
                  <div className="grid gap-3 md:grid-cols-[1.2fr,1fr,1fr,1fr,auto] md:items-end">
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Lô</p>
                      <p className="mt-1 text-sm font-semibold text-ink-900">{line.batchCode}</p>
                      <p className="text-xs text-ink-600">{drugName} · {line.lotNumber || '-'}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">SL nhập</p>
                      <p className="mt-1 text-sm font-semibold text-ink-900">{qty.toLocaleString('vi-VN')}</p>
                    </div>
                    <label className="space-y-1 text-xs text-ink-600">
                      Số tem in
                      <input
                        value={printCount}
                        onChange={(event) =>
                          setLabelCounts((prev) => ({ ...prev, [line.id]: sanitizeDigits(event.target.value) }))
                        }
                        className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                      />
                    </label>
                    <div>
                      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Giá trên tem</p>
                      <p className="mt-1 text-sm font-semibold text-ink-900">
                        {formatCurrency(getLotLabelPrice(line))}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => printLotLabels([line])}
                      disabled={labelPrinting}
                      className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
                    >
                      In tem lô
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={closeLabelConfirm}
            className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
          >
            Về danh sách nhập hàng
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 tablet:flex-row tablet:items-center tablet:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Nhập hàng</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Theo dõi phiếu nhập</h2>
          <p className="mt-2 text-sm text-ink-600">Quản lý lô thuốc, nhà phân phối và công nợ.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={openCreate}
            disabled={loadingOrders}
            className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
          >
            Tạo phiếu nhập
          </button>
          <button
            type="button"
            onClick={exportOrdersExcel}
            disabled={loadingOrders || paged.length === 0}
            className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
          >
            Xuất Excel
          </button>
        </div>
      </header>

      {alert ? (
        <div className="glass-card flex items-center justify-between rounded-2xl px-4 py-3 text-sm text-ink-700">
          <span>{alert}</span>
          <button onClick={() => setAlert(null)} className="text-ink-600">Đóng</button>
        </div>
      ) : null}

      {apiMismatchNotice ? (
        <div className="rounded-2xl border border-sun-500/30 bg-sun-500/10 px-4 py-3 text-sm text-ink-700">
          {apiMismatchNotice}
        </div>
      ) : null}

      {loadingOrders ? (
        <div className="rounded-2xl border border-ink-900/10 bg-white/70 px-4 py-3 text-sm text-ink-600">
          Đang đồng bộ dữ liệu nhập hàng từ API...
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => (
          <div key={item.label} className="glass-card min-w-0 rounded-2xl p-4 sm:rounded-3xl sm:p-5">
            <p className="text-[10px] uppercase tracking-[0.2em] text-ink-600 sm:text-xs sm:tracking-[0.28em]">{item.label}</p>
            <p className="mt-2 text-xl font-semibold text-ink-900 sm:mt-3 sm:text-2xl">{item.value}</p>
            <p className="mt-1 text-[11px] text-ink-600 sm:mt-2 sm:text-xs">{item.note}</p>
          </div>
        ))}
      </section>

      <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            placeholder="Tìm theo mã phiếu, nhà phân phối"
          />
          <button
            type="button"
            onClick={() => setMobileFiltersOpen((prev) => !prev)}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 md:hidden"
          >
            {mobileFiltersOpen ? 'Ẩn bộ lọc' : 'Bộ lọc nâng cao'}
          </button>
        </div>

        <div className="hidden gap-3 md:grid md:grid-cols-[1fr,1fr,1fr,1fr,auto]">
          <select
            value={supplierFilter}
            onChange={(event) => {
              setSupplierFilter(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value="Tất cả">Tất cả NPP</option>
            {supplierOptions.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
          <select
            value={paymentStatusFilter}
            onChange={(event) => {
              setPaymentStatusFilter(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value="Tất cả">Tất cả thanh toán</option>
            <option value="Đã thanh toán">Đã thanh toán</option>
            <option value="Còn nợ">Còn nợ</option>
          </select>
          <input
            value={dateFrom}
            onChange={(event) => {
              setDateFrom(event.target.value)
              setPage(1)
            }}
            type="date"
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
          />
          <input
            value={dateTo}
            onChange={(event) => {
              setDateTo(event.target.value)
              setPage(1)
            }}
            type="date"
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
          />
          <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
            Reset
          </button>
        </div>

        {mobileFiltersOpen ? (
          <div className="grid gap-3 md:hidden">
            <select
              value={supplierFilter}
              onChange={(event) => {
                setSupplierFilter(event.target.value)
                setPage(1)
              }}
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            >
              <option value="Tất cả">Tất cả NPP</option>
              {supplierOptions.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
              ))}
            </select>
            <select
              value={paymentStatusFilter}
              onChange={(event) => {
                setPaymentStatusFilter(event.target.value)
                setPage(1)
              }}
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            >
              <option value="Tất cả">Tất cả thanh toán</option>
              <option value="Đã thanh toán">Đã thanh toán</option>
              <option value="Còn nợ">Còn nợ</option>
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={dateFrom}
                onChange={(event) => {
                  setDateFrom(event.target.value)
                  setPage(1)
                }}
                type="date"
                className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
              />
              <input
                value={dateTo}
                onChange={(event) => {
                  setDateTo(event.target.value)
                  setPage(1)
                }}
                type="date"
                className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
              />
            </div>
            <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
              Reset
            </button>
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.25em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã phiếu</th>
                <th className="px-6 py-4">Ngày</th>
                <th className="px-6 py-4">Nhà phân phối</th>
                <th className="px-6 py-4">Số mặt hàng</th>
                <th className="px-6 py-4">Tổng tiền</th>
                <th className="px-6 py-4">Thanh toán</th>
                <th className="px-6 py-4">PT thanh toán</th>
                <th className="px-6 py-4">Vận chuyển</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {paged.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-6 text-sm text-ink-600">Không có phiếu nhập phù hợp.</td>
                </tr>
              ) : null}
              {paged.map((order) => {
                const canEditOrder =
                  (order.canEdit !== false || canOverrideReceiptLock) &&
                  order.receiptStatus !== 'cancelled'
                const canCancelOrder =
                  order.canEdit !== false && order.receiptStatus !== 'cancelled'
                return (
                  <Fragment key={order.id}>
                    <tr className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">{order.code}</td>
                      <td className="px-6 py-4 text-ink-700">{formatDate(order.date)}</td>
                      <td className="px-6 py-4 text-ink-900">{supplierMap.get(order.supplierId)?.name}</td>
                      <td className="px-6 py-4 text-ink-700">{order.lines.length}</td>
                      <td className="px-6 py-4 text-ink-900">{formatCurrency(calcOrderTotal(order.lines))}</td>
                      <td className="px-6 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${paymentStatusStyles[order.paymentStatus]}`}>
                          {order.paymentStatus}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-ink-700">{order.paymentMethod}</td>
                      <td className="px-6 py-4 text-ink-700">{order.shippingCarrier}</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            Chi tiết
                          </button>
                          <button
                            onClick={() => openEdit(order)}
                            title={canEditOrder ? 'Sửa phiếu nhập' : 'Phiếu này đã phát sinh giao dịch, chỉ owner/admin được sửa'}
                            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900"
                          >
                            Sửa
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === order.id ? (
                      <tr className="bg-white/50">
                        <td colSpan={9} className="px-6 pb-6">
                          <div className="space-y-4 rounded-3xl border border-ink-900/10 bg-gradient-to-br from-white via-white to-fog-50/70 p-5">
                            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_340px]">
                              <div className="rounded-3xl border border-ink-900/10 bg-white/90 p-4">
                                <div className="flex items-start justify-between gap-4">
                                  <div>
                                    <p className="text-xs uppercase tracking-[0.3em] text-ink-500">Thông tin phiếu</p>
                                    <h4 className="mt-2 text-lg font-semibold text-ink-900">{order.code}</h4>
                                    <p className="mt-1 text-sm text-ink-600">Ngày nhập {formatDate(order.date)}</p>
                                  </div>
                                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${paymentStatusStyles[order.paymentStatus]}`}>
                                    {order.paymentStatus}
                                  </span>
                                </div>
                                <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                                  <ReceiptMetaItem label="Nhà phân phối" value={supplierMap.get(order.supplierId)?.name || '-'} />
                                  <ReceiptMetaItem label="Người liên hệ" value={supplierMap.get(order.supplierId)?.contactName || '-'} />
                                  <ReceiptMetaItem label="Số điện thoại" value={supplierMap.get(order.supplierId)?.phone || '-'} />
                                  <ReceiptMetaItem label="Địa chỉ" value={supplierMap.get(order.supplierId)?.address || '-'} />
                                  <ReceiptMetaItem label="Vận chuyển" value={order.shippingCarrier || '-'} />
                                  <ReceiptMetaItem label="PT thanh toán" value={order.paymentMethod || '-'} />
                                </div>
                                <div className="mt-3 rounded-2xl bg-fog-50/90 px-4 py-3">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">Ghi chú</p>
                                  <p className="mt-1 text-sm text-ink-700 break-words">{order.note || 'Không có ghi chú'}</p>
                                </div>
                              </div>

                              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                                <ReceiptStatCard
                                  label="Tổng tiền"
                                  value={formatCurrency(calcOrderTotal(order.lines))}
                                  helper={`${order.lines.length} dòng thuốc`}
                                  tone="primary"
                                />
                                <ReceiptStatCard
                                  label="Thanh toán"
                                  value={order.paymentStatus}
                                  helper={order.paymentMethod || 'Chưa chọn phương thức'}
                                />
                                <ReceiptStatCard
                                  label="Nhà vận chuyển"
                                  value={order.shippingCarrier || '-'}
                                  helper={supplierMap.get(order.supplierId)?.name || 'Chưa có NPP'}
                                />
                              </div>
                            </div>

                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-xs uppercase tracking-[0.3em] text-ink-500">Dòng thuốc</p>
                                  <p className="mt-1 text-sm text-ink-700">Hiển thị chi tiết lô, giá sau khuyến mãi và giá bán theo đơn vị.</p>
                                </div>
                                <span className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-700">
                                  {order.lines.length} dòng
                                </span>
                              </div>
                              <div className="grid gap-3 xl:grid-cols-2">
                                {order.lines.map((line, lineIndex) => (
                                  <ReceiptLineCard
                                    key={line.id}
                                    line={line}
                                    drug={drugMap.get(line.drugId)}
                                    index={lineIndex + 1}
                                  />
                                ))}
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-3 rounded-2xl border border-coral-500/15 bg-coral-500/5 px-4 py-3">
                              <p className="text-sm text-ink-600">
                                Hủy phiếu sẽ đưa toàn bộ lô trong phiếu này về trạng thái đã hủy nếu phiếu chưa phát sinh giao dịch.
                              </p>
                              <button
                                type="button"
                                onClick={() => removeOrder(order.id)}
                                disabled={!canCancelOrder}
                                title={canCancelOrder ? 'Hủy phiếu nhập' : 'Phiếu này đã phát sinh giao dịch, không thể hủy'}
                                className="shrink-0 rounded-full border border-coral-500/30 bg-coral-500/10 px-4 py-2 text-sm font-semibold text-coral-500 disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                Hủy phiếu
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 p-3 md:hidden">
          {paged.length === 0 ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">
              Không có phiếu nhập phù hợp.
            </div>
          ) : null}
          {paged.map((order) => {
            const canEditOrder =
              (order.canEdit !== false || canOverrideReceiptLock) &&
              order.receiptStatus !== 'cancelled'
            const canCancelOrder =
              order.canEdit !== false && order.receiptStatus !== 'cancelled'
            const isExpanded = expandedId === order.id
            return (
              <article key={order.id} className="rounded-2xl border border-ink-900/10 bg-white/80 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold tracking-wide text-ink-600">{order.code}</p>
                    <p className="mt-1 text-sm text-ink-700">{formatDate(order.date)}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${paymentStatusStyles[order.paymentStatus]}`}>
                    {order.paymentStatus}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-700">
                  <p><span className="font-semibold text-ink-900">NPP:</span> {supplierMap.get(order.supplierId)?.name || '-'}</p>
                  <p><span className="font-semibold text-ink-900">Mặt hàng:</span> {order.lines.length}</p>
                  <p><span className="font-semibold text-ink-900">Tổng tiền:</span> {formatCurrency(calcOrderTotal(order.lines))}</p>
                  <p><span className="font-semibold text-ink-900">PTTT:</span> {order.paymentMethod || '-'}</p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                    className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                  >
                    {isExpanded ? 'Ẩn' : 'Chi tiết'}
                  </button>
                  <button
                    onClick={() => openEdit(order)}
                    title={canEditOrder ? 'Sửa phiếu nhập' : 'Phiếu này đã phát sinh giao dịch, chỉ owner/admin được sửa'}
                    className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                  >
                    Sửa
                  </button>
                </div>

                {isExpanded ? (
                  <div className="mt-3 space-y-3 rounded-2xl border border-ink-900/10 bg-gradient-to-br from-white via-white to-fog-50/80 p-3 text-xs text-ink-700">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ReceiptMetaItem label="Người liên hệ" value={supplierMap.get(order.supplierId)?.contactName || '-'} />
                      <ReceiptMetaItem label="Số điện thoại" value={supplierMap.get(order.supplierId)?.phone || '-'} />
                      <ReceiptMetaItem label="Địa chỉ" value={supplierMap.get(order.supplierId)?.address || '-'} />
                      <ReceiptMetaItem label="Vận chuyển" value={order.shippingCarrier || '-'} />
                    </div>
                    <div className="rounded-2xl bg-fog-50/90 px-3 py-3">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-ink-500">Ghi chú</p>
                      <p className="mt-1 text-sm text-ink-700 break-words">{order.note || 'Không có ghi chú'}</p>
                    </div>
                    <div className="grid gap-3">
                      {order.lines.map((line, lineIndex) => (
                        <ReceiptLineCard
                          key={line.id}
                          line={line}
                          drug={drugMap.get(line.drugId)}
                          index={lineIndex + 1}
                        />
                      ))}
                    </div>
                    <div className="flex flex-col gap-2 rounded-2xl border border-coral-500/15 bg-coral-500/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-ink-600">
                        Hủy phiếu sẽ đưa toàn bộ lô trong phiếu này về trạng thái đã hủy nếu phiếu chưa phát sinh giao dịch.
                      </p>
                      <button
                        type="button"
                        onClick={() => removeOrder(order.id)}
                        disabled={!canCancelOrder}
                        title={canCancelOrder ? 'Hủy phiếu nhập' : 'Phiếu này đã phát sinh giao dịch, không thể hủy'}
                        className="rounded-full border border-coral-500/30 bg-coral-500/10 px-4 py-2 text-sm font-semibold text-coral-500 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Hủy phiếu
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>Hiển thị {rangeStart} - {rangeEnd} trong {totalOrders} phiếu</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Trước</button>
          <span>{page}/{totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Sau</button>
        </div>
      </section>

      {/* ========== MODAL TẠO/SỬA PHIẾU NHẬP ========== */}
      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-5xl max-h-[90vh] min-h-0 flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-start justify-between gap-3 border-b border-ink-900/10 px-6 py-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                    {editingId ? 'Chỉnh sửa phiếu nhập' : 'Tạo phiếu nhập mới'}
                  </p>
                  <span className="rounded-full border border-ink-900/10 bg-fog-50 px-3 py-1 text-xs font-semibold text-ink-700">
                    Mã phiếu: {form.code}
                  </span>
                </div>
                <div className="mt-2 w-full overflow-x-auto">
                  <div className="inline-flex min-w-max items-center gap-2 whitespace-nowrap pr-1">
                    {selectedLinePills.length ? (
                      selectedLinePills.map((pill) => (
                        <button
                          key={pill.drugId}
                          type="button"
                          onClick={() => scrollToLineCard(pill.lineId)}
                          className="rounded-full border border-brand-500/20 bg-brand-500/10 px-2.5 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-500/15"
                          title={pill.name}
                        >
                          {pill.name}
                        </button>
                      ))
                    ) : (
                      <span className="text-xs text-ink-500">Chưa có thuốc trong phiếu</span>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={closeModal} className="shrink-0 rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">
                Đóng
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã phiếu nhập</span>
                  <input value={form.code} disabled className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-xs text-ink-500" />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ngày nhập *</span>
                  <input
                    ref={setFormFieldRef('field-date')}
                    value={form.date}
                    onChange={(event) => handleDateChange(event.target.value)}
                    type="date"
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  />
                  {errors.date ? <span className="text-xs text-coral-500">{errors.date}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Nhà phân phối *</span>
                  <select
                    ref={setFormFieldRef('field-supplier')}
                    value={form.supplierId}
                    onChange={(event) => updateForm('supplierId', event.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  >
                    {supplierOptions.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                    ))}
                  </select>
                  {errors.supplierId ? <span className="text-xs text-coral-500">{errors.supplierId}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Đơn vị vận chuyển</span>
                  <input
                    ref={setFormFieldRef('field-shippingCarrier')}
                    list="shipping-carrier-options"
                    value={form.shippingCarrier}
                    onChange={(event) => updateForm('shippingCarrier', event.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                    placeholder="Ví dụ: GHN, J&T, Viettel Post"
                  />
                  <datalist id="shipping-carrier-options">
                    {shippingCarrierSuggestions.map((carrier) => (
                      <option key={carrier} value={carrier} />
                    ))}
                  </datalist>
                  {errors.shippingCarrier ? <span className="text-xs text-coral-500">{errors.shippingCarrier}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Trạng thái thanh toán</span>
                  <select
                    value={form.paymentStatus}
                    onChange={(event) => updateForm('paymentStatus', event.target.value as PaymentStatus)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  >
                    <option value="Đã thanh toán">Đã thanh toán</option>
                    <option value="Còn nợ">Còn nợ</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Phương thức thanh toán</span>
                  <select
                    value={form.paymentMethod}
                    onChange={(event) => updateForm('paymentMethod', event.target.value as PaymentMethod)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  >
                    {paymentMethods.map((method) => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                </label>
                <label className="col-span-2 space-y-2 text-sm text-ink-700">
                  <span>Ghi chú</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateForm('note', event.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                    rows={2}
                  />
                </label>
              </div>

              <div className="space-y-4">
                <div>
                  <div>
                    <p className="text-sm font-semibold text-ink-900">Chi tiết lô nhập</p>
                    <p className="text-xs text-ink-500">Quét barcode hoặc chọn thuốc để tự điền thông tin.</p>
                  </div>
                </div>
                {isLockedReceiptEdit ? (
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                    Phiếu này đã phát sinh giao dịch. Bạn có thể thêm dòng thuốc mới, nhưng không thể đổi thuốc, số lượng hoặc xóa các dòng cũ.
                  </div>
                ) : null}
                {errors.lines ? <p className="text-xs text-coral-500">{errors.lines}</p> : null}

                <div className="space-y-4">
                  {form.lines.map((line, index) => {
                    const drug = drugMap.get(line.drugId)
                    const pricing = calcLinePricing(line)
                    const lineDrugOptions = getLineDrugOptions(line.id, line.drugId)
                    return (
                      <div key={line.id} ref={setLineCardRef(line.id)} className="rounded-2xl bg-fog-50 p-4 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Số thứ tự lô</p>
                            <p className="text-sm font-semibold text-ink-900">
                              #{index + 1}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => openScan({ type: 'line', id: line.id })}
                              className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                            >
                              Quét barcode
                            </button>
                            <button
                              type="button"
                              onClick={() => removeLine(line.id)}
                              disabled={isLockedExistingLine(line.id)}
                              className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                            >
                              Xóa dòng
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <label className="col-span-2 space-y-1 text-xs text-ink-600">
                            Thuốc *
                            <input
                              ref={setFormFieldRef(`line-drug-${line.id}`)}
                              list={`line-drug-options-${line.id}`}
                              value={lineDrugSearch[line.id] ?? ''}
                              onChange={(event) => handleLineDrugSearchChange(line.id, event.target.value)}
                              disabled={isLockedExistingLine(line.id)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="Tìm tên thuốc"
                            />
                            <datalist id={`line-drug-options-${line.id}`}>
                              {lineDrugOptions.slice(0, 50).map((item) => (
                                <option key={item.id} value={item.name} />
                              ))}
                            </datalist>
                            {(lineDrugSearch[line.id] ?? '').trim() && lineDrugOptions.length === 0 ? (
                              <span className="text-xs text-amber-700">Không tìm thấy thuốc phù hợp.</span>
                            ) : null}
                            {errors[`line-drug-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-drug-${index}`]}</span>
                            ) : null}
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Số đăng ký
                            <input
                              value={drug?.regNo ?? ''}
                              disabled
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-2 text-sm text-ink-500"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Barcode
                            <input
                              ref={setFormFieldRef(`line-barcode-${line.id}`)}
                              value={line.barcode}
                              onChange={(event) => updateLine(line.id, 'barcode', event.target.value)}
                              onBlur={(event) => handleLineBarcodeBlur(line.id, event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="Quét hoặc nhập barcode"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Số lô *
                            <input
                              ref={setFormFieldRef(`line-lot-${line.id}`)}
                              value={line.lotNumber}
                              onChange={(event) => updateLine(line.id, 'lotNumber', event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="LOT"
                            />
                            {errors[`line-lot-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-lot-${index}`]}</span>
                            ) : null}
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Số lượng nhập (đơn vị bán sỉ) *
                            <input
                              ref={setFormFieldRef(`line-qty-${line.id}`)}
                              value={line.quantity}
                              onChange={(event) => updateLine(line.id, 'quantity', event.target.value)}
                              disabled={isLockedExistingLine(line.id)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="0"
                            />
                            {errors[`line-qty-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-qty-${index}`]}</span>
                            ) : null}
                          </label>
                          <label className="space-y-1 text-xs text-ink-600">
                            Giá nhập *
                            <input
                              ref={setFormFieldRef(`line-price-${line.id}`)}
                              value={line.price}
                              onChange={(event) => updateLine(line.id, 'price', event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="0"
                            />
                            {errors[`line-price-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-price-${index}`]}</span>
                            ) : null}
                          </label>

                          <div className="col-span-2 space-y-2 text-xs text-ink-600">
                            <p>Giá bán lẻ theo từng đơn vị *</p>
                            {line.unitRetailPrices.length ? (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {line.unitRetailPrices.map((unitPrice, unitIndex) => (
                                  <label key={unitPrice.unitId} className="space-y-1 rounded-xl border border-ink-900/10 bg-white p-3">
                                    <span className="text-[11px] text-ink-600">
                                      {unitPrice.unitName} ({unitPrice.conversion} đơn vị gốc)
                                    </span>
                                    <input
                                      ref={(element) => {
                                        setFormFieldRef(`line-retail-${line.id}-${unitPrice.unitId}`)(element)
                                        if (unitIndex === 0) {
                                          setFormFieldRef(`line-retail-first-${line.id}`)(element)
                                        }
                                      }}
                                      value={unitPrice.price}
                                      onChange={(event) =>
                                        updateLineRetailPrice(line.id, unitPrice.unitId, event.target.value)
                                      }
                                      className="w-full rounded-lg border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                                      placeholder="Giá bán lẻ"
                                    />
                                    {errors[`line-retail-price-${index}-${unitPrice.unitId}`] ? (
                                      <span className="text-xs text-coral-500">
                                        {errors[`line-retail-price-${index}-${unitPrice.unitId}`]}
                                      </span>
                                    ) : null}
                                  </label>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-coral-500">
                                {errors[`line-retail-prices-${index}`] ?? 'Vui lòng chọn thuốc để nhập giá theo đơn vị.'}
                              </p>
                            )}
                          </div>
                          <label className="space-y-1 text-xs text-ink-600">
                            Loại khuyến mãi NPP
                            <select
                              value={line.promoType}
                              onChange={(event) => updateLine(line.id, 'promoType', event.target.value as PromoType)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                            >
                              <option value="none">Không khuyến mãi</option>
                              <option value="buy_x_get_y">Mua X tặng Y</option>
                              <option value="discount_percent">Giảm %</option>
                            </select>
                          </label>

                          {line.promoType === 'buy_x_get_y' ? (
                            <label className="space-y-1 text-xs text-ink-600">
                              Mua X tặng Y
                              <div className="mt-1 grid grid-cols-2 gap-2">
                                <input
                                  ref={setFormFieldRef(`line-promo-buy-${line.id}`)}
                                  value={line.promoBuyQty}
                                  onChange={(event) => updateLine(line.id, 'promoBuyQty', event.target.value)}
                                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                                  placeholder="Mua X"
                                />
                                <input
                                  ref={setFormFieldRef(`line-promo-get-${line.id}`)}
                                  value={line.promoGetQty}
                                  onChange={(event) => updateLine(line.id, 'promoGetQty', event.target.value)}
                                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                                  placeholder="Tặng Y"
                                />
                              </div>
                              {errors[`line-promo-buy-${index}`] || errors[`line-promo-get-${index}`] ? (
                                <span className="text-xs text-coral-500">
                                  {errors[`line-promo-buy-${index}`] || errors[`line-promo-get-${index}`]}
                                </span>
                              ) : null}
                            </label>
                          ) : null}

                          {line.promoType === 'discount_percent' ? (
                            <label className="space-y-1 text-xs text-ink-600">
                              Giảm %
                              <input
                                ref={setFormFieldRef(`line-promo-discount-${line.id}`)}
                                value={line.promoDiscountPercent}
                                onChange={(event) => updateLine(line.id, 'promoDiscountPercent', event.target.value)}
                                className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                                placeholder="VD: 20"
                              />
                              {errors[`line-promo-discount-${index}`] ? (
                                <span className="text-xs text-coral-500">{errors[`line-promo-discount-${index}`]}</span>
                              ) : null}
                            </label>
                          ) : null}

                          <label className="col-span-2 space-y-1 text-xs text-ink-600">
                            Số lượng sau khuyến mãi
                            <input
                              value={pricing.quantityAfterPromo.toLocaleString('vi-VN')}
                              disabled
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-2 text-sm text-ink-500"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Giá sau khuyến mãi
                            <input
                              value={formatCurrency(pricing.unitPriceAfterPromo)}
                              disabled
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-2 text-sm text-ink-500"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Giá trị dòng sau KM
                            <input
                              value={formatCurrency(pricing.lineTotal)}
                              disabled
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-2 text-sm text-ink-500"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            NSX *
                            <input
                              ref={setFormFieldRef(`line-mfg-${line.id}`)}
                              value={line.mfgDate}
                              onChange={(event) => updateLine(line.id, 'mfgDate', event.target.value)}
                              type="date"
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                            />
                            {errors[`line-mfg-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-mfg-${index}`]}</span>
                            ) : null}
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            HSD *
                            <input
                              ref={setFormFieldRef(`line-exp-${line.id}`)}
                              value={line.expDate}
                              onChange={(event) => updateLine(line.id, 'expDate', event.target.value)}
                              type="date"
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                            />
                            {errors[`line-exp-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-exp-${index}`]}</span>
                            ) : null}
                          </label>



                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
                          <span>QR Code: <span className="font-semibold text-ink-900">{line.batchCode}</span></span>
                          <span>KM: {describePromo(line)}</span>
                          <span>
                            Tạm tính: <span className="font-semibold text-ink-900">{formatCurrency(calcLineTotal(line))}</span>
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-900/10 px-6 py-4">
              <div className="text-sm text-ink-700">
                Tổng cộng: <span className="font-semibold text-ink-900">{formatCurrency(calcOrderTotal(form.lines))}</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  ref={setFormFieldRef('action-add-line')}
                  onClick={addLine}
                  className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
                >
                  Thêm dòng thuốc
                </button>
                <button
                  onClick={saveOrder}
                  disabled={savingOrder}
                  className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
                >
                  {savingOrder ? 'Đang lưu...' : 'Lưu phiếu nhập'}
                </button>
                <button onClick={closeModal} className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
                  Hủy
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ========== MODAL QUÉT BARCODE ========== */}
      {scanOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-xl max-h-[85vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">{scanTitle}</p>
                <h3 className="mt-2 text-xl font-semibold text-ink-900">Đưa barcode vào khung</h3>
              </div>
              <button onClick={() => setScanOpen(false)} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">
                Tắt camera
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {cameraDevices.length > 1 ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-ink-700">
                  <label className="text-xs uppercase tracking-[0.25em] text-ink-500">Camera</label>
                  <select
                    value={selectedDeviceId}
                    onChange={(event) => {
                      setScanError(null)
                      setScanMessage('Đang chuyển camera...')
                      setSelectedDeviceId(event.target.value)
                    }}
                    className="rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  >
                    {cameraDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || 'Camera'}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="relative overflow-hidden rounded-2xl bg-ink-900">
                <div ref={quaggaContainerRef} className="quagga-view h-72 w-full" />
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                  <div className="relative h-16 w-[70%] rounded-lg border-2 border-white/50">
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/80">
                      Barcode ở đây
                    </div>
                  </div>
                </div>
                {scanEngine ? (
                  <div className="absolute bottom-2 right-2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/70">
                    🔧 Quagga
                  </div>
                ) : null}
              </div>

              {zoomRange && zoomRange.max > zoomRange.min ? (
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-ink-500 w-10">Zoom</span>
                  <input
                    type="range"
                    min={zoomRange.min}
                    max={zoomRange.max}
                    step={zoomRange.step}
                    value={zoomLevel}
                    onChange={(event) => handleZoom(parseFloat(event.target.value))}
                    className="flex-1 accent-ink-900"
                  />
                  <span className="text-xs text-ink-600 w-10 text-right">{zoomLevel.toFixed(1)}×</span>
                </div>
              ) : null}

              {focusSupported ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRefocus}
                    className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
                  >
                    Lấy nét lại
                  </button>
                  {focusRange && focusDistance !== null ? (
                    <div className="flex flex-1 items-center gap-3">
                      <input
                        type="range"
                        min={focusRange.min}
                        max={focusRange.max}
                        step={focusRange.step}
                        value={focusDistance}
                        onChange={(event) => handleFocusDistance(parseFloat(event.target.value))}
                        className="flex-1 accent-ink-900"
                      />
                      <span className="text-xs text-ink-600 w-12 text-right">{focusDistance.toFixed(2)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {torchSupported ? (
                  <button
                    type="button"
                    onClick={handleTorch}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${torchOn ? 'bg-amber-100 text-amber-700 border border-amber-300' : 'border border-ink-900/10 bg-white/80 text-ink-900'}`}
                  >
                    {torchOn ? '💡 Tắt đèn' : '🔦 Bật đèn'}
                  </button>
                ) : null}
                <button type="button" onClick={captureAndDecode} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">
                  📸 Chụp & quét
                </button>
              </div>

              {scanError ? <p className="mt-3 text-sm text-coral-500">{scanError}</p> : null}
              {!scanError ? <p className="mt-3 text-sm text-ink-700">{scanMessage}</p> : null}
              <p className="mt-2 text-xs text-ink-500">
                Mẹo: Đưa barcode vào khung, giữ thẳng và yên. Dùng Zoom để phóng to nếu cần.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}


