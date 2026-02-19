import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { ApiError } from '../api/usersService'
import { storeApi, type StoreInfo, type StoreSettingsMap } from '../api/storeService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { BANK_OPTIONS } from '../constants/bankList'

type StoreInfoForm = {
  name: string
  address: string
  phone: string
  email: string
  taxCode: string
  licenseNumber: string
  ownerName: string
  bankAccount: string
  bankName: string
  bankBranch: string
}

type BankQrAddInfoMode = 'order_code' | 'custom'
type AdsTransition = 'none' | 'fade' | 'slide'

type StoreSettingsForm = {
  autoPrint: boolean
  sellByLot: boolean
  defaultPaymentMethod: string
  bankQrAddInfoMode: BankQrAddInfoMode
  bankQrAddInfoCustom: string
  customerDisplayShowPrice: boolean
  customerDisplayShowTotal: boolean
  customerDisplayAds: string
  customerDisplayAdsIntervalSeconds: string
  customerDisplayAdsTransition: AdsTransition
  customerDisplayAdsTransitionMs: string
  returnWindowValue: string
  returnWindowUnit: 'day' | 'hour'
  lowStockThreshold: string
  expiryWarningDays: string
  nearDateDays: string
  enableFefo: boolean
  fefoThresholdDays: string
  timezone: string
  currency: string
}

const emptyStoreInfoForm: StoreInfoForm = {
  name: '',
  address: '',
  phone: '',
  email: '',
  taxCode: '',
  licenseNumber: '',
  ownerName: '',
  bankAccount: '',
  bankName: '',
  bankBranch: '',
}

const defaultStoreSettings: StoreSettingsForm = {
  autoPrint: true,
  sellByLot: true,
  defaultPaymentMethod: 'cash',
  bankQrAddInfoMode: 'order_code',
  bankQrAddInfoCustom: '',
  customerDisplayShowPrice: true,
  customerDisplayShowTotal: true,
  customerDisplayAds: '',
  customerDisplayAdsIntervalSeconds: '8',
  customerDisplayAdsTransition: 'fade',
  customerDisplayAdsTransitionMs: '650',
  returnWindowValue: '7',
  returnWindowUnit: 'day',
  lowStockThreshold: '10',
  expiryWarningDays: '30',
  nearDateDays: '90',
  enableFefo: true,
  fefoThresholdDays: '180',
  timezone: 'Asia/Ho_Chi_Minh',
  currency: 'VND',
}

const formatDateTime = (value: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const asString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

const asBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return fallback
}

const asNumberString = (value: unknown, fallback: number): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return String(Math.trunc(Number(value)))
  }
  return String(fallback)
}

const normalizeBankQrAddInfoMode = (value: unknown): BankQrAddInfoMode =>
  asString(value, 'order_code').toLowerCase() === 'custom' ? 'custom' : 'order_code'

const normalizeAdsTransition = (value: unknown): AdsTransition => {
  const next = asString(value, 'fade').toLowerCase()
  if (next === 'none' || next === 'slide') return next
  return 'fade'
}

const settingValueToStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
        }
      } catch {
        // fallback as plain line-based value
      }
    }
    return raw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const bankSearchKey = (bank: (typeof BANK_OPTIONS)[number]) =>
  `${bank.code} ${bank.name} ${bank.bin}`.toLowerCase()

const resolveBankInputValue = (value: string) => {
  const raw = value.trim()
  const keyword = normalizeText(raw)
  if (!keyword) return null
  const codeCandidate = raw.split('-')[0]?.trim()
  return (
    (codeCandidate
      ? BANK_OPTIONS.find((bank) => bank.code.toLowerCase() === codeCandidate.toLowerCase())
      : null) ??
    BANK_OPTIONS.find((bank) => bank.code.toLowerCase() === keyword) ??
    BANK_OPTIONS.find((bank) => bank.name.toLowerCase() === raw.toLowerCase()) ??
    BANK_OPTIONS.find((bank) => bank.bin === raw) ??
    BANK_OPTIONS.find((bank) => normalizeText(bankSearchKey(bank)).includes(keyword)) ??
    null
  )
}

