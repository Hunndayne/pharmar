import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Quagga from '@ericblade/quagga2'
import {
  catalogApi,
  type DrugReferenceItem,
  type DrugGroupItem,
  type ManufacturerItem,
  type ProductDetailItem,
  type ProductUnitItem,
} from '../api/catalogService'
import { inventoryApi } from '../api/inventoryService'
import { storeApi } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { downloadCsv, parseDelimitedText } from '../utils/csv'
import { readLocalDraft, removeLocalDraft, writeLocalDraft } from '../utils/localDraft'

type Unit = {
  id: string
  name: string
  conversion: number
  price: number
  level: 'import' | 'intermediate' | 'retail'
}

type Drug = {
  id: string
  code: string
  name: string
  activeIngredient: string
  regNo: string
  category: string
  vatRate: number
  otherTaxRate: number
  groupId: string | null
  group: string
  makerId: string | null
  maker: string
  barcode: string
  usage: string
  note: string
  units: Unit[]
  active: boolean
  hasTransactions: boolean
}

type FormUnit = {
  name: string
  conversion: string
  price: string
}

type FormState = {
  id?: string
  code: string
  name: string
  activeIngredient: string
  regNo: string
  groupCategory: string
  groupId: string
  makerId: string
  barcode: string
  usage: string
  note: string
  active: boolean
  singleUnit: boolean
  hasIntermediate: boolean
  importUnit: FormUnit
  intermediateUnit: FormUnit
  retailUnit: FormUnit
}

type ScanTarget = 'search' | 'form'

const unitNames = [
  'Chai',
  'Đôi',
  'Lá',
  'Vỉ',
  'Hộp',
  'Hộp to',
  'Hộp nhỏ',
  'Thùng',
  'Lọ',
  'Lốc',
  'Gói',
  'Viên',
  'Tuýp',
  'Cọc',
  'Túi',
  'Bịch',
  'Chiếc',
  'Cái',
  'Cuộn',
  'Miếng',
  'Ống',
  'Bình',
  'Dây',
  'Bộ',
  'Lon',
  'Xấp',
  'Thỏi',
  'Bao',
]

const initialDrugs: Drug[] = []
const DRUG_FORM_DRAFT_STORAGE_KEY = 'pharmar.drug-catalog.form.draft.v1'

const statusStyles: Record<string, string> = {
  'Đang bán': 'bg-brand-500/15 text-brand-600 border border-brand-500/30',
  'Ngừng bán': 'bg-ink-600/10 text-ink-600 border border-ink-600/20',
}

const emptyForm = (groupId = '', makerId = '', groupCategory = ''): FormState => ({
  code: '',
  name: '',
  activeIngredient: '',
  regNo: '',
  groupCategory,
  groupId,
  makerId,
  barcode: '',
  usage: '',
  note: '',
  active: true,
  singleUnit: false,
  hasIntermediate: true,
  importUnit: {
    name: 'Hộp',
    conversion: '10',
    price: '',
  },
  intermediateUnit: {
    name: 'Vỉ',
    conversion: '10',
    price: '',
  },
  retailUnit: {
    name: 'Viên',
    conversion: '1',
    price: '',
  },
})

const unitLevelLabel: Record<Unit['level'], string> = {
  import: 'Nhập',
  intermediate: 'Trung gian',
  retail: 'Bán lẻ',
}

const unitLevelOrder: Record<Unit['level'], number> = {
  import: 0,
  intermediate: 1,
  retail: 2,
}

const toNumber = (value: string) => Number(value.trim())

const parsePositive = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const formatUnits = (units: Unit[]) =>
  units
    .slice()
    .sort((a, b) => unitLevelOrder[a.level] - unitLevelOrder[b.level])
    .map((unit) => `${unit.name} (${unitLevelLabel[unit.level]}) ${unit.price.toLocaleString('vi-VN')}đ`)
    .join(' · ')

const inferFormFromDrug = (drug: Drug) => {
  const byLevel: Partial<Record<Unit['level'], Unit>> = {}
  for (const unit of drug.units) {
    if (unit.level) byLevel[unit.level] = unit
  }

  if (!byLevel.retail) {
    const sorted = drug.units.slice().sort((a, b) => a.conversion - b.conversion)
    if (sorted[0]) byLevel.retail = sorted[0]
    if (sorted[1]) byLevel.intermediate = sorted.length > 2 ? sorted[1] : undefined
    if (sorted[sorted.length - 1]) byLevel.import = sorted[sorted.length - 1]
  }

  const retail = byLevel.retail ?? drug.units[0]
  const intermediate = byLevel.intermediate
  const importUnit = byLevel.import
  const hasImport = Boolean(importUnit)
  const hasIntermediate = Boolean(importUnit && intermediate)
  const singleUnit = !hasImport

  const importConversion = hasIntermediate
    ? Math.max(1, Math.round((importUnit?.conversion ?? 1) / (intermediate?.conversion ?? 1)))
    : Math.max(1, importUnit?.conversion ?? 1)

  return {
    singleUnit,
    hasIntermediate,
    importUnit: {
      name: importUnit?.name ?? 'Hộp',
      conversion: importConversion.toString(),
      price: importUnit?.price?.toString() ?? '',
    },
    intermediateUnit: {
      name: intermediate?.name ?? 'Vỉ',
      conversion: Math.max(1, intermediate?.conversion ?? 1).toString(),
      price: intermediate?.price?.toString() ?? '',
    },
    retailUnit: {
      name: retail?.name ?? 'Viên',
      conversion: '1',
      price: retail?.price?.toString() ?? '',
    },
  }
}

const toPriceNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

const toUiUnitsFromProductUnits = (units: ProductUnitItem[]): Unit[] => {
  const active = units
    .filter((unit) => unit.is_active)
    .sort((a, b) => a.conversion_rate - b.conversion_rate)

  if (!active.length) return []

  if (active.length === 1) {
    const retail = active[0]
    return [
      {
        id: retail.id,
        name: retail.unit_name,
        conversion: 1,
        price: toPriceNumber(retail.selling_price),
        level: 'retail',
      },
    ]
  }

  if (active.length === 2) {
    const retail = active[0]
    const importUnit = active[1]
    return [
      {
        id: retail.id,
        name: retail.unit_name,
        conversion: 1,
        price: toPriceNumber(retail.selling_price),
        level: 'retail',
      },
      {
        id: importUnit.id,
        name: importUnit.unit_name,
        conversion: Math.max(1, importUnit.conversion_rate),
        price: toPriceNumber(importUnit.selling_price),
        level: 'import',
      },
    ]
  }

  const retail = active[0]
  const intermediate = active[active.length - 2]
  const importUnit = active[active.length - 1]
  return [
    {
      id: retail.id,
      name: retail.unit_name,
      conversion: 1,
      price: toPriceNumber(retail.selling_price),
      level: 'retail',
    },
    {
      id: intermediate.id,
      name: intermediate.unit_name,
      conversion: Math.max(1, intermediate.conversion_rate),
      price: toPriceNumber(intermediate.selling_price),
      level: 'intermediate',
    },
    {
      id: importUnit.id,
      name: importUnit.unit_name,
      conversion: Math.max(1, importUnit.conversion_rate),
      price: toPriceNumber(importUnit.selling_price),
      level: 'import',
    },
  ]
}

const mapProductDetailToDrug = (item: ProductDetailItem): Drug => {
  const units = toUiUnitsFromProductUnits(item.units)
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    activeIngredient: item.active_ingredient ?? '',
    regNo: item.registration_number ?? '',
    category: '-',
    vatRate: toPriceNumber(item.vat_rate),
    otherTaxRate: toPriceNumber(item.other_tax_rate),
    groupId: item.group?.id ?? null,
    group: item.group?.name ?? '-',
    makerId: item.manufacturer?.id ?? null,
    maker: item.manufacturer?.name ?? '-',
    barcode: item.barcode ?? '',
    usage: item.instructions ?? '',
    note: item.note ?? '',
    units,
    active: item.is_active,
    hasTransactions: false,
  }
}

type DesiredUnit = {
  name: string
  conversion: number
  price: number
  level: Unit['level']
}

const buildDesiredUnits = (form: FormState): DesiredUnit[] => {
  const result: DesiredUnit[] = [
    {
      name: form.retailUnit.name.trim(),
      conversion: 1,
      price: toNumber(form.retailUnit.price),
      level: 'retail',
    },
  ]

  if (!form.singleUnit) {
    const importConversion = toNumber(form.importUnit.conversion)
    if (form.hasIntermediate) {
      const intermediateConversion = toNumber(form.intermediateUnit.conversion)
      result.push(
        {
          name: form.intermediateUnit.name.trim(),
          conversion: intermediateConversion,
          price: toNumber(form.intermediateUnit.price),
          level: 'intermediate',
        },
        {
          name: form.importUnit.name.trim(),
          conversion: importConversion * intermediateConversion,
          price: toNumber(form.importUnit.price),
          level: 'import',
        },
      )
    } else {
      result.push({
        name: form.importUnit.name.trim(),
        conversion: importConversion,
        price: toNumber(form.importUnit.price),
        level: 'import',
      })
    }
  }

  return result
}

