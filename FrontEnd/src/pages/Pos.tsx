import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  inventoryApi,
  type InventoryBatch,
  type InventoryBatchDetail,
  type InventoryMetaDrug,
  type InventoryStockDrugDetail,
} from '../api/inventoryService'
import { customerApi, type CustomerRecord } from '../api/customerService'
import { paymentQrApi } from '../api/paymentQrService'
import { saleApi } from '../api/saleService'
import { storeApi, type StoreInfo } from '../api/storeService'
import { findBankOption } from '../constants/bankList'
import { ApiError, buildUsersApiUrl } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type UnitRole = 'single' | 'import' | 'intermediate' | 'retail'
type ServiceFeeMode = 'split' | 'separate'
type CustomerMode = 'walk_in' | 'member'
type PaymentMode = 'cash' | 'debt'
type BankQrAddInfoMode = 'order_code' | 'custom'
type AdsTransition = 'none' | 'fade' | 'slide'

type PosDrugUnit = {
  id: string
  name: string
  conversion: number
  price: number
  barcode: string
  role: UnitRole
}

type PosDrug = {
  id: string
  code: string
  name: string
  group: string
  instructions: string
  units: PosDrugUnit[]
  totalQty: number
}

type PosItemAllocationMode = 'explicit_lot' | 'auto_fill'

type PosOrderItemAllocation = {
  batchId: string
  batchCode: string
  lotNumber: string
  expDate: string
  baseQuantity: number
}

type PosOrderItem = {
  id: string
  drugId: string
  drugCode: string
  drugName: string
  batchId: string
  batchCode: string
  lotNumber: string
  expDate: string
  batchQtyRemaining: number
  unitId: string
  unitName: string
  conversion: number
  unitPrice: number
  quantity: string
  allocationMode: PosItemAllocationMode
  plannedAllocations: PosOrderItemAllocation[]
  availableBaseQty: number | null
  allocationWarning: string | null
  lotPolicyWarning: string | null
  lotPolicyAcknowledged: boolean
}

type PosOrder = {
  id: string
  customerMode: CustomerMode
  customerId: string | null
  customerCode: string | null
  customerName: string
  customerPhone: string
  customerTier: string | null
  customerTierDiscountPercent: number | null
  customerPoints: number | null
  pointsToRedeem: string
  note: string
  serviceFee: string
  serviceFeeMode: ServiceFeeMode
  paymentMode: PaymentMode
  cashReceived: string
  items: PosOrderItem[]
}

type CheckoutLine = {
  item: PosOrderItem
  quantity: number
  lineTotal: number
  surcharge: number
  adjustedUnitPrice: number
}

type ExpandedCheckoutLine = {
  item: PosOrderItem
  batchId: string
  batchCode: string
  lotNumber: string
  expDate: string
  quantity: number
  conversion: number
  unitId: string
  unitName: string
  adjustedUnitPrice: number
}

type ScannerCamera = {
  id: string
  label: string
}

type InvoicePreviewLine = {
  name: string
  unit: string
  quantity: number
  unitPrice: number
  amount: number
  lotNumber?: string | null
  isService?: boolean
}

type InvoicePreview = {
  id: string
  code: string
  createdAt: string
  storeName: string
  storeLogoUrl: string
  storePhone: string
  storeAddress: string
  cashier: string
  customerName: string
  customerPhone: string
  note: string
  paymentMethod: string
  amountPaid: number
  changeAmount: number
  debtAmount: number
  roundingAdjustmentAmount: number
  medicineTotal: number
  serviceFee: number
  grandTotal: number
  serviceFeeMode: ServiceFeeMode
  returnPolicyText: string | null
  tierDiscountAmount?: number
  pointsDiscountAmount?: number
  pointsUsed?: number
  lines: InvoicePreviewLine[]
}

type LotPolicyConfirmState = {
  mode: 'add' | 'checkout'
  orderId: string
  item: PosOrderItem
  message: string
}

type BankQrState = {
  orderId: string
  referenceCode: string
  transferContent: string
  amount: number
  accountNo: string
  accountName: string
  acqId: string
  qrCode: string
  qrDataURL: string
}

type CustomerDisplayPayload = {
  updatedAt: string
  store: {
    name: string
    phone: string
    address: string
  }
  settings: {
    showPrice: boolean
    showTotal: boolean
    ads: string[]
    adsIntervalSeconds: number
    adsTransition: AdsTransition
    adsTransitionMs: number
  }
  order: {
    id: string
    customerName: string
    itemCount: number
    subtotal: number
    serviceFee: number
    total: number
    lines: Array<{
      id: string
      name: string
      unit: string
      quantity: number
      unitPrice: number
      lineTotal: number
    }>
  }
  paymentQr: {
    active: boolean
    amount: number
    referenceCode: string
    transferContent: string
    qrDataURL: string
  } | null
}

type CheckoutOptions = {
  paymentMethod?: 'cash' | 'bank'
  amountPaid?: number
  paymentLabel?: string
  noteSuffix?: string
}

const MIN_DEBT_AMOUNT_AFTER_ROUNDING = 500

const roundMoneyAmount = (value: number) =>
  Math.round(Number.isFinite(value) ? value : 0)

const coerceFiniteNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const formatCurrency = (value: number) =>
  `${roundMoneyAmount(value).toLocaleString('vi-VN')}đ`

const parseNonNegativeNumber = (value: string) => {
  const normalized = value.replace(/,/g, '').trim()
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

const roundCashTotalByStep = (amount: number, step: number) => {
  const safeAmount = Math.max(0, amount)
  const safeStep = Math.max(1, Math.floor(step))
  return Math.round(safeAmount / safeStep) * safeStep
}

const applyMinimumDebtThreshold = (
  totalAmount: number,
  amountPaid: number,
  roundingAdjustmentAmount: number,
) => {
  const rawDebtAmount = Math.max(0, totalAmount - amountPaid)
  const absorbedDebtAmount =
    rawDebtAmount > 0 && rawDebtAmount <= MIN_DEBT_AMOUNT_AFTER_ROUNDING ? rawDebtAmount : 0
  const adjustedTotalAmount = Math.max(0, totalAmount - absorbedDebtAmount)

  return {
    totalAmount: adjustedTotalAmount,
    debtAmount: Math.max(0, adjustedTotalAmount - amountPaid),
    changeAmount: Math.max(0, amountPaid - adjustedTotalAmount),
    roundingAdjustmentAmount: roundingAdjustmentAmount - absorbedDebtAmount,
    absorbedDebtAmount,
  }
}

const parsePositiveInt = (value: string, fallback = 0) => {
  if (!value.trim()) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.floor(parsed)
  if (rounded < 0) return fallback
  return rounded
}

const unitRoleFromIndex = (index: number, total: number): UnitRole => {
  if (total <= 1) return 'single'
  if (index === 0) return 'import'
  if (index === total - 1) return 'retail'
  return 'intermediate'
}

const unitRoleLabel = (role: UnitRole) => {
  if (role === 'import') return 'Đơn vị bán sỉ'
  if (role === 'intermediate') return 'Đơn vị trung gian'
  if (role === 'retail') return 'Đơn vị bán lẻ'
  return 'Đơn vị'
}

const isAutoFillAllocationMode = (mode: PosItemAllocationMode) => mode === 'auto_fill'

const sumPlannedAllocationBaseQty = (item: PosOrderItem) =>
  item.plannedAllocations.reduce((sum, allocation) => sum + Math.max(0, allocation.baseQuantity), 0)

const getItemAvailableBaseQty = (item: PosOrderItem) =>
  Math.max(
    0,
    isAutoFillAllocationMode(item.allocationMode)
      ? item.availableBaseQty ?? item.batchQtyRemaining
      : item.batchQtyRemaining,
  )

const buildAutoFillPolicyLabel = (fefoEnabled: boolean, fefoThresholdDays: number) =>
  fefoEnabled
    ? `Xuất kho tự động theo FEFO/FIFO (ngưỡng ${fefoThresholdDays} ngày)`
    : 'Xuất kho tự động theo FIFO'

const mapMetaDrugToPosDrug = (drug: InventoryMetaDrug): PosDrug => {
  const priceByUnitId = new Map(drug.unit_prices.map((item) => [item.unit_id, Number(item.price || 0)]))
  const sortedUnits = drug.units.slice().sort((a, b) => b.conversion - a.conversion)

  return {
    id: drug.id,
    code: drug.code,
    name: drug.name,
    group: drug.group ?? '',
    instructions: String(drug.instructions ?? '').trim(),
    totalQty: 0,
    units: sortedUnits.map((unit, index) => ({
      id: unit.id,
      name: unit.name,
      conversion: Math.max(1, unit.conversion),
      price: Number.isFinite(priceByUnitId.get(unit.id)) ? Number(priceByUnitId.get(unit.id)) : 0,
      barcode: String(unit.barcode ?? '').trim(),
      role: unitRoleFromIndex(index, sortedUnits.length),
    })),
  }
}

const getRetailUnit = (drug: PosDrug): PosDrugUnit => {
  const sorted = drug.units.slice().sort((a, b) => a.conversion - b.conversion)
  return sorted[0] ?? drug.units[0]
}

const createOrderId = () => `order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const createItemId = () => `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

const createEmptyOrder = (): PosOrder => ({
  id: createOrderId(),
  customerMode: 'walk_in',
  customerId: null,
  customerCode: null,
  customerName: '',
  customerPhone: '',
  customerTier: null,
  customerTierDiscountPercent: null,
  customerPoints: null,
  pointsToRedeem: '',
  note: '',
  serviceFee: '0',
  serviceFeeMode: 'split',
  paymentMode: 'cash',
  cashReceived: '',
  items: [],
})

const normalizePhone = (value: string) => value.replace(/[^\d+]/g, '').trim()
const normalizeSearchText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9a-zA-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const buildDrugSearchLabel = (drug: Pick<PosDrug, 'code' | 'name'>) => `${drug.code} - ${drug.name}`
const buildDrugSearchHaystack = (drug: Pick<PosDrug, 'code' | 'name' | 'group'>) =>
  normalizeSearchText([drug.code, drug.name, drug.group].join(' '))

const extractDrugSearchNeedles = (raw: string) => {
  const normalized = normalizeSearchText(raw)
  if (!normalized) return [] as string[]

  const needles = new Set<string>([normalized])
  const codeMatches = normalized.match(/\b[a-z]{1,4}\d{3,}\b/g)
  codeMatches?.forEach((code) => needles.add(code))

  normalized
    .split(' ')
    .filter((word) => word.length >= 3)
    .slice(0, 4)
    .forEach((word) => needles.add(word))

  return Array.from(needles)
}

const normalizeQrText = (value: string) => value.replace(/[\u0000-\u001F\u007F]/g, '').trim()
const normalizeBarcodeText = (value: string) => value.replace(/\s+/g, '').trim().toUpperCase()

const POS_QR_SCANNER_ID = 'pos-lot-qr-scanner'
const HTML5_QR_SCRIPT_ID_PREFIX = 'html5-qrcode-runtime'
const HTML5_QR_SCRIPT_CANDIDATES = [
  '/vendor/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
]

const CUSTOMER_DISPLAY_STORAGE_KEY = 'pharmar:customer-display:state'
const CUSTOMER_DISPLAY_CHANNEL = 'pharmar-customer-display'
const CUSTOMER_DISPLAY_SCREEN_ID = 'default'

let html5QrcodeLoader: Promise<void> | null = null

const ensureHtml5QrcodeLibrary = () => {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window-not-available'))
  }
  if ((window as any).Html5Qrcode) {
    return Promise.resolve()
  }
  if (html5QrcodeLoader) {
    return html5QrcodeLoader
  }

  html5QrcodeLoader = (async () => {
    const appendAndWait = (src: string, index: number) =>
      new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.id = `${HTML5_QR_SCRIPT_ID_PREFIX}-${index}`
        script.src = src
        script.async = true
        script.crossOrigin = 'anonymous'
        script.dataset.html5QrcodeRuntime = '1'
        script.addEventListener('load', () => resolve(), { once: true })
        script.addEventListener('error', () => reject(new Error(`load-failed:${src}`)), { once: true })
        document.head.appendChild(script)
      })

    const existingScripts = Array.from(
      document.querySelectorAll('script[data-html5-qrcode-runtime="1"]'),
    ) as HTMLScriptElement[]
    if (existingScripts.length) {
      for (let i = 0; i < existingScripts.length; i += 1) {
        if ((window as any).Html5Qrcode) return
        await new Promise<void>((resolve) => {
          const script = existingScripts[i]
          script.addEventListener('load', () => resolve(), { once: true })
          script.addEventListener('error', () => resolve(), { once: true })
          window.setTimeout(() => resolve(), 2000)
        })
      }
    }

    for (let i = 0; i < HTML5_QR_SCRIPT_CANDIDATES.length; i += 1) {
      if ((window as any).Html5Qrcode) return
      try {
        await appendAndWait(HTML5_QR_SCRIPT_CANDIDATES[i], i)
        if ((window as any).Html5Qrcode) return
      } catch {
        // try next source
      }
    }

    throw new Error('library-load-failed')
  })().catch((error) => {
    html5QrcodeLoader = null
    throw error
  })

  return html5QrcodeLoader
}

const extractQrCandidates = (input: string) => {
  const values = new Set<string>()
  const push = (value: string) => {
    const normalized = normalizeQrText(value)
    if (normalized) values.add(normalized)
  }

  const raw = normalizeQrText(input)
  if (!raw) return [] as string[]
  push(raw)

  try {
    const decoded = decodeURIComponent(raw)
    push(decoded)
  } catch {
    // ignore malformed URI sequences
  }

  const seedList = Array.from(values)
  for (const seed of seedList) {
    seed
      .split(/[\s|,;]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach(push)

    try {
      const url = new URL(seed)
      push(url.pathname.split('/').filter(Boolean).slice(-1)[0] ?? '')
      ;['qr', 'batch', 'batch_code', 'batchCode', 'lot', 'lot_number', 'code'].forEach((key) => {
        push(url.searchParams.get(key) ?? '')
      })
    } catch {
      // not a URL
    }

    if (seed.startsWith('{') && seed.endsWith('}')) {
      try {
        const payload = JSON.parse(seed) as Record<string, unknown>
        ;['qr', 'batch', 'batch_code', 'batchCode', 'lot', 'lot_number', 'code'].forEach((key) => {
          const candidate = payload[key]
          if (typeof candidate === 'string') push(candidate)
        })
      } catch {
        // not JSON
      }
    }
  }

  for (const value of Array.from(values)) {
    const colonParts = value.split(':')
    if (colonParts.length > 1) {
      push(colonParts[colonParts.length - 1])
    }
    const match = value.match(/[A-Za-z]{1,6}[-_ ]?\d{4,}/g)
    match?.forEach(push)
  }

  const expanded = Array.from(values)
  expanded.forEach((value) => push(value.toUpperCase()))
  return Array.from(values)
}

const allocateServiceFee = (lineTotals: number[], serviceFee: number, mode: ServiceFeeMode) => {
  const normalizedFee = Math.floor(Math.max(0, serviceFee))
  const output = lineTotals.map(() => 0)
  if (!lineTotals.length || normalizedFee <= 0) return output

  if (mode === 'separate') {
    return output
  }

  const total = lineTotals.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (total <= 0) {
    const even = Math.floor(normalizedFee / lineTotals.length)
    let remainder = normalizedFee - even * lineTotals.length
    return lineTotals.map(() => {
      const extra = remainder > 0 ? 1 : 0
      remainder -= extra
      return even + extra
    })
  }

  const rawShares = lineTotals.map((lineTotal) => (Math.max(0, lineTotal) / total) * normalizedFee)
  const floorShares = rawShares.map((share) => Math.floor(share))
  let remainder = normalizedFee - floorShares.reduce((sum, share) => sum + share, 0)

  const rankedIndexes = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction)

  rankedIndexes.forEach(({ index }) => {
    if (remainder <= 0) return
    floorShares[index] += 1
    remainder -= 1
  })

  return floorShares
}

const toIsoDate = (value: string | null | undefined) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 10)
}

const DAY_IN_MS = 24 * 60 * 60 * 1000

