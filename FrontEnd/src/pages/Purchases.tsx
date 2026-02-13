import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Quagga from '@ericblade/quagga2'
import QRCode from 'qrcode'

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
type ShippingCarrier = 'GHN' | 'J&T'
type PromoType = 'none' | 'buy_x_get_y' | 'discount_percent'

type LineRetailPrice = {
  unitId: string
  unitName: string
  conversion: number
  price: string
}

type LineItemForm = {
  id: string
  batchCode: string
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
}

type ScanTarget = { type: 'line'; id: string }

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

const buildLineRetailPrices = (drugId: string, existing?: LineRetailPrice[]) => {
  const drug = drugCatalog.find((item) => item.id === drugId)
  if (!drug) return []
  const sortedUnits = drug.units.slice().sort((a, b) => b.conversion - a.conversion)
  const existingMap = new Map((existing ?? []).map((item) => [item.unitId, item.price]))
  return sortedUnits.map((unit) => ({
    unitId: unit.id,
    unitName: unit.name,
    conversion: unit.conversion,
    price:
      existingMap.get(unit.id) ??
      defaultRetailPricesByDrug[drugId]?.[unit.id] ??
      '',
  }))
}

const initialOrders: PurchaseOrder[] = [
  {
    id: 'po-1',
    code: 'PN20260205001',
    date: '2026-02-05',
    supplierId: 's1',
    shippingCarrier: 'GHN',
    note: 'Đã đối chiếu công nợ.',
    paymentStatus: 'Đã thanh toán',
    paymentMethod: 'Ngân hàng',
    createdAt: Date.now() - 1000 * 60 * 60 * 3,
    lines: [
      {
        id: 'l1',
        batchCode: 'LO20260205001',
        drugId: 'd1',
        lotNumber: 'L0205A',
        quantity: '240',
        mfgDate: '2025-11-15',
        expDate: '2027-11-15',
        price: '245000',
        promoType: 'buy_x_get_y',
        promoBuyQty: '10',
        promoGetQty: '1',
        promoDiscountPercent: '',
        barcode: '8936012345003',
        unitRetailPrices: buildLineRetailPrices('d1'),
      },
      {
        id: 'l2',
        batchCode: 'LO20260205002',
        drugId: 'd2',
        lotNumber: 'L0205C',
        quantity: '90',
        mfgDate: '2025-12-10',
        expDate: '2027-12-10',
        price: '178000',
        promoType: 'discount_percent',
        promoBuyQty: '',
        promoGetQty: '',
        promoDiscountPercent: '20',
        barcode: '8936017777002',
        unitRetailPrices: buildLineRetailPrices('d2'),
      },
    ],
  },
  {
    id: 'po-2',
    code: 'PN20260204002',
    date: '2026-02-04',
    supplierId: 's2',
    shippingCarrier: 'GHN',
    note: 'Chờ nhận đủ chứng từ.',
    paymentStatus: 'Còn nợ',
    paymentMethod: 'Ví điện tử Momo/ZaloPay',
    createdAt: Date.now() - 1000 * 60 * 60 * 8,
    lines: [
      {
        id: 'l3',
        batchCode: 'LO20260204001',
        drugId: 'd3',
        lotNumber: 'A02-0402',
        quantity: '500',
        mfgDate: '2025-09-01',
        expDate: '2027-09-01',
        price: '39000',
        promoType: 'none',
        promoBuyQty: '',
        promoGetQty: '',
        promoDiscountPercent: '',
        barcode: '8936011111002',
        unitRetailPrices: buildLineRetailPrices('d3'),
      },
    ],
  },
  {
    id: 'po-3',
    code: 'PN20260203001',
    date: '2026-02-03',
    supplierId: 's3',
    shippingCarrier: 'J&T',
    note: '',
    paymentStatus: 'Còn nợ',
    paymentMethod: 'Thanh toán thẻ',
    createdAt: Date.now() - 1000 * 60 * 60 * 18,
    lines: [
      {
        id: 'l4',
        batchCode: 'LO20260203001',
        drugId: 'd4',
        lotNumber: 'ORE-0203',
        quantity: '200',
        mfgDate: '2025-10-01',
        expDate: '2027-10-01',
        price: '5200',
        promoType: 'buy_x_get_y',
        promoBuyQty: '20',
        promoGetQty: '2',
        promoDiscountPercent: '',
        barcode: '8936013333001',
        unitRetailPrices: buildLineRetailPrices('d4'),
      },
    ],
  },
]

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