const normalizeGroupKey = (value: string) => value.trim().toLocaleLowerCase('vi-VN')
const loadDrugFormDraft = (): Partial<FormState> | null =>
  readLocalDraft<Partial<FormState>>(DRUG_FORM_DRAFT_STORAGE_KEY)

const normalizeMatchText = (value: string) =>
  value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeCompanyKey = (value: string) => {
  const text = normalizeMatchText(value)
  if (!text) return ''
  const stopWords = new Set([
    'cong',
    'ty',
    'co',
    'phan',
    'trach',
    'nhiem',
    'huu',
    'han',
    'tnhh',
    'mtv',
    'cp',
    'duoc',
    'pham',
  ])
  return text
    .split(' ')
    .filter((token) => token && !stopWords.has(token))
    .join(' ')
}

const findBestMakerId = (rawName: string, makers: ManufacturerItem[]) => {
  const source = rawName.trim()
  if (!source) return ''
  const sourceKey = normalizeMatchText(source)
  const sourceCompanyKey = normalizeCompanyKey(source)
  if (!sourceKey) return ''

  const exact = makers.find((item) => normalizeMatchText(item.name) === sourceKey)
  if (exact) return exact.id

  if (sourceCompanyKey) {
    const companyExact = makers.find((item) => normalizeCompanyKey(item.name) === sourceCompanyKey)
    if (companyExact) return companyExact.id
  }

  const partial = makers.find((item) => {
    const nameKey = normalizeMatchText(item.name)
    if (nameKey.includes(sourceKey) || sourceKey.includes(nameKey)) return true
    if (!sourceCompanyKey) return false
    const companyKey = normalizeCompanyKey(item.name)
    return Boolean(companyKey) && (companyKey.includes(sourceCompanyKey) || sourceCompanyKey.includes(companyKey))
  })
  return partial?.id ?? ''
}

const combineActiveIngredientText = (activeIngredient: string | null, strength: string | null) => {
  const ingredient = (activeIngredient ?? '').trim()
  const dose = (strength ?? '').trim()
  if (!ingredient) return dose
  if (!dose) return ingredient
  return ingredient.toLocaleLowerCase('vi-VN').includes(dose.toLocaleLowerCase('vi-VN'))
    ? ingredient
    : `${ingredient} ${dose}`
}

const applyReferenceUnitHintToForm = (
  prev: FormState,
  unitHint: DrugReferenceItem['unit_hint'],
): FormState => {
  if (!unitHint) return prev

  const retailName = unitHint.retail_unit_name?.trim() || prev.retailUnit.name

  if (unitHint.single_unit) {
    return {
      ...prev,
      singleUnit: true,
      hasIntermediate: false,
      retailUnit: {
        ...prev.retailUnit,
        name: retailName,
        conversion: '1',
      },
    }
  }

  const importName = unitHint.import_unit_name?.trim() || prev.importUnit.name
  const importConversion = Math.max(1, Number(unitHint.import_conversion ?? 1))

  if (unitHint.has_intermediate) {
    const intermediateName = unitHint.intermediate_unit_name?.trim() || prev.intermediateUnit.name
    const intermediateConversion = Math.max(1, Number(unitHint.intermediate_conversion ?? 1))
    return {
      ...prev,
      singleUnit: false,
      hasIntermediate: true,
      importUnit: {
        ...prev.importUnit,
        name: importName,
        conversion: importConversion.toString(),
      },
      intermediateUnit: {
        ...prev.intermediateUnit,
        name: intermediateName,
        conversion: intermediateConversion.toString(),
      },
      retailUnit: {
        ...prev.retailUnit,
        name: retailName,
        conversion: '1',
      },
    }
  }

  return {
    ...prev,
    singleUnit: false,
    hasIntermediate: false,
    importUnit: {
      ...prev.importUnit,
      name: importName,
      conversion: importConversion.toString(),
    },
    retailUnit: {
      ...prev.retailUnit,
      name: retailName,
      conversion: '1',
    },
  }
}

const buildReferenceNote = (reference: DrugReferenceItem) => {
  const parts = [
    reference.registration_number ? `SDK: ${reference.registration_number}` : '',
    reference.manufacturer ? `NSX: ${reference.manufacturer}` : '',
    reference.manufacturer_country ? `Nước SX: ${reference.manufacturer_country}` : '',
  ].filter(Boolean)
  return parts.length ? `Tham chiếu Bộ Y tế - ${parts.join(' | ')}` : ''
}

// ============================================================
// Barcode Scanning Engine (Quagga2)
//
// Ưu tiên: Quagga2 (nhạy với barcode 1D, nhiều tuỳ chỉnh)
// - Live stream + locate: true
// - Có nút "Chụp & quét" để chủ động quét khi cần
// ============================================================

