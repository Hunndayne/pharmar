import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Quagga from '@ericblade/quagga2'

type Unit = {
  id: string
  name: string
  conversion: number
  barcode: string
  price: number
}

type Drug = {
  id: string
  code: string
  name: string
  regNo: string
  group: string
  maker: string
  barcode: string
  usage: string
  note: string
  units: Unit[]
  active: boolean
  hasTransactions: boolean
}

type FormUnit = {
  id: string
  name: string
  conversion: string
  barcode: string
  price: string
}

type FormState = {
  id?: string
  code: string
  name: string
  regNo: string
  group: string
  maker: string
  barcode: string
  usage: string
  note: string
  active: boolean
  units: FormUnit[]
}

type ScanTarget = 'search' | 'form' | { type: 'unit'; id: string }

const groups = ['Giảm đau', 'Kháng sinh', 'Vitamin', 'Tiêu hóa', 'Chăm sóc da', 'Vật tư y tế']
const makers = ['GSK', 'DHG', 'Imexpharm', 'Santen', 'DHC', 'Traphaco']

const initialDrugs: Drug[] = [
  {
    id: 'd1',
    code: 'T0001',
    name: 'Panadol Extra',
    regNo: 'VD-12345-21',
    group: 'Giảm đau',
    maker: 'GSK',
    barcode: '8936012345678',
    usage: 'Uống sau ăn, không dùng quá 4 viên/ngày.',
    note: 'Sản phẩm bán chạy.',
    active: true,
    hasTransactions: true,
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936012345001', price: 3000 },
      { id: 'u2', name: 'Vỉ', conversion: 10, barcode: '8936012345002', price: 28000 },
      { id: 'u3', name: 'Hộp', conversion: 120, barcode: '8936012345003', price: 320000 },
    ],
  },
  {
    id: 'd2',
    code: 'T0034',
    name: 'Vitamin C 1000',
    regNo: 'VN-98765-19',
    group: 'Vitamin',
    maker: 'DHC',
    barcode: '8936017777777',
    usage: 'Uống 1 viên/ngày.',
    note: '',
    active: true,
    hasTransactions: false,
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936017777001', price: 6000 },
      { id: 'u2', name: 'Chai', conversion: 30, barcode: '8936017777002', price: 185000 },
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
    usage: 'Theo chỉ định bác sĩ.',
    note: 'Hàng cần kiểm soát.',
    active: true,
    hasTransactions: true,
    units: [
      { id: 'u1', name: 'Viên', conversion: 1, barcode: '8936011111001', price: 4200 },
      { id: 'u2', name: 'Vỉ', conversion: 10, barcode: '8936011111002', price: 42000 },
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
    usage: 'Pha 1 gói với 200ml nước.',
    note: '',
    active: true,
    hasTransactions: false,
    units: [{ id: 'u1', name: 'Gói', conversion: 1, barcode: '8936013333001', price: 6000 }],
  },
]

const statusStyles: Record<string, string> = {
  'Đang bán': 'bg-brand-500/15 text-brand-600 border border-brand-500/30',
  'Ngừng bán': 'bg-ink-600/10 text-ink-600 border border-ink-600/20',
}

const emptyForm = (): FormState => ({
  code: '',
  name: '',
  regNo: '',
  group: groups[0],
  maker: makers[0],
  barcode: '',
  usage: '',
  note: '',
  active: true,
  units: [
    {
      id: `u-${Date.now()}`,
      name: '',
      conversion: '1',
      barcode: '',
      price: '',
    },
  ],
})

const formatUnits = (units: Unit[]) =>
  units
    .slice()
    .sort((a, b) => a.conversion - b.conversion)
    .map((unit) => `${unit.name} ${unit.price.toLocaleString('vi-VN')}đ`)
    .join(' · ')

// ============================================================
// Barcode Scanning Engine (Quagga2)
//
// Ưu tiên: Quagga2 (nhạy với barcode 1D, nhiều tuỳ chỉnh)
// - Live stream + locate: true
// - Có nút "Chụp & quét" để chủ động quét khi cần
// ============================================================