const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')}đ`
const paymentMethods: PaymentMethod[] = ['Ngân hàng', 'Ví điện tử Momo/ZaloPay', 'Thanh toán thẻ']
const shippingCarriers: ShippingCarrier[] = ['GHN', 'J&T']
const STORE_NAME = 'Nhà thuốc Thanh Huy'
const LABEL_WIDTH_MM = 50.8
const LABEL_HEIGHT_MM = 25.4

const sanitizeDigits = (value: string) => value.replace(/\D+/g, '')
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const createOrderCode = (orders: PurchaseOrder[], date: string) => {
  const key = toDateKey(date)
  const sameDayCount = orders.filter((order) => order.code.includes(key)).length
  return `PN${key}${String(sameDayCount + 1).padStart(3, '0')}`
}

const createLine = (date: string, index: number): LineItemForm => ({
  id: `line-${Date.now()}-${index}`,
  batchCode: `LO${toDateKey(date)}${String(index).padStart(3, '0')}`,
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
})

const createEmptyOrder = (orders: PurchaseOrder[], date = todayISO()): OrderFormState => ({
  code: createOrderCode(orders, date),
  date,
  supplierId: suppliers[0]?.id ?? '',
  shippingCarrier: 'GHN',
  note: '',
  paymentStatus: 'Còn nợ',
  paymentMethod: 'Ngân hàng',
  lines: [createLine(date, 1)],
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

const getLotLabelPrice = (line: LineItemForm) => {
  const baseUnit = line.unitRetailPrices
    .slice()
    .sort((a, b) => a.conversion - b.conversion)[0]
  const basePrice = parseNumber(baseUnit?.price ?? '')
  if (basePrice > 0) return basePrice
  return calcLinePricing(line).unitPriceAfterPromo
}

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
  const [orders, setOrders] = useState<PurchaseOrder[]>(initialOrders)
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('Tất cả')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('Tất cả')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState<OrderFormState>(() => createEmptyOrder(initialOrders))
  const [editingId, setEditingId] = useState<string | null>(null)
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

  const pageSize = 5

  const supplierMap = useMemo(
    () => new Map(suppliers.map((supplier) => [supplier.id, supplier])),
    []
  )

  const drugMap = useMemo(() => new Map(drugCatalog.map((drug) => [drug.id, drug])), [])

  const barcodeIndex = useMemo(() => {
    const index = new Map<string, string>()
    drugCatalog.forEach((drug) => {
      if (drug.barcode) index.set(drug.barcode, drug.id)
      drug.units.forEach((unit) => {
        if (unit.barcode) index.set(unit.barcode, drug.id)
      })
    })
    return index
  }, [])

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
        note: `${suppliers.length} nhà cung cấp`,
      },
      {
        label: 'Lô mới',
        value: recentLines.toString(),
        note: 'trong 30 ngày',
      },
    ]
  }, [orders])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return orders.filter((order) => {
      const supplierName = supplierMap.get(order.supplierId)?.name ?? ''
      const matchKeyword =
        !keyword ||
        order.code.toLowerCase().includes(keyword) ||
        supplierName.toLowerCase().includes(keyword)
      const matchSupplier = supplierFilter === 'Tất cả' || order.supplierId === supplierFilter
      const matchPaymentStatus =
        paymentStatusFilter === 'Tất cả' || order.paymentStatus === paymentStatusFilter
      const matchFrom = !dateFrom || order.date >= dateFrom
      const matchTo = !dateTo || order.date <= dateTo
      return matchKeyword && matchSupplier && matchPaymentStatus && matchFrom && matchTo
    })
  }, [orders, search, supplierFilter, paymentStatusFilter, dateFrom, dateTo, supplierMap])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  const resetFilters = () => {
    setSearch('')
    setSupplierFilter('Tất cả')
    setPaymentStatusFilter('Tất cả')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  const openCreate = () => {
    setErrors({})
    setEditingId(null)
    setForm(createEmptyOrder(orders))
    setModalOpen(true)
  }

  const openEdit = (order: PurchaseOrder) => {
    setErrors({})
    setEditingId(order.id)
    setForm({
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
        promoType: line.promoType ?? 'none',
        promoBuyQty: line.promoBuyQty ?? '',
        promoGetQty: line.promoGetQty ?? '',
        promoDiscountPercent: line.promoDiscountPercent ?? '',
        unitRetailPrices: buildLineRetailPrices(line.drugId, line.unitRetailPrices),
      })),
    })
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditingId(null)
    setScanOpen(false)
  }

  const updateForm = (field: keyof OrderFormState, value: OrderFormState[keyof OrderFormState]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleDateChange = (value: string) => {
    setForm((prev) => {
      if (editingId) return { ...prev, date: value }
      const updatedLines = prev.lines.map((line, index) => ({
        ...line,
        batchCode: `LO${toDateKey(value)}${String(index + 1).padStart(3, '0')}`,
      }))
      return {
        ...prev,
        date: value,
        code: createOrderCode(orders, value),
        lines: updatedLines,
      }
    })
  }

  const updateLine = (id: string, field: keyof LineItemForm, value: string) => {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    }))
  }

  const handleDrugChange = (id: string, drugId: string) => {
    const drug = drugMap.get(drugId)
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => {
        if (line.id !== id) return line
        return {
          ...line,
          drugId,
          barcode: line.barcode || drug?.barcode || '',
          unitRetailPrices: buildLineRetailPrices(drugId, line.unitRetailPrices),
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

  const addLine = () => {
    setForm((prev) => ({
      ...prev,
      lines: [...prev.lines, createLine(prev.date || todayISO(), prev.lines.length + 1)],
    }))
  }

  const removeLine = (id: string) => {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.length > 1 ? prev.lines.filter((line) => line.id !== id) : prev.lines,
    }))
  }

  const validate = () => {
    const next: Record<string, string> = {}
    if (!form.date) next.date = 'Bắt buộc'
    if (!form.supplierId) next.supplierId = 'Bắt buộc'
    if (!form.shippingCarrier) next.shippingCarrier = 'Bắt buộc'
    if (!form.lines.length) next.lines = 'Cần ít nhất 1 dòng thuốc'

    form.lines.forEach((line, index) => {
      if (!line.drugId) next[`line-drug-${index}`] = 'Bắt buộc'
      if (!line.lotNumber.trim()) next[`line-lot-${index}`] = 'Bắt buộc'
      if (!line.quantity.trim()) next[`line-qty-${index}`] = 'Bắt buộc'
      if (!line.mfgDate) next[`line-mfg-${index}`] = 'Bắt buộc'
      if (!line.expDate) next[`line-exp-${index}`] = 'Bắt buộc'
      if (!line.price.trim()) next[`line-price-${index}`] = 'Bắt buộc'
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
    return Object.keys(next).length === 0
  }

  const saveOrder = () => {
    if (!validate()) return
    const isCreating = !editingId
    const payload: PurchaseOrder = {
      id: form.id ?? `po-${Date.now()}`,
      code: form.code,
      date: form.date,
      supplierId: form.supplierId,
      shippingCarrier: form.shippingCarrier,
      note: form.note.trim(),
      paymentStatus: form.paymentStatus,
      paymentMethod: form.paymentMethod,
      lines: form.lines.map((line) => ({
        ...line,
        lotNumber: line.lotNumber.trim(),
        barcode: line.barcode.trim(),
        promoBuyQty: line.promoBuyQty.trim(),
        promoGetQty: line.promoGetQty.trim(),
        promoDiscountPercent: line.promoDiscountPercent.trim(),
        unitRetailPrices: line.unitRetailPrices.map((item) => ({
          ...item,
          price: item.price.trim(),
        })),
      })),
      createdAt:
        form.id && orders.find((order) => order.id === form.id)?.createdAt
          ? orders.find((order) => order.id === form.id)?.createdAt ?? Date.now()
          : Date.now(),
    }

    setOrders((prev) => {
      const exists = prev.some((order) => order.id === payload.id)
      return exists
        ? prev.map((order) => (order.id === payload.id ? payload : order))
        : [payload, ...prev]
    })
    setModalOpen(false)
    setEditingId(null)
    if (isCreating) {
      openLabelConfirm(payload)
    }
  }

  const removeOrder = (orderId: string) => {
    setOrders((prev) => prev.filter((order) => order.id !== orderId))
    setAlert('Đã xóa phiếu nhập.')
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
    (text: string) => {
      const target = scanTargetRef.current
      if (!target) return
      if (target.type === 'line') {
        const match = barcodeIndex.get(text)
        setForm((prev) => ({
          ...prev,
          lines: prev.lines.map((line) => {
            if (line.id !== target.id) return line
            const nextLine = { ...line, barcode: text }
            if (match) {
              nextLine.drugId = match
            }
            return nextLine
          }),
        }))
      }
      setScanOpen(false)
      setScanMessage('Đã quét thành công.')
    },
    [barcodeIndex]
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
        applyScanResult(normalized)
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
              const pricing = calcLinePricing(line)
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
                        {formatCurrency(pricing.unitPriceAfterPromo)}
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
          <button onClick={openCreate} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
            Tạo phiếu nhập
          </button>
          <button className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
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

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((item) => (
          <div key={item.label} className="glass-card rounded-3xl p-5">
            <p className="text-xs uppercase tracking-[0.28em] text-ink-600">{item.label}</p>
            <p className="mt-3 text-2xl font-semibold text-ink-900">{item.value}</p>
            <p className="mt-2 text-xs text-ink-600">{item.note}</p>
          </div>
        ))}
      </section>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1.2fr,1fr,1fr,1fr,auto]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            placeholder="Tìm theo mã phiếu, nhà phân phối"
          />
          <select
            value={supplierFilter}
            onChange={(event) => setSupplierFilter(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value="Tất cả">Tất cả NPP</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
          <select
            value={paymentStatusFilter}
            onChange={(event) => setPaymentStatusFilter(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value="Tất cả">Tất cả thanh toán</option>
            <option value="Đã thanh toán">Đã thanh toán</option>
            <option value="Còn nợ">Còn nợ</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              type="date"
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
            />
            <input
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              type="date"
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-3 py-2 text-xs"
            />
          </div>
          <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
            Reset
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
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
              {paged.map((order) => (
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
                          className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900"
                        >
                          Sửa
                        </button>
                        <button
                          onClick={() => removeOrder(order.id)}
                          className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                        >
                          Xóa
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === order.id ? (
                    <tr className="bg-white/50">
                      <td colSpan={9} className="px-6 pb-6">
                        <div className="rounded-2xl bg-white/80 p-4 space-y-4">
                          <div className="grid gap-4 md:grid-cols-[1.1fr,1fr]">
                            <div className="space-y-2 text-sm text-ink-700">
                              <p><span className="font-semibold text-ink-900">Nhà phân phối:</span> {supplierMap.get(order.supplierId)?.name}</p>
                              <p><span className="font-semibold text-ink-900">Liên hệ nhà phân phối:</span> {supplierMap.get(order.supplierId)?.contactName}</p>
                              <p><span className="font-semibold text-ink-900">Liên hệ:</span> {supplierMap.get(order.supplierId)?.phone}</p>
                              <p><span className="font-semibold text-ink-900">Địa chỉ:</span> {supplierMap.get(order.supplierId)?.address}</p>
                              <p><span className="font-semibold text-ink-900">Đơn vị vận chuyển:</span> {order.shippingCarrier}</p>
                              <p><span className="font-semibold text-ink-900">Trạng thái thanh toán:</span> {order.paymentStatus}</p>
                              <p><span className="font-semibold text-ink-900">Phương thức thanh toán:</span> {order.paymentMethod}</p>
                              <p><span className="font-semibold text-ink-900">Ghi chú:</span> {order.note || '-'}</p>
                            </div>
                            <div className="rounded-2xl bg-white px-4 py-3 text-sm text-ink-700">
                              <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Tổng hợp</p>
                              <p className="mt-2 text-lg font-semibold text-ink-900">{formatCurrency(calcOrderTotal(order.lines))}</p>
                              <p className="mt-1 text-xs text-ink-600">{order.lines.length} dòng thuốc</p>
                            </div>
                          </div>
                          <div className="space-y-2 text-sm text-ink-700">
                            {order.lines.map((line) => {
                              const drug = drugMap.get(line.drugId)
                              const pricing = calcLinePricing(line)
                                                            return (
                                <div key={line.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2">
                                  <span className="font-semibold text-ink-900">{drug?.name ?? '-'}</span>
                                  <span>Lô {line.lotNumber || '-'}</span>
                                  <span>SL sau KM {pricing.quantityAfterPromo.toLocaleString('vi-VN')}</span>
                                  <span>Giá sau KM {formatCurrency(pricing.unitPriceAfterPromo)}</span>
                                  <span className="text-xs text-ink-700">Giá bẻ: {formatRetailPrices(line) || '-'}</span>
                                  <span>{describePromo(line)}</span>
                                  <span>HSD {formatDate(line.expDate)}</span>
                                  <span>{formatCurrency(calcLineTotal(line))}</span>
                                  <span className="text-xs text-ink-600">QR: {line.batchCode}</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>Hiển thị {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, filtered.length)} trong {filtered.length} phiếu</span>
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
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">
                  {editingId ? 'Chỉnh sửa phiếu nhập' : 'Tạo phiếu nhập mới'}
                </p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.code}</h3>
              </div>
              <button onClick={closeModal} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">
                Đóng
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã phiếu nhập</span>
                  <input value={form.code} disabled className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-sm text-ink-500" />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ngày nhập *</span>
                  <input
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
                    value={form.supplierId}
                    onChange={(event) => updateForm('supplierId', event.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  >
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                    ))}
                  </select>
                  {errors.supplierId ? <span className="text-xs text-coral-500">{errors.supplierId}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Liên hệ của nhà phân phối</span>
                  <input
                    value={
                      supplierMap.get(form.supplierId)
                        ? `${supplierMap.get(form.supplierId)?.contactName} - ${supplierMap.get(form.supplierId)?.phone}`
                        : ''
                    }
                    disabled
                    className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-sm text-ink-500"
                  />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Đơn vị vận chuyển</span>
                  <select
                    value={form.shippingCarrier}
                    onChange={(event) => updateForm('shippingCarrier', event.target.value as ShippingCarrier)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                  >
                    {shippingCarriers.map((carrier) => (
                      <option key={carrier} value={carrier}>{carrier}</option>
                    ))}
                  </select>
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
                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
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
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">Chi tiết lô nhập</p>
                    <p className="text-xs text-ink-500">Quét barcode hoặc chọn thuốc để tự điền thông tin.</p>
                  </div>
                  <button onClick={addLine} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-xs font-semibold text-ink-900">
                    Thêm dòng thuốc
                  </button>
                </div>
                {errors.lines ? <p className="text-xs text-coral-500">{errors.lines}</p> : null}

                <div className="space-y-4">
                  {form.lines.map((line, index) => {
                    const drug = drugMap.get(line.drugId)
                    const pricing = calcLinePricing(line)
                                        return (
                      <div key={line.id} className="rounded-2xl bg-fog-50 p-4 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Mã lô</p>
                            <p className="text-sm font-semibold text-ink-900">{line.batchCode}</p>
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
                              className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                            >
                              Xóa dòng
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                          <label className="space-y-1 text-xs text-ink-600">
                            Thuốc *
                            <select
                              value={line.drugId}
                              onChange={(event) => handleDrugChange(line.id, event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                            >
                              <option value="">Chọn thuốc</option>
                              {drugCatalog.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.code} - {item.name}
                                </option>
                              ))}
                            </select>
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
                              value={line.barcode}
                              onChange={(event) => updateLine(line.id, 'barcode', event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="Quét hoặc nhập barcode"
                            />
                          </label>

                          <label className="space-y-1 text-xs text-ink-600">
                            Số lô *
                            <input
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
                            Số lượng *
                            <input
                              value={line.quantity}
                              onChange={(event) => updateLine(line.id, 'quantity', event.target.value)}
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
                              value={line.price}
                              onChange={(event) => updateLine(line.id, 'price', event.target.value)}
                              className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                              placeholder="0"
                            />
                            {errors[`line-price-${index}`] ? (
                              <span className="text-xs text-coral-500">{errors[`line-price-${index}`]}</span>
                            ) : null}
                          </label>

                          <div className="space-y-2 text-xs text-ink-600 md:col-span-2 lg:col-span-3">
                            <p>Giá bán lẻ theo từng đơn vị *</p>
                            {line.unitRetailPrices.length ? (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {line.unitRetailPrices.map((unitPrice) => (
                                  <label key={unitPrice.unitId} className="space-y-1 rounded-xl border border-ink-900/10 bg-white p-3">
                                    <span className="text-[11px] text-ink-600">
                                      {unitPrice.unitName} ({unitPrice.conversion} đơn vị gốc)
                                    </span>
                                    <input
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
                                  value={line.promoBuyQty}
                                  onChange={(event) => updateLine(line.id, 'promoBuyQty', event.target.value)}
                                  className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                                  placeholder="Mua X"
                                />
                                <input
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

                          <label className="space-y-1 text-xs text-ink-600">
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
                <button onClick={saveOrder} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
                  Lưu phiếu nhập
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