const QUAGGA_READERS = ['ean_reader', 'upc_reader']
const QUAGGA_AREA = { top: '35%', right: '10%', left: '10%', bottom: '35%' }
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
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const canManage = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'
  const canDelete = isOwnerOrAdmin(user)

  const [drugs, setDrugs] = useState<Drug[]>(initialDrugs)
  const [groupOptions, setGroupOptions] = useState<DrugGroupItem[]>([])
  const [groupCategoryById, setGroupCategoryById] = useState<Record<string, string>>({})
  const [groupIdsByCategory, setGroupIdsByCategory] = useState<Record<string, string[]>>({})
  const [groupTaxById, setGroupTaxById] = useState<
    Record<string, { vatRate: number; otherTaxRate: number }>
  >({})
  const [makerOptions, setMakerOptions] = useState<ManufacturerItem[]>([])
  const [inventoryStats, setInventoryStats] = useState<{ lowStock: number; nearDate: number }>({
    lowStock: 0,
    nearDate: 0,
  })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  const [barcodeSearch, setBarcodeSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('Tất cả')
  const [makerFilter, setMakerFilter] = useState('Tất cả')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState<FormState>(emptyForm())
  const [makerQuery, setMakerQuery] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [referenceQuery, setReferenceQuery] = useState('')
  const [referenceResults, setReferenceResults] = useState<DrugReferenceItem[]>([])
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [unitSectionTouched, setUnitSectionTouched] = useState(false)
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
  const referenceSearchRequestRef = useRef(0)
  const scanTargetRef = useRef<ScanTarget>('search')
  const scanActiveRef = useRef(false)
  const scanStabilityRef = useRef<{ value: string; count: number; lastSeen: number } | null>(null)

  const clearDrugFormDraft = useCallback(() => {
    removeLocalDraft(DRUG_FORM_DRAFT_STORAGE_KEY)
  }, [])

  const pageSize = 6

  const getApiErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (error instanceof ApiError) {
      if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
      if (error.status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
      return error.message || fallback
    }
    return fallback
  }, [])

  const loadCatalogData = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const fetchAllProducts = async () => {
        const allProducts: Array<{ id: string }> = []
        let currentPage = 1
        let totalPages = 1

        while (currentPage <= totalPages) {
          const pageResponse = await catalogApi.listProducts(accessToken, {
            page: currentPage,
            size: 200,
          })
          allProducts.push(...pageResponse.items.map((item) => ({ id: item.id })))
          totalPages = Math.max(1, pageResponse.pages)
          currentPage += 1
        }
        return allProducts
      }

      const fetchAllManufacturers = async () => {
        const allMakers: ManufacturerItem[] = []
        let currentPage = 1
        let totalPages = 1

        while (currentPage <= totalPages) {
          const pageResponse = await catalogApi.listManufacturers(accessToken, {
            is_active: true,
            page: currentPage,
            size: 200,
          })
          allMakers.push(...pageResponse.items)
          totalPages = Math.max(1, pageResponse.pages)
          currentPage += 1
        }
        return allMakers
      }

      const [groupPage, allManufacturers, products, stockSummary] = await Promise.all([
        catalogApi.listDrugGroups(accessToken, { is_active: true, page: 1, size: 200 }),
        fetchAllManufacturers(),
        fetchAllProducts(),
        inventoryApi.getStockSummary(accessToken).catch(() => []),
      ])

      let resolvedGroups = groupPage.items
      const groupCategoryByName: Record<string, string> = {}
      const groupTaxByName: Record<string, { vatRate: number; otherTaxRate: number }> = {}
      let storeCategories: Array<{
        name: string
        groups: Array<{
          name: string
          is_active: boolean
          vat_rate: number | string
          other_tax_rate: number | string
        }>
      }> = []

      try {
        const storeCategoryPage = await storeApi.listDrugCategories({
          include_inactive: false,
        })
        storeCategories = storeCategoryPage.items.map((category) => ({
          name: category.name.trim(),
          groups: category.groups.map((group) => ({
            name: group.name.trim(),
            is_active: group.is_active,
            vat_rate: group.vat_rate,
            other_tax_rate: group.other_tax_rate,
          })),
        }))

        const catalogGroupByKey = new Map(
          resolvedGroups.map((group) => [normalizeGroupKey(group.name), group]),
        )

        const uniqueStoreGroupNames = Array.from(
          new Set(
            storeCategoryPage.items.flatMap((category) => {
              const categoryName = category.name.trim()
              return category.groups
                .filter((group) => group.is_active)
                .map((group) => {
                  const normalizedGroupName = normalizeGroupKey(group.name)
                  if (normalizedGroupName && !groupCategoryByName[normalizedGroupName]) {
                    groupCategoryByName[normalizedGroupName] = categoryName || '-'
                  }
                  if (normalizedGroupName && !groupTaxByName[normalizedGroupName]) {
                    groupTaxByName[normalizedGroupName] = {
                      vatRate: toPriceNumber(group.vat_rate),
                      otherTaxRate: toPriceNumber(group.other_tax_rate),
                    }
                  }
                  return group.name.trim()
                })
                .filter(Boolean)
            }),
          ),
        )

        if (canManage && uniqueStoreGroupNames.length > 0) {
          let hasSyncedNewGroup = false
          for (const groupName of uniqueStoreGroupNames) {
            const groupKey = normalizeGroupKey(groupName)
            if (catalogGroupByKey.has(groupKey)) continue
            try {
              const createdGroup = await catalogApi.createDrugGroup(accessToken, {
                name: groupName,
                description: null,
                is_active: true,
              })
              catalogGroupByKey.set(groupKey, createdGroup)
              hasSyncedNewGroup = true
            } catch (syncError) {
              if (!(syncError instanceof ApiError) || syncError.status >= 500) {
                throw syncError
              }
            }
          }

          if (hasSyncedNewGroup) {
            const refreshedGroups = await catalogApi.listDrugGroups(accessToken, {
              is_active: true,
              page: 1,
              size: 200,
            })
            resolvedGroups = refreshedGroups.items
          }
        }
      } catch (syncError) {
        console.warn('Skip syncing drug groups from store service:', syncError)
      }

      const details = await Promise.all(
        products.map((item) => catalogApi.getProduct(accessToken, item.id)),
      )

      const nextGroupCategoryById = resolvedGroups.reduce<Record<string, string>>((acc, group) => {
        acc[group.id] = groupCategoryByName[normalizeGroupKey(group.name)] ?? '-'
        return acc
      }, {})
      const nextGroupTaxById = resolvedGroups.reduce<
        Record<string, { vatRate: number; otherTaxRate: number }>
      >((acc, group) => {
        const byName = groupTaxByName[normalizeGroupKey(group.name)]
        acc[group.id] = byName ?? { vatRate: 0, otherTaxRate: 0 }
        return acc
      }, {})
      const catalogGroupByKey = new Map(
        resolvedGroups.map((group) => [normalizeGroupKey(group.name), group]),
      )
      const nextGroupIdsByCategory: Record<string, string[]> = {}
      for (const category of storeCategories) {
        if (!category.name) continue
        const uniqueIds = new Set<string>()
        for (const group of category.groups) {
          if (!group.is_active) continue
          const normalizedGroupName = normalizeGroupKey(group.name)
          const catalogGroup = catalogGroupByKey.get(normalizedGroupName)
          if (!catalogGroup) continue
          uniqueIds.add(catalogGroup.id)

          // 1 group có thể xuất hiện ở nhiều category.
          // Map này chỉ dùng fallback khi không có category được chọn.
          if (!nextGroupCategoryById[catalogGroup.id]) {
            nextGroupCategoryById[catalogGroup.id] = category.name
          }
          if (!nextGroupTaxById[catalogGroup.id]) {
            nextGroupTaxById[catalogGroup.id] = {
              vatRate: toPriceNumber(group.vat_rate),
              otherTaxRate: toPriceNumber(group.other_tax_rate),
            }
          }
        }
        if (uniqueIds.size) {
          nextGroupIdsByCategory[category.name] = Array.from(uniqueIds)
        }
      }

      setGroupOptions(
        resolvedGroups
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, 'vi-VN')),
      )
      setGroupCategoryById(nextGroupCategoryById)
      setGroupIdsByCategory(nextGroupIdsByCategory)
      setGroupTaxById(nextGroupTaxById)
      setMakerOptions(
        allManufacturers
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, 'vi-VN')),
      )
      setInventoryStats({
        lowStock: stockSummary.filter(
          (item) => item.status === 'low_stock' || item.status === 'out_of_stock',
        ).length,
        nearDate: stockSummary.filter(
          (item) => item.status === 'near_date' || item.status === 'expiring_soon',
        ).length,
      })
      setDrugs(
        details.map((item) => {
          const mapped = mapProductDetailToDrug(item)
          const groupTax = mapped.groupId ? nextGroupTaxById[mapped.groupId] : undefined
          return {
            ...mapped,
            category: mapped.groupId
              ? (nextGroupCategoryById[mapped.groupId] ?? '-')
              : (groupCategoryByName[normalizeGroupKey(mapped.group)] ?? '-'),
            vatRate: groupTax?.vatRate ?? mapped.vatRate,
            otherTaxRate: groupTax?.otherTaxRate ?? mapped.otherTaxRate,
          }
        }),
      )
    } catch (error) {
      setAlert(getApiErrorMessage(error, 'Không thể tải danh mục thuốc từ cơ sở dữ liệu.'))
    } finally {
      setLoading(false)
    }
  }, [accessToken, canManage, getApiErrorMessage])

  useEffect(() => {
    void loadCatalogData()
  }, [loadCatalogData])

  const syncProductUnits = useCallback(
    async (productId: string, existingUnits: ProductUnitItem[], desiredUnits: DesiredUnit[]) => {
      if (!accessToken) return
      const baseDesired = desiredUnits.find((item) => item.level === 'retail')
      if (!baseDesired) return

      const baseUnit = existingUnits.find((item) => item.is_base_unit) ?? existingUnits[0]
      if (baseUnit) {
        await catalogApi.updateProductUnit(accessToken, productId, baseUnit.id, {
          unit_name: baseDesired.name,
          conversion_rate: 1,
          selling_price: baseDesired.price,
          barcode: null,
          is_base_unit: true,
          is_active: true,
        })
      }

      const desiredNonBase = desiredUnits
        .filter((item) => item.level !== 'retail')
        .sort((a, b) => a.conversion - b.conversion)
      const activeNonBase = existingUnits
        .filter((item) => !item.is_base_unit && item.is_active)
        .sort((a, b) => a.conversion_rate - b.conversion_rate)

      for (let index = 0; index < desiredNonBase.length; index += 1) {
        const desired = desiredNonBase[index]
        const existing = activeNonBase[index]
        if (existing) {
          await catalogApi.updateProductUnit(accessToken, productId, existing.id, {
            unit_name: desired.name,
            conversion_rate: desired.conversion,
            selling_price: desired.price,
            barcode: null,
            is_active: true,
          })
        } else {
          await catalogApi.createProductUnit(accessToken, productId, {
            unit_name: desired.name,
            conversion_rate: desired.conversion,
            selling_price: desired.price,
            barcode: null,
            is_base_unit: false,
            is_active: true,
          })
        }
      }

      for (let index = desiredNonBase.length; index < activeNonBase.length; index += 1) {
        await catalogApi.deleteProductUnit(accessToken, productId, activeNonBase[index].id)
      }
    },
    [accessToken],
  )

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const barcodeKey = barcodeSearch.trim().toLowerCase()
    return drugs.filter((drug) => {
      const matchKeyword =
        !keyword ||
        [drug.code, drug.name, drug.activeIngredient, drug.regNo, drug.barcode, drug.maker]
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      const matchBarcode =
        !barcodeKey ||
        drug.barcode.toLowerCase().includes(barcodeKey)
      const matchGroup = groupFilter === 'Tất cả' || drug.groupId === groupFilter
      const matchMaker = makerFilter === 'Tất cả' || drug.makerId === makerFilter
      return matchKeyword && matchBarcode && matchGroup && matchMaker
    })
  }, [drugs, search, barcodeSearch, groupFilter, makerFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize)

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages))
  }, [totalPages])

  const stats = [
    { label: 'Tổng thuốc', value: drugs.length.toString(), note: `${groupOptions.length} nhóm` },
    { label: 'Sắp hết hàng', value: inventoryStats.lowStock.toString(), note: 'dưới ngưỡng' },
    { label: 'Cận date', value: inventoryStats.nearDate.toString(), note: 'sắp đến hạn' },
    { label: 'Đang bán', value: drugs.filter((d) => d.active).length.toString(), note: 'đang hoạt động' },
  ]

  const conversionHint = useMemo(() => {
    const retailName = form.retailUnit.name.trim() || 'đơn vị bán lẻ'
    if (form.singleUnit) return `Sản phẩm chỉ có 1 đơn vị: ${retailName}.`

    const importName = form.importUnit.name.trim() || 'đơn vị bán sỉ'
    const importConversion = parsePositive(form.importUnit.conversion)
    if (!importConversion) return 'Quy đổi tự động: nhập quy đổi để xem công thức.'

    if (!form.hasIntermediate) {
      return `1 ${importName} = ${importConversion} ${retailName}.`
    }

    const intermediateName = form.intermediateUnit.name.trim() || 'đơn vị trung gian'
    const intermediateConversion = parsePositive(form.intermediateUnit.conversion)
    if (!intermediateConversion) return 'Quy đổi tự động: nhập quy đổi đơn vị trung gian để xem công thức.'

    const total = importConversion * intermediateConversion
    return `1 ${importName} = ${importConversion} ${intermediateName}; 1 ${intermediateName} = ${intermediateConversion} ${retailName}; tổng: 1 ${importName} = ${total} ${retailName}.`
  }, [
    form.singleUnit,
    form.hasIntermediate,
    form.importUnit.name,
    form.importUnit.conversion,
    form.intermediateUnit.name,
    form.intermediateUnit.conversion,
    form.retailUnit.name,
  ])

  const categoryOptions = useMemo(
    () => {
      const fromStore = Object.keys(groupIdsByCategory).filter(Boolean)
      if (fromStore.length) {
        return fromStore.sort((a, b) => a.localeCompare(b, 'vi-VN'))
      }
      return Array.from(
        new Set(
          groupOptions
            .map((group) => groupCategoryById[group.id] ?? '')
            .filter((name): name is string => Boolean(name && name !== '-')),
        ),
      ).sort((a, b) => a.localeCompare(b, 'vi-VN'))
    },
    [groupIdsByCategory, groupOptions, groupCategoryById],
  )

  const filteredGroupOptions = useMemo(() => {
    if (!form.groupCategory) return groupOptions
    const ids = groupIdsByCategory[form.groupCategory]
    if (ids?.length) {
      const idSet = new Set(ids)
      return groupOptions.filter((group) => idSet.has(group.id))
    }
    return groupOptions.filter((group) => (groupCategoryById[group.id] ?? '-') === form.groupCategory)
  }, [form.groupCategory, groupIdsByCategory, groupOptions, groupCategoryById])

  const selectedGroupCategory = useMemo(() => {
    if (form.groupCategory) return form.groupCategory
    if (!form.groupId) return '-'
    const fromStore = Object.entries(groupIdsByCategory).find(([, ids]) => ids.includes(form.groupId))
    if (fromStore?.[0]) return fromStore[0]
    return groupCategoryById[form.groupId] ?? '-'
  }, [form.groupCategory, form.groupId, groupIdsByCategory, groupCategoryById])

  const selectedGroupTax = useMemo(() => {
    if (!form.groupId) return null
    return groupTaxById[form.groupId] ?? null
  }, [form.groupId, groupTaxById])

  const selectedMakerName = useMemo(() => {
    if (!form.makerId) return ''
    return makerOptions.find((maker) => maker.id === form.makerId)?.name ?? ''
  }, [form.makerId, makerOptions])

  const resolveMakerIdByQuery = useCallback(
    (query: string) => {
      return findBestMakerId(query, makerOptions)
    },
    [makerOptions],
  )

  const handleMakerQueryChange = useCallback(
    (value: string) => {
      setMakerQuery(value)
      const makerId = resolveMakerIdByQuery(value)
      updateForm('makerId', makerId)
    },
    [resolveMakerIdByQuery],
  )

  const handleGroupCategoryChange = (groupCategory: string) => {
    setForm((prev) => {
      const preferredIds = groupIdsByCategory[groupCategory] ?? []
      const firstGroupId = preferredIds[0] ??
        groupOptions.find((group) => (groupCategoryById[group.id] ?? '-') === groupCategory)?.id
      return {
        ...prev,
        groupCategory,
        groupId: firstGroupId ?? '',
      }
    })
  }

  const handleGroupChange = (groupId: string) => {
    setForm((prev) => ({
      ...prev,
      groupId,
      groupCategory: groupId ? (groupCategoryById[groupId] ?? prev.groupCategory) : prev.groupCategory,
    }))
  }

  const openCreate = () => {
    if (!canManage) {
      setAlert('Bạn không có quyền thêm thuốc.')
      return
    }
    setErrors({})
    setReferenceQuery('')
    setReferenceResults([])
    setReferenceError(null)
    setUnitSectionTouched(false)
    const fallback = emptyForm('', makerOptions[0]?.id ?? '', '')
    const draft = loadDrugFormDraft()
    if (!draft) {
      setForm(fallback)
      setMakerQuery(fallback.makerId ? (makerOptions.find((item) => item.id === fallback.makerId)?.name ?? '') : '')
      setUnitSectionTouched(false)
      setModalOpen(true)
      return
    }
    const nextForm: FormState = {
      ...fallback,
      ...draft,
      id: undefined,
      importUnit: {
        ...fallback.importUnit,
        ...(draft.importUnit ?? {}),
      },
      intermediateUnit: {
        ...fallback.intermediateUnit,
        ...(draft.intermediateUnit ?? {}),
      },
      retailUnit: {
        ...fallback.retailUnit,
        ...(draft.retailUnit ?? {}),
      },
    }
    setForm(nextForm)
    setMakerQuery(
      nextForm.makerId ? (makerOptions.find((item) => item.id === nextForm.makerId)?.name ?? '') : '',
    )
    // Chỉ đánh dấu "đã chạm đơn vị" khi người dùng sửa trong phiên hiện tại.
    // Draft cũ không nên chặn auto-fill từ tra cứu Bộ Y tế.
    setUnitSectionTouched(false)
    setModalOpen(true)
  }

  const openEdit = (drug: Drug) => {
    if (!canManage) {
      setAlert('Bạn không có quyền chỉnh sửa thuốc.')
      return
    }
    setErrors({})
    setReferenceQuery('')
    setReferenceResults([])
    setReferenceError(null)
    setUnitSectionTouched(false)
    const unitForm = inferFormFromDrug(drug)
    setForm({
      id: drug.id,
      code: drug.code,
      name: drug.name,
      activeIngredient: drug.activeIngredient,
      regNo: drug.regNo,
      groupCategory:
        (drug.groupId ? (groupCategoryById[drug.groupId] ?? '') : '') ||
        (drug.category !== '-' ? drug.category : ''),
      groupId: drug.groupId ?? '',
      makerId: drug.makerId ?? '',
      barcode: drug.barcode,
      usage: drug.usage,
      note: drug.note,
      active: drug.active,
      ...unitForm,
    })
    setMakerQuery(drug.maker || '')
    setModalOpen(true)
  }

  const removeDrug = async (drug: Drug) => {
    if (!accessToken) {
      setAlert('Bạn cần đăng nhập để xóa thuốc.')
      return
    }
    if (!canDelete) {
      setAlert('Chỉ owner/admin mới có quyền xóa thuốc.')
      return
    }
    if (!window.confirm(`Xóa thuốc ${drug.name}?`)) {
      return
    }
    try {
      await catalogApi.deleteProduct(accessToken, drug.id)
      await loadCatalogData()
      setAlert('Đã xóa thuốc.')
    } catch (error) {
      setAlert(getApiErrorMessage(error, 'Không thể xóa thuốc.'))
    }
  }

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const updateUnit = (
    scope: 'importUnit' | 'intermediateUnit' | 'retailUnit',
    field: keyof FormUnit,
    value: string,
    options?: { markTouched?: boolean },
  ) => {
    if (options?.markTouched !== false) {
      setUnitSectionTouched(true)
    }
    setForm((prev) => ({
      ...prev,
      [scope]: {
        ...prev[scope],
        [field]: field === 'conversion' && scope === 'retailUnit' ? '1' : value,
      },
    }))
  }

  const updateSingleUnit = (next: boolean, options?: { markTouched?: boolean }) => {
    if (options?.markTouched !== false) {
      setUnitSectionTouched(true)
    }
    setForm((prev) => ({
      ...prev,
      singleUnit: next,
      hasIntermediate: next ? false : prev.hasIntermediate,
      retailUnit: {
        ...prev.retailUnit,
        conversion: '1',
      },
    }))
  }

  const updateHasIntermediate = (next: boolean, options?: { markTouched?: boolean }) => {
    if (options?.markTouched !== false) {
      setUnitSectionTouched(true)
    }
    setForm((prev) => ({
      ...prev,
      hasIntermediate: next,
    }))
  }

  useEffect(() => {
    if (!modalOpen || Boolean(form.id)) return
    writeLocalDraft(DRUG_FORM_DRAFT_STORAGE_KEY, form)
  }, [form, modalOpen])

  useEffect(() => {
    if (modalOpen) return
    setMakerQuery('')
    setReferenceQuery('')
    setReferenceResults([])
    setReferenceError(null)
    setReferenceLoading(false)
    setUnitSectionTouched(false)
  }, [modalOpen])

  useEffect(() => {
    if (!modalOpen) return
    if (!form.makerId) return
    if (makerQuery.trim()) return
    if (!selectedMakerName) return
    setMakerQuery(selectedMakerName)
  }, [modalOpen, form.makerId, makerQuery, selectedMakerName])

  useEffect(() => {
    if (!modalOpen || !accessToken) return
    const query = referenceQuery.trim()
    if (query.length < 2) {
      setReferenceResults([])
      setReferenceLoading(false)
      setReferenceError(null)
      return
    }

    const requestId = referenceSearchRequestRef.current + 1
    referenceSearchRequestRef.current = requestId
    setReferenceLoading(true)
    setReferenceError(null)

    const timeoutId = window.setTimeout(() => {
      void catalogApi
        .searchDrugReferences(accessToken, { q: query, limit: 8 })
        .then((items) => {
          if (referenceSearchRequestRef.current !== requestId) return
          setReferenceResults(items)
        })
        .catch((error: unknown) => {
          if (referenceSearchRequestRef.current !== requestId) return
          const message = getApiErrorMessage(error, 'Không thể tra cứu dữ liệu tham chiếu Bộ Y tế.')
          setReferenceError(message)
          setReferenceResults([])
        })
        .finally(() => {
          if (referenceSearchRequestRef.current !== requestId) return
          setReferenceLoading(false)
        })
    }, 280)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [modalOpen, accessToken, referenceQuery, getApiErrorMessage])

  const applyReferenceSuggestion = useCallback(
    (reference: DrugReferenceItem) => {
      const referenceManufacturerName = (reference.manufacturer ?? '').trim()
      const matchedMakerId = findBestMakerId(referenceManufacturerName, makerOptions)

      setErrors((prev) => {
        const next = { ...prev }
        delete next.name
        delete next.regNo
        delete next.maker
        delete next['retail-name']
        delete next['import-name']
        delete next['intermediate-name']
        return next
      })
      setForm((prev) => {
        const noteSuggestion = buildReferenceNote(reference)
        const next: FormState = {
          ...prev,
          name: reference.name?.trim() || prev.name,
          activeIngredient: combineActiveIngredientText(
            reference.active_ingredient ?? null,
            reference.strength ?? null,
          ) || prev.activeIngredient,
          regNo: reference.registration_number?.trim() || prev.regNo,
          makerId: matchedMakerId,
          note: prev.note.trim() ? prev.note : noteSuggestion || prev.note,
        }
        if (unitSectionTouched) {
          return next
        }
        return applyReferenceUnitHintToForm(next, reference.unit_hint)
      })
      setMakerQuery(
        matchedMakerId
          ? (makerOptions.find((item) => item.id === matchedMakerId)?.name ?? referenceManufacturerName)
          : '',
      )
      setReferenceQuery(`${reference.registration_number} - ${reference.name}`)
      setReferenceResults([])
      setReferenceError(null)
    },
    [makerOptions, unitSectionTouched],
  )

  const validate = () => {
    const next: Record<string, string> = {}
    if (!form.name.trim()) next.name = 'Bắt buộc'
    if (!form.regNo.trim()) next.regNo = 'Bắt buộc'
    if (!form.groupId) next.group = 'Bắt buộc'
    if (!form.makerId) next.maker = 'Bắt buộc'
    const retailPrice = parsePositive(form.retailUnit.price)
    if (!form.retailUnit.name.trim()) next['retail-name'] = 'Bắt buộc'
    if (!retailPrice) next['retail-price'] = 'Giá bán không hợp lệ'

    if (!form.singleUnit) {
      const importConversion = parsePositive(form.importUnit.conversion)
      const importPrice = parsePositive(form.importUnit.price)
      if (!form.importUnit.name.trim()) next['import-name'] = 'Bắt buộc'
      if (!importConversion) next['import-conversion'] = 'Quy đổi phải lớn hơn 0'
      if (!importPrice) next['import-price'] = 'Giá bán không hợp lệ'

      if (form.hasIntermediate) {
        const intermediateConversion = parsePositive(form.intermediateUnit.conversion)
        const intermediatePrice = parsePositive(form.intermediateUnit.price)
        if (!form.intermediateUnit.name.trim()) next['intermediate-name'] = 'Bắt buộc'
        if (!intermediateConversion) next['intermediate-conversion'] = 'Quy đổi phải lớn hơn 0'
        if (!intermediatePrice) next['intermediate-price'] = 'Giá bán không hợp lệ'
      }
    }

    const selectedNames = [form.retailUnit.name.trim().toLowerCase()]
    if (!form.singleUnit) {
      selectedNames.push(form.importUnit.name.trim().toLowerCase())
      if (form.hasIntermediate) selectedNames.push(form.intermediateUnit.name.trim().toLowerCase())
    }
    const unique = new Set(selectedNames.filter(Boolean))
    if (unique.size !== selectedNames.filter(Boolean).length) {
      next['unit-duplicate'] = 'Tên đơn vị không được trùng nhau.'
    }

    setErrors(next)
    return Object.keys(next).length === 0
  }

  const saveDrug = async () => {
    if (!accessToken) {
      setAlert('Bạn cần đăng nhập để lưu thuốc.')
      return
    }
    if (!canManage) {
      setAlert('Bạn không có quyền cập nhật danh mục thuốc.')
      return
    }
    if (!validate()) return

    setSaving(true)
    try {
      const desiredUnits = buildDesiredUnits(form)
      const baseUnit = desiredUnits.find((item) => item.level === 'retail')
      const selectedGroupTax = form.groupId ? groupTaxById[form.groupId] : undefined
      if (!baseUnit) {
        setAlert('Không thể xác định đơn vị bán lẻ.')
        return
      }

      const productPayload = {
        name: form.name.trim(),
        active_ingredient: form.activeIngredient.trim() || null,
        registration_number: form.regNo.trim() || null,
        group_id: form.groupId || null,
        manufacturer_id: form.makerId || null,
        barcode: form.barcode.trim() || null,
        instructions: form.usage.trim() || null,
        note: form.note.trim() || null,
        vat_rate: selectedGroupTax?.vatRate ?? 0,
        other_tax_rate: selectedGroupTax?.otherTaxRate ?? 0,
        is_active: form.active,
      }

      if (form.id) {
        const updated = await catalogApi.updateProduct(accessToken, form.id, productPayload)
        await syncProductUnits(updated.id, updated.units, desiredUnits)
        setAlert('Đã cập nhật thuốc.')
      } else {
        const created = await catalogApi.createProduct(accessToken, {
          ...productPayload,
          base_unit: {
            unit_name: baseUnit.name,
            selling_price: baseUnit.price,
          },
        })
        await syncProductUnits(created.id, created.units, desiredUnits)
        clearDrugFormDraft()
        setAlert('Đã thêm thuốc.')
      }

      setModalOpen(false)
      setErrors({})
      await loadCatalogData()
    } catch (error) {
      setAlert(getApiErrorMessage(error, 'Không thể lưu thuốc.'))
    } finally {
      setSaving(false)
    }
  }

  const exportCsv = () => {
    const rows = drugs.map((drug) => {
      const unitData = drug.units
        .map((unit) => `${unit.name}=${unit.conversion}:${unit.price}`)
        .join('|')
      return [
        drug.code,
        drug.name,
        drug.activeIngredient,
        drug.regNo,
        drug.category,
        drug.group,
        drug.maker,
        drug.barcode,
        drug.active ? 'Đang bán' : 'Ngừng bán',
        unitData,
      ]
    })
    downloadCsv(
      'danh-muc-thuoc.csv',
      ['M\u00e3 thu\u1ed1c', 'T\u00ean thu\u1ed1c', 'Ho\u1ea1t ch\u1ea5t', 'S\u1ed1 \u0111\u0103ng k\u00fd', 'Lo\u1ea1i thu\u1ed1c', 'Nh\u00f3m', 'NSX', 'Barcode', 'Tr\u1ea1ng th\u00e1i', '\u0110\u01a1n v\u1ecb'],
      rows,
    )
  }

  const normalizeImportText = (value: string) =>
    value
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '')

  const parseImportedUnits = (raw: string): DesiredUnit[] => {
    if (!raw.trim()) {
      return [{ name: 'Vien', conversion: 1, price: 0, level: 'retail' }]
    }

    const parsed = raw
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [namePart = '', payloadPart = ''] = item.split('=')
        const [conversionPart = '1', pricePart = '0'] = payloadPart.split(':')
        const conversion = Number(conversionPart.replace(/[^\d.-]/g, ''))
        const price = Number(pricePart.replace(/[^\d.-]/g, ''))
        return {
          name: namePart.trim(),
          conversion: Number.isFinite(conversion) && conversion > 0 ? conversion : 1,
          price: Number.isFinite(price) && price >= 0 ? price : 0,
        }
      })
      .filter((item) => item.name)
      .sort((a, b) => a.conversion - b.conversion)

    if (!parsed.length) {
      return [{ name: 'Vien', conversion: 1, price: 0, level: 'retail' }]
    }

    const baseConversion = parsed[0].conversion > 0 ? parsed[0].conversion : 1
    const normalized = parsed.map((item) => ({
      ...item,
      conversion: Math.max(1, Math.round(item.conversion / baseConversion)),
    }))

    if (normalized.length === 1) {
      return [{ ...normalized[0], conversion: 1, level: 'retail' }]
    }

    if (normalized.length === 2) {
      return [
        { ...normalized[0], conversion: 1, level: 'retail' },
        { ...normalized[1], level: 'import' },
      ]
    }

    const retail = normalized[0]
    const importUnit = normalized[normalized.length - 1]
    const intermediate = normalized[normalized.length - 2]
    return [
      { ...retail, conversion: 1, level: 'retail' },
      { ...intermediate, level: 'intermediate' },
      { ...importUnit, level: 'import' },
    ]
  }

  const readFileText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('Không thể đọc file'))
      reader.readAsText(file, 'utf-8')
    })

  const handleImportExcel = async (file: File | null) => {
    if (!file) return
    setImportFile(file.name)

    if (!accessToken) {
      setAlert('Ban can dang nhap de import du lieu.')
      return
    }

    if (!canManage) {
      setAlert('Bạn không có quyền import danh mục thuốc.')
      return
    }

    if (file.name.toLowerCase().endsWith('.xlsx')) {
      setAlert('Hien tai chi ho tro import file CSV (co the Save As CSV tu Excel).')
      return
    }

    setImporting(true)
    try {
      const text = await readFileText(file)
      const rows = parseDelimitedText(text)
      if (rows.length <= 1) {
        setAlert('File import không có dữ liệu.')
        return
      }

      const header = rows[0].map(normalizeImportText)
      const dataRows = rows.slice(1)
      const findIndex = (...aliases: string[]) => {
        const normalizedAliases = aliases.map(normalizeImportText)
        return header.findIndex((item) => normalizedAliases.includes(item))
      }

      const idxCode = findIndex('Mã thuốc', 'Code')
      const idxName = findIndex('Tên thuốc', 'Name')
      const idxActiveIngredient = findIndex('Hoat chat', 'Active ingredient')
      const idxRegNo = findIndex('Số đăng ký', 'Registration number')
      const idxGroup = findIndex('Nhóm', 'Nhom thuoc', 'Group')
      const idxMaker = findIndex('NSX', 'Nha san xuat', 'Maker')
      const idxBarcode = findIndex('Barcode')
      const idxStatus = findIndex('Trạng thái', 'Status')
      const idxUnits = findIndex('Đơn vị', 'Đơn vị & giá')

      if (idxName < 0) {
        setAlert('Không tìm thấy cột "Tên thuốc" trong file import.')
        return
      }

      const groupByName = new Map(groupOptions.map((item) => [normalizeGroupKey(item.name), item.id]))
      const makerByName = new Map(makerOptions.map((item) => [normalizeGroupKey(item.name), item.id]))
      const existingByCode = new Map<string, { id: string }>(
        drugs
          .filter((item) => item.code)
          .map((item) => [item.code.trim().toUpperCase(), { id: item.id }]),
      )
      const existingByName = new Map<string, { id: string }>(
        drugs.map((item) => [normalizeGroupKey(item.name), { id: item.id }]),
      )

      let created = 0
      let updated = 0
      let skipped = 0
      const failed: string[] = []

      for (const row of dataRows) {
        const name = (row[idxName] ?? '').trim()
        if (!name) {
          skipped += 1
          continue
        }

        try {
          const code = idxCode >= 0 ? (row[idxCode] ?? '').trim().toUpperCase() : ''
          const activeIngredient = idxActiveIngredient >= 0 ? (row[idxActiveIngredient] ?? '').trim() : ''
          const regNo = idxRegNo >= 0 ? (row[idxRegNo] ?? '').trim() : ''
          const groupName = idxGroup >= 0 ? (row[idxGroup] ?? '').trim() : ''
          const makerName = idxMaker >= 0 ? (row[idxMaker] ?? '').trim() : ''
          const barcode = idxBarcode >= 0 ? (row[idxBarcode] ?? '').trim() : ''
          const statusRaw = idxStatus >= 0 ? normalizeImportText(row[idxStatus] ?? '') : ''
          const active = !(statusRaw.includes('ngung') || statusRaw.includes('inactive'))
          const desiredUnits = parseImportedUnits(idxUnits >= 0 ? (row[idxUnits] ?? '') : '')
          const baseUnit = desiredUnits.find((item) => item.level === 'retail')
          if (!baseUnit) {
            skipped += 1
            continue
          }

          const groupId = groupByName.get(normalizeGroupKey(groupName)) ?? null
          const groupTax = groupId ? groupTaxById[groupId] : undefined
          const payload = {
            name,
            active_ingredient: activeIngredient || null,
            registration_number: regNo || null,
            group_id: groupId,
            manufacturer_id: makerByName.get(normalizeGroupKey(makerName)) ?? null,
            barcode: barcode || null,
            instructions: null,
            note: null,
            vat_rate: groupTax?.vatRate ?? 0,
            other_tax_rate: groupTax?.otherTaxRate ?? 0,
            is_active: active,
          }

          const nameKey = normalizeGroupKey(name)
          const existing = (code ? existingByCode.get(code) : undefined) ?? existingByName.get(nameKey)

          if (existing) {
            const updatedProduct = await catalogApi.updateProduct(accessToken, existing.id, payload)
            await syncProductUnits(updatedProduct.id, updatedProduct.units, desiredUnits)
            if (code) existingByCode.set(code, { id: updatedProduct.id })
            existingByName.set(nameKey, { id: updatedProduct.id })
            updated += 1
            continue
          }

          const createdProduct = await catalogApi.createProduct(accessToken, {
            ...payload,
            base_unit: {
              unit_name: baseUnit.name,
              selling_price: baseUnit.price,
            },
          })
          await syncProductUnits(createdProduct.id, createdProduct.units, desiredUnits)
          if (code) existingByCode.set(code, { id: createdProduct.id })
          existingByName.set(nameKey, { id: createdProduct.id })
          created += 1
        } catch (error) {
          failed.push(`${name}: ${getApiErrorMessage(error, 'Không thể import dòng dữ liệu')}`)
        }
      }

      await loadCatalogData()

      const failedPreview = failed.slice(0, 3).join(' | ')
      setAlert(
        `Import hoan tat. Tao moi: ${created}, cap nhat: ${updated}, bo qua: ${skipped}, loi: ${failed.length}` +
          (failedPreview ? `. ${failedPreview}` : ''),
      )
    } catch (error) {
      setAlert(getApiErrorMessage(error, 'Không thể import file danh mục thuốc.'))
    } finally {
      setImporting(false)
    }
  }

  const resetFilters = () => {
    setSearch('')
    setBarcodeSearch('')
    setGroupFilter('Tất cả')
    setMakerFilter('Tất cả')
    setMobileFiltersOpen(false)
    setPage(1)
  }

  // applyScanResult — dùng useCallback + ref để tránh stale closure
  const applyScanResult = useCallback((text: string) => {
    const target = scanTargetRef.current
    if (target === 'search') {
      setBarcodeSearch(text)
    } else {
      setForm((prev) => ({ ...prev, barcode: text }))
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
      : 'Quét barcode thuốc'

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
          <button
            onClick={openCreate}
            disabled={!canManage}
            className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
          >
            Thêm thuốc
          </button>
          <label className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
            Import Excel
            <input
              type="file"
              className="hidden"
              accept=".csv,.xlsx"
              onChange={(event) => {
                const [file] = Array.from(event.target.files ?? [])
                void handleImportExcel(file ?? null)
                event.currentTarget.value = ''
              }}
            />
          </label>
          <button onClick={exportCsv} className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900">
            Export Excel
          </button>
        </div>
      </header>

      {importFile ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-ink-700">
          Đã chọn file: <span className="font-semibold text-ink-900">{importFile}</span>
          {importing ? <span className="ml-2 text-ink-500">Đang import...</span> : null}
        </div>
      ) : null}

      {alert ? (
        <div className="glass-card flex items-center justify-between rounded-2xl px-4 py-3 text-sm text-ink-700">
          <span>{alert}</span>
          <button onClick={() => setAlert(null)} className="text-ink-600">Đóng</button>
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
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            placeholder={'T\u00ecm theo t\u00ean, m\u00e3, s\u1ed1 \u0111\u0103ng k\u00fd'}
          />
          <button
            type="button"
            onClick={() => setMobileFiltersOpen((prev) => !prev)}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 md:hidden"
          >
            {mobileFiltersOpen ? 'Ẩn bộ lọc' : 'Bộ lọc nâng cao'}
          </button>
        </div>

        <div className="hidden gap-3 md:grid md:grid-cols-[1fr,1fr,auto]">
          <select
            value={groupFilter}
            onChange={(e) => {
              setGroupFilter(e.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value={'T\u1ea5t c\u1ea3'}>{'T\u1ea5t c\u1ea3'}</option>
            {groupOptions.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <select
            value={makerFilter}
            onChange={(e) => {
              setMakerFilter(e.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
          >
            <option value={'T\u1ea5t c\u1ea3'}>{'T\u1ea5t c\u1ea3'}</option>
            {makerOptions.map((maker) => <option key={maker.id} value={maker.id}>{maker.name}</option>)}
          </select>
          <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">Reset</button>
        </div>

        {mobileFiltersOpen ? (
          <div className="grid gap-3 md:hidden">
            <select
              value={groupFilter}
              onChange={(e) => {
                setGroupFilter(e.target.value)
                setPage(1)
              }}
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            >
              <option value={'T\u1ea5t c\u1ea3'}>{'T\u1ea5t c\u1ea3'}</option>
              {groupOptions.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <select
              value={makerFilter}
              onChange={(e) => {
                setMakerFilter(e.target.value)
                setPage(1)
              }}
              className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            >
              <option value={'T\u1ea5t c\u1ea3'}>{'T\u1ea5t c\u1ea3'}</option>
              {makerOptions.map((maker) => <option key={maker.id} value={maker.id}>{maker.name}</option>)}
            </select>
            <button onClick={resetFilters} className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white">Reset</button>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={barcodeSearch}
            onChange={(e) => {
              setBarcodeSearch(e.target.value)
              setPage(1)
            }}
            className="min-w-0 flex-1 rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm"
            placeholder={'Qu\u00e9t barcode \u0111\u1ec3 t\u00ecm nhanh'}
          />
          <button
            type="button"
            onClick={() => openScan('search')}
            className="w-full rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 sm:w-auto"
          >
            {'Qu\u00e9t b\u1eb1ng camera'}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.25em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã thuốc</th>
                <th className="px-6 py-4">Tên thuốc</th>
                <th className="px-6 py-4">Loại thuốc</th>
                <th className="px-6 py-4">Nhóm</th>
                <th className="px-6 py-4">Nhà SX</th>
                <th className="px-6 py-4">Đơn vị & giá</th>
                <th className="px-6 py-4">Barcode</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-6 py-6 text-sm text-ink-600">Đang tải dữ liệu...</td>
                </tr>
              ) : null}
              {!loading && paged.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-6 text-sm text-ink-600">Không có dữ liệu thuốc.</td>
                </tr>
              ) : null}
              {!loading ? paged.map((drug) => (
                <Fragment key={drug.id}>
                  <tr className="hover:bg-white/80">
                    <td className="px-6 py-4 font-semibold text-ink-900">{drug.code}</td>
                    <td className="px-6 py-4 text-ink-900">
                      <p>{drug.name}</p>
                      {drug.activeIngredient ? (
                        <p className="mt-1 text-xs text-ink-600">Hoạt chất: {drug.activeIngredient}</p>
                      ) : null}
                    </td>
                    <td className="px-6 py-4 text-ink-700">{drug.category || '-'}</td>
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
                        <button
                          onClick={() => openEdit(drug)}
                          disabled={!canManage}
                          className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                        >
                          Sửa
                        </button>
                        <button
                          onClick={() => void removeDrug(drug)}
                          disabled={!canDelete}
                          className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                        >
                          Xóa
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === drug.id ? (
                    <tr>
                      <td colSpan={9} className="px-6 pb-6">
                        <div className="rounded-2xl bg-white/80 p-4">
                          <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
                            <div className="space-y-2 text-sm text-ink-700">
                              <p><span className="font-semibold text-ink-900">Loại thuốc:</span> {drug.category || '-'}</p>
                              <p><span className="font-semibold text-ink-900">Hoạt chất:</span> {drug.activeIngredient || '-'}</p>
                              <p><span className="font-semibold text-ink-900">Số đăng ký:</span> {drug.regNo}</p>
                              <p><span className="font-semibold text-ink-900">Thuế:</span> VAT {drug.vatRate}% · Thuế khác {drug.otherTaxRate}%</p>
                              <p><span className="font-semibold text-ink-900">Hướng dẫn:</span> {drug.usage || '-'}</p>
                              <p><span className="font-semibold text-ink-900">Ghi chú:</span> {drug.note || '-'}</p>
                            </div>
                            <div>
                              <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đơn vị tính</p>
                              <div className="mt-3 space-y-2 text-sm text-ink-700">
                                {drug.units.slice().sort((a, b) => unitLevelOrder[a.level] - unitLevelOrder[b.level]).map((unit) => (
                                  <div key={unit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2">
                                    <span className="font-semibold text-ink-900">{unit.name}</span>
                                    <span>{unitLevelLabel[unit.level]}</span>
                                    <span>{unit.conversion} quy đổi</span>
                                    <span>{unit.price.toLocaleString('vi-VN')}đ</span>
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
              )) : null}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 p-3 md:hidden">
          {loading ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">
              Đang tải dữ liệu...
            </div>
          ) : null}
          {!loading && paged.length === 0 ? (
            <div className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-4 text-sm text-ink-600">
              Không có dữ liệu thuốc.
            </div>
          ) : null}
          {!loading
            ? paged.map((drug) => (
                <article key={drug.id} className="rounded-2xl border border-ink-900/10 bg-white/80 p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold tracking-wide text-ink-600">{drug.code}</p>
                      <h4 className="mt-1 truncate text-base font-semibold text-ink-900">{drug.name}</h4>
                      {drug.activeIngredient ? (
                        <p className="mt-1 text-xs text-ink-600">Hoạt chất: {drug.activeIngredient}</p>
                      ) : null}
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[drug.active ? 'Đang bán' : 'Ngừng bán']}`}>
                      {drug.active ? 'Đang bán' : 'Ngừng bán'}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-700">
                    <p><span className="font-semibold text-ink-900">Loại:</span> {drug.category || '-'}</p>
                    <p><span className="font-semibold text-ink-900">Nhóm:</span> {drug.group}</p>
                    <p><span className="font-semibold text-ink-900">Nhà SX:</span> {drug.maker}</p>
                    <p><span className="font-semibold text-ink-900">Barcode:</span> {drug.barcode || '-'}</p>
                  </div>
                  <p className="mt-3 text-xs text-ink-700">
                    <span className="font-semibold text-ink-900">Đơn vị:</span> {formatUnits(drug.units)}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => setExpandedId((prev) => (prev === drug.id ? null : drug.id))} className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">
                      {expandedId === drug.id ? 'Ẩn' : 'Chi tiết'}
                    </button>
                    <button
                      onClick={() => openEdit(drug)}
                      disabled={!canManage}
                      className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                    >
                      Sửa
                    </button>
                    <button
                      onClick={() => void removeDrug(drug)}
                      disabled={!canDelete}
                      className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                    >
                      Xóa
                    </button>
                  </div>

                  {expandedId === drug.id ? (
                    <div className="mt-3 rounded-xl border border-ink-900/10 bg-white p-3 text-xs text-ink-700">
                      <div className="space-y-1.5">
                        <p><span className="font-semibold text-ink-900">Số đăng ký:</span> {drug.regNo || '-'}</p>
                        <p><span className="font-semibold text-ink-900">Thuế:</span> VAT {drug.vatRate}% · Thuế khác {drug.otherTaxRate}%</p>
                        <p><span className="font-semibold text-ink-900">Hướng dẫn:</span> {drug.usage || '-'}</p>
                        <p><span className="font-semibold text-ink-900">Ghi chú:</span> {drug.note || '-'}</p>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {drug.units
                          .slice()
                          .sort((a, b) => unitLevelOrder[a.level] - unitLevelOrder[b.level])
                          .map((unit) => (
                            <div key={unit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-fog-50 px-3 py-2">
                              <span className="font-semibold text-ink-900">{unit.name}</span>
                              <span>{unitLevelLabel[unit.level]}</span>
                              <span>{unit.price.toLocaleString('vi-VN')}đ</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))
            : null}
        </div>
      </section>

      <section className="flex flex-col gap-3 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between">
        <span>
          Hiển thị {filtered.length === 0 ? 0 : (page - 1) * pageSize + 1} - {Math.min(page * pageSize, filtered.length)} trong {filtered.length} thuốc
        </span>
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
                <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
                  <span>Tra cứu tham chiếu Bộ Y tế</span>
                  <input
                    value={referenceQuery}
                    onChange={(e) => setReferenceQuery(e.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Nhập số đăng ký hoặc tên thuốc"
                  />
                  {referenceLoading ? (
                    <p className="text-xs text-ink-500">Đang tìm dữ liệu tham chiếu...</p>
                  ) : null}
                  {referenceError ? (
                    <p className="text-xs text-coral-500">{referenceError}</p>
                  ) : null}
                  {referenceResults.length > 0 ? (
                    <div className="max-h-56 overflow-y-auto rounded-2xl border border-ink-900/10 bg-white">
                      {referenceResults.map((item) => (
                        <button
                          key={`${item.registration_number}-${item.name}`}
                          type="button"
                          onClick={() => applyReferenceSuggestion(item)}
                          className="w-full border-b border-ink-900/5 px-4 py-2 text-left text-sm text-ink-800 last:border-b-0 hover:bg-fog-50"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-ink-900">{item.name}</span>
                            {item.is_otc ? (
                              <span className="rounded-full border border-brand-500/30 bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                                OTC
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-ink-600">{item.registration_number}</p>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Mã thuốc</span>
                  <div className="w-full rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-ink-700">
                    {form.code || 'Tự động sinh khi lưu'}
                  </div>
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Tên thuốc *</span>
                  <input value={form.name} onChange={(e) => updateForm('name', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                  {errors.name ? <span className="text-xs text-coral-500">{errors.name}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>{'Ho\u1ea1t ch\u1ea5t'}</span>
                  <input value={form.activeIngredient} onChange={(e) => updateForm('activeIngredient', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Số đăng ký *</span>
                  <input value={form.regNo} onChange={(e) => updateForm('regNo', e.target.value)} className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2" />
                  {errors.regNo ? <span className="text-xs text-coral-500">{errors.regNo}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Loại thuốc *</span>
                  <select
                    value={form.groupCategory}
                    onChange={(e) => handleGroupCategoryChange(e.target.value)}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  >
                    <option value="">Chọn loại thuốc</option>
                    {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                  </select>
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Nhóm thuốc *</span>
                  <select
                    value={form.groupId}
                    onChange={(e) => handleGroupChange(e.target.value)}
                    disabled={!form.groupCategory}
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 disabled:opacity-60"
                  >
                    <option value="">Chọn nhóm thuốc</option>
                    {filteredGroupOptions.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  {!form.groupCategory ? (
                    <span className="text-xs text-ink-500">Hãy chọn loại thuốc trước.</span>
                  ) : null}
                  <div className="rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-sm text-ink-700">
                    {'Lo\u1ea1i thu\u1ed1c hi\u1ec7n t\u1ea1i:'} <span className="font-semibold text-ink-900">{selectedGroupCategory}</span>
                  </div>
                  {selectedGroupTax ? (
                    <div className="rounded-2xl border border-ink-900/10 bg-fog-50 px-4 py-2 text-sm text-ink-700">
                      {'Thu\u1ebf nh\u00f3m \u00e1p d\u1ee5ng:'} VAT {selectedGroupTax.vatRate}% {'\u00b7'} {'Thu\u1ebf kh\u00e1c'} {selectedGroupTax.otherTaxRate}%
                    </div>
                  ) : null}
                  {errors.group ? <span className="text-xs text-coral-500">{errors.group}</span> : null}
                </label>
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Hãng sản xuất *</span>
                  <input
                    value={makerQuery}
                    onChange={(e) => handleMakerQueryChange(e.target.value)}
                    list="drug-maker-options"
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Tìm hãng sản xuất..."
                  />
                  <datalist id="drug-maker-options">
                    {makerOptions.map((maker) => (
                      <option key={maker.id} value={maker.name} />
                    ))}
                  </datalist>
                  {form.makerId ? (
                    <p className="text-xs text-ink-500">Đã chọn: {selectedMakerName || makerQuery}</p>
                  ) : makerQuery.trim() ? (
                    <p className="text-xs text-amber-700">Không có trong danh mục hãng sản xuất. Vui lòng chọn công ty hợp lệ.</p>
                  ) : null}
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
              <div className="mt-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-ink-900">Đơn vị bán sỉ / trung gian / bán lẻ</p>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-ink-700">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.singleUnit}
                        onChange={(e) => updateSingleUnit(e.target.checked)}
                        className="h-4 w-4 rounded border-ink-900/20"
                      />
                      Sản phẩm chỉ có 1 đơn vị
                    </label>
                    {!form.singleUnit ? (
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={form.hasIntermediate}
                          onChange={(e) => updateHasIntermediate(e.target.checked)}
                          className="h-4 w-4 rounded border-ink-900/20"
                        />
                        Có đơn vị trung gian
                      </label>
                    ) : null}
                  </div>
                </div>
                {errors['unit-duplicate'] ? <p className="text-xs text-coral-500">{errors['unit-duplicate']}</p> : null}

                {!form.singleUnit ? (
                  <div className="rounded-2xl bg-fog-50 p-4">
                    <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đơn vị bán sỉ</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="space-y-1 text-xs text-ink-600">
                        Tên đơn vị *
                        <select value={form.importUnit.name} onChange={(e) => updateUnit('importUnit', 'name', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900">
                          {unitNames.map((unitName) => <option key={unitName} value={unitName}>{unitName}</option>)}
                        </select>
                        {errors['import-name'] ? <span className="text-xs text-coral-500">{errors['import-name']}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        {form.hasIntermediate ? 'Quy đổi với trung gian *' : 'Quy đổi với bán lẻ *'}
                        <input value={form.importUnit.conversion} onChange={(e) => updateUnit('importUnit', 'conversion', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" inputMode="numeric" />
                        {errors['import-conversion'] ? <span className="text-xs text-coral-500">{errors['import-conversion']}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Giá bán *
                        <input value={form.importUnit.price} onChange={(e) => updateUnit('importUnit', 'price', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" inputMode="numeric" />
                        {errors['import-price'] ? <span className="text-xs text-coral-500">{errors['import-price']}</span> : null}
                      </label>
                    </div>
                  </div>
                ) : null}

                {!form.singleUnit && form.hasIntermediate ? (
                  <div className="rounded-2xl bg-fog-50 p-4">
                    <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đơn vị trung gian</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="space-y-1 text-xs text-ink-600">
                        Tên đơn vị *
                        <select value={form.intermediateUnit.name} onChange={(e) => updateUnit('intermediateUnit', 'name', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900">
                          {unitNames.map((unitName) => <option key={unitName} value={unitName}>{unitName}</option>)}
                        </select>
                        {errors['intermediate-name'] ? <span className="text-xs text-coral-500">{errors['intermediate-name']}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Quy đổi với bán lẻ *
                        <input value={form.intermediateUnit.conversion} onChange={(e) => updateUnit('intermediateUnit', 'conversion', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" inputMode="numeric" />
                        {errors['intermediate-conversion'] ? <span className="text-xs text-coral-500">{errors['intermediate-conversion']}</span> : null}
                      </label>
                      <label className="space-y-1 text-xs text-ink-600">
                        Giá bán *
                        <input value={form.intermediateUnit.price} onChange={(e) => updateUnit('intermediateUnit', 'price', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" inputMode="numeric" />
                        {errors['intermediate-price'] ? <span className="text-xs text-coral-500">{errors['intermediate-price']}</span> : null}
                      </label>
                    </div>
                  </div>
                ) : null}

                <div className="rounded-2xl bg-fog-50 p-4">
                  <p className="text-xs uppercase tracking-[0.25em] text-ink-600">{form.singleUnit ? 'Đơn vị' : 'Đơn vị bán lẻ'}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1 text-xs text-ink-600">
                      Tên đơn vị *
                      <select value={form.retailUnit.name} onChange={(e) => updateUnit('retailUnit', 'name', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900">
                        {unitNames.map((unitName) => <option key={unitName} value={unitName}>{unitName}</option>)}
                      </select>
                      {errors['retail-name'] ? <span className="text-xs text-coral-500">{errors['retail-name']}</span> : null}
                    </label>
                    <label className="space-y-1 text-xs text-ink-600">
                      Quy đổi
                      <input value="1" disabled className="mt-1 w-full rounded-xl border border-ink-900/10 bg-ink-900/5 px-3 py-2 text-sm text-ink-700" />
                    </label>
                    <label className="space-y-1 text-xs text-ink-600">
                      Giá bán *
                      <input value={form.retailUnit.price} onChange={(e) => updateUnit('retailUnit', 'price', e.target.value)} className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900" inputMode="numeric" />
                      {errors['retail-price'] ? <span className="text-xs text-coral-500">{errors['retail-price']}</span> : null}
                    </label>
                  </div>
                </div>

                <div className="rounded-2xl border border-ink-900/10 bg-white p-4 text-sm text-ink-700">
                  <p className="font-semibold text-ink-900">Quy đổi tự động</p>
                  <p className="mt-2">{conversionHint}</p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                onClick={() => void saveDrug()}
                disabled={saving || !canManage}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
              >
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
              <button
                onClick={() => setModalOpen(false)}
                disabled={saving}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
              >
                Hủy
              </button>
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