const parseDateOnly = (value: string | null | undefined) => {
  if (!value) return null
  const normalized = value.length === 10 ? `${value}T00:00:00` : value
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

const compareDatesAsc = (
  left: string | null | undefined,
  right: string | null | undefined,
  fallback = 0,
) => {
  const leftDate = parseDateOnly(left)
  const rightDate = parseDateOnly(right)
  if (!leftDate || !rightDate) return fallback
  return leftDate.getTime() - rightDate.getTime()
}

const getIssueStrategy = (
  batch: Pick<InventoryBatch, 'exp_date'>,
  today: Date,
  fefoEnabled: boolean,
  fefoThresholdDays: number,
) => {
  if (!fefoEnabled) return 'fifo' as const
  const expDate = parseDateOnly(batch.exp_date)
  if (!expDate) return 'fifo' as const
  const daysToExpiry = Math.floor((expDate.getTime() - today.getTime()) / DAY_IN_MS)
  return daysToExpiry < fefoThresholdDays ? ('fefo' as const) : ('fifo' as const)
}

const compareByLotIssuePolicy = (
  left: InventoryBatch,
  right: InventoryBatch,
  today: Date,
  fefoEnabled: boolean,
  fefoThresholdDays: number,
) => {
  const leftStrategy = getIssueStrategy(left, today, fefoEnabled, fefoThresholdDays)
  const rightStrategy = getIssueStrategy(right, today, fefoEnabled, fefoThresholdDays)
  if (leftStrategy !== rightStrategy) return leftStrategy === 'fefo' ? -1 : 1

  if (leftStrategy === 'fefo') {
    const byExpDate = compareDatesAsc(left.exp_date, right.exp_date)
    if (byExpDate !== 0) return byExpDate

    const byReceived = compareDatesAsc(left.received_date, right.received_date)
    if (byReceived !== 0) return byReceived
  } else {
    const byReceived = compareDatesAsc(left.received_date, right.received_date)
    if (byReceived !== 0) return byReceived

    const byExpDate = compareDatesAsc(left.exp_date, right.exp_date)
    if (byExpDate !== 0) return byExpDate
  }

  const byCreated = compareDatesAsc(left.created_at, right.created_at)
  if (byCreated !== 0) return byCreated

  return left.batch_code.localeCompare(right.batch_code, 'vi-VN')
}

const normalizeSettingNumber = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed))
  }
  return fallback
}

const normalizeSettingBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false
  }
  if (typeof value === 'number') return Boolean(value)
  return fallback
}

const normalizeSettingString = (value: unknown, fallback = '') => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  return fallback
}

const normalizeSettingStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
        }
      } catch {
        // fallback to line based parsing
      }
    }
    return raw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

const normalizeAdsTransition = (value: unknown): AdsTransition => {
  const lowered = normalizeSettingString(value, 'fade').toLowerCase()
  if (lowered === 'none' || lowered === 'slide') return lowered
  return 'fade'
}

const normalizeReturnWindowUnit = (value: unknown): 'day' | 'hour' => {
  const lowered = String(value ?? '').trim().toLowerCase()
  return ['hour', 'hours', 'gio', 'h'].includes(lowered) ? 'hour' : 'day'
}

const buildReturnPolicyText = (settings: Record<string, unknown>) => {
  const value = normalizeSettingNumber(settings['sale.return_window_value'], 7)
  const unit = normalizeReturnWindowUnit(settings['sale.return_window_unit'])
  const unitLabel = unit === 'hour' ? 'giờ' : 'ngày'
  return `Đổi trả trong ${value} ${unitLabel} với hóa đơn.`
}

const resolveAssetUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
  const apiBase = String(import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (apiBase) {
    const path = raw.startsWith('/') ? raw : `/${raw}`
    return `${apiBase}${path}`
  }
  return raw
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function Pos() {
  const { token, user } = useAuth()

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const [drugs, setDrugs] = useState<PosDrug[]>([])
  const [fefoEnabled, setFefoEnabled] = useState(true)
  const [fefoThresholdDays, setFefoThresholdDays] = useState(180)
  const [sellByLot, setSellByLot] = useState(true)
  const [cashRoundingEnabled, setCashRoundingEnabled] = useState(true)
  const [cashRoundingUnit, setCashRoundingUnit] = useState(1000)
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null)
  const [returnPolicyText, setReturnPolicyText] = useState('Đổi trả trong 7 ngày với hóa đơn.')
  const [bankQrAccountNo, setBankQrAccountNo] = useState('')
  const [bankQrAccountName, setBankQrAccountName] = useState('')
  const [bankQrAcqId, setBankQrAcqId] = useState('')
  const [bankQrAddInfoMode, setBankQrAddInfoMode] = useState<BankQrAddInfoMode>('order_code')
  const [bankQrAddInfoCustom, setBankQrAddInfoCustom] = useState('')
  const [customerDisplayShowPrice, setCustomerDisplayShowPrice] = useState(true)
  const [customerDisplayShowTotal, setCustomerDisplayShowTotal] = useState(true)
  const [customerDisplayAds, setCustomerDisplayAds] = useState<string[]>([])
  const [customerDisplayAdsIntervalSeconds, setCustomerDisplayAdsIntervalSeconds] = useState(8)
  const [customerDisplayAdsTransition, setCustomerDisplayAdsTransition] = useState<AdsTransition>('fade')
  const [customerDisplayAdsTransitionMs, setCustomerDisplayAdsTransitionMs] = useState(650)
  const [bankQrState, setBankQrState] = useState<BankQrState | null>(null)
  const [generatingBankQr, setGeneratingBankQr] = useState(false)

  const [orders, setOrders] = useState<PosOrder[]>([createEmptyOrder()])
  const [activeOrderId, setActiveOrderId] = useState<string>('')

  const [drugSearch, setDrugSearch] = useState('')
  const [lotScanInput, setLotScanInput] = useState('')
  const [selectedDrugId, setSelectedDrugId] = useState('')
  const [selectedUnitId, setSelectedUnitId] = useState('')
  const [selectedQuantity, setSelectedQuantity] = useState('1')

  const [addingByQr, setAddingByQr] = useState(false)
  const [addingByDrug, setAddingByDrug] = useState(false)
  const [checkingOut, setCheckingOut] = useState(false)
  const [searchingCustomer, setSearchingCustomer] = useState(false)
  const [creatingCustomer, setCreatingCustomer] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanMessage, setScanMessage] = useState('Đang khởi tạo camera...')
  const [cameraDevices, setCameraDevices] = useState<ScannerCamera[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [showCreateMemberForm, setShowCreateMemberForm] = useState(false)
  const [invoicePreview, setInvoicePreview] = useState<InvoicePreview | null>(null)
  const [invoicePreviewOpen, setInvoicePreviewOpen] = useState(false)
  const [lotPolicyConfirm, setLotPolicyConfirm] = useState<LotPolicyConfirmState | null>(null)
  const [stockDetailsByDrugId, setStockDetailsByDrugId] = useState<Record<string, InventoryStockDrugDetail>>({})

  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberPhone, setNewMemberPhone] = useState('')
  const [customerPointValue, setCustomerPointValue] = useState<number>(1000)

  const scanContainerRef = useRef<HTMLDivElement | null>(null)
  const scanEngineRef = useRef<any>(null)
  const scanActiveRef = useRef(false)
  const scanProcessingRef = useRef(false)
  const customerDisplayChannelRef = useRef<BroadcastChannel | null>(null)
  const customerDisplaySyncTimerRef = useRef<number | null>(null)
  const ordersRef = useRef<PosOrder[]>(orders)

  const activeOrder = useMemo(
    () => orders.find((order) => order.id === activeOrderId) ?? orders[0] ?? null,
    [orders, activeOrderId],
  )

  useEffect(() => {
    ordersRef.current = orders
  }, [orders])

  const drugsById = useMemo(() => new Map(drugs.map((drug) => [drug.id, drug])), [drugs])
  const availableDrugs = useMemo(
    () => drugs.filter((drug) => Number.isFinite(drug.totalQty) && drug.totalQty > 0),
    [drugs],
  )
  const searchableDrugs = useMemo(
    () =>
      drugs
        .slice()
        .sort((a, b) => {
          const aAvailable = a.totalQty > 0 ? 1 : 0
          const bAvailable = b.totalQty > 0 ? 1 : 0
          if (aAvailable !== bAvailable) return bAvailable - aAvailable
          return a.name.localeCompare(b.name, 'vi-VN')
        }),
    [drugs],
  )
  const filteredDrugs = useMemo(() => {
    const needles = extractDrugSearchNeedles(drugSearch)
    if (!needles.length) return searchableDrugs

    return searchableDrugs.filter((drug) => {
      const haystack = buildDrugSearchHaystack(drug)
      const code = normalizeSearchText(drug.code)
      const name = normalizeSearchText(drug.name)
      return needles.some((needle) => {
        if (haystack.includes(needle)) return true
        if (needle.includes(code) || needle.includes(name)) return true
        return false
      })
    })
  }, [searchableDrugs, drugSearch])

  const selectedDrug = selectedDrugId ? drugsById.get(selectedDrugId) ?? null : null
  const selectedUnit = selectedDrug?.units.find((unit) => unit.id === selectedUnitId) ?? null
  const selectedDrugOutOfStock = Boolean(selectedDrug && selectedDrug.totalQty <= 0)
  const barcodeIndex = useMemo(() => {
    const map = new Map<string, { drug: PosDrug; unit: PosDrugUnit }>()
    for (const drug of drugs) {
      for (const unit of drug.units) {
        const key = normalizeBarcodeText(unit.barcode)
        if (!key || map.has(key)) continue
        map.set(key, { drug, unit })
      }
    }
    return map
  }, [drugs])

  const findDrugByExactSearch = useCallback(
    (raw: string) => {
      const normalized = normalizeSearchText(raw)
      if (!normalized) return null

      const codeMatches = normalized.match(/\b[a-z]{1,4}\d{3,}\b/g) ?? []
      for (const matchedCode of codeMatches) {
        const matchedDrug = searchableDrugs.find(
          (drug) => normalizeSearchText(drug.code) === matchedCode,
        )
        if (matchedDrug) return matchedDrug
      }

      return (
        searchableDrugs.find((drug) => {
          const code = normalizeSearchText(drug.code)
          const name = normalizeSearchText(drug.name)
          const label = normalizeSearchText(buildDrugSearchLabel(drug))
          return code === normalized || name === normalized || label === normalized
        }) ?? null
      )
    },
    [searchableDrugs],
  )

  const resolveDrugFromSearch = useCallback(
    (raw: string) => {
      const exactDrug = findDrugByExactSearch(raw)
      if (exactDrug) return exactDrug

      const needles = extractDrugSearchNeedles(raw)
      if (!needles.length) return null
      const primary = needles[0]
      return (
        searchableDrugs.find((drug) => {
          const code = normalizeSearchText(drug.code)
          const name = normalizeSearchText(drug.name)
          const label = normalizeSearchText(buildDrugSearchLabel(drug))
          return code === primary || name === primary || label === primary
        }) ??
        searchableDrugs.find((drug) => {
          const haystack = buildDrugSearchHaystack(drug)
          const code = normalizeSearchText(drug.code)
          const name = normalizeSearchText(drug.name)
          return needles.some((needle) => haystack.includes(needle) || needle.includes(code) || needle.includes(name))
        }) ??
        null
      )
    },
    [findDrugByExactSearch, searchableDrugs],
  )

  useEffect(() => {
    if (!orders.length) return
    if (activeOrderId && orders.some((order) => order.id === activeOrderId)) return
    setActiveOrderId(orders[0].id)
  }, [orders, activeOrderId])

  useEffect(() => {
    const exactDrug = findDrugByExactSearch(drugSearch)
    if (exactDrug) {
      if (selectedDrugId !== exactDrug.id) {
        setSelectedDrugId(exactDrug.id)
      }
      return
    }

    if (!filteredDrugs.length) {
      if (selectedDrugId) {
        setSelectedDrugId('')
      }
      return
    }
    if (selectedDrugId && filteredDrugs.some((drug) => drug.id === selectedDrugId)) return
    setSelectedDrugId(filteredDrugs[0].id)
  }, [drugSearch, filteredDrugs, findDrugByExactSearch, selectedDrugId])

  useEffect(() => {
    if (!selectedDrug) {
      setSelectedUnitId('')
      return
    }
    const exists = selectedDrug.units.some((unit) => unit.id === selectedUnitId)
    if (exists) return
    setSelectedUnitId(getRetailUnit(selectedDrug).id)
  }, [selectedDrug, selectedUnitId])

  useEffect(() => {
    if (!activeOrder) return
    setNewMemberPhone(activeOrder.customerPhone)
    setNewMemberName(activeOrder.customerMode === 'member' ? activeOrder.customerName : '')
    setShowCreateMemberForm(false)
  }, [activeOrder?.id])

  const loadPosData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      const [metaDrugs, stockSummary, inventorySettings, saleSettings, customerSettings, store] = await Promise.all([
        inventoryApi.getMetaDrugs(token?.access_token),
        inventoryApi.getStockSummary(token?.access_token),
        storeApi.getSettingsByGroup('inventory'),
        storeApi.getSettingsByGroup('sale'),
        storeApi.getSettingsByGroup('customer').catch(() => ({})),
        storeApi.getInfo().catch(() => null),
      ])

      const totalQtyByDrugId = new Map(
        stockSummary.map((item) => [item.drug_id, Number(item.total_qty || 0)]),
      )
      const mappedDrugs = metaDrugs
        .map((drug) => ({
          ...mapMetaDrugToPosDrug(drug),
          totalQty: totalQtyByDrugId.get(drug.id) ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'vi-VN'))

      setDrugs(mappedDrugs)
      setFefoEnabled(normalizeSettingBoolean(inventorySettings['inventory.enable_fefo'], true))
      setFefoThresholdDays(
        normalizeSettingNumber(inventorySettings['inventory.fefo_threshold_days'], 180),
      )
      setSellByLot(normalizeSettingBoolean(saleSettings['sale.enforce_lot_policy'], true))
      setCashRoundingEnabled(
        normalizeSettingBoolean(saleSettings['sale.cash_rounding_enabled'], true),
      )
      setCashRoundingUnit(
        Math.max(
          1,
          normalizeSettingNumber(saleSettings['sale.cash_rounding_step'], 1000),
        ),
      )
      setReturnPolicyText(buildReturnPolicyText(saleSettings))
      setBankQrAddInfoMode(
        normalizeSettingString(saleSettings['sale.bank_qr_add_info_mode'], 'order_code')
          .toLowerCase() === 'custom'
          ? 'custom'
          : 'order_code',
      )
      setBankQrAddInfoCustom(
        normalizeSettingString(saleSettings['sale.bank_qr_add_info_custom'], ''),
      )
      setCustomerDisplayShowPrice(
        normalizeSettingBoolean(saleSettings['sale.customer_display_show_price'], true),
      )
      setCustomerDisplayShowTotal(
        normalizeSettingBoolean(saleSettings['sale.customer_display_show_total'], true),
      )
      setCustomerDisplayAds(normalizeSettingStringArray(saleSettings['sale.customer_display_ads']))
      setCustomerDisplayAdsIntervalSeconds(
        Math.max(
          1,
          normalizeSettingNumber(saleSettings['sale.customer_display_ads_interval_seconds'], 8),
        ),
      )
      setCustomerDisplayAdsTransition(
        normalizeAdsTransition(saleSettings['sale.customer_display_ads_transition']),
      )
      setCustomerDisplayAdsTransitionMs(
        Math.max(
          0,
          normalizeSettingNumber(saleSettings['sale.customer_display_ads_transition_ms'], 650),
        ),
      )
      const customerSettingsRecord = customerSettings as Record<string, unknown> | null
      if (customerSettingsRecord && typeof customerSettingsRecord['customer.point_value'] === 'number') {
        setCustomerPointValue(customerSettingsRecord['customer.point_value'])
      } else if (customerSettingsRecord && typeof customerSettingsRecord['customer.point_value'] === 'string') {
        setCustomerPointValue(Number(customerSettingsRecord['customer.point_value']) || 1000)
      }
      if (store) {
        const bankOption = findBankOption(normalizeSettingString(store.bank_name, ''))
        setBankQrAccountNo(normalizeSettingString(store.bank_account, ''))
        setBankQrAccountName(
          normalizeSettingString(
            saleSettings['sale.bank_account_name'],
            normalizeSettingString(store.owner_name || store.name, ''),
          ),
        )
        setBankQrAcqId(bankOption?.bin ?? '')
        setStoreInfo(store)
      } else {
        setBankQrAccountNo('')
        setBankQrAccountName(normalizeSettingString(saleSettings['sale.bank_account_name'], ''))
        setBankQrAcqId('')
      }
    } catch (error) {
      if (error instanceof ApiError) setLoadError(error.message)
      else setLoadError('Không thể tải dữ liệu bán hàng.')
    } finally {
      setLoading(false)
    }
  }, [token?.access_token])

  useEffect(() => {
    void loadPosData()
  }, [loadPosData])

  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
    const channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL)
    customerDisplayChannelRef.current = channel
    return () => {
      customerDisplayChannelRef.current = null
      channel.close()
    }
  }, [])

  const updateOrder = useCallback((orderId: string, updater: (order: PosOrder) => PosOrder) => {
    setOrders((prev) => {
      const next = prev.map((order) => (order.id === orderId ? updater(order) : order))
      ordersRef.current = next
      return next
    })
  }, [])

  const addOrder = useCallback(() => {
    const nextOrder = createEmptyOrder()
    setOrders((prev) => {
      const next = [...prev, nextOrder]
      ordersRef.current = next
      return next
    })
    setActiveOrderId(nextOrder.id)
  }, [])

  const removeOrder = useCallback((orderId: string) => {
    setOrders((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.filter((order) => order.id !== orderId)
      ordersRef.current = next
      return next
    })
  }, [])

  const getStockDrugDetailCached = useCallback(
    async (drugId: string, forceRefresh = false) => {
      if (!forceRefresh && stockDetailsByDrugId[drugId]) {
        return stockDetailsByDrugId[drugId]
      }

      const detail = await inventoryApi.getStockDrugDetail(drugId, token?.access_token)
      setStockDetailsByDrugId((prev) => ({ ...prev, [drugId]: detail }))
      return detail
    },
    [stockDetailsByDrugId, token?.access_token],
  )

  const recalculateAutoFillOrder = useCallback(
    async (orderId: string, forceRefresh = false) => {
      const currentOrder = ordersRef.current.find((order) => order.id === orderId)
      if (!currentOrder) return null

      const autoFillItems = currentOrder.items.filter((item) => isAutoFillAllocationMode(item.allocationMode))
      if (!autoFillItems.length) return currentOrder

      const uniqueDrugIds = Array.from(new Set(autoFillItems.map((item) => item.drugId)))
      const detailEntries = await Promise.all(
        uniqueDrugIds.map(async (drugId) => [drugId, await getStockDrugDetailCached(drugId, forceRefresh)] as const),
      )

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const sortedBatchesByDrugId = new Map<string, InventoryBatch[]>()
      const remainingByDrugId = new Map<string, Map<string, number>>()

      detailEntries.forEach(([drugId, detail]) => {
        const sorted = detail.batches
          .filter((batch) => batch.status === 'active' && batch.qty_remaining > 0)
          .slice()
          .sort((left, right) =>
            compareByLotIssuePolicy(left, right, today, fefoEnabled, fefoThresholdDays),
          )

        sortedBatchesByDrugId.set(drugId, sorted)
        remainingByDrugId.set(
          drugId,
          new Map(sorted.map((batch) => [batch.id, batch.qty_remaining])),
        )
      })

      currentOrder.items.forEach((item) => {
        if (isAutoFillAllocationMode(item.allocationMode)) return
        const requestedBaseQty =
          parsePositiveInt(item.quantity, 0) * Math.max(item.conversion, 1)
        if (requestedBaseQty <= 0) return

        const remaining = remainingByDrugId.get(item.drugId)
        if (!remaining) return

        const available = remaining.get(item.batchId) ?? 0
        remaining.set(item.batchId, Math.max(0, available - Math.min(available, requestedBaseQty)))
      })

      const recalculatedItems = currentOrder.items.map((item) => {
        if (!isAutoFillAllocationMode(item.allocationMode)) {
          return {
            ...item,
            availableBaseQty: item.batchQtyRemaining,
            allocationWarning: null,
          }
        }

        const drug = drugsById.get(item.drugId)
        const retailUnit = drug ? getRetailUnit(drug) : null
        const sortedBatches = sortedBatchesByDrugId.get(item.drugId) ?? []
        const remaining = remainingByDrugId.get(item.drugId) ?? new Map<string, number>()
        const totalAvailableBaseQty = Array.from(remaining.values()).reduce((sum, value) => sum + Math.max(0, value), 0)

        if (!drug || !retailUnit || item.conversion !== 1 || item.unitId !== retailUnit.id) {
          return {
            ...item,
            batchQtyRemaining: totalAvailableBaseQty,
            availableBaseQty: totalAvailableBaseQty,
            plannedAllocations: [],
            allocationWarning: `Tự phân bổ nhiều lô chỉ hỗ trợ ở đơn vị lẻ ${retailUnit?.name ?? 'đơn vị gốc'}. Vui lòng đổi về đơn vị lẻ hoặc chọn lô cụ thể.`,
          }
        }

        const requestedBaseQty = parsePositiveInt(item.quantity, 0)
        let remainingNeed = requestedBaseQty
        const plannedAllocations: PosOrderItemAllocation[] = []

        sortedBatches.forEach((batch) => {
          if (remainingNeed <= 0) return
          const available = remaining.get(batch.id) ?? 0
          if (available <= 0) return

          const allocated = Math.min(available, remainingNeed)
          if (allocated <= 0) return

          plannedAllocations.push({
            batchId: batch.id,
            batchCode: batch.batch_code,
            lotNumber: batch.lot_number,
            expDate: toIsoDate(batch.exp_date),
            baseQuantity: allocated,
          })
          remaining.set(batch.id, available - allocated)
          remainingNeed -= allocated
        })

        const firstAllocation = plannedAllocations[0]
        return {
          ...item,
          batchId: firstAllocation?.batchId ?? item.batchId,
          batchCode: 'Tự động',
          lotNumber: '',
          expDate: '',
          batchQtyRemaining: totalAvailableBaseQty,
          availableBaseQty: totalAvailableBaseQty,
          plannedAllocations,
          allocationWarning:
            remainingNeed > 0
              ? `Không đủ tồn kho khả dụng khi cộng các lô. Có ${totalAvailableBaseQty.toLocaleString('vi-VN')} ${retailUnit.name}, cần ${requestedBaseQty.toLocaleString('vi-VN')} ${retailUnit.name}.`
              : null,
        }
      })

      const nextOrder = {
        ...currentOrder,
        items: recalculatedItems,
      }

      updateOrder(orderId, () => nextOrder)
      return nextOrder
    },
    [drugsById, fefoEnabled, fefoThresholdDays, getStockDrugDetailCached, updateOrder],
  )

  const validateOrderItemQuantityMessage = useCallback(
    (item: PosOrderItem, quantity: number) => {
      if (quantity <= 0) {
        return 'Số lượng phải lớn hơn 0.'
      }

      if (isAutoFillAllocationMode(item.allocationMode)) {
        if (item.conversion !== 1) {
          return item.allocationWarning || 'Đơn vị này chưa hỗ trợ tự phân bổ nhiều lô.'
        }

        const availableBaseQty = getItemAvailableBaseQty(item)
        if (quantity > availableBaseQty) {
          return item.allocationWarning || 'Số lượng vượt tồn kho khả dụng khi cộng các lô.'
        }

        if (sumPlannedAllocationBaseQty(item) < quantity) {
          return item.allocationWarning || 'Chưa phân bổ đủ số lượng qua các lô khả dụng.'
        }

        return null
      }

      const availableBaseQty = getItemAvailableBaseQty(item)
      if (quantity * Math.max(item.conversion, 1) > availableBaseQty) {
        return `Số lượng vượt tồn kho của lô ${item.batchCode}.`
      }
      return null
    },
    [],
  )

  const printInvoicePreview = useCallback((preview: InvoicePreview) => {
    const printWindow = window.open('', '_blank', 'width=900,height=680')
    if (!printWindow) {
      setActionError('Trình duyệt đang chặn cửa sổ in. Hãy bật popup và thử lại.')
      return
    }

    const rowsHtml = preview.lines
      .map(
        (line, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>
              ${escapeHtml(line.name)}${line.isService ? ' <span class="service">(DV)</span>' : ''}
              ${line.lotNumber ? `<div class="service">Lô: ${escapeHtml(line.lotNumber)}</div>` : ''}
            </td>
            <td class="center">${escapeHtml(line.unit)}</td>
            <td class="right">${line.quantity.toLocaleString('vi-VN')}</td>
            <td class="right">${formatCurrency(line.unitPrice)}</td>
            <td class="right">${formatCurrency(line.amount)}</td>
          </tr>
        `,
      )
      .join('')

    const logoHtml = preview.storeLogoUrl
      ? `<img class="store-logo" src="${escapeHtml(preview.storeLogoUrl)}" alt="Store logo" />`
      : ''

    const html = `
      <!doctype html>
      <html lang="vi">
        <head>
          <meta charset="utf-8" />
          <title>Hóa đơn ${escapeHtml(preview.code)}</title>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 16px;
              font-family: "Segoe UI", Arial, sans-serif;
              color: #111827;
              background: #ffffff;
            }
            .wrap {
              max-width: 780px;
              margin: 0 auto;
              border: 1px solid #e5e7eb;
              border-radius: 12px;
              padding: 14px;
            }
            h1 {
              margin: 0 0 6px 0;
              font-size: 20px;
              text-align: center;
            }
            .store-head {
              border-bottom: 1px solid #e5e7eb;
              padding-bottom: 8px;
              margin-bottom: 10px;
            }
            .store-row {
              display: flex;
              align-items: center;
              gap: 12px;
            }
            .store-info {
              flex: 1;
              min-width: 0;
              text-align: left;
            }
            .store-logo {
              width: 56px;
              height: 56px;
              object-fit: contain;
              border-radius: 8px;
              border: 1px solid #e5e7eb;
              padding: 4px;
              background: #fff;
            }
            .store-name {
              margin: 0;
              font-size: 18px;
              font-weight: 700;
              line-height: 1.25;
            }
            .store-sub {
              margin-top: 3px;
              font-size: 12px;
              color: #4b5563;
            }
            .meta {
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 6px 18px;
              font-size: 13px;
              margin-bottom: 12px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 12px;
              font-size: 13px;
            }
            th, td {
              border: 1px solid #e5e7eb;
              padding: 6px 8px;
              vertical-align: top;
            }
            th { background: #f3f4f6; text-align: left; }
            .right { text-align: right; }
            .center { text-align: center; }
            .summary {
              margin-left: auto;
              width: 320px;
              font-size: 13px;
            }
            .summary-row {
              display: flex;
              justify-content: space-between;
              padding: 4px 0;
            }
            .summary-row.total {
              font-size: 16px;
              font-weight: 700;
              border-top: 1px solid #e5e7eb;
              margin-top: 4px;
              padding-top: 8px;
            }
            .service {
              font-size: 11px;
              color: #6b7280;
            }
            .note {
              margin-top: 10px;
              font-size: 12px;
              color: #4b5563;
              white-space: pre-wrap;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="store-head">
              <div class="store-row">
                ${logoHtml}
                <div class="store-info">
                  <p class="store-name">${escapeHtml(preview.storeName || 'Nhà thuốc')}</p>
                  ${preview.storePhone ? `<div class="store-sub">SDT: ${escapeHtml(preview.storePhone)}</div>` : ''}
                  ${preview.storeAddress ? `<div class="store-sub">Địa chỉ: ${escapeHtml(preview.storeAddress)}</div>` : ''}
                </div>
              </div>
            </div>
            <h1>Hóa đơn bán hàng</h1>
            <div class="meta">
              <div><strong>Số hóa đơn:</strong> ${escapeHtml(preview.code)}</div>
              <div><strong>Ngày:</strong> ${escapeHtml(preview.createdAt)}</div>
              <div><strong>Thu ngân:</strong> ${escapeHtml(preview.cashier || '-')}</div>
              <div><strong>Khách hàng:</strong> ${escapeHtml(preview.customerName || 'Khách vãng lai')}</div>
              <div><strong>SDT:</strong> ${escapeHtml(preview.customerPhone || '-')}</div>
              <div><strong>Thanh toán:</strong> ${escapeHtml(preview.paymentMethod)}</div>
            </div>

            <table>
              <thead>
                <tr>
                  <th style="width: 40px">#</th>
                  <th>Mặt hàng</th>
                  <th style="width: 80px">Đơn vị</th>
                  <th style="width: 80px" class="right">SL</th>
                  <th style="width: 120px" class="right">Đơn giá</th>
                  <th style="width: 130px" class="right">Thành tiền</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>

            <div class="summary">
              ${
                preview.serviceFeeMode === 'separate' && preview.serviceFee > 0
                  ? `<div class="summary-row"><span>Phí dịch vụ</span><strong>${formatCurrency(preview.serviceFee)}</strong></div>`
                  : ''
              }
              ${
                preview.tierDiscountAmount
                  ? `<div class="summary-row" style="color:#059669"><span>Chiết khấu hạng thẻ</span><strong>-${formatCurrency(preview.tierDiscountAmount)}</strong></div>`
                  : ''
              }
              ${
                preview.pointsDiscountAmount
                  ? `<div class="summary-row" style="color:#059669"><span>Điểm thưởng (-${preview.pointsUsed} điểm)</span><strong>-${formatCurrency(preview.pointsDiscountAmount)}</strong></div>`
                  : ''
              }
              ${
                preview.roundingAdjustmentAmount !== 0
                  ? `<div class="summary-row"><span>Điều chỉnh làm tròn</span><strong>${formatCurrency(preview.roundingAdjustmentAmount)}</strong></div>`
                  : ''
              }
              <div class="summary-row total"><span>Tổng thanh toán</span><strong>${formatCurrency(preview.grandTotal)}</strong></div>
              <div class="summary-row"><span>Khách đưa</span><strong>${formatCurrency(preview.amountPaid)}</strong></div>
              <div class="summary-row"><span>Tiền thừa</span><strong>${formatCurrency(Math.max(0, preview.changeAmount))}</strong></div>
              ${preview.debtAmount > 0 ? `<div class="summary-row"><span>Còn nợ</span><strong>${formatCurrency(preview.debtAmount)}</strong></div>` : ''}
            </div>

            ${preview.returnPolicyText ? `<div class="note"><strong>Đổi trả:</strong> ${escapeHtml(preview.returnPolicyText)}</div>` : ''}
            ${preview.note ? `<div class="note"><strong>Ghi chú:</strong> ${escapeHtml(preview.note)}</div>` : ''}
          </div>
        </body>
      </html>
    `

    printWindow.document.open()
    printWindow.document.write(html)
    printWindow.document.close()
    printWindow.focus()
    window.setTimeout(() => {
      printWindow.print()
      printWindow.close()
    }, 250)
  }, [])

  const evaluateLotPolicy = useCallback(
    async (params: {
      drugId: string
      drugCode: string
      batchId: string
      batchCode: string
      lotNumber: string
      baseQuantity: number
    }) => {
      if (!sellByLot) return null
      if (params.baseQuantity <= 0) return null

      try {
        const normalizedDrugCode = normalizeBarcodeText(params.drugCode)
        const relatedBatches = await inventoryApi.listBatches({
          search: params.drugCode,
          status: 'active',
        })

        const activeCandidates = relatedBatches.filter((batch) => {
          if (batch.qty_remaining <= 0) return false
          if (batch.id === params.batchId) return true
          if (!normalizedDrugCode) return false
          return normalizeBarcodeText(batch.drug_code) === normalizedDrugCode
        })

        if (!activeCandidates.length) return null

        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const sortedCandidates = activeCandidates
          .slice()
          .sort((left, right) =>
            compareByLotIssuePolicy(left, right, today, fefoEnabled, fefoThresholdDays),
          )

        const recommended = sortedCandidates[0]
        if (!recommended || recommended.id === params.batchId) return null

        const recommendedStrategy = getIssueStrategy(
          recommended,
          today,
          fefoEnabled,
          fefoThresholdDays,
        )

        return `L\u00f4 ${params.batchCode || params.lotNumber} ch\u01b0a theo ${recommendedStrategy.toUpperCase()}. G\u1ee3i \u00fd: ${recommended.batch_code}.`
      } catch {
        return null
      }
    },
    [sellByLot, fefoEnabled, fefoThresholdDays],
  )

  const applyItemPolicyCheck = useCallback(
    async (
      orderId: string,
      itemId: string,
      params: {
        drugId: string
        drugCode: string
        batchId: string
        batchCode: string
        lotNumber: string
        quantity: number
        conversion: number
      },
    ) => {
      const warning = await evaluateLotPolicy({
        drugId: params.drugId,
        drugCode: params.drugCode,
        batchId: params.batchId,
        batchCode: params.batchCode,
        lotNumber: params.lotNumber,
        baseQuantity: params.quantity * Math.max(params.conversion, 1),
      })

      updateOrder(orderId, (order) => ({
        ...order,
        items: order.items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                lotPolicyWarning: warning,
                lotPolicyAcknowledged:
                  !!warning &&
                  item.lotPolicyAcknowledged &&
                  item.lotPolicyWarning === warning,
              }
            : item,
        ),
      }))
    },
    [evaluateLotPolicy, updateOrder],
  )

  const addItemToOrder = useCallback((orderId: string, item: PosOrderItem) => {
    updateOrder(orderId, (order) => {
      const existing = order.items.find((current) => {
        if (
          isAutoFillAllocationMode(current.allocationMode) &&
          isAutoFillAllocationMode(item.allocationMode)
        ) {
          return current.drugId === item.drugId && current.unitId === item.unitId
        }

        return (
          current.batchId === item.batchId &&
          current.drugId === item.drugId &&
          current.unitId === item.unitId
        )
      })

      if (existing) {
        const nextQuantity =
          parsePositiveInt(existing.quantity, 0) + parsePositiveInt(item.quantity, 1)
        return {
          ...order,
          items: order.items.map((current) =>
            current.id === existing.id
              ? {
                  ...current,
                  quantity: String(nextQuantity),
                  lotPolicyWarning: item.lotPolicyWarning,
                  lotPolicyAcknowledged: item.lotPolicyAcknowledged,
                  allocationWarning: item.allocationWarning,
                }
              : current,
          ),
        }
      }

      return {
        ...order,
        items: [item, ...order.items],
      }
    })
  }, [updateOrder])

  const buildAutoFillItem = useCallback(
    async (
      orderId: string,
      drug: PosDrug,
      preferredUnit: PosDrugUnit,
      defaultQuantity = 1,
    ) => {
      const retailUnit = getRetailUnit(drug)
      if (preferredUnit.conversion !== 1 || preferredUnit.id !== retailUnit.id) {
        throw new ApiError(
          `Tự phân bổ nhiều lô chỉ hỗ trợ ở đơn vị lẻ ${retailUnit.name}. Vui lòng đổi về đơn vị lẻ hoặc chọn lô cụ thể.`,
          400,
        )
      }

      const detail = await getStockDrugDetailCached(drug.id)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const firstBatch = detail.batches
        .filter((batch) => batch.status === 'active' && batch.qty_remaining > 0)
        .slice()
        .sort((left, right) =>
          compareByLotIssuePolicy(left, right, today, fefoEnabled, fefoThresholdDays),
        )[0]

      if (!firstBatch) {
        throw new ApiError(`Không còn lô khả dụng cho ${drug.name}.`, 409)
      }

      addItemToOrder(orderId, {
        id: createItemId(),
        drugId: drug.id,
        drugCode: drug.code,
        drugName: drug.name,
        batchId: firstBatch.id,
        batchCode: 'Tự động',
        lotNumber: '',
        expDate: '',
        batchQtyRemaining: 0,
        unitId: retailUnit.id,
        unitName: retailUnit.name,
        conversion: retailUnit.conversion,
        unitPrice: retailUnit.price,
        quantity: String(Math.max(1, defaultQuantity)),
        allocationMode: 'auto_fill',
        plannedAllocations: [],
        availableBaseQty: 0,
        allocationWarning: null,
        lotPolicyWarning: null,
        lotPolicyAcknowledged: false,
      })

      return recalculateAutoFillOrder(orderId)
    },
    [addItemToOrder, fefoEnabled, fefoThresholdDays, getStockDrugDetailCached, recalculateAutoFillOrder],
  )

  const buildItemFromBatch = useCallback(
    async (
      batchDetail: InventoryBatchDetail,
      orderId: string,
      defaultQuantity = 1,
      preferredDrug?: PosDrug | null,
      preferredUnit?: PosDrugUnit | null,
    ) => {
      const batch = batchDetail.batch
      if (batch.status !== 'active' || batch.qty_remaining <= 0) {
        throw new ApiError(`Lô ${batch.batch_code} không còn khả dụng để bán.`, 409)
      }

      const drug = preferredDrug ?? drugsById.get(batch.drug_id)
      if (!drug) {
        throw new ApiError(`Không tìm thấy thông tin thuốc cho lô ${batch.batch_code}.`, 404)
      }

      const defaultUnit =
        preferredUnit && drug.units.some((unit) => unit.id === preferredUnit.id)
          ? preferredUnit
          : getRetailUnit(drug)
      const quantity = Math.max(1, defaultQuantity)
      const warning = await evaluateLotPolicy({
        drugId: drug.id,
        drugCode: drug.code,
        batchId: batch.id,
        batchCode: batch.batch_code,
        lotNumber: batch.lot_number,
        baseQuantity: quantity * defaultUnit.conversion,
      })

      const item: PosOrderItem = {
        id: createItemId(),
        drugId: drug.id,
        drugCode: drug.code,
        drugName: drug.name,
        batchId: batch.id,
        batchCode: batch.batch_code,
        lotNumber: batch.lot_number,
        expDate: toIsoDate(batch.exp_date),
        batchQtyRemaining: batch.qty_remaining,
        unitId: defaultUnit.id,
        unitName: defaultUnit.name,
        conversion: defaultUnit.conversion,
        unitPrice: defaultUnit.price,
        quantity: String(quantity),
        allocationMode: 'explicit_lot',
        plannedAllocations: [
          {
            batchId: batch.id,
            batchCode: batch.batch_code,
            lotNumber: batch.lot_number,
            expDate: toIsoDate(batch.exp_date),
            baseQuantity: quantity * Math.max(defaultUnit.conversion, 1),
          },
        ],
        availableBaseQty: batch.qty_remaining,
        allocationWarning: null,
        lotPolicyWarning: warning,
        lotPolicyAcknowledged: false,
      }

      if (sellByLot && warning) {
        setLotPolicyConfirm({
          mode: 'add',
          orderId,
          item,
          message: warning,
        })
        setActionError(null)
        setActionMessage(
          `Lô ${batch.batch_code} không theo chính sách xuất kho hiện tại. Vui lòng xác nhận.`,
        )
        return
      }

      addItemToOrder(orderId, item)
      if (!sellByLot) {
        await recalculateAutoFillOrder(orderId)
      }
      setActionMessage(`Đã thêm ${drug.name} từ lô ${batch.batch_code}.`)
      setActionError(null)
    },
    [addItemToOrder, drugsById, evaluateLotPolicy, recalculateAutoFillOrder, sellByLot],
  )

  const addByLotQrValue = useCallback(
    async (rawQrValue: string) => {
      if (!activeOrder) return
      const qrValue = normalizeQrText(rawQrValue)
      if (!qrValue) return

      setAddingByQr(true)
      setActionError(null)
      setActionMessage(null)

      try {
        const candidates = extractQrCandidates(qrValue)
        if (!candidates.length) {
          throw new ApiError('QR lô không hợp lệ.', 400)
        }

        let batchDetail: InventoryBatchDetail | null = null
        let lastError: ApiError | null = null
        for (const candidate of candidates) {
          try {
            batchDetail = await inventoryApi.getBatchByQr(candidate, token?.access_token)
            break
          } catch (error) {
            if (error instanceof ApiError) {
              lastError = error
              if (error.status === 404) continue
              throw error
            }
            throw error
          }
        }

        if (!batchDetail) {
          if (!sellByLot) {
            const barcodeLookup = barcodeIndex.get(normalizeBarcodeText(qrValue))
            if (barcodeLookup) {
              const quantity = Math.max(1, parsePositiveInt(selectedQuantity, 1))
              const baseQuantity = quantity * Math.max(barcodeLookup.unit.conversion, 1)

              const suggestion = await inventoryApi.suggestIssueByDrug({
                drug_id: barcodeLookup.drug.id,
                drug_code: barcodeLookup.drug.code,
                quantity: baseQuantity,
              }, token?.access_token)
              const suggestedBatch = suggestion.allocations[0]
              if (!suggestedBatch || suggestion.shortage > 0) {
                throw new ApiError(`Không đủ tồn kho cho ${barcodeLookup.drug.name}.`, 409)
              }

              if (barcodeLookup.unit.conversion === 1) {
                await buildAutoFillItem(
                  activeOrder.id,
                  barcodeLookup.drug,
                  barcodeLookup.unit,
                  quantity,
                )
                setActionMessage(
                  `Đã thêm ${barcodeLookup.drug.name}; hệ thống sẽ tự phân bổ lô khi thanh toán.`,
                )
                setLotScanInput('')
                return
              }

              if (suggestion.allocations.length > 1 || suggestedBatch.allocated < baseQuantity) {
                throw new ApiError(
                  `Đơn vị ${barcodeLookup.unit.name} chỉ bán được khi một lô đủ tồn. Vui lòng đổi về đơn vị lẻ hoặc quét lô cụ thể.`,
                  409,
                )
              }

              const byBarcodeDetail = await inventoryApi.getBatchDetail(suggestedBatch.batch_id)
              await buildItemFromBatch(
                byBarcodeDetail,
                activeOrder.id,
                quantity,
                barcodeLookup.drug,
                barcodeLookup.unit,
              )
              setActionMessage(
                `Đã thêm ${barcodeLookup.drug.name} theo barcode ${normalizeBarcodeText(qrValue)}.`,
              )
              setLotScanInput('')
              return
            }
          }

          if (lastError?.status === 404) {
            throw new ApiError('Không tìm thấy lô tương ứng với mã đã quét.', 404)
          }
          throw lastError ?? new ApiError('Không thể đọc QR lô.', 400)
        }

        await buildItemFromBatch(batchDetail, activeOrder.id)
        setLotScanInput('')
      } catch (error) {
        if (error instanceof ApiError) setActionError(error.message)
        else setActionError('Không thể quét QR lô.')
      } finally {
        setAddingByQr(false)
      }
    },
    [activeOrder, barcodeIndex, buildAutoFillItem, buildItemFromBatch, sellByLot, selectedQuantity, token?.access_token],
  )

  const handleAddByLotQr = useCallback(async () => {
    await addByLotQrValue(lotScanInput)
  }, [addByLotQrValue, lotScanInput])

  const stopCameraScanner = useCallback(async () => {
    scanActiveRef.current = false
    scanProcessingRef.current = false

    const scanner = scanEngineRef.current
    scanEngineRef.current = null
    if (scanner) {
      try {
        await scanner.stop()
      } catch {
        // ignore stop failure
      }
      try {
        await scanner.clear()
      } catch {
        // ignore clear failure
      }
    }

    if (scanContainerRef.current) {
      scanContainerRef.current.innerHTML = ''
    }
  }, [])

  useEffect(() => {
    if (!scanOpen) {
      void stopCameraScanner()
      setScanError(null)
      setScanMessage('Đang khởi tạo camera...')
      return
    }

    let cancelled = false
    const startScanner = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setScanError('Trình duyệt không hỗ trợ camera.')
          return
        }

        const container = scanContainerRef.current
        if (!container) {
          setScanError('Không khởi tạo được camera.')
          return
        }

        setScanError(null)
        setScanMessage('Đang tải bộ quét QR...')

        await ensureHtml5QrcodeLibrary()
        if (cancelled) {
          return
        }

        const Html5Qrcode = (window as any).Html5Qrcode
        const formats = (window as any).Html5QrcodeSupportedFormats
        if (!Html5Qrcode) {
          setScanError('Không tải được thư viện quét QR.')
          return
        }

        let resolvedCameraId = selectedCameraId.trim()
        try {
          // Ask camera permission once so browser returns full device labels.
          const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
          tempStream.getTracks().forEach((track) => track.stop())

          const rawDevices = await navigator.mediaDevices.enumerateDevices()
          const cameras = rawDevices
            .filter((device) => device.kind === 'videoinput')
            .map((device, index) => ({
              id: device.deviceId,
              label: device.label?.trim() || `Camera ${index + 1}`,
            }))
            .filter((camera) => camera.id)

          setCameraDevices(cameras)

          if (!cameras.length) {
            setScanError('Không tìm thấy camera trên thiết bị.')
            return
          }

          const selectedExists = resolvedCameraId
            ? cameras.some((camera) => camera.id === resolvedCameraId)
            : false

          if (!selectedExists) {
            const backCamera = cameras.find((camera) =>
              /back|rear|environment|sau|camera\s?2/i.test(camera.label),
            )
            const preferredCameraId = backCamera?.id ?? cameras[0].id
            resolvedCameraId = preferredCameraId
            if (selectedCameraId !== preferredCameraId) {
              setSelectedCameraId(preferredCameraId)
              return
            }
          }
        } catch {
          setCameraDevices([])
          if (selectedCameraId) setSelectedCameraId('')
        }

        const scanner = new Html5Qrcode(POS_QR_SCANNER_ID, { verbose: false })
        scanEngineRef.current = scanner
        scanActiveRef.current = true
        scanProcessingRef.current = false
        setScanError(null)
        setScanMessage(
          sellByLot
            ? 'Đang quét... Đưa QR lô vào khung hình.'
            : 'Đang quét... Đưa QR hoặc barcode vào khung hình.',
        )

        const formatList =
          sellByLot && typeof formats?.QR_CODE === 'number'
            ? [formats.QR_CODE]
            : undefined

        const cameraConfig = resolvedCameraId
          ? { deviceId: { exact: resolvedCameraId } }
          : { facingMode: { ideal: 'environment' } }

        await scanner.start(
          cameraConfig,
          {
            fps: 10,
            qrbox: { width: 220, height: 220 },
            aspectRatio: 1.7777778,
            rememberLastUsedCamera: false,
            formatsToSupport: formatList,
          },
          (decodedText: string) => {
            if (!scanActiveRef.current || scanProcessingRef.current) return
            const detected = normalizeQrText(decodedText)
            if (!detected) return

            scanProcessingRef.current = true
            scanActiveRef.current = false
            setScanMessage('Đang xử lý mã QR...')
            setLotScanInput(detected)
            setScanOpen(false)
            void addByLotQrValue(detected)
          },
          () => {
            // ignore per-frame decode error
          },
        )
      } catch (error: any) {
        if (cancelled) return
        const message = String(error?.message || '')
        const name = error?.name ?? ''
        const friendly =
          name === 'NotAllowedError' || /permission|denied|notallowed/i.test(message)
                    ? 'Bạn đã từ chối quyền camera.'
            : name === 'NotReadableError' || /notreadable|trackstart/i.test(message)
              ? 'Camera đang được ứng dụng khác sử dụng.'
              : name === 'NotFoundError' || /notfound/i.test(message)
                ? 'Không tìm thấy camera trên thiết bị.'
                : /library-load-failed|library-not-ready|Failed to fetch/i.test(message)
                  ? 'Không tải được thư viện quét QR. Đặt file /vendor/html5-qrcode.min.js hoặc kiểm tra kết nối internet.'
                  : `Không mở được camera: ${error?.message || 'Lỗi không xác định'}`
        setScanError(friendly)
      }
    }

    void startScanner()

    return () => {
      cancelled = true
      void stopCameraScanner()
    }
  }, [scanOpen, selectedCameraId, stopCameraScanner, addByLotQrValue, sellByLot])

  const handleAddByDrug = useCallback(async () => {
    if (!activeOrder || !selectedDrug || !selectedUnit) return

    const quantity = parsePositiveInt(selectedQuantity, 0)
    if (quantity <= 0) {
      setActionError('Số lượng phải lớn hơn 0.')
      return
    }

    const baseQuantity = quantity * selectedUnit.conversion

    setAddingByDrug(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const suggestion = await inventoryApi.suggestIssueByDrug({
        drug_id: selectedDrug.id,
        quantity: baseQuantity,
      }, token?.access_token)
      const suggestedBatch = suggestion.allocations[0]
      if (!suggestedBatch || suggestion.shortage > 0) {
        throw new ApiError(`Không đủ tồn kho cho ${selectedDrug.name}.`, 409)
      }

      if (!sellByLot && selectedUnit.conversion === 1) {
        await buildAutoFillItem(activeOrder.id, selectedDrug, selectedUnit, quantity)
        setActionMessage(
          `Đã thêm ${selectedDrug.name}; hệ thống sẽ tự phân bổ lô khi thanh toán.`,
        )
        return
      }

      if (!sellByLot && (suggestion.allocations.length > 1 || suggestedBatch.allocated < baseQuantity)) {
        throw new ApiError(
          `Đơn vị ${selectedUnit.name} chỉ bán được khi một lô đủ tồn. Vui lòng đổi về đơn vị lẻ hoặc chọn lô cụ thể.`,
          409,
        )
      }

      const batchDetail = await inventoryApi.getBatchDetail(suggestedBatch.batch_id)
      await buildItemFromBatch(batchDetail, activeOrder.id, quantity, selectedDrug, selectedUnit)
    } catch (error) {
      if (error instanceof ApiError) setActionError(error.message)
      else setActionError('Không thể thêm thuốc theo gợi ý lô.')
    } finally {
      setAddingByDrug(false)
    }
  }, [activeOrder, selectedDrug, selectedUnit, selectedQuantity, buildAutoFillItem, buildItemFromBatch, sellByLot, token?.access_token])

  const updateActiveOrder = useCallback(
    (updater: (order: PosOrder) => PosOrder) => {
      if (!activeOrder) return
      updateOrder(activeOrder.id, updater)
    },
    [activeOrder, updateOrder],
  )

  const applyCustomerToOrder = useCallback(
    (orderId: string, customer: CustomerRecord, customerStats?: import('../api/customerService').CustomerStatsResponse) => {
      updateOrder(orderId, (order) => ({
        ...order,
        customerMode: 'member',
        customerId: customer.id,
        customerCode: customer.code,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerTier: customerStats?.tier ?? customer.tier,
        customerTierDiscountPercent: customerStats?.tier_discount_percent ?? null,
        customerPoints: customerStats?.current_points ?? customer.current_points,
        pointsToRedeem: '',
      }))
      setShowCreateMemberForm(false)
    },
    [updateOrder],
  )

  const handleLookupCustomerByPhone = useCallback(async () => {
    if (!activeOrder || !token?.access_token) return

    const phone = normalizePhone(activeOrder.customerPhone)
    if (!phone) {
      setActionError('Vui lòng nhập số điện thoại để tìm khách hàng.')
      return
    }

    setSearchingCustomer(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const customer = await customerApi.getCustomerByPhone(token.access_token, phone)
      let stats = undefined
      try {
        stats = await customerApi.getCustomerStats(token.access_token, customer.id)
      } catch (statsErr) {
        console.warn('Failed to fetch customer stats', statsErr)
      }

      applyCustomerToOrder(activeOrder.id, customer, stats)
      setActionMessage(`Đã tìm thấy khách hàng ${customer.name}.`)
      setNewMemberPhone(customer.phone)
      setNewMemberName(customer.name)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        updateOrder(activeOrder.id, (order) => ({
          ...order,
          customerId: null,
          customerCode: null,
          customerName: '',
          customerPhone: phone,
          customerTier: null,
          customerTierDiscountPercent: null,
          customerPoints: null,
          pointsToRedeem: '',
        }))
        setActionError('Không tìm thấy thành viên theo số điện thoại.')
        setNewMemberPhone(phone)
        setNewMemberName('')
      } else if (error instanceof ApiError) {
        setActionError(error.message)
      } else {
        setActionError('Không thể tìm khách hàng theo số điện thoại.')
      }
    } finally {
      setSearchingCustomer(false)
    }
  }, [activeOrder, token?.access_token, applyCustomerToOrder, updateOrder])

  const handleCreateMember = useCallback(async () => {
    if (!activeOrder || !token?.access_token) return

    const name = newMemberName.trim()
    const phone = normalizePhone(newMemberPhone || activeOrder.customerPhone)
    if (!name) {
      setActionError('Vui long nhap ten thanh vien.')
      return
    }
    if (!phone) {
      setActionError('Vui long nhap so dien thoai thanh vien.')
      return
    }

    setCreatingCustomer(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const customer = await customerApi.createCustomer(token.access_token, {
        name,
        phone,
        is_active: true,
      })

      let stats = undefined
      try {
        stats = await customerApi.getCustomerStats(token.access_token, customer.id)
      } catch (statsErr) {
        console.warn('Failed to fetch customer stats for new member', statsErr)
      }

      applyCustomerToOrder(activeOrder.id, customer, stats)
      setActionMessage(`Da tao thanh vien ${customer.name}.`)
      setNewMemberPhone(customer.phone)
      setNewMemberName(customer.name)
    } catch (error) {
      if (error instanceof ApiError) setActionError(error.message)
      else setActionError('Không thể thêm thành viên mới.')
    } finally {
      setCreatingCustomer(false)
    }
  }, [activeOrder, token?.access_token, newMemberName, newMemberPhone, applyCustomerToOrder])

  const updateItemField = useCallback(
    (itemId: string, updater: (item: PosOrderItem) => PosOrderItem) => {
      if (!activeOrder) return
      updateOrder(activeOrder.id, (order) => ({
        ...order,
        items: order.items.map((item) => (item.id === itemId ? updater(item) : item)),
      }))
    },
    [activeOrder, updateOrder],
  )

  const removeItem = useCallback(
    (itemId: string) => {
      if (!activeOrder) return
      updateOrder(activeOrder.id, (order) => ({
        ...order,
        items: order.items.filter((item) => item.id !== itemId),
      }))
      if (!sellByLot) {
        void recalculateAutoFillOrder(activeOrder.id)
      }
    },
    [activeOrder, recalculateAutoFillOrder, sellByLot, updateOrder],
  )

  const handleItemQuantityChange = useCallback(
    (itemId: string, rawValue: string) => {
      if (!activeOrder) return
      const item = activeOrder.items.find((row) => row.id === itemId)
      if (!item) return

      const availableInSelectedUnit = Math.floor(
        getItemAvailableBaseQty(item) / Math.max(item.conversion, 1),
      )
      const nextQuantity = parsePositiveInt(rawValue, 0)
      const safeQuantity = Math.min(nextQuantity, Math.max(0, availableInSelectedUnit))

      updateItemField(itemId, (current) => ({
        ...current,
        quantity: rawValue.trim() === '' ? '' : String(safeQuantity),
      }))

      if (!sellByLot) {
        void recalculateAutoFillOrder(activeOrder.id)
      }

      if (!isAutoFillAllocationMode(item.allocationMode) && safeQuantity > 0) {
        void applyItemPolicyCheck(activeOrder.id, itemId, {
          drugId: item.drugId,
          drugCode: item.drugCode,
          batchId: item.batchId,
          batchCode: item.batchCode,
          lotNumber: item.lotNumber,
          quantity: safeQuantity,
          conversion: item.conversion,
        })
      }
    },
    [
      activeOrder,
      applyItemPolicyCheck,
      recalculateAutoFillOrder,
      sellByLot,
      updateItemField,
    ],
  )

  const handleItemUnitChange = useCallback(
    (itemId: string, unitId: string) => {
      if (!activeOrder) return
      const item = activeOrder.items.find((row) => row.id === itemId)
      if (!item) return

      const drug = drugsById.get(item.drugId)
      const nextUnit = drug?.units.find((unit) => unit.id === unitId)
      if (!nextUnit) return

      const currentQty = parsePositiveInt(item.quantity, 0)
      const maxQuantity = Math.floor(
        getItemAvailableBaseQty(item) / Math.max(nextUnit.conversion, 1),
      )
      const safeQuantity = Math.min(currentQty, Math.max(0, maxQuantity))

      updateItemField(itemId, (current) => ({
        ...current,
        unitId: nextUnit.id,
        unitName: nextUnit.name,
        conversion: nextUnit.conversion,
        unitPrice: nextUnit.price,
        quantity: String(safeQuantity),
      }))

      if (!sellByLot) {
        void recalculateAutoFillOrder(activeOrder.id)
      }

      if (!isAutoFillAllocationMode(item.allocationMode) && safeQuantity > 0) {
        void applyItemPolicyCheck(activeOrder.id, itemId, {
          drugId: item.drugId,
          drugCode: item.drugCode,
          batchId: item.batchId,
          batchCode: item.batchCode,
          lotNumber: item.lotNumber,
          quantity: safeQuantity,
          conversion: nextUnit.conversion,
        })
      }
    },
    [
      activeOrder,
      applyItemPolicyCheck,
      drugsById,
      recalculateAutoFillOrder,
      sellByLot,
      updateItemField,
    ],
  )

  const activeOrderLineDetails = useMemo(() => {
    if (!activeOrder) return [] as Array<{
      item: PosOrderItem
      quantity: number
      lineTotal: number
      availableInUnit: number
      isQuantityValid: boolean
      validationMessage: string | null
    }>

    return activeOrder.items.map((item) => {
      const quantity = parsePositiveInt(item.quantity, 0)
      const availableInUnit = Math.floor(
        getItemAvailableBaseQty(item) / Math.max(item.conversion, 1),
      )
      const validationMessage = validateOrderItemQuantityMessage(item, quantity)
      return {
        item,
        quantity,
        lineTotal: quantity * item.unitPrice,
        availableInUnit,
        isQuantityValid: !validationMessage,
        validationMessage,
      }
    })
  }, [activeOrder, validateOrderItemQuantityMessage])

  const subtotal = useMemo(
    () => activeOrderLineDetails.reduce((sum, row) => sum + row.lineTotal, 0),
    [activeOrderLineDetails],
  )

  const serviceFee = useMemo(
    () => parseNonNegativeNumber(activeOrder?.serviceFee ?? '0'),
    [activeOrder?.serviceFee],
  )

  const tierDiscountPercent = activeOrder?.customerTierDiscountPercent || 0
  const isSeparateServiceFee = activeOrder?.serviceFeeMode === 'separate'
  const discountableSubtotal = useMemo(
    () => Math.max(0, subtotal + (isSeparateServiceFee ? 0 : serviceFee)),
    [isSeparateServiceFee, serviceFee, subtotal],
  )
  const tierDiscountAmount = useMemo(() => {
    if (tierDiscountPercent <= 0 || discountableSubtotal <= 0) return 0
    return Math.min(
      discountableSubtotal,
      roundMoneyAmount((discountableSubtotal * tierDiscountPercent) / 100),
    )
  }, [discountableSubtotal, tierDiscountPercent])
  const discountableAmountAfterTier = useMemo(
    () => Math.max(0, discountableSubtotal - tierDiscountAmount),
    [discountableSubtotal, tierDiscountAmount],
  )

  const requestedPointsToRedeem = parsePositiveInt(activeOrder?.pointsToRedeem)
  const availableCustomerPoints = Math.max(0, activeOrder?.customerPoints ?? 0)
  const maxRedeemablePoints = useMemo(() => {
    if (activeOrder?.customerMode !== 'member' || availableCustomerPoints <= 0 || customerPointValue <= 0) {
      return 0
    }
    const maxPointsByAmount = Math.floor(discountableAmountAfterTier / customerPointValue)
    return Math.max(0, Math.min(availableCustomerPoints, maxPointsByAmount))
  }, [
    activeOrder?.customerMode,
    availableCustomerPoints,
    customerPointValue,
    discountableAmountAfterTier,
  ])
  const effectivePointsToRedeem = Math.min(requestedPointsToRedeem, maxRedeemablePoints)
  const pointsToRedeem = effectivePointsToRedeem
  const pointsDiscountAmount = effectivePointsToRedeem * customerPointValue

  const unroundedTotal = useMemo(() => {
    const discountedAmount = Math.max(0, discountableAmountAfterTier - pointsDiscountAmount)
    return discountedAmount + (isSeparateServiceFee ? serviceFee : 0)
  }, [discountableAmountAfterTier, isSeparateServiceFee, pointsDiscountAmount, serviceFee])

  const grandTotal = useMemo(() => {
    if (activeOrder?.paymentMode !== 'cash' || !cashRoundingEnabled) {
      return unroundedTotal
    }
    return roundCashTotalByStep(unroundedTotal, cashRoundingUnit)
  }, [activeOrder?.paymentMode, cashRoundingEnabled, cashRoundingUnit, unroundedTotal])
  const baseRoundingAdjustment = useMemo(
    () => grandTotal - unroundedTotal,
    [grandTotal, unroundedTotal],
  )
  const cashReceived = parseNonNegativeNumber(activeOrder?.cashReceived ?? '0')
  const paymentSummary = useMemo(
    () =>
      applyMinimumDebtThreshold(
        grandTotal,
        cashReceived,
        baseRoundingAdjustment,
      ),
    [grandTotal, cashReceived, baseRoundingAdjustment],
  )
  const displayGrandTotal = paymentSummary.totalAmount
  const displayRoundingAdjustmentAmount = paymentSummary.roundingAdjustmentAmount
  const changeAmount = cashReceived - displayGrandTotal
  const outstandingAmount = paymentSummary.debtAmount
  const roundedCashChangeAmount = useMemo(() => {
    if (activeOrder?.paymentMode !== 'cash') return 0
    return paymentSummary.changeAmount
  }, [activeOrder?.paymentMode, paymentSummary.changeAmount])

  useEffect(() => {
    if (!activeOrder) return
    if (activeOrder.customerMode !== 'member') {
      if (activeOrder.pointsToRedeem !== '') {
        updateOrder(activeOrder.id, (order) => ({ ...order, pointsToRedeem: '' }))
      }
      return
    }

    const rawPointsValue = activeOrder.pointsToRedeem.trim()
    if (!rawPointsValue) return

    const clampedValue = String(effectivePointsToRedeem)
    if (rawPointsValue !== clampedValue) {
      updateOrder(activeOrder.id, (order) => ({ ...order, pointsToRedeem: clampedValue }))
    }
  }, [
    activeOrder,
    effectivePointsToRedeem,
    updateOrder,
  ])

  const customerDisplayPayload = useMemo<CustomerDisplayPayload>(() => {
    const lines = activeOrderLineDetails.map((row) => ({
      id: row.item.id,
      name: row.item.drugName,
      unit: row.item.unitName,
      quantity: row.quantity,
      unitPrice: row.item.unitPrice,
      lineTotal: row.lineTotal,
    }))

    return {
      updatedAt: new Date().toISOString(),
      store: {
        name: storeInfo?.name?.trim() || 'Nhà thuốc',
        phone: storeInfo?.phone?.trim() || '',
        address: storeInfo?.address?.trim() || '',
      },
      settings: {
        showPrice: customerDisplayShowPrice,
        showTotal: customerDisplayShowTotal,
        ads: customerDisplayAds,
        adsIntervalSeconds: customerDisplayAdsIntervalSeconds,
        adsTransition: customerDisplayAdsTransition,
        adsTransitionMs: customerDisplayAdsTransitionMs,
      },
      order: {
        id: activeOrder?.id ?? '',
        customerName: activeOrder?.customerName?.trim() || 'Khách vãng lai',
        itemCount: lines.length,
        subtotal,
        serviceFee,
        total: displayGrandTotal,
        lines,
      },
      paymentQr: bankQrState
        ? {
            active: true,
            amount: bankQrState.amount,
            referenceCode: bankQrState.referenceCode,
            transferContent: bankQrState.transferContent,
            qrDataURL: bankQrState.qrDataURL,
          }
        : null,
    }
  }, [
    activeOrder?.customerName,
    activeOrder?.id,
    activeOrderLineDetails,
    bankQrState,
    customerDisplayAds,
    customerDisplayAdsIntervalSeconds,
    customerDisplayAdsTransition,
    customerDisplayAdsTransitionMs,
    customerDisplayShowPrice,
    customerDisplayShowTotal,
    displayGrandTotal,
    serviceFee,
    storeInfo?.address,
    storeInfo?.name,
    storeInfo?.phone,
    subtotal,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      window.localStorage.setItem(CUSTOMER_DISPLAY_STORAGE_KEY, JSON.stringify(customerDisplayPayload))
    } catch {
      // ignore storage failures on restricted environments
    }
    try {
      customerDisplayChannelRef.current?.postMessage(customerDisplayPayload)
    } catch {
      // ignore channel failures
    }

    if (customerDisplaySyncTimerRef.current !== null) {
      window.clearTimeout(customerDisplaySyncTimerRef.current)
      customerDisplaySyncTimerRef.current = null
    }

    customerDisplaySyncTimerRef.current = window.setTimeout(() => {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (token?.access_token) {
        headers.set('Authorization', `Bearer ${token.access_token}`)
      }

      void fetch(buildUsersApiUrl('/system/customer-display/state'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          screen_id: CUSTOMER_DISPLAY_SCREEN_ID,
          state: customerDisplayPayload,
        }),
      }).catch(() => {
        // fallback to local transport if remote sync unavailable
      })
    }, 200)

    return () => {
      if (customerDisplaySyncTimerRef.current !== null) {
        window.clearTimeout(customerDisplaySyncTimerRef.current)
        customerDisplaySyncTimerRef.current = null
      }
    }
  }, [customerDisplayPayload, token?.access_token])

  const buildCheckoutLines = useCallback(
    (order: PosOrder): CheckoutLine[] => {
      const lineItems = order.items
        .map((item) => {
          const quantity = parsePositiveInt(item.quantity, 0)
          return {
            item,
            quantity,
            lineTotal: quantity * item.unitPrice,
          }
        })
        .filter((row) => row.quantity > 0)

      const surcharges = allocateServiceFee(
        lineItems.map((row) => row.lineTotal),
        parseNonNegativeNumber(order.serviceFee),
        order.serviceFeeMode,
      )

      return lineItems.map((row, index) => {
        const surcharge = surcharges[index] ?? 0
        const adjustedUnitPrice = row.quantity > 0 ? (row.lineTotal + surcharge) / row.quantity : row.item.unitPrice
        return {
          ...row,
          surcharge,
          adjustedUnitPrice,
        }
      })
    },
    [],
  )

  const expandCheckoutLines = useCallback(
    (lines: CheckoutLine[]): ExpandedCheckoutLine[] =>
      lines.flatMap((line) => {
        if (!isAutoFillAllocationMode(line.item.allocationMode)) {
          return [
            {
              item: line.item,
              batchId: line.item.batchId,
              batchCode: line.item.batchCode,
              lotNumber: line.item.lotNumber,
              expDate: line.item.expDate,
              quantity: line.quantity,
              conversion: Math.max(1, line.item.conversion),
              unitId: line.item.unitId,
              unitName: line.item.unitName,
              adjustedUnitPrice: line.adjustedUnitPrice,
            },
          ]
        }

        return line.item.plannedAllocations
          .filter((allocation) => allocation.baseQuantity > 0)
          .map((allocation) => ({
            item: line.item,
            batchId: allocation.batchId,
            batchCode: allocation.batchCode,
            lotNumber: allocation.lotNumber,
            expDate: allocation.expDate,
            quantity: allocation.baseQuantity,
            conversion: 1,
            unitId: line.item.unitId,
            unitName: line.item.unitName,
            adjustedUnitPrice: line.adjustedUnitPrice,
          }))
      }),
    [],
  )

  const findFirstPolicyViolation = useCallback(
    async (order: PosOrder) => {
      for (const item of order.items) {
        const quantity = parsePositiveInt(item.quantity, 0)
        if (quantity <= 0) continue

        const warning = await evaluateLotPolicy({
          drugId: item.drugId,
          drugCode: item.drugCode,
          batchId: item.batchId,
          batchCode: item.batchCode,
          lotNumber: item.lotNumber,
          baseQuantity: quantity * Math.max(item.conversion, 1),
        })

        if (!warning) continue
        if (item.lotPolicyAcknowledged && item.lotPolicyWarning === warning) {
          continue
        }

        if (warning) {
          return { item, warning }
        }
      }
      return null
    },
    [evaluateLotPolicy],
  )

  const handleCheckout = useCallback(async (skipPolicyCheck = false, options?: CheckoutOptions) => {
    if (!activeOrder || !token?.access_token) return false

    setCheckingOut(true)
    setActionError(null)
    setActionMessage(null)

    try {
      let checkoutOrder = activeOrder
      if (!sellByLot && activeOrder.items.some((item) => isAutoFillAllocationMode(item.allocationMode))) {
        const recalculatedOrder = await recalculateAutoFillOrder(activeOrder.id, true)
        checkoutOrder =
          recalculatedOrder ??
          ordersRef.current.find((order) => order.id === activeOrder.id) ??
          activeOrder
      }

      const lines = buildCheckoutLines(checkoutOrder)
      if (!lines.length) {
        throw new ApiError('Don hang chua co thuoc hop le de thanh toan.', 400)
      }

      const invalidStock = lines.find((line) =>
        Boolean(validateOrderItemQuantityMessage(line.item, line.quantity)),
      )
      if (invalidStock) {
        throw new ApiError(
          validateOrderItemQuantityMessage(invalidStock.item, invalidStock.quantity) ||
            `So luong vuot ton kho cua lo ${invalidStock.item.batchCode}.`,
          409,
        )
      }

      const expandedLines = expandCheckoutLines(lines)

      if (sellByLot && !skipPolicyCheck) {
        const violatingFromCache = lines.find((line) => !!line.item.lotPolicyWarning)
        if (
          violatingFromCache?.item.lotPolicyWarning &&
          !violatingFromCache.item.lotPolicyAcknowledged
        ) {
          setLotPolicyConfirm({
            mode: 'checkout',
            orderId: checkoutOrder.id,
            item: violatingFromCache.item,
            message: violatingFromCache.item.lotPolicyWarning,
          })
          return false
        }

        const freshViolation = await findFirstPolicyViolation(checkoutOrder)
        if (freshViolation) {
          updateOrder(checkoutOrder.id, (order) => ({
            ...order,
            items: order.items.map((row) =>
              row.id === freshViolation.item.id
                ? { ...row, lotPolicyWarning: freshViolation.warning }
                : row,
            ),
          }))
          setLotPolicyConfirm({
            mode: 'checkout',
            orderId: checkoutOrder.id,
            item: freshViolation.item,
            message: freshViolation.warning,
          })
          return false
        }
      }

      const checkoutPaymentMethod = options?.paymentMethod ?? 'cash'
      const checkoutTotal = grandTotal
      const baseRoundingAdjustmentAmount = baseRoundingAdjustment
      const amountPaid = options?.amountPaid ?? parseNonNegativeNumber(checkoutOrder.cashReceived)
      const paymentSummary = applyMinimumDebtThreshold(
        checkoutTotal,
        amountPaid,
        baseRoundingAdjustmentAmount,
      )
      const effectiveCheckoutTotal = paymentSummary.totalAmount
      const roundingAdjustmentAmount = paymentSummary.roundingAdjustmentAmount
      const debtAmount = paymentSummary.debtAmount

      if (checkoutOrder.paymentMode === 'cash' && amountPaid < effectiveCheckoutTotal) {
        throw new ApiError('Tiền khách đưa chưa đủ để thanh toán.', 400)
      }
      if (checkoutOrder.customerMode === 'member' && !checkoutOrder.customerId) {
        throw new ApiError('Vui lòng tìm hoặc tạo thành viên trước khi thanh toán.', 400)
      }

      const serviceFeeValue = parseNonNegativeNumber(checkoutOrder.serviceFee)
      const noteParts = [checkoutOrder.note.trim()].filter(Boolean)
      if (serviceFeeValue > 0 && checkoutOrder.serviceFeeMode === 'separate') {
        noteParts.push(`Phí dịch vụ: ${formatCurrency(serviceFeeValue)} (mục riêng)`)
      }
      if (debtAmount > 0) {
        noteParts.push(`Cong no: ${formatCurrency(debtAmount)}`)
      }
      if (checkoutOrder.customerName.trim()) {
        if (checkoutOrder.customerMode === 'member') {
          noteParts.push(
            `Khách thành viên: ${checkoutOrder.customerName.trim()}${checkoutOrder.customerCode ? ` (${checkoutOrder.customerCode})` : ''}${checkoutOrder.customerPhone ? ` - ${checkoutOrder.customerPhone}` : ''}`,
          )
        } else {
          noteParts.push(`Khách vãng lai: ${checkoutOrder.customerName.trim()}`)
        }
      }
      if (options?.noteSuffix?.trim()) {
        noteParts.push(options.noteSuffix.trim())
      }

      const invoice = await saleApi.createInvoice(token.access_token, {
        customer_id:
          checkoutOrder.customerMode === 'member' && checkoutOrder.customerId
            ? checkoutOrder.customerId
            : null,
        payment_method: checkoutPaymentMethod,
        service_fee_amount: serviceFeeValue,
        service_fee_mode: checkoutOrder.serviceFeeMode,
        points_used: effectivePointsToRedeem,
        rounding_adjustment_amount: roundingAdjustmentAmount,
        amount_paid: amountPaid,
        note: noteParts.join(' | ') || null,
        items: expandedLines.map((line) => ({
          // Use product_id as SKU for reserve API to avoid ambiguity when drug codes are duplicated.
          sku: line.item.drugId,
          product_id: line.item.drugId,
          product_code: line.item.drugCode,
          product_name: line.item.drugName,
          unit_id: line.unitId,
          unit_name: line.unitName,
          conversion_rate: Math.max(1, line.conversion),
          batch_id: line.batchId,
          lot_number: line.lotNumber,
          expiry_date: line.expDate || null,
          quantity: line.quantity,
          unit_price: line.adjustedUnitPrice,
          discount_amount: 0,
        })),
      })

      const medicineTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0)
      const previewLines: InvoicePreviewLine[] = expandedLines.map((line) => {
        const lineAmount = line.quantity * line.adjustedUnitPrice
        return {
          name: line.item.drugName,
          unit: line.unitName,
          quantity: line.quantity,
          unitPrice: line.quantity > 0 ? lineAmount / line.quantity : line.item.unitPrice,
          amount: lineAmount,
          lotNumber: line.lotNumber || null,
        }
      })

      if (checkoutOrder.serviceFeeMode === 'separate' && serviceFeeValue > 0) {
        previewLines.push({
          name: 'Phi dich vu',
          unit: 'Lan',
          quantity: 1,
          unitPrice: serviceFeeValue,
          amount: serviceFeeValue,
          isService: true,
        })
      }

      const invoiceAmountPaid = coerceFiniteNumber(invoice.amount_paid, amountPaid)
      const invoiceGrandTotal = coerceFiniteNumber(invoice.total_amount, effectiveCheckoutTotal)
      const invoiceChangeAmount = coerceFiniteNumber(
        invoice.change_amount,
        Math.max(0, invoiceAmountPaid - invoiceGrandTotal),
      )
      const invoiceDebtAmount = Math.max(0, invoiceGrandTotal - invoiceAmountPaid)
      const invoiceRoundingAdjustmentAmount = coerceFiniteNumber(
        invoice.rounding_adjustment_amount,
        roundingAdjustmentAmount,
      )
      const invoiceTierDiscountAmount = coerceFiniteNumber(invoice.tier_discount, tierDiscountAmount)
      const invoicePointsDiscountAmount = coerceFiniteNumber(invoice.points_discount, pointsDiscountAmount)
      const invoicePointsUsed = Math.max(
        0,
        roundMoneyAmount(coerceFiniteNumber(invoice.points_used, effectivePointsToRedeem)),
      )
      const preview: InvoicePreview = {
        id: invoice.id,
        code: invoice.code,
        createdAt: invoice.created_at
          ? new Date(invoice.created_at).toLocaleString('vi-VN')
          : new Date().toLocaleString('vi-VN'),
        storeName: storeInfo?.name?.trim() || 'Nha thuoc',
        storeLogoUrl: resolveAssetUrl(storeInfo?.logo_url),
        storePhone: storeInfo?.phone?.trim() || '',
        storeAddress: storeInfo?.address?.trim() || '',
        cashier: user?.full_name?.trim() || user?.username || 'Nhan vien',
        customerName: checkoutOrder.customerName.trim() || 'Khach vang lai',
        customerPhone: checkoutOrder.customerPhone.trim(),
        note: checkoutOrder.note.trim(),
        paymentMethod: invoice.payment_method === 'debt' ? 'Mua no' : (options?.paymentLabel ?? 'Tien mat'),
        amountPaid: invoiceAmountPaid,
        changeAmount: invoiceChangeAmount,
        debtAmount: invoiceDebtAmount,
        roundingAdjustmentAmount: invoiceRoundingAdjustmentAmount,
        medicineTotal,
        serviceFee: serviceFeeValue,
        grandTotal: invoiceGrandTotal,
        serviceFeeMode: checkoutOrder.serviceFeeMode,
        returnPolicyText,
        tierDiscountAmount: invoiceTierDiscountAmount > 0 ? invoiceTierDiscountAmount : undefined,
        pointsDiscountAmount: invoicePointsDiscountAmount > 0 ? invoicePointsDiscountAmount : undefined,
        pointsUsed: invoicePointsUsed > 0 ? invoicePointsUsed : undefined,
        lines: previewLines,
      }
      setInvoicePreview(preview)
      setInvoicePreviewOpen(true)
      printInvoicePreview(preview)

      updateOrder(checkoutOrder.id, (order) => ({
        ...order,
        customerMode: 'walk_in',
        customerId: null,
        customerCode: null,
        customerName: '',
        customerPhone: '',
        customerTier: null,
        customerTierDiscountPercent: null,
        customerPoints: null,
        pointsToRedeem: '',
        note: '',
        serviceFee: '0',
        paymentMode: 'cash',
        cashReceived: '',
        items: [],
      }))

      setActionMessage(
        `Thanh toan thanh cong ${invoice.code}. Thanh tien: ${formatCurrency(invoiceGrandTotal)}.${invoiceDebtAmount > 0 ? ` Con no: ${formatCurrency(invoiceDebtAmount)}.` : ` Tien thua: ${formatCurrency(invoiceChangeAmount)}.`}`,
      )
      return true
    } catch (error) {
      if (error instanceof ApiError) setActionError(error.message)
      else setActionError('Khong the thanh toan hoa don.')
      return false
    } finally {
      setCheckingOut(false)
    }
  }, [
    activeOrder,
    token?.access_token,
    user,
    storeInfo,
    returnPolicyText,
    buildCheckoutLines,
    expandCheckoutLines,
    grandTotal,
    baseRoundingAdjustment,
    effectivePointsToRedeem,
    updateOrder,
    printInvoicePreview,
    recalculateAutoFillOrder,
    sellByLot,
    findFirstPolicyViolation,
    tierDiscountAmount,
    pointsDiscountAmount,
    validateOrderItemQuantityMessage,
  ])

  const handleGenerateBankQr = useCallback(async () => {
    if (!activeOrder || !token?.access_token) return

    setActionError(null)
    setActionMessage(null)

    if (!activeOrder.items.length) {
      setActionError('Đơn hàng chưa có thuốc để tạo mã QR thanh toán.')
      return
    }
    if (activeOrder.paymentMode === 'debt') {
      setActionError('Không thể tạo QR ngân hàng cho đơn mua nợ.')
      return
    }

    const accountNo = bankQrAccountNo.trim()
    const accountName = bankQrAccountName.trim()
    const acqId = bankQrAcqId.trim()
    if (!accountNo || !accountName || !acqId) {
      const missing: string[] = []
      if (!accountName) missing.push('Tên chủ tài khoản')
      if (!accountNo) missing.push('Số tài khoản')
      if (!acqId) missing.push('Ngân hàng')
      setActionError(
        `Thiếu cấu hình QR ngân hàng: ${missing.join(', ')}. Vui lòng cập nhật trong mục Thông tin cửa hàng.`,
      )
      return
    }

    const amount = Math.round(Math.max(0, grandTotal))
    if (amount <= 0) {
      setActionError('Số tiền thanh toán không hợp lệ để tạo mã QR.')
      return
    }

    const referenceCode = `DH${Date.now()}`
    const transferContent =
      bankQrAddInfoMode === 'custom' && bankQrAddInfoCustom.trim()
        ? bankQrAddInfoCustom.trim()
        : referenceCode
    setGeneratingBankQr(true)
    try {
      const response = await paymentQrApi.generateBankQr(token.access_token, {
        accountNo,
        accountName,
        acqId,
        addInfo: transferContent,
        amount,
      })
      setBankQrState({
        orderId: activeOrder.id,
        referenceCode,
        transferContent,
        amount,
        accountNo,
        accountName,
        acqId,
        qrCode: response.data.qrCode,
        qrDataURL: response.data.qrDataURL,
      })
    } catch (error) {
      if (error instanceof ApiError) setActionError(error.message)
      else setActionError('Không thể tạo QR ngân hàng.')
    } finally {
      setGeneratingBankQr(false)
    }
  }, [
    activeOrder,
    token?.access_token,
    bankQrAccountNo,
    bankQrAccountName,
    bankQrAcqId,
    bankQrAddInfoMode,
    bankQrAddInfoCustom,
    grandTotal,
  ])

  const handleCheckoutByBankQr = useCallback(async () => {
    if (!bankQrState) return
    const noteSuffix =
      bankQrState.transferContent === bankQrState.referenceCode
        ? `Thanh toan QR ngan hang, ma tham chieu: ${bankQrState.referenceCode}`
        : `Thanh toan QR ngan hang, noi dung: ${bankQrState.transferContent} (ma don: ${bankQrState.referenceCode})`
    const success = await handleCheckout(false, {
      paymentMethod: 'bank',
      paymentLabel: 'QR ngan hang',
      amountPaid: bankQrState.amount,
      noteSuffix,
    })
    if (success) {
      setBankQrState(null)
    }
  }, [bankQrState, handleCheckout])

  const policyDescription = sellByLot
    ? (fefoEnabled
        ? `Bán theo lô bật: FEFO khi hạn dùng dưới ${fefoThresholdDays} ngày, còn lại FIFO.`
        : 'Bán theo lô bật: FIFO cho tất cả lô.')
    : (fefoEnabled
        ? `Bán theo lô tắt: hệ thống tự gợi ý xuất kho FEFO/FIFO (ngưỡng ${fefoThresholdDays} ngày).`
        : 'Bán theo lô tắt: hệ thống tự gợi ý xuất kho FIFO.')

  return (
    <div className="space-y-4 sm:space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">POS</p>
        <h2 className="mt-1 text-2xl font-semibold text-ink-900 sm:mt-2 sm:text-3xl">Bán hàng tại quầy</h2>
        <p className="mt-1 hidden text-sm text-ink-600 sm:block">Quét QR số lô, xử lý nhiều khách cùng lúc và thanh toán tiền mặt.</p>
        <p className="mt-1 text-xs text-ink-500 hidden sm:block">Chính sách xuất kho hiện tại: {policyDescription}</p>
      </header>

      <section className="glass-card rounded-2xl p-3 sm:rounded-3xl sm:p-5">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {orders.map((order, index) => (
            <div key={order.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveOrderId(order.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold sm:px-4 sm:py-2 sm:text-sm ${
                  activeOrder?.id === order.id
                    ? 'bg-ink-900 text-white'
                    : 'border border-ink-900/10 bg-white text-ink-900'
                }`}
              >
                Đơn {index + 1}
              </button>
              {orders.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeOrder(order.id)}
                  className="rounded-full border border-coral-500/30 bg-coral-500/10 px-2 py-1 text-xs font-semibold text-coral-500"
                >
                  Xóa
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={addOrder}
            className="rounded-full border border-ink-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 sm:px-4 sm:py-2 sm:text-sm"
          >
            + Thêm
          </button>
        </div>

        {activeOrder ? (
          <div className="mt-3 space-y-2 sm:mt-4 sm:space-y-3">
            <div className="grid gap-2 sm:gap-3 md:grid-cols-[220px,1fr]">
              <label className="space-y-2 text-sm text-ink-700">
                <span>Loại khách</span>
                <select
                  value={activeOrder.customerMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as CustomerMode
                    setShowCreateMemberForm(false)
                    updateActiveOrder((order) => {
                      if (nextMode === 'member') {
                        return {
                          ...order,
                          customerMode: 'member',
                          customerId: null,
                          customerCode: null,
                          customerName: '',
                          customerTier: null,
                          customerTierDiscountPercent: null,
                          customerPoints: null,
                          pointsToRedeem: '',
                        }
                      }

                      return {
                        ...order,
                        customerMode: 'walk_in',
                        customerId: null,
                        customerCode: null,
                        customerName: '',
                        customerPhone: '',
                        customerTier: null,
                        customerTierDiscountPercent: null,
                        customerPoints: null,
                        pointsToRedeem: '',
                      }
                    })
                  }}
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                >
                  <option value="walk_in">Khách vãng lai</option>
                  <option value="member">Khách hàng thân thiết</option>
                </select>
              </label>

              {activeOrder.customerMode === 'walk_in' ? (
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên khách</span>
                  <input
                    value={activeOrder.customerName}
                    onChange={(event) =>
                      updateActiveOrder((order) => ({ ...order, customerName: event.target.value }))
                    }
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                    placeholder="Khách vãng lai"
                  />
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-[1fr,auto]">
                  <label className="space-y-2 text-sm text-ink-700">
                    <span>So dien thoai thanh vien</span>
                    <input
                      value={activeOrder.customerPhone}
                      onChange={(event) => {
                        const phone = normalizePhone(event.target.value)
                        setShowCreateMemberForm(false)
                        updateActiveOrder((order) => ({
                          ...order,
                          customerPhone: phone,
                          customerId: null,
                          customerCode: null,
                          customerName: '',
                          customerTier: null,
                          customerTierDiscountPercent: null,
                          customerPoints: null,
                          pointsToRedeem: '',
                        }))
                        setNewMemberPhone(phone)
                      }}
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                      placeholder="Nhap so dien thoai"
                    />
                  </label>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void handleLookupCustomerByPhone()
                      }}
                      disabled={searchingCustomer}
                      className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
                    >
                      {searchingCustomer ? 'Đang tìm...' : 'Tim thanh vien'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewMemberName('')
                        setNewMemberPhone(activeOrder.customerPhone)
                        setShowCreateMemberForm(true)
                      }}
                      className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
                    >
                      + Thêm khách hàng
                    </button>
                  </div>
                </div>
              )}
            </div>

            {activeOrder.customerMode === 'member' ? (
              <div className="rounded-2xl border border-ink-900/10 bg-white/80 p-4">
                {activeOrder.customerId ? (
                  <div className="rounded-xl border border-brand-500/20 bg-brand-500/5 px-3 py-2 text-sm text-ink-700">
                    <p className="font-semibold text-ink-900">{activeOrder.customerName}</p>
                    <p className="text-xs text-ink-600">
                      Diem tich luy: {(activeOrder.customerPoints ?? 0).toLocaleString('vi-VN')}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-600">
                    Chưa có thành viên. Tìm theo số điện thoại hoặc thêm nhanh khách hàng mới.
                  </p>
                )}
              </div>
            ) : null}

            <label className="space-y-2 text-sm text-ink-700">
              <span>Ghi chú đơn</span>
              <input
                value={activeOrder.note}
                onChange={(event) => updateActiveOrder((order) => ({ ...order, note: event.target.value }))}
                className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                placeholder="Ghi chú thêm"
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="grid gap-3 sm:gap-4 xl:grid-cols-[1.7fr,1fr]">
        <article className="glass-card rounded-2xl p-3 sm:rounded-3xl sm:p-5">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
              <input
                value={lotScanInput}
                onChange={(event) => setLotScanInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (lotScanInput.trim()) {
                      void handleAddByLotQr()
                      return
                    }
                    setScanError(null)
                    setScanMessage('Đang khởi tạo camera...')
                    setScanOpen(true)
                  }
                }}
                className="min-w-0 flex-1 rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-sm sm:min-w-[180px] sm:rounded-2xl sm:px-4 sm:py-2"
                placeholder={
                  sellByLot
                    ? 'Quét QR số lô hoặc nhập mã lô'
                    : 'Quét QR/mã vạch hoặc nhập mã lô/barcode'
                }
              />
              <button
                type="button"
                onClick={() => {
                  if (lotScanInput.trim()) {
                    void handleAddByLotQr()
                    return
                  }
                  setScanError(null)
                  setScanMessage('Đang khởi tạo camera...')
                  setScanOpen(true)
                }}
                disabled={addingByQr || !activeOrder}
                className="shrink-0 rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 disabled:opacity-60 sm:rounded-2xl sm:px-4 sm:py-2 sm:text-sm"
              >
                {addingByQr
                  ? 'Đang xử lý...'
                  : lotScanInput.trim()
                    ? (sellByLot ? 'Thêm theo mã lô' : 'Thêm theo mã quét')
                    : (sellByLot ? 'Bật cam quét QR' : 'Bật cam quét QR/Barcode')}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                void loadPosData()
              }}
              className="shrink-0 rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 sm:rounded-2xl sm:px-4 sm:py-2 sm:text-sm"
            >
              <span className="sm:hidden">Tải lại</span>
              <span className="hidden sm:inline">Tải lại dữ liệu</span>
            </button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:mt-3 sm:gap-3 md:grid-cols-2 2xl:grid-cols-[minmax(0,1.7fr),minmax(0,1fr),120px,160px,auto]">
            <div className="col-span-2 space-y-1 min-w-0 2xl:col-span-1">
              <input
                value={drugSearch}
                onChange={(event) => {
                  const nextValue = event.target.value
                  setDrugSearch(nextValue)

                  const pickedDrug = findDrugByExactSearch(nextValue)
                  if (pickedDrug) setSelectedDrugId(pickedDrug.id)
                }}
                onBlur={() => {
                  const pickedDrug = findDrugByExactSearch(drugSearch) ?? resolveDrugFromSearch(drugSearch)
                  if (!pickedDrug) return

                  setSelectedDrugId(pickedDrug.id)
                  setDrugSearch(buildDrugSearchLabel(pickedDrug))
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()

                  const pickedDrug =
                    findDrugByExactSearch(drugSearch) ??
                    resolveDrugFromSearch(drugSearch) ??
                    filteredDrugs[0] ??
                    null
                  if (!pickedDrug) return

                  setSelectedDrugId(pickedDrug.id)
                  setDrugSearch(buildDrugSearchLabel(pickedDrug))
                }}
                list="pos-drug-suggestions"
                className="w-full min-w-0 rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-sm sm:rounded-2xl sm:px-4 sm:py-2"
                placeholder="Tìm và chọn thuốc (mã/tên)"
              />
              <datalist id="pos-drug-suggestions">
                {filteredDrugs.slice(0, 30).map((drug) => (
                  <option key={drug.id} value={`${drug.code} - ${drug.name}`} />
                ))}
              </datalist>
            </div>

            <select
              value={selectedUnitId}
              onChange={(event) => setSelectedUnitId(event.target.value)}
              className="w-full min-w-0 rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-sm sm:rounded-2xl sm:px-4 sm:py-2"
              disabled={!selectedDrug}
            >
              {(selectedDrug?.units ?? []).map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} - {unitRoleLabel(unit.role)}
                </option>
              ))}
            </select>

            <input
              value={selectedQuantity}
              onChange={(event) => setSelectedQuantity(event.target.value)}
              className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-sm sm:rounded-2xl sm:px-4 sm:py-2"
              placeholder="SL"
            />

            <input
              value={selectedUnit ? formatCurrency(selectedUnit.price) : ''}
              readOnly
              className="hidden w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-1.5 text-sm text-ink-500 sm:block sm:rounded-2xl sm:px-4 sm:py-2"
              placeholder="Giá đơn vị"
              title="Giá đơn vị tham khảo"
            />

            <button
              type="button"
              onClick={() => {
                void handleAddByDrug()
              }}
              disabled={addingByDrug || !activeOrder || !selectedDrug || !selectedUnit || selectedDrugOutOfStock}
              className="rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 disabled:opacity-60 col-span-2 sm:rounded-2xl sm:px-4 sm:py-2 sm:text-sm md:col-span-2 2xl:col-span-1"
            >
              {addingByDrug ? 'Đang thêm...' : 'Thêm theo gợi ý'}
            </button>
          </div>

          {loading ? <p className="mt-3 text-sm text-ink-600">Đang tải danh mục thuốc...</p> : null}
          {loadError ? <p className="mt-3 text-sm text-coral-500">{loadError}</p> : null}
          {!loading && !loadError && !availableDrugs.length ? (
            <p className="mt-3 text-sm text-amber-700">
              Chưa có thuốc còn tồn kho để bán. Vui lòng nhập hàng trước khi tạo đơn.
            </p>
          ) : null}
          {!loading && !loadError && selectedDrug ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-ink-600">
                Tồn khả dụng: {Math.max(0, selectedDrug.totalQty).toLocaleString('vi-VN')} đơn vị gốc.
              </p>
              {selectedDrug.instructions ? (
                <p className="text-xs text-ink-600">
                  <span className="font-semibold text-ink-800">HDSD:</span> {selectedDrug.instructions}
                </p>
              ) : null}
            </div>
          ) : null}
          {!loading && !loadError && selectedDrugOutOfStock ? (
            <p className="mt-1 text-xs text-coral-500">
              Thuốc này hiện hết tồn kho, không thể thêm vào đơn.
            </p>
          ) : null}

          <div className="mt-3 space-y-2 sm:space-y-3">
            {!activeOrder?.items.length ? (
              <p className="rounded-2xl border border-dashed border-ink-900/20 bg-white/70 px-4 py-6 text-sm text-ink-600">
                Chưa có mặt hàng trong đơn này.
              </p>
            ) : null}

            {activeOrder?.items.map((item) => {
              const drug = drugsById.get(item.drugId)
              const availableInUnit = Math.floor(
                getItemAvailableBaseQty(item) / Math.max(item.conversion, 1),
              )
              const unitRefPrice =
                drug?.units.find((unit) => unit.id === item.unitId)?.price ?? item.unitPrice
              const quantity = parsePositiveInt(item.quantity, 0)
              const lineTotal = quantity * item.unitPrice
              const quantityValidationMessage = validateOrderItemQuantityMessage(item, quantity)
              const quantityInvalid = Boolean(quantityValidationMessage)
              const autoFillDescription = buildAutoFillPolicyLabel(fefoEnabled, fefoThresholdDays)
              const allocationSummary = item.plannedAllocations
                .map((allocation) => `${allocation.batchCode} (${allocation.baseQuantity.toLocaleString('vi-VN')})`)
                .join(' · ')

              return (
                <div key={item.id} className="rounded-xl border border-ink-900/10 bg-white p-2.5 sm:rounded-2xl sm:p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-ink-900">{item.drugName}</p>
                      <p className="text-xs text-ink-600">
                        {isAutoFillAllocationMode(item.allocationMode)
                          ? `${item.drugCode} · ${autoFillDescription}`
                          : `${item.drugCode} · Lô ${item.batchCode} · HSD ${item.expDate || '-'}`}
                      </p>
                      {isAutoFillAllocationMode(item.allocationMode) && allocationSummary ? (
                        <p className="mt-1 text-xs text-ink-500">Dự kiến xuất: {allocationSummary}</p>
                      ) : null}
                      {drug?.instructions ? (
                        <p className="mt-1 text-xs text-ink-600">
                          <span className="font-semibold text-ink-800">HDSD:</span> {drug.instructions}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                    >
                      Xóa
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 sm:mt-3 sm:gap-3 md:grid-cols-5">
                    <label className="space-y-1 text-xs text-ink-600">
                      Đơn vị
                      <select
                        value={item.unitId}
                        onChange={(event) => handleItemUnitChange(item.id, event.target.value)}
                        className="w-full rounded-lg border border-ink-900/10 bg-white px-2 py-1.5 text-sm text-ink-900 sm:rounded-xl sm:px-3 sm:py-2"
                      >
                        {(drug?.units ?? []).map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.name} ({unitRoleLabel(unit.role)})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-xs text-ink-600">
                      Số lượng
                      <input
                        value={item.quantity}
                        onChange={(event) => handleItemQuantityChange(item.id, event.target.value)}
                        className="w-full rounded-lg border border-ink-900/10 bg-white px-2 py-1.5 text-sm text-ink-900 sm:rounded-xl sm:px-3 sm:py-2"
                      />
                    </label>

                    <label className="hidden space-y-1 text-xs text-ink-600 sm:block">
                      Giá tham khảo
                      <input
                        value={formatCurrency(unitRefPrice)}
                        readOnly
                        className="w-full rounded-xl border border-ink-900/10 bg-white/70 px-3 py-2 text-sm text-ink-500"
                      />
                    </label>

                    <label className="space-y-1 text-xs text-ink-600">
                      Giá bán
                      <input
                        value={String(item.unitPrice)}
                        onChange={(event) => {
                          const nextPrice = parseNonNegativeNumber(event.target.value)
                          updateItemField(item.id, (current) => ({ ...current, unitPrice: nextPrice }))
                        }}
                        className="w-full rounded-lg border border-ink-900/10 bg-white px-2 py-1.5 text-sm text-ink-900 sm:rounded-xl sm:px-3 sm:py-2"
                      />
                    </label>

                    <div className="space-y-1 text-xs text-ink-600">
                      <p>Tạm tính</p>
                      <p className="rounded-lg border border-ink-900/10 bg-fog-50 px-2 py-1.5 text-sm font-semibold text-ink-900 sm:rounded-xl sm:px-3 sm:py-2">
                        {formatCurrency(lineTotal)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-600 sm:mt-2 sm:gap-3">
                    <span>
                      {isAutoFillAllocationMode(item.allocationMode) ? 'Tồn khả dụng' : 'Tồn'}:{' '}
                      {availableInUnit.toLocaleString('vi-VN')} {item.unitName}
                    </span>
                    <span>({getItemAvailableBaseQty(item).toLocaleString('vi-VN')} đơn vị gốc)</span>
                  </div>

                  {quantityInvalid ? (
                    <p className="mt-2 text-xs text-coral-500">{quantityValidationMessage}</p>
                  ) : null}
                  {!quantityInvalid && isAutoFillAllocationMode(item.allocationMode) && item.allocationWarning ? (
                    <p className="mt-2 text-xs text-amber-700">{item.allocationWarning}</p>
                  ) : null}
                  {sellByLot && item.lotPolicyWarning ? (
                    <p className="mt-2 text-xs text-amber-700">{item.lotPolicyWarning}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </article>

        <aside className="glass-card rounded-2xl p-3 sm:rounded-3xl sm:p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Thanh toán</p>
          <h3 className="mt-1 text-xl font-semibold text-ink-900 sm:mt-2 sm:text-2xl">Đơn đang chọn</h3>

          {activeOrder ? (
            <div className="mt-3 space-y-2 sm:mt-4 sm:space-y-3">
              <label className="space-y-2 text-sm text-ink-700">
                <span>Phí dịch vụ</span>
                <input
                  value={activeOrder.serviceFee}
                  onChange={(event) =>
                    updateActiveOrder((order) => ({ ...order, serviceFee: event.target.value }))
                  }
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                  placeholder="0"
                />
              </label>

              {activeOrder.customerMode === 'member' && activeOrder.customerPoints !== null && activeOrder.customerPoints > 0 ? (
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Sử dụng điểm (Tối đa: {activeOrder.customerPoints.toLocaleString('vi-VN')})</span>
                  <input
                    type="number"
                    min="0"
                    max={maxRedeemablePoints}
                    value={activeOrder.pointsToRedeem}
                    onChange={(event) => {
                      let nextVal = event.target.value
                      const parsed = parseInt(nextVal, 10)
                      if (!isNaN(parsed)) {
                        if (parsed < 0) nextVal = '0'
                        if (parsed > maxRedeemablePoints) {
                          nextVal = String(maxRedeemablePoints)
                        }
                      }
                      updateActiveOrder((order) => ({ ...order, pointsToRedeem: nextVal }))
                    }}
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                    placeholder="0"
                  />
                  <p className="text-xs text-ink-500">
                    1 diem = {customerPointValue.toLocaleString('vi-VN')}d. Co the ap toi da {maxRedeemablePoints.toLocaleString('vi-VN')} diem cho don nay.
                  </p>
                  <p className="text-xs text-ink-500">1 điểm = {customerPointValue.toLocaleString('vi-VN')}đ</p>
                </label>
              ) : null}

              <label className="space-y-2 text-sm text-ink-700">
                <span>Cách tính phí dịch vụ</span>
                <select
                  value={activeOrder.serviceFeeMode}
                  onChange={(event) =>
                    updateActiveOrder((order) => ({
                      ...order,
                      serviceFeeMode: event.target.value as ServiceFeeMode,
                    }))
                  }
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                >
                  <option value="split">Chia đều vào các dòng thuốc</option>
                  <option value="separate">Mục riêng trong hóa đơn</option>
                </select>
              </label>

              <div className="rounded-xl border border-ink-900/10 bg-white p-3 text-sm text-ink-700 sm:rounded-2xl sm:p-4">
                <div className="flex items-center justify-between py-1">
                  <span>Tam tinh thuoc</span>
                  <span className="font-semibold text-ink-900">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span>Phi dich vu</span>
                  <span className="font-semibold text-ink-900">{formatCurrency(serviceFee)}</span>
                </div>
                {tierDiscountAmount > 0 ? (
                  <div className="flex items-center justify-between py-1 text-emerald-600">
                    <span>
                      Chiết khấu hạng thẻ {activeOrder.customerTier ? `(${activeOrder.customerTier})` : ''}
                    </span>
                    <span className="font-semibold">-{formatCurrency(tierDiscountAmount)}</span>
                  </div>
                ) : null}
                {pointsDiscountAmount > 0 ? (
                  <div className="flex items-center justify-between py-1 text-emerald-600">
                    <span>Trừ điểm ({pointsToRedeem} điểm)</span>
                    <span className="font-semibold">-{formatCurrency(pointsDiscountAmount)}</span>
                  </div>
                ) : null}
                {displayRoundingAdjustmentAmount !== 0 ? (
                  <div className="flex items-center justify-between py-1">
                    <span>Điều chỉnh làm tròn</span>
                    <span className="font-semibold text-ink-900">{formatCurrency(displayRoundingAdjustmentAmount)}</span>
                  </div>
                ) : null}
                <div className="mt-2 flex items-center justify-between border-t border-ink-900/10 pt-2">
                  <span className="font-semibold">Thanh tien</span>
                  <span className="text-lg font-semibold text-ink-900">{formatCurrency(displayGrandTotal)}</span>
                </div>
              </div>

              <label className="space-y-2 text-sm text-ink-700">
                <span>Hình thức thanh toán</span>
                <select
                  value={activeOrder.paymentMode}
                  onChange={(event) =>
                    updateActiveOrder((order) => ({
                      ...order,
                      paymentMode: event.target.value as PaymentMode,
                    }))
                  }
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                >
                  <option value="cash">Tiền mặt</option>
                  <option value="debt">Mua nợ</option>
                </select>
              </label>

              <label className="space-y-2 text-sm text-ink-700">
                <span>{activeOrder.paymentMode === 'debt' ? 'Đã thanh toán trước' : 'Khách đưa'}</span>
                <input
                  value={activeOrder.cashReceived}
                  onChange={(event) =>
                    updateActiveOrder((order) => ({ ...order, cashReceived: event.target.value }))
                  }
                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-1.5 sm:rounded-2xl sm:px-4 sm:py-2"
                  placeholder="0"
                />
              </label>

              <div className="rounded-xl border border-ink-900/10 bg-white p-3 sm:rounded-2xl sm:p-4">
                <p className="text-sm text-ink-600">
                  {activeOrder.paymentMode === 'debt' ? 'Con no' : 'Tien tra lai'}
                </p>
                <p
                  className={`mt-1 text-2xl font-semibold ${
                    activeOrder.paymentMode === 'cash' && changeAmount < 0 ? 'text-coral-500' : 'text-ink-900'
                  }`}
                >
                  {formatCurrency(activeOrder.paymentMode === 'debt' ? outstandingAmount : roundedCashChangeAmount)}
                </p>
                {activeOrder.paymentMode === 'cash' && changeAmount < 0 ? (
                  <p className="mt-1 text-xs text-coral-500">Khách đưa chua du tien.</p>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleCheckout()
                }}
                disabled={checkingOut || !activeOrder.items.length || (activeOrder.paymentMode === 'cash' && changeAmount < 0)}
                className="w-full rounded-xl bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:rounded-2xl sm:py-3"
              >
                {checkingOut
                  ? 'Đang thanh toán...'
                  : activeOrder.paymentMode === 'debt'
                    ? 'Chốt mua nợ'
                    : 'Thanh toán tiền mặt'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleGenerateBankQr()
                }}
                disabled={
                  generatingBankQr ||
                  checkingOut ||
                  !activeOrder.items.length ||
                  activeOrder.paymentMode === 'debt'
                }
                className="w-full rounded-xl border border-ink-900/10 bg-white px-4 py-2.5 text-sm font-semibold text-ink-900 disabled:opacity-60 sm:rounded-2xl sm:py-3"
              >
                {generatingBankQr ? 'Đang tạo QR ngân hàng...' : 'Thanh toán QR ngân hàng'}
              </button>
            </div>
          ) : null}
        </aside>
      </section>

      {bankQrState ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-lg max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">QR ngân hàng</p>
                <h3 className="mt-2 text-xl font-semibold text-ink-900">
                  Thanh toán {formatCurrency(bankQrState.amount)}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setBankQrState(null)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-ink-900/10 bg-white p-4">
                <img
                  src={bankQrState.qrDataURL}
                  alt="QR thanh toán ngân hàng"
                  className="mx-auto h-64 w-64 max-w-full object-contain"
                />
              </div>

              <div className="mt-4 space-y-2 text-sm text-ink-700">
                <p>
                  <span className="font-semibold text-ink-900">Số tài khoản:</span> {bankQrState.accountNo}
                </p>
                <p>
                  <span className="font-semibold text-ink-900">Tên tài khoản:</span> {bankQrState.accountName}
                </p>
                <p>
                  <span className="font-semibold text-ink-900">Mã tham chiếu:</span> {bankQrState.referenceCode}
                </p>
                <p>
                  <span className="font-semibold text-ink-900">Nội dung chuyển khoản:</span> {bankQrState.transferContent}
                </p>
                <p>
                  <span className="font-semibold text-ink-900">Số tiền:</span> {formatCurrency(bankQrState.amount)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  void handleCheckoutByBankQr()
                }}
                disabled={checkingOut}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {checkingOut ? 'Đang xử lý...' : 'Đã nhận tiền, hoàn tất hóa đơn'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleGenerateBankQr()
                }}
                disabled={generatingBankQr}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
              >
                {generatingBankQr ? 'Đang tạo lại QR...' : 'Tạo lại mã QR'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {invoicePreviewOpen && invoicePreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">Hóa đơn</p>
                <h3 className="mt-2 text-xl font-semibold text-ink-900">{invoicePreview.code}</h3>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => printInvoicePreview(invoicePreview)}
                  className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  In hóa đơn
                </button>
                <button
                  type="button"
                  onClick={() => setInvoicePreviewOpen(false)}
                  className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
                >
                  Đóng
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-ink-900/10 bg-white/80 p-4 text-sm text-ink-700">
                <div className="flex items-center gap-3">
                  {invoicePreview.storeLogoUrl ? (
                    <img
                      src={invoicePreview.storeLogoUrl}
                      alt="Store logo"
                      className="h-12 w-12 rounded-lg border border-ink-900/10 bg-white object-contain p-1"
                    />
                  ) : null}
                  <div>
                    <p className="text-base font-semibold text-ink-900">{invoicePreview.storeName || 'Nhà thuốc'}</p>
                    {invoicePreview.storePhone ? <p className="mt-1">SDT: {invoicePreview.storePhone}</p> : null}
                    {invoicePreview.storeAddress ? <p className="mt-1">Địa chỉ: {invoicePreview.storeAddress}</p> : null}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 text-sm text-ink-700 md:grid-cols-2">
                <p><span className="font-semibold text-ink-900">Ngày:</span> {invoicePreview.createdAt}</p>
                <p><span className="font-semibold text-ink-900">Thu ngân:</span> {invoicePreview.cashier || '-'}</p>
                <p><span className="font-semibold text-ink-900">Khách hàng:</span> {invoicePreview.customerName || 'Khách vãng lai'}</p>
                <p><span className="font-semibold text-ink-900">SDT:</span> {invoicePreview.customerPhone || '-'}</p>
              </div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-ink-900/10">
                <table className="w-full text-left text-sm">
                  <thead className="bg-fog-50 text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Mặt hàng</th>
                      <th className="px-4 py-3">Đơn vị</th>
                      <th className="px-4 py-3 text-right">SL</th>
                      <th className="px-4 py-3 text-right">Đơn giá</th>
                      <th className="px-4 py-3 text-right">Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/10">
                    {invoicePreview.lines.map((line, index) => (
                      <tr key={`${line.name}-${index}`}>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink-900">{line.name}</p>
                          {line.lotNumber ? <p className="text-xs text-ink-500">Lô: {line.lotNumber}</p> : null}
                          {line.isService ? <p className="text-xs text-ink-500">Mục dịch vụ riêng</p> : null}
                        </td>
                        <td className="px-4 py-3 text-ink-700">{line.unit}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{line.quantity.toLocaleString('vi-VN')}</td>
                        <td className="px-4 py-3 text-right text-ink-700">{formatCurrency(line.unitPrice)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-ink-900">{formatCurrency(line.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 ml-auto w-full max-w-sm space-y-2 text-sm text-ink-700">
                {invoicePreview.serviceFeeMode === 'separate' && invoicePreview.serviceFee > 0 ? (
                  <div className="flex items-center justify-between">
                    <span>Phí dịch vụ</span>
                    <span className="font-semibold text-ink-900">{formatCurrency(invoicePreview.serviceFee)}</span>
                  </div>
                ) : null}
                {invoicePreview.tierDiscountAmount ? (
                  <div className="flex items-center justify-between text-emerald-600">
                    <span>Chiết khấu hạng thẻ</span>
                    <span className="font-semibold">-{formatCurrency(invoicePreview.tierDiscountAmount)}</span>
                  </div>
                ) : null}
                {invoicePreview.pointsDiscountAmount ? (
                  <div className="flex items-center justify-between text-emerald-600">
                    <span>Điểm thưởng (-{invoicePreview.pointsUsed} điểm)</span>
                    <span className="font-semibold">-{formatCurrency(invoicePreview.pointsDiscountAmount)}</span>
                  </div>
                ) : null}
                {invoicePreview.roundingAdjustmentAmount !== 0 ? (
                  <div className="flex items-center justify-between">
                    <span>Điều chỉnh làm tròn</span>
                    <span className="font-semibold text-ink-900">{formatCurrency(invoicePreview.roundingAdjustmentAmount)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between border-t border-ink-900/10 pt-2">
                  <span className="font-semibold">Tổng thanh toán</span>
                  <span className="text-lg font-semibold text-ink-900">{formatCurrency(invoicePreview.grandTotal)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Khách đưa</span>
                  <span className="font-semibold text-ink-900">{formatCurrency(invoicePreview.amountPaid)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Tiền thừa</span>
                  <span className="font-semibold text-ink-900">{formatCurrency(Math.max(0, invoicePreview.changeAmount))}</span>
                </div>
                {invoicePreview.debtAmount > 0 ? (
                  <div className="flex items-center justify-between text-coral-500">
                    <span>Còn nợ</span>
                    <span className="font-semibold">{formatCurrency(invoicePreview.debtAmount)}</span>
                  </div>
                ) : null}
              </div>
              {invoicePreview.returnPolicyText ? (
                <p className="mt-3 text-xs text-ink-600">{invoicePreview.returnPolicyText}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {lotPolicyConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="w-full max-w-xl rounded-3xl bg-white shadow-lift">
            <div className="border-b border-ink-900/10 px-6 py-5">
              <p className="text-xs uppercase tracking-[0.3em] text-ink-600">Cảnh báo xuất kho</p>
              <h3 className="mt-2 text-xl font-semibold text-ink-900">Lô chưa theo FIFO/FEFO</h3>
            </div>
            <div className="space-y-3 px-6 py-5 text-sm text-ink-700">
              <p>
                <span className="font-semibold text-ink-900">Thuốc:</span> {lotPolicyConfirm.item.drugName}
              </p>
              <p>
                <span className="font-semibold text-ink-900">Lô:</span> {lotPolicyConfirm.item.batchCode || lotPolicyConfirm.item.lotNumber}
              </p>
              <p className="rounded-xl border border-amber-400/40 bg-amber-50 px-3 py-2 text-amber-700">
                {lotPolicyConfirm.message}
              </p>
              <p className="text-xs text-ink-500">
                Bạn có thể giữ lô vừa chọn hoặc xóa khỏi danh sách để chọn lô khác.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => setLotPolicyConfirm(null)}
                className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = lotPolicyConfirm
                  setLotPolicyConfirm(null)

                  if (pending.mode === 'add') {
                    setActionMessage(`Đã bỏ lô ${pending.item.batchCode} khỏi danh sách.`)
                    return
                  }

                  updateOrder(pending.orderId, (order) => ({
                    ...order,
                    items: order.items.filter((item) => item.id !== pending.item.id),
                  }))
                  setActionMessage(`Đã xóa lô ${pending.item.batchCode} để chọn lô khác.`)
                }}
                className="rounded-full border border-coral-500/30 bg-coral-500/10 px-4 py-2 text-sm font-semibold text-coral-500"
              >
                Xóa lô này
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = lotPolicyConfirm
                  setLotPolicyConfirm(null)

                  if (pending.mode === 'add') {
                    addItemToOrder(pending.orderId, {
                      ...pending.item,
                      lotPolicyWarning: pending.message,
                      lotPolicyAcknowledged: true,
                    })
                    setActionMessage(`Đã giữ lô ${pending.item.batchCode} trong đơn hàng.`)
                    return
                  }

                  updateOrder(pending.orderId, (order) => ({
                    ...order,
                    items: order.items.map((item) =>
                      item.id === pending.item.id
                        ? {
                            ...item,
                            lotPolicyWarning: pending.message,
                            lotPolicyAcknowledged: true,
                          }
                        : item,
                    ),
                  }))
                  void handleCheckout(true)
                }}
                className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
              >
                Giữ lô này
              </button>
            </div>
          </div>
        </div>
      ) : null}


      {scanOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-xl max-h-[85vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {sellByLot ? 'Quét QR lô' : 'Quét QR / Barcode'}
                </p>
                <h3 className="mt-2 text-xl font-semibold text-ink-900">
                  {sellByLot ? 'Đưa QR vào khung' : 'Đưa mã vào khung'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setScanOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Tắt camera
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {cameraDevices.length > 0 ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-ink-700">
                  <label className="text-xs uppercase tracking-[0.25em] text-ink-500">Camera</label>
                  <select
                    value={selectedCameraId || cameraDevices[0]?.id || ''}
                    onChange={(event) => {
                      setScanError(null)
                      setScanMessage('Đang chuyển camera...')
                      setSelectedCameraId(event.target.value)
                    }}
                    className="rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  >
                    {cameraDevices.map((camera) => (
                      <option key={camera.id} value={camera.id}>
                        {camera.label || 'Camera'}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="relative overflow-hidden rounded-2xl bg-ink-900">
                <div id={POS_QR_SCANNER_ID} ref={scanContainerRef} className="h-72 w-full" />
              </div>

              {scanError ? (
                <p className="mt-3 text-sm text-coral-500">{scanError}</p>
              ) : (
                <p className="mt-3 text-sm text-ink-700">{scanMessage}</p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showCreateMemberForm && activeOrder?.customerMode === 'member' ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Khách hàng</p>
                <h3 className="mt-1 text-xl font-semibold text-ink-900">Thêm khách hàng mới</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateMemberForm(false)}
                className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Dong
              </button>
            </div>

            <div className="space-y-3 px-6 py-5">
              <label className="space-y-1 text-sm text-ink-700">
                <span>Ten thanh vien</span>
                <input
                  value={newMemberName}
                  onChange={(event) => setNewMemberName(event.target.value)}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  placeholder="Nguyen Van A"
                />
              </label>
              <label className="space-y-1 text-sm text-ink-700">
                <span>So dien thoai</span>
                <input
                  value={newMemberPhone}
                  onChange={(event) => setNewMemberPhone(normalizePhone(event.target.value))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  placeholder="0901234567"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowCreateMemberForm(false)}
                className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCreateMember()
                }}
                disabled={creatingCustomer}
                className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {creatingCustomer ? 'Đang thêm...' : 'Xác nhận thêm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-coral-500">{actionError}</div>
      ) : null}
      {actionMessage ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-brand-600">{actionMessage}</div>
      ) : null}
    </div>
  )
}