const mapStoreInfoToForm = (info: StoreInfo): StoreInfoForm => ({
  name: info.name ?? '',
  address: info.address ?? '',
  phone: info.phone ?? '',
  email: info.email ?? '',
  taxCode: info.tax_code ?? '',
  licenseNumber: info.license_number ?? '',
  ownerName: info.owner_name ?? '',
  bankAccount: info.bank_account ?? '',
  bankName: info.bank_name ?? '',
  bankBranch: info.bank_branch ?? '',
})

const mapSettingsToForm = (settings: StoreSettingsMap): StoreSettingsForm => ({
  autoPrint: asBoolean(settings['sale.auto_print'], true),
  sellByLot: asBoolean(settings['sale.enforce_lot_policy'], true),
  defaultPaymentMethod: asString(settings['sale.default_payment_method'], 'cash'),
  bankQrAddInfoMode: normalizeBankQrAddInfoMode(settings['sale.bank_qr_add_info_mode']),
  bankQrAddInfoCustom: asString(settings['sale.bank_qr_add_info_custom'], ''),
  customerDisplayShowPrice: asBoolean(settings['sale.customer_display_show_price'], true),
  customerDisplayShowTotal: asBoolean(settings['sale.customer_display_show_total'], true),
  customerDisplayAds: settingValueToStringArray(settings['sale.customer_display_ads']).join('\n'),
  customerDisplayAdsIntervalSeconds: asNumberString(
    settings['sale.customer_display_ads_interval_seconds'],
    8,
  ),
  customerDisplayAdsTransition: normalizeAdsTransition(settings['sale.customer_display_ads_transition']),
  customerDisplayAdsTransitionMs: asNumberString(
    settings['sale.customer_display_ads_transition_ms'],
    650,
  ),
  returnWindowValue: asNumberString(settings['sale.return_window_value'], 7),
  returnWindowUnit: asString(settings['sale.return_window_unit'], 'day').toLowerCase() === 'hour' ? 'hour' : 'day',
  lowStockThreshold: asNumberString(settings['inventory.low_stock_threshold'], 10),
  expiryWarningDays: asNumberString(settings['inventory.expiry_warning_days'], 30),
  nearDateDays: asNumberString(settings['inventory.near_date_days'], 90),
  enableFefo: asBoolean(settings['inventory.enable_fefo'], true),
  fefoThresholdDays: asNumberString(settings['inventory.fefo_threshold_days'], 180),
  timezone: asString(settings['system.timezone'], 'Asia/Ho_Chi_Minh'),
  currency: asString(settings['system.currency'], 'VND'),
})