const QUAGGA_READERS = ['ean_reader', 'upc_reader']
const QUAGGA_AREA = { top: '35%', right: '10%', left: '10%', bottom: '35%' }
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

const quaggaConfig = (target: HTMLElement, deviceId?: string) => ({
  inputStream: {
    type: 'LiveStream',
    target,
    area: QUAGGA_AREA,
    constraints: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      facingMode: deviceId ? undefined : { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
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
  frequency: 10,
})


export function DrugCatalog() {
  const [drugs, setDrugs] = useState<Drug[]>(initialDrugs)
  const [search, setSearch] = useState('')
  const [barcodeSearch, setBarcodeSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('Tất cả')
  const [makerFilter, setMakerFilter] = useState('Tất cả')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState<FormState>(emptyForm())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [importFile, setImportFile] = useState<string | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanTarget, setScanTarget] = useState<ScanTarget>('search')
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [scanMessage, setScanMessage] = useState<string>('Đang khởi tạo camera...')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [scanEngine, setScanEngine] = useState<'quagga' | ''>('')

  const quaggaContainerRef = useRef<HTMLDivElement | null>(null)
  const scanTargetRef = useRef<ScanTarget>('search')
  const scanActiveRef = useRef(false)
  const scanStabilityRef = useRef<{ value: string; count: number; lastSeen: number } | null>(null)

  const pageSize = 6

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const barcodeKey = barcodeSearch.trim().toLowerCase()
    return drugs.filter((drug) => {
      const matchKeyword =
        !keyword ||
        [drug.code, drug.name, drug.regNo, drug.barcode, drug.maker]
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      const matchBarcode =
        !barcodeKey ||
        drug.barcode.toLowerCase().includes(barcodeKey) ||
        drug.units.some((unit) => unit.barcode.toLowerCase().includes(barcodeKey))
      const matchGroup = groupFilter === 'Tất cả' || drug.group === groupFilter
      const matchMaker = makerFilter === 'Tất cả' || drug.maker === makerFilter
      return matchKeyword && matchBarcode && matchGroup && matchMaker
    })
  }, [drugs, search, barcodeSearch, groupFilter, makerFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  const stats = [
    { label: 'Tổng thuốc', value: drugs.length.toString(), note: `${groups.length} nhóm` },
    { label: 'Sắp hết hàng', value: '38', note: 'dưới ngưỡng' },
    { label: 'Cận date', value: '12', note: 'trong 30 ngày' },
    { label: 'Đang bán', value: drugs.filter((d) => d.active).length.toString(), note: 'đang hoạt động' },
  ]

  const openCreate = () => {
    setErrors({})
    setForm(emptyForm())
    setModalOpen(true)
  }

  const openEdit = (drug: Drug) => {
    setErrors({})
    setForm({
      id: drug.id,
      code: drug.code,
      name: drug.name,
      regNo: drug.regNo,
      group: drug.group,
      maker: drug.maker,
      barcode: drug.barcode,
      usage: drug.usage,
      note: drug.note,
      active: drug.active,
      units: drug.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        conversion: unit.conversion.toString(),
        barcode: unit.barcode,
        price: unit.price.toString(),
      })),
    })
    setModalOpen(true)
  }

  const removeDrug = (drug: Drug) => {
    if (drug.hasTransactions) {
      setAlert('Không thể xóa vì thuốc đã có giao dịch.')
      return
    }
    setDrugs((prev) => prev.filter((item) => item.id !== drug.id))
  }

  const updateForm = (field: keyof FormState, value: string | boolean | FormUnit[]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const updateUnit = (id: string, field: keyof FormUnit, value: string) => {
    setForm((prev) => ({
      ...prev,
      units: prev.units.map((unit) => (unit.id === id ? { ...unit, [field]: value } : unit)),
    }))
  }

  const addUnit = () => {
    setForm((prev) => ({
      ...prev,
      units: [
        ...prev.units,
        { id: `u-${Date.now()}`, name: '', conversion: '', barcode: '', price: '' },
      ],
    }))
  }

  const removeUnit = (id: string) => {
    setForm((prev) => ({
      ...prev,
      units: prev.units.length > 1 ? prev.units.filter((unit) => unit.id !== id) : prev.units,
    }))
  }

  const validate = () => {
    const next: Record<string, string> = {}
    if (!form.code.trim()) next.code = 'Bắt buộc'
    if (!form.name.trim()) next.name = 'Bắt buộc'
    if (!form.regNo.trim()) next.regNo = 'Bắt buộc'
    if (!form.group) next.group = 'Bắt buộc'
    if (!form.maker) next.maker = 'Bắt buộc'
    form.units.forEach((unit, index) => {
      if (!unit.name.trim()) next[`unit-name-${index}`] = 'Bắt buộc'
      if (!unit.conversion.trim()) next[`unit-conversion-${index}`] = 'Bắt buộc'
      if (!unit.price.trim()) next[`unit-price-${index}`] = 'Bắt buộc'
    })
    if (!form.units.some((unit) => Number(unit.conversion) === 1)) {
      next.baseUnit = 'Cần có 1 đơn vị quy đổi = 1'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const saveDrug = () => {
    if (!validate()) return
    const formattedUnits: Unit[] = form.units.map((unit) => ({
      id: unit.id,
      name: unit.name.trim(),
      conversion: Number(unit.conversion),
      barcode: unit.barcode.trim(),
      price: Number(unit.price),
    }))
    const payload: Drug = {
      id: form.id ?? `d-${Date.now()}`,
      code: form.code.trim(),
      name: form.name.trim(),
      regNo: form.regNo.trim(),
      group: form.group,
      maker: form.maker,
      barcode: form.barcode.trim(),
      usage: form.usage.trim(),
      note: form.note.trim(),
      active: form.active,
      units: formattedUnits,
      hasTransactions: form.id ? drugs.find((d) => d.id === form.id)?.hasTransactions ?? false : false,
    }
    setDrugs((prev) => {
      const exists = prev.some((item) => item.id === payload.id)
      return exists
        ? prev.map((item) => (item.id === payload.id ? payload : item))
        : [payload, ...prev]
    })
    setModalOpen(false)
  }

  const exportCsv = () => {
    const rows = drugs.map((drug) => {
      const unitData = drug.units
        .map((unit) => `${unit.name}=${unit.conversion}:${unit.price}`)
        .join('|')
      return [
        drug.code, drug.name, drug.regNo, drug.group, drug.maker,
        drug.barcode, drug.active ? 'Đang bán' : 'Ngừng bán', unitData,
      ].join(',')
    })
    const header = ['Mã thuốc','Tên thuốc','Số đăng ký','Nhóm','NSX','Barcode','Trạng thái','Đơn vị'].join(',')
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'danh-muc-thuoc.csv'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const resetFilters = () => {
    setSearch('')
    setBarcodeSearch('')
    setGroupFilter('Tất cả')
    setMakerFilter('Tất cả')
    setPage(1)
  }

  // applyScanResult — dùng useCallback + ref để tránh stale closure
  const applyScanResult = useCallback((text: string) => {
    const target = scanTargetRef.current
    if (target === 'search') {
      setBarcodeSearch(text)
    } else if (target === 'form') {
      setForm((prev) => ({ ...prev, barcode: text }))
    } else {
      setForm((prev) => ({
        ...prev,
        units: prev.units.map((unit) =>
          unit.id === target.id ? { ...unit, barcode: text } : unit
        ),
      }))
    }
    setScanOpen(false)
    setScanMessage('Đã quét thành công.')
  }, [])

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

  const scanTitle =
    scanTarget === 'search'
      ? 'Quét barcode tìm kiếm'
      : scanTarget === 'form'
      ? 'Quét barcode thuốc'
      : 'Quét barcode đơn vị'

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

  // Zoom handler
  const handleZoom = useCallback((newZoom: number) => {
    setZoomLevel(newZoom)
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (track) {
      try {
        track.applyConstraints({ advanced: [{ zoom: newZoom } as any] } as any)
      } catch { /* ignore */ }
    }
  }, [])

  // Torch handler
  const handleTorch = useCallback(() => {
    const next = !torchOn
    setTorchOn(next)
    const track = (Quagga as any).CameraAccess?.getActiveTrack?.()
    if (track) {
      try {
        track.applyConstraints({ advanced: [{ torch: next } as any] } as any)
      } catch { /* ignore */ }
    }
  }, [torchOn])

  const handleDetected = useCallback(
    (result: any) => {
      const text = result?.codeResult?.code
      if (text && scanActiveRef.current) {
        handleScanCandidate(text)
      }
    },
    [handleScanCandidate]
  )

  const stopQuagga = useCallback(() => {
    try {
      ;(Quagga as any).offDetected?.(handleDetected)
    } catch { /* ignore */ }
    try {
      ;(Quagga as any).stop?.()
    } catch { /* ignore */ }
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

        // Xin quyền camera để lấy label thiết bị
        try {
          const temp = await navigator.mediaDevices.getUserMedia({ video: true })
          temp.getTracks().forEach((t) => t.stop())
        } catch (e: any) {
          setScanError(
            e?.name === 'NotAllowedError'
              ? 'Chưa cấp quyền camera. Vui lòng cho phép trong cài đặt trình duyệt.'
              : `Không thể truy cập camera: ${e?.message || 'Lỗi không xác định'}`
          )
          return
        }

        if (!scanActiveRef.current) return

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
        const initQuagga = (deviceId?: string) =>
          new Promise<void>((resolve, reject) => {
            ;(Quagga as any).init(quaggaConfig(quaggaContainerRef.current as HTMLElement, deviceId), (err: any) => {
              if (err) reject(err)
              else resolve()
            })
          })

        try {
          await initQuagga(preferredId)
        } catch (initErr: any) {
          if (preferredId) {
            await initQuagga()
          } else {
            throw initErr
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
            const advanced: any[] = []
            if (caps?.focusMode?.includes?.('continuous')) advanced.push({ focusMode: 'continuous' })
            if (caps?.exposureMode?.includes?.('continuous')) advanced.push({ exposureMode: 'continuous' })
            if (advanced.length) await track.applyConstraints({ advanced } as any)
          } catch { /* ignore */ }
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

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 tablet:flex-row tablet:items-center tablet:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục thuốc</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Quản lý danh sách thuốc</h2>
          <p className="mt-2 text-sm text-ink-600">Master data thuốc, đơn vị tính và barcode.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button onClick={openCreate} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
            Thêm thuốc
          </button>
          <label className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
            Import Excel
            <input type="file" className="hidden" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0]?.name ?? null)} />
          </label>
          <button onClick={exportCsv} className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
            Export Excel
          </button>
        </div>
      </header>

      {importFile ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-ink-700">
          Đã chọn file: <span className="font-semibold text-ink-900">{importFile}</span>
        </div>
      ) : null}

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
        <div className="grid gap-3 md:grid-cols-[1.2fr,1fr,1fr,auto]">
          <input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm" placeholder="Tìm theo tên, mã, số đăng ký" />
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm">
            <option>Tất cả</option>
            {groups.map((g) => <option key={g}>{g}</option>)}
          </select>
          <select value={makerFilter} onChange={(e) => setMakerFilter(e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm">
            <option>Tất cả</option>
            {makers.map((m) => <option key={m}>{m}</option>)}
          </select>
          <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">Reset</button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input value={barcodeSearch} onChange={(e) => setBarcodeSearch(e.target.value)} className="min-w-[220px] flex-1 rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm" placeholder="Quét barcode để tìm nhanh" />
          <button type="button" onClick={() => openScan('search')} className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">
            Quét bằng camera
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.25em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã thuốc</th>
                <th className="px-6 py-4">Tên thuốc</th>
                <th className="px-6 py-4">Nhóm</th>
                <th className="px-6 py-4">Nhà SX</th>
                <th className="px-6 py-4">Đơn vị & giá</th>
                <th className="px-6 py-4">Barcode</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {paged.map((drug) => (
                <Fragment key={drug.id}>
                  <tr className="hover:bg-white/80">
                    <td className="px-6 py-4 font-semibold text-ink-900">{drug.code}</td>
                    <td className="px-6 py-4 text-ink-900">{drug.name}</td>
                    <td className="px-6 py-4 text-ink-700">{drug.group}</td>
                    <td className="px-6 py-4 text-ink-700">{drug.maker}</td>
                    <td className="px-6 py-4 text-ink-900">{formatUnits(drug.units)}</td>
                    <td className="px-6 py-4 text-ink-700">{drug.barcode || '-'}</td>
                    <td className="px-6 py-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[drug.active ? 'Đang bán' : 'Ngừng bán']}`}>
                        {drug.active ? 'Đang bán' : 'Ngừng bán'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => setExpandedId((prev) => (prev === drug.id ? null : drug.id))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Chi tiết</button>
                        <button onClick={() => openEdit(drug)} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Sửa</button>
                        <button onClick={() => removeDrug(drug)} className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500">Xóa</button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === drug.id ? (
                    <tr>
                      <td colSpan={8} className="px-6 pb-6">
                        <div className="rounded-2xl bg-white/80 p-4">
                          <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
                            <div className="space-y-2 text-sm text-ink-700">
                              <p><span className="font-semibold text-ink-900">Số đăng ký:</span> {drug.regNo}</p>
                              <p><span className="font-semibold text-ink-900">Hướng dẫn:</span> {drug.usage || '-'}</p>
                              <p><span className="font-semibold text-ink-900">Ghi chú:</span> {drug.note || '-'}</p>
                            </div>
                            <div>
                              <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đơn vị tính</p>
                              <div className="mt-3 space-y-2 text-sm text-ink-700">
                                {drug.units.slice().sort((a, b) => a.conversion - b.conversion).map((unit) => (
                                  <div key={unit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2">
                                    <span className="font-semibold text-ink-900">{unit.name}</span>
                                    <span>{unit.conversion} đơn vị</span>
                                    <span>{unit.price.toLocaleString('vi-VN')}đ</span>
                                    <span className="text-xs text-ink-600">{unit.barcode || '—'}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
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
        <span>Hiển thị {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, filtered.length)} trong {filtered.length} thuốc</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Trước</button>
          <span>{page}/{totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Sau</button>
        </div>
      </section>

      {/* ========== MODAL THÊM/SỬA THUỐC ========== */}
      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-4xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">{form.id ? 'Chỉnh sửa thuốc' : 'Thêm thuốc mới'}</p>
                <h3 className="mt-2 text-2xl font-semibold text-ink-900">{form.name || 'Thông tin thuốc'}</h3>
              </div>
              <button onClick={() => setModalOpen(false)} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">Đóng</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã thuốc *</span>
                  <input value={form.code} onChange={(e) => updateForm('code', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                  {errors.code ? <span className="text-xs text-coral-500">{errors.code}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên thuốc *</span>
                  <input value={form.name} onChange={(e) => updateForm('name', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                  {errors.name ? <span className="text-xs text-coral-500">{errors.name}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Số đăng ký *</span>
                  <input value={form.regNo} onChange={(e) => updateForm('regNo', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                  {errors.regNo ? <span className="text-xs text-coral-500">{errors.regNo}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Nhóm thuốc *</span>
                  <select value={form.group} onChange={(e) => updateForm('group', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2">
                    {groups.map((g) => <option key={g}>{g}</option>)}
                  </select>
                  {errors.group ? <span className="text-xs text-coral-500">{errors.group}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Hãng sản xuất *</span>
                  <select value={form.maker} onChange={(e) => updateForm('maker', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2">
                    {makers.map((m) => <option key={m}>{m}</option>)}
                  </select>
                  {errors.maker ? <span className="text-xs text-coral-500">{errors.maker}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Barcode</span>
                  <div className="flex gap-2">
                    <input value={form.barcode} onChange={(e) => updateForm('barcode', e.target.value)} className="flex-1 rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                    <button type="button" onClick={() => openScan('form')} className="rounded-2xl border border-ink-900/10 bg-white/80 px-3 text-sm font-semibold text-ink-900">Quét</button>
                  </div>
                </label>
                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Hướng dẫn sử dụng</span>
                  <textarea value={form.usage} onChange={(e) => updateForm('usage', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" rows={2} />
                </label>
                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Ghi chú</span>
                  <textarea value={form.note} onChange={(e) => updateForm('note', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" rows={2} />
                </label>
                <label className="flex items-center gap-3 text-sm text-ink-700">
                  <input type="checkbox" checked={form.active} onChange={(e) => updateForm('active', e.target.checked)} className="h-4 w-4 rounded border-ink-900/20" />
                  Đang bán
                </label>
              </div>
              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink-900">Đơn vị tính & giá bán</p>
                  <button onClick={addUnit} className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900">Thêm đơn vị</button>
                </div>
                {errors.baseUnit ? <p className="mt-2 text-xs text-coral-500">{errors.baseUnit}</p> : null}
                <div className="mt-4 space-y-3">
                  {form.units.map((unit, index) => (
                    <div key={unit.id} className="grid gap-3 rounded-2xl bg-fog-50 p-4 sm:grid-cols-5">
                      <label className="space-y-1 text-xs text-ink-600">
                        Tên đơn vị *
                        <input value={unit.name} onChange={(e) => updateUnit(unit.id, 'name', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" />
                        {errors[`unit-name-${index}`] ? <span className="text-xs text-coral-500">{errors[`unit-name-${index}`]}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Quy đổi *
                        <input value={unit.conversion} onChange={(e) => updateUnit(unit.id, 'conversion', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" />
                        {errors[`unit-conversion-${index}`] ? <span className="text-xs text-coral-500">{errors[`unit-conversion-${index}`]}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Barcode
                        <div className="mt-1 flex gap-2">
                          <input value={unit.barcode} onChange={(e) => updateUnit(unit.id, 'barcode', e.target.value)} className="flex-1 rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" />
                          <button type="button" onClick={() => openScan({ type: 'unit', id: unit.id })} className="rounded-xl border border-ink-900/10 bg-white/80 px-2 text-xs font-semibold text-ink-900">Quét</button>
                        </div>
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Giá bán *
                        <input value={unit.price} onChange={(e) => updateUnit(unit.id, 'price', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" />
                        {errors[`unit-price-${index}`] ? <span className="text-xs text-coral-500">{errors[`unit-price-${index}`]}</span> : null}
                      </label>
                      <div className="flex items-end justify-between text-xs text-ink-600">
                        <button onClick={() => removeUnit(unit.id)} className="rounded-full border border-ink-900/10 bg-white px-3 py-2 text-xs font-semibold text-ink-900">Xóa đơn vị</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 border-t border-ink-900/10 px-6 py-4">
              <button onClick={saveDrug} className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">Lưu</button>
              <button onClick={() => setModalOpen(false)} className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">Hủy</button>
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
              <button onClick={() => setScanOpen(false)} className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900">Tắt camera</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {cameraDevices.length > 1 ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-ink-700">
                  <label className="text-xs uppercase tracking-[0.25em] text-ink-500">Camera</label>
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => { setScanError(null); setScanMessage('Đang chuyển camera...'); setSelectedDeviceId(e.target.value) }}
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
                  <input type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoomLevel} onChange={(e) => handleZoom(parseFloat(e.target.value))} className="flex-1 accent-ink-900" />
                  <span className="text-xs text-ink-600 w-10 text-right">{zoomLevel.toFixed(1)}×</span>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {torchSupported ? (
                  <button type="button" onClick={handleTorch} className={`rounded-full px-4 py-2 text-sm font-semibold ${torchOn ? 'bg-amber-100 text-amber-700 border border-amber-300' : 'border border-ink-900/10 bg-white/80 text-ink-900'}`}>
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