export function StoreSettings() {
  const { user, token } = useAuth()
  const canManageStore = isOwnerOrAdmin(user)

  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null)
  const [storeInfoForm, setStoreInfoForm] = useState<StoreInfoForm>(emptyStoreInfoForm)
  const [storeSettingsForm, setStoreSettingsForm] = useState<StoreSettingsForm>(defaultStoreSettings)
  const [autoPrintUpdatedAt, setAutoPrintUpdatedAt] = useState<string | null>(null)

  const [storeLoading, setStoreLoading] = useState(false)
  const [storeError, setStoreError] = useState<string | null>(null)

  const [storeInfoSubmitting, setStoreInfoSubmitting] = useState(false)
  const [logoSubmitting, setLogoSubmitting] = useState(false)
  const [storeInfoMessage, setStoreInfoMessage] = useState<string | null>(null)
  const [storeInfoError, setStoreInfoError] = useState<string | null>(null)

  const [settingsSubmitting, setSettingsSubmitting] = useState(false)
  const [settingsResetting, setSettingsResetting] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [bankPickerOpen, setBankPickerOpen] = useState(false)
  const [bankPickerKeyword, setBankPickerKeyword] = useState('')
  const [qrAccountName, setQrAccountName] = useState('')

  const bankSuggestions = useMemo(() => {
    const keyword = normalizeText(bankPickerKeyword.trim())
    const filtered = !keyword
      ? BANK_OPTIONS
      : BANK_OPTIONS.filter((bank) => normalizeText(bankSearchKey(bank)).includes(keyword))
    return filtered
  }, [bankPickerKeyword])

  const loadStoreData = useCallback(async () => {
    setStoreLoading(true)
    setStoreError(null)

    try {
      const [info, saleSettings, inventorySettings, systemSettings, autoPrintSetting] =
        await Promise.all([
          storeApi.getInfo(),
          storeApi.getSettingsByGroup('sale'),
          storeApi.getSettingsByGroup('inventory'),
          storeApi.getSettingsByGroup('system'),
          storeApi.getSetting('sale.auto_print'),
        ])

      const mergedSettings = {
        ...saleSettings,
        ...inventorySettings,
        ...systemSettings,
      }

      setStoreInfo(info)
      setStoreInfoForm(mapStoreInfoToForm(info))
      setStoreSettingsForm(mapSettingsToForm(mergedSettings))
      setQrAccountName(asString(saleSettings['sale.bank_account_name'], info.owner_name ?? ''))
      setAutoPrintUpdatedAt(autoPrintSetting.updated_at)
    } catch (storeLoadError) {
      if (storeLoadError instanceof ApiError) setStoreError(storeLoadError.message)
      else setStoreError('Không thể tải dữ liệu cửa hàng.')
    } finally {
      setStoreLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStoreData()
  }, [loadStoreData])

  const onSubmitStoreInfo = async (event: FormEvent) => {
    event.preventDefault()
    if (!token?.access_token) return

    if (!canManageStore) {
      setStoreInfoError('Chỉ owner/admin được cập nhật thông tin cửa hàng.')
      return
    }

    if (!storeInfoForm.name.trim()) {
      setStoreInfoError('Tên nhà thuốc là bắt buộc.')
      return
    }

    setStoreInfoSubmitting(true)
    setStoreInfoError(null)
    setStoreInfoMessage(null)

    try {
      const selectedBank = resolveBankInputValue(storeInfoForm.bankName)
      const bankNameToSave = selectedBank
        ? `${selectedBank.code} - ${selectedBank.name}`
        : storeInfoForm.bankName.trim()

      const response = await storeApi.updateInfo(token.access_token, {
        name: storeInfoForm.name.trim(),
        address: storeInfoForm.address.trim() || null,
        phone: storeInfoForm.phone.trim() || null,
        email: storeInfoForm.email.trim() || null,
        tax_code: storeInfoForm.taxCode.trim() || null,
        license_number: storeInfoForm.licenseNumber.trim() || null,
        owner_name: storeInfoForm.ownerName.trim() || null,
        bank_account: storeInfoForm.bankAccount.trim() || null,
        bank_name: bankNameToSave || null,
        bank_branch: storeInfoForm.bankBranch.trim() || null,
      })
      await storeApi.updateSetting(
        token.access_token,
        'sale.bank_account_name',
        qrAccountName.trim(),
      )

      setStoreInfo(response.data)
      setStoreInfoForm(mapStoreInfoToForm(response.data))
      setStoreInfoMessage('Đã cập nhật thông tin cửa hàng.')
    } catch (submitStoreInfoError) {
      if (submitStoreInfoError instanceof ApiError) setStoreInfoError(submitStoreInfoError.message)
      else setStoreInfoError('Không thể cập nhật thông tin cửa hàng.')
    } finally {
      setStoreInfoSubmitting(false)
    }
  }

  const onUploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !token?.access_token) return

    if (!canManageStore) {
      setStoreInfoError('Chỉ owner/admin được cập nhật logo cửa hàng.')
      return
    }

    setLogoSubmitting(true)
    setStoreInfoError(null)
    setStoreInfoMessage(null)

    try {
      const response = await storeApi.uploadLogo(token.access_token, file)
      setStoreInfo(response.data)
      setStoreInfoMessage('Đã cập nhật logo cửa hàng.')
    } catch (uploadError) {
      if (uploadError instanceof ApiError) setStoreInfoError(uploadError.message)
      else setStoreInfoError('Không thể tải logo lên.')
    } finally {
      setLogoSubmitting(false)
    }
  }

  const onDeleteLogo = async () => {
    if (!token?.access_token || !storeInfo?.logo_url) return

    if (!canManageStore) {
      setStoreInfoError('Chỉ owner/admin được xóa logo cửa hàng.')
      return
    }

    setLogoSubmitting(true)
    setStoreInfoError(null)
    setStoreInfoMessage(null)

    try {
      const response = await storeApi.deleteLogo(token.access_token)
      setStoreInfo(response.data)
      setStoreInfoMessage('Đã xóa logo cửa hàng.')
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setStoreInfoError(deleteError.message)
      else setStoreInfoError('Không thể xóa logo cửa hàng.')
    } finally {
      setLogoSubmitting(false)
    }
  }

  const onSubmitStoreSettings = async (event: FormEvent) => {
    event.preventDefault()
    if (!token?.access_token) return

    if (!canManageStore) {
      setSettingsError('Chỉ owner/admin được cập nhật cấu hình cửa hàng.')
      return
    }

    const bankQrAddInfoMode = storeSettingsForm.bankQrAddInfoMode
    const bankQrAddInfoCustom = storeSettingsForm.bankQrAddInfoCustom.trim()
    if (bankQrAddInfoMode === 'custom' && !bankQrAddInfoCustom) {
      setSettingsError('Vui l\u00f2ng nh\u1eadp n\u1ed9i dung chuy\u1ec3n kho\u1ea3n t\u00f9y ch\u1ec9nh.')
      return
    }

    const lowStock = Number(storeSettingsForm.lowStockThreshold)
    const expiryDays = Number(storeSettingsForm.expiryWarningDays)
    const nearDateDays = Number(storeSettingsForm.nearDateDays)
    const fefoThresholdDays = Number(storeSettingsForm.fefoThresholdDays)
    const returnWindowValue = Number(storeSettingsForm.returnWindowValue)
    const adsIntervalSeconds = Number(storeSettingsForm.customerDisplayAdsIntervalSeconds)
    const adsTransitionMs = Number(storeSettingsForm.customerDisplayAdsTransitionMs)
    const adsList = storeSettingsForm.customerDisplayAds
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)

    if (!Number.isFinite(lowStock) || lowStock < 0) {
      setSettingsError('Ngưỡng sắp hết hàng không hợp lệ.')
      return
    }
    if (!Number.isFinite(expiryDays) || expiryDays < 0) {
      setSettingsError('Số ngày cảnh báo hết hạn không hợp lệ.')
      return
    }
    if (!Number.isFinite(nearDateDays) || nearDateDays < 0) {
      setSettingsError('Số ngày cận date không hợp lệ.')
      return
    }
    if (!Number.isFinite(fefoThresholdDays) || fefoThresholdDays <= 0) {
      setSettingsError('Ngưỡng FEFO/FIFO không hợp lệ.')
      return
    }
    if (!Number.isFinite(returnWindowValue) || returnWindowValue < 0) {
      setSettingsError('Thời gian trả hàng không hợp lệ.')
      return
    }

    if (!Number.isFinite(adsIntervalSeconds) || adsIntervalSeconds < 1) {
      setSettingsError('Thoi gian chuyen ads phai lon hon hoac bang 1 giay.')
      return
    }
    if (!Number.isFinite(adsTransitionMs) || adsTransitionMs < 0) {
      setSettingsError('Thoi gian transition ads khong hop le.')
      return
    }

    setSettingsSubmitting(true)
    setSettingsError(null)
    setSettingsMessage(null)

    try {
      await Promise.all([
        storeApi.updateSetting(token.access_token, 'sale.auto_print', storeSettingsForm.autoPrint),
        storeApi.updateSettingsBulk(token.access_token, {
          'sale.enforce_lot_policy': storeSettingsForm.sellByLot,
          'sale.default_payment_method': storeSettingsForm.defaultPaymentMethod.trim() || 'cash',
          'sale.bank_qr_add_info_mode': bankQrAddInfoMode,
          'sale.bank_qr_add_info_custom': bankQrAddInfoCustom,
          'sale.customer_display_show_price': storeSettingsForm.customerDisplayShowPrice,
          'sale.customer_display_show_total': storeSettingsForm.customerDisplayShowTotal,
          'sale.customer_display_ads': adsList,
          'sale.customer_display_ads_interval_seconds': Math.trunc(adsIntervalSeconds),
          'sale.customer_display_ads_transition': storeSettingsForm.customerDisplayAdsTransition,
          'sale.customer_display_ads_transition_ms': Math.trunc(adsTransitionMs),
          'sale.return_window_value': Math.trunc(returnWindowValue),
          'sale.return_window_unit': storeSettingsForm.returnWindowUnit,
          'inventory.low_stock_threshold': Math.trunc(lowStock),
          'inventory.expiry_warning_days': Math.trunc(expiryDays),
          'inventory.near_date_days': Math.trunc(nearDateDays),
          'inventory.enable_fefo': storeSettingsForm.enableFefo,
          'inventory.fefo_threshold_days': Math.trunc(fefoThresholdDays),
          'system.timezone': storeSettingsForm.timezone.trim() || 'Asia/Ho_Chi_Minh',
          'system.currency': storeSettingsForm.currency.trim() || 'VND',
        }),
      ])

      const autoPrintSetting = await storeApi.getSetting('sale.auto_print')
      setAutoPrintUpdatedAt(autoPrintSetting.updated_at)
      setSettingsMessage('Đã cập nhật cấu hình cửa hàng.')
    } catch (submitStoreSettingsError) {
      if (submitStoreSettingsError instanceof ApiError) setSettingsError(submitStoreSettingsError.message)
      else setSettingsError('Không thể cập nhật cấu hình cửa hàng.')
    } finally {
      setSettingsSubmitting(false)
    }
  }

  const onResetAutoPrint = async () => {
    if (!token?.access_token || !canManageStore) return

    setSettingsResetting(true)
    setSettingsError(null)
    setSettingsMessage(null)

    try {
      const response = await storeApi.resetSetting(token.access_token, 'sale.auto_print')
      const nextValue = asBoolean(response.value, true)
      setStoreSettingsForm((prev) => ({ ...prev, autoPrint: nextValue }))

      const autoPrintSetting = await storeApi.getSetting('sale.auto_print')
      setAutoPrintUpdatedAt(autoPrintSetting.updated_at)
      setSettingsMessage('Đã reset tự động in hóa đơn về mặc định.')
    } catch (resetError) {
      if (resetError instanceof ApiError) setSettingsError(resetError.message)
      else setSettingsError('Không thể reset cấu hình auto print.')
    } finally {
      setSettingsResetting(false)
    }
  }

  const onResetAllSettings = async () => {
    if (!token?.access_token || !canManageStore) return

    const confirmed = window.confirm('Reset toàn bộ cấu hình cửa hàng về mặc định?')
    if (!confirmed) return

    setSettingsResetting(true)
    setSettingsError(null)
    setSettingsMessage(null)

    try {
      await storeApi.resetAllSettings(token.access_token)
      await loadStoreData()
      setSettingsMessage('Đã reset toàn bộ cấu hình cửa hàng.')
    } catch (resetError) {
      if (resetError instanceof ApiError) setSettingsError(resetError.message)
      else setSettingsError('Không thể reset cấu hình cửa hàng.')
    } finally {
      setSettingsResetting(false)
    }
  }

  const logoPreviewUrl = useMemo(() => {
    if (!storeInfo?.logo_url) return null
    if (storeInfo.logo_url.startsWith('http')) return storeInfo.logo_url

    const apiBase = String(import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
    if (apiBase) return `${apiBase}${storeInfo.logo_url}`

    return `${window.location.origin}${storeInfo.logo_url}`
  }, [storeInfo?.logo_url])

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Cửa hàng</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Thông tin và cấu hình cửa hàng</h2>
        <p className="mt-2 text-sm text-ink-600">
          Cập nhật hồ sơ nhà thuốc và các cấu hình vận hành từ Store Service.
        </p>
        {!canManageStore ? (
          <p className="mt-2 text-sm text-amber-700">Bạn chỉ có quyền xem. Owner/Admin mới được chỉnh sửa.</p>
        ) : null}
      </header>

      <section className="glass-card rounded-3xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xl font-semibold text-ink-900">Thông tin cửa hàng</h3>
          <button
            type="button"
            onClick={() => void loadStoreData()}
            className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Tải lại từ service
          </button>
        </div>

        {storeLoading ? <p className="mt-3 text-sm text-ink-600">Đang tải dữ liệu cửa hàng...</p> : null}
        {storeError ? <p className="mt-3 text-sm text-coral-500">{storeError}</p> : null}

        <form onSubmit={onSubmitStoreInfo} className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm text-ink-700">
            <span>Tên nhà thuốc *</span>
            <input
              value={storeInfoForm.name}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Chủ sở hữu</span>
            <input
              value={storeInfoForm.ownerName}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, ownerName: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
            <span>Địa chỉ</span>
            <input
              value={storeInfoForm.address}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, address: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Số điện thoại</span>
            <input
              value={storeInfoForm.phone}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, phone: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Email</span>
            <input
              value={storeInfoForm.email}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, email: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Mã số thuế</span>
            <input
              value={storeInfoForm.taxCode}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, taxCode: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Số giấy phép</span>
            <input
              value={storeInfoForm.licenseNumber}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, licenseNumber: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Tài khoản ngân hàng</span>
            <input
              value={storeInfoForm.bankAccount}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, bankAccount: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Tên chủ tài khoản (dùng cho QR)</span>
            <input
              value={qrAccountName}
              onChange={(event) => setQrAccountName(event.target.value)}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              placeholder="Vi du: NGUYEN VAN A"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Ngân hàng (mã + tên)</span>
            <div className="relative">
              <input
                value={storeInfoForm.bankName}
                onFocus={() => {
                  setBankPickerOpen(true)
                  setBankPickerKeyword('')
                }}
                onBlur={() => window.setTimeout(() => setBankPickerOpen(false), 120)}
                onChange={(event) => {
                  setStoreInfoForm((prev) => ({ ...prev, bankName: event.target.value }))
                  setBankPickerKeyword(event.target.value)
                  setBankPickerOpen(true)
                }}
                className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                placeholder="Tìm theo mã (VCB) hoặc tên (VietcomBank)"
                disabled={!canManageStore || storeLoading}
              />
              {bankPickerOpen && bankSuggestions.length ? (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-2xl border border-ink-900/10 bg-white p-1 shadow-lift">
                  {bankSuggestions.map((bank) => (
                    <button
                      key={`${bank.code}-${bank.bin}`}
                      type="button"
                      onMouseDown={() => {
                        setStoreInfoForm((prev) => ({
                          ...prev,
                          bankName: `${bank.code} - ${bank.name}`,
                        }))
                        setBankPickerKeyword('')
                        setBankPickerOpen(false)
                      }}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-ink-800 hover:bg-fog-50"
                    >
                      <span className="font-medium">{bank.code} - {bank.name}</span>
                      <span className="text-xs text-ink-500">{bank.bin}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </label>
          <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
            <span>Chi nhánh ngân hàng</span>
            <input
              value={storeInfoForm.bankBranch}
              onChange={(event) => setStoreInfoForm((prev) => ({ ...prev, bankBranch: event.target.value }))}
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          <div className="md:col-span-2 rounded-2xl border border-ink-900/10 bg-white p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Logo cửa hàng</p>
            {logoPreviewUrl ? (
              <img src={logoPreviewUrl} alt="Store logo" className="mt-3 h-14 w-auto object-contain" />
            ) : (
              <p className="mt-3 text-sm text-ink-600">Chưa có logo.</p>
            )}
            {canManageStore ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">
                  {logoSubmitting ? 'Đang tải...' : 'Tải logo'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={logoSubmitting || storeLoading}
                    onChange={(event) => {
                      void onUploadLogo(event)
                    }}
                  />
                </label>
                {storeInfo?.logo_url ? (
                  <button
                    type="button"
                    onClick={() => void onDeleteLogo()}
                    disabled={logoSubmitting || storeLoading}
                    className="rounded-full border border-coral-500/30 bg-coral-500/10 px-4 py-2 text-sm font-semibold text-coral-500 disabled:opacity-60"
                  >
                    Xóa logo
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {storeInfoError ? <p className="md:col-span-2 text-sm text-coral-500">{storeInfoError}</p> : null}
          {storeInfoMessage ? <p className="md:col-span-2 text-sm text-brand-600">{storeInfoMessage}</p> : null}

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={storeInfoSubmitting || !canManageStore || storeLoading}
              className="w-fit rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {storeInfoSubmitting ? 'Đang cập nhật...' : 'Cập nhật thông tin cửa hàng'}
            </button>
          </div>
        </form>
      </section>

      <section className="glass-card rounded-3xl p-6">
        <h3 className="text-xl font-semibold text-ink-900">Cấu hình bán hàng và kho</h3>
        <p className="mt-2 text-xs text-ink-500">
          Tự động in hóa đơn cập nhật lúc: {formatDateTime(autoPrintUpdatedAt)}
        </p>

        <form onSubmit={onSubmitStoreSettings} className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-ink-700 md:col-span-2">
            <input
              type="checkbox"
              checked={storeSettingsForm.autoPrint}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, autoPrint: event.target.checked }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Tự động in hóa đơn
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700 md:col-span-2">
            <input
              type="checkbox"
              checked={storeSettingsForm.sellByLot}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, sellByLot: event.target.checked }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Bán hàng theo lô (áp dụng FIFO/FEFO khi tạo hóa đơn)
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Phương thức thanh toán mặc định</span>
            <input
              value={storeSettingsForm.defaultPaymentMethod}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, defaultPaymentMethod: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Nội dung chuyển khoản QR</span>
            <select
              value={storeSettingsForm.bankQrAddInfoMode}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  bankQrAddInfoMode: event.target.value === "custom" ? "custom" : "order_code",
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            >
              <option value="order_code">Mã đơn hàng</option>
              <option value="custom">Nội dung tùy chỉnh</option>
            </select>
          </label>
          <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
            <span>Nội dung chuyển khoản tùy chỉnh</span>
            <input
              value={storeSettingsForm.bankQrAddInfoCustom}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  bankQrAddInfoCustom: event.target.value,
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              placeholder="Ví dụ: Thanh toán đơn thuốc"
              disabled={!canManageStore || storeLoading || storeSettingsForm.bankQrAddInfoMode !== "custom"}
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-ink-700 md:col-span-2">
            <input
              type="checkbox"
              checked={storeSettingsForm.customerDisplayShowPrice}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayShowPrice: event.target.checked,
                }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Man hinh khach: hien gia tung dong thuoc
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700 md:col-span-2">
            <input
              type="checkbox"
              checked={storeSettingsForm.customerDisplayShowTotal}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayShowTotal: event.target.checked,
                }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Man hinh khach: hien tong tien
          </label>

          <label className="space-y-2 text-sm text-ink-700 md:col-span-2">
            <span>Danh sach ads man hinh khach (moi dong 1 URL hinh)</span>
            <textarea
              value={storeSettingsForm.customerDisplayAds}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayAds: event.target.value,
                }))
              }
              className="min-h-[120px] w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              placeholder="/customer-display/ads/ad-01.svg&#10;/customer-display/ads/ad-02.svg"
              disabled={!canManageStore || storeLoading}
            />
            <p className="text-xs text-ink-500">
              Co the dung link tuyet doi (https://...) hoac duong dan static tu public/.
            </p>
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Kieu transition ads</span>
            <select
              value={storeSettingsForm.customerDisplayAdsTransition}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayAdsTransition:
                    (event.target.value === 'none' || event.target.value === 'slide' ? event.target.value : 'fade') as AdsTransition,
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            >
              <option value="fade">Fade</option>
              <option value="slide">Slide</option>
              <option value="none">None</option>
            </select>
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Chu ky doi ads (giay)</span>
            <input
              type="number"
              min={1}
              value={storeSettingsForm.customerDisplayAdsIntervalSeconds}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayAdsIntervalSeconds: event.target.value,
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Thoi gian transition (ms)</span>
            <input
              type="number"
              min={0}
              value={storeSettingsForm.customerDisplayAdsTransitionMs}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  customerDisplayAdsTransitionMs: event.target.value,
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Cho phép trả hàng trong</span>
            <input
              type="number"
              min={0}
              value={storeSettingsForm.returnWindowValue}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, returnWindowValue: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Đơn vị thời gian trả hàng</span>
            <select
              value={storeSettingsForm.returnWindowUnit}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  returnWindowUnit: event.target.value === 'hour' ? 'hour' : 'day',
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            >
              <option value="day">Ngày</option>
              <option value="hour">Giờ</option>
            </select>
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Ngưỡng sắp hết hàng</span>
            <input
              type="number"
              min={0}
              value={storeSettingsForm.lowStockThreshold}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, lowStockThreshold: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Cảnh báo hết hạn trước (ngày)</span>
            <input
              type="number"
              min={0}
              value={storeSettingsForm.expiryWarningDays}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, expiryWarningDays: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Ngưỡng cận date (ngày)</span>
            <input
              type="number"
              min={0}
              value={storeSettingsForm.nearDateDays}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, nearDateDays: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={storeSettingsForm.enableFefo}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, enableFefo: event.target.checked }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Bật FEFO cho lô có HSD ngắn
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Ngưỡng chuyển FEFO/FIFO (ngày)</span>
            <input
              type="number"
              min={1}
              value={storeSettingsForm.fefoThresholdDays}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, fefoThresholdDays: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Múi giờ</span>
            <input
              value={storeSettingsForm.timezone}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, timezone: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Tiền tệ</span>
            <input
              value={storeSettingsForm.currency}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({ ...prev, currency: event.target.value }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading}
            />
          </label>

          {settingsError ? <p className="md:col-span-2 text-sm text-coral-500">{settingsError}</p> : null}
          {settingsMessage ? <p className="md:col-span-2 text-sm text-brand-600">{settingsMessage}</p> : null}

          <div className="md:col-span-2 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={settingsSubmitting || !canManageStore || storeLoading}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {settingsSubmitting ? 'Đang cập nhật...' : 'Cập nhật cấu hình'}
            </button>
            <button
              type="button"
              onClick={() => void onResetAutoPrint()}
              disabled={settingsResetting || !canManageStore || storeLoading}
              className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
            >
              Reset auto print
            </button>
            <button
              type="button"
              onClick={() => void onResetAllSettings()}
              disabled={settingsResetting || !canManageStore || storeLoading}
              className="rounded-full border border-coral-500/30 bg-coral-500/10 px-5 py-2 text-sm font-semibold text-coral-500 disabled:opacity-60"
            >
              Reset tất cả
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
