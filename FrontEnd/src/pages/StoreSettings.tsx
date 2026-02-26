import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { ApiError } from '../api/usersService'
import { storeApi, type BackupRecord, type StoreInfo, type StoreSettingsMap } from '../api/storeService'
import { fileApi, type FileRecord } from '../api/fileService'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { BANK_OPTIONS } from '../constants/bankList'
import { resolveAssetUrl, setDocumentFavicon } from '../utils/assets'

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
  cashRoundingEnabled: boolean
  cashRoundingStep: string
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
  cashRoundingEnabled: true,
  cashRoundingStep: '1000',
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

const ADS_REF_TYPE = 'customer_display_ads'
const ADS_REF_ID = 'default'
const LOGO_REF_TYPE = 'store_logo'

const formatDateTime = (value: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

const mapFilesToAdsUrls = (files: FileRecord[]): string[] =>
  files
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((item) => (typeof item.url === 'string' ? item.url.trim() : ''))
    .filter(Boolean)

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
  cashRoundingEnabled: asBoolean(settings['sale.cash_rounding_enabled'], true),
  cashRoundingStep: asNumberString(settings['sale.cash_rounding_step'], 1000),
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
  const [logoPreviewFailed, setLogoPreviewFailed] = useState(false)
  const [storeInfoMessage, setStoreInfoMessage] = useState<string | null>(null)
  const [storeInfoError, setStoreInfoError] = useState<string | null>(null)

  const [settingsSubmitting, setSettingsSubmitting] = useState(false)
  const [settingsResetting, setSettingsResetting] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [bankPickerOpen, setBankPickerOpen] = useState(false)
  const [bankPickerKeyword, setBankPickerKeyword] = useState('')
  const [qrAccountName, setQrAccountName] = useState('')

  // --- Backup & Sync state ---
  const [backups, setBackups] = useState<BackupRecord[]>([])
  const [pgDumpOk, setPgDumpOk] = useState(true)
  const [backupLoading, setBackupLoading] = useState(false)
  const [backupCreating, setBackupCreating] = useState(false)
  const [backupUploading, setBackupUploading] = useState(false)
  const [backupRestoring, setBackupRestoring] = useState<string | null>(null)
  const [backupSyncing, setBackupSyncing] = useState<'push' | 'pull' | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [bkAutoEnabled, setBkAutoEnabled] = useState(false)
  const [bkAutoInterval, setBkAutoInterval] = useState('24')
  const [bkMaxFiles, setBkMaxFiles] = useState('10')
  const [bkSettingsSaving, setBkSettingsSaving] = useState(false)
  const [adsFiles, setAdsFiles] = useState<FileRecord[]>([])
  const [adsFilesLoading, setAdsFilesLoading] = useState(false)
  const [adsFilesUploading, setAdsFilesUploading] = useState(false)

  const bankSuggestions = useMemo(() => {
    const keyword = normalizeText(bankPickerKeyword.trim())
    const filtered = !keyword
      ? BANK_OPTIONS
      : BANK_OPTIONS.filter((bank) => normalizeText(bankSearchKey(bank)).includes(keyword))
    return filtered
  }, [bankPickerKeyword])

  const adsFilesSorted = useMemo(
    () =>
      adsFiles
        .slice()
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [adsFiles],
  )

  const adsUrlsFromFiles = useMemo(() => mapFilesToAdsUrls(adsFiles), [adsFiles])

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

  useEffect(() => {
    setDocumentFavicon(storeInfo?.logo_url)
  }, [storeInfo?.logo_url])

  useEffect(() => {
    setLogoPreviewFailed(false)
  }, [storeInfo?.logo_url])

  // --- Backup data loading ---
  const loadBackups = useCallback(async () => {
    if (!token?.access_token || !canManageStore) return
    setBackupLoading(true)
    try {
      const res = await storeApi.listBackups(token.access_token)
      setBackups(res.items)
      setPgDumpOk(res.pg_dump_ok)
    } catch {
      // silent
    } finally {
      setBackupLoading(false)
    }
  }, [token?.access_token, canManageStore])

  const loadBackupSettings = useCallback(async () => {
    try {
      const bs = await storeApi.getSettingsByGroup('backup')
      setBkAutoEnabled(asBoolean(bs['backup.auto_enabled'], false))
      setBkAutoInterval(asNumberString(bs['backup.auto_interval_hours'], 24))
      setBkMaxFiles(asNumberString(bs['backup.max_files'], 10))
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    void loadBackups()
    void loadBackupSettings()
  }, [loadBackups, loadBackupSettings])

  const loadAdsFiles = useCallback(async () => {
    if (!token?.access_token) return
    setAdsFilesLoading(true)
    try {
      const response = await fileApi.list(token.access_token, {
        category: 'general',
        ref_type: ADS_REF_TYPE,
        ref_id: ADS_REF_ID,
        per_page: 200,
      })
      setAdsFiles(response.files)
    } catch {
      // keep current state
    } finally {
      setAdsFilesLoading(false)
    }
  }, [token?.access_token])

  useEffect(() => {
    void loadAdsFiles()
  }, [loadAdsFiles])

  const uploadBackupToR2KeepLatest = useCallback(
    async (accessToken: string, backupRecord: BackupRecord) => {
      const { blob, filename } = await storeApi.downloadBackup(accessToken, backupRecord.id)
      const backupFile = new File([blob], filename || backupRecord.filename, {
        type: blob.type || 'application/gzip',
      })
      const uploaded = await fileApi.upload(accessToken, backupFile, {
        category: 'backup',
        refType: 'store_backup',
        refId: backupRecord.id,
      })

      // Keep only the latest backup on R2.
      try {
        const remoteBackups = await fileApi.list(accessToken, {
          category: 'backup',
          ref_type: 'store_backup',
          per_page: 200,
        })
        const staleFiles = remoteBackups.files.filter((item) => item.id !== uploaded.id)
        await Promise.all(
          staleFiles.map((item) =>
            fileApi.delete(accessToken, item.id).catch(() => undefined),
          ),
        )
      } catch {
        // Best effort cleanup only.
      }
    },
    [],
  )

  const onCreateBackup = async () => {
    if (!token?.access_token) return
    setBackupCreating(true)
    setBackupError(null)
    setBackupMessage(null)
    try {
      const created = await storeApi.createBackup(token.access_token, 'Thủ công')
      const backupRecord = created.data
      let uploadedToR2 = false
      try {
        await uploadBackupToR2KeepLatest(token.access_token, backupRecord)
        uploadedToR2 = true
      } catch {
        uploadedToR2 = false
      }
      setBackupMessage(
        uploadedToR2
          ? 'Đã tạo bản sao lưu. R2 chỉ giữ bản mới nhất.'
          : 'Đã tạo bản sao lưu local. Chưa đồng bộ R2 được, vui lòng thử lại.',
      )
      void loadBackups()
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể tạo bản sao lưu.')
    } finally {
      setBackupCreating(false)
    }
  }

  const onDownloadBackup = async (backupId: string, filename: string) => {
    if (!token?.access_token) return
    try {
      const { blob } = await storeApi.downloadBackup(token.access_token, backupId)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể tải bản sao lưu.')
    }
  }

  const onDeleteBackup = async (backupId: string) => {
    if (!token?.access_token) return
    if (!window.confirm('Xóa bản sao lưu này?')) return
    setBackupError(null)
    setBackupMessage(null)
    try {
      await storeApi.deleteBackup(token.access_token, backupId)
      setBackupMessage('Đã xóa bản sao lưu.')
      void loadBackups()
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể xóa bản sao lưu.')
    }
  }

  const onUploadBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !token?.access_token) return
    setBackupUploading(true)
    setBackupError(null)
    setBackupMessage(null)
    try {
      await storeApi.uploadBackup(token.access_token, file)
      setBackupMessage('Đã tải lên bản sao lưu thành công.')
      void loadBackups()
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể tải lên bản sao lưu.')
    } finally {
      setBackupUploading(false)
    }
  }

  const onRestoreBackup = async (backupId: string) => {
    if (!token?.access_token) return
    if (!window.confirm('Khôi phục dữ liệu từ bản sao lưu này? Dữ liệu hiện tại sẽ bị ghi đè.')) return
    setBackupRestoring(backupId)
    setBackupError(null)
    setBackupMessage(null)
    try {
      await storeApi.restoreBackup(token.access_token, backupId)
      setBackupMessage('Đã khôi phục dữ liệu thành công. Hãy tải lại trang.')
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể khôi phục dữ liệu.')
    } finally {
      setBackupRestoring(null)
    }
  }

  const onSaveBackupSettings = async () => {
    if (!token?.access_token) return
    setBkSettingsSaving(true)
    setBackupError(null)
    setBackupMessage(null)
    try {
      await storeApi.updateSettingsBulk(token.access_token, {
        'backup.auto_enabled': bkAutoEnabled,
        'backup.auto_interval_hours': Math.max(1, Math.trunc(Number(bkAutoInterval) || 24)),
        'backup.max_files': Math.max(1, Math.trunc(Number(bkMaxFiles) || 10)),
      })
      setBackupMessage('Đã lưu cấu hình sao lưu.')
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể lưu cấu hình.')
    } finally {
      setBkSettingsSaving(false)
    }
  }

  const onSyncPush = async () => {
    if (!token?.access_token) return
    if (!window.confirm('Tạo bản sao lưu mới và đồng bộ lên R2?')) return
    setBackupSyncing('push')
    setBackupError(null)
    setBackupMessage(null)
    try {
      const created = await storeApi.createBackup(token.access_token, 'Đồng bộ R2')
      const backupRecord = created.data
      await uploadBackupToR2KeepLatest(token.access_token, backupRecord)
      setBackupMessage('Đã đồng bộ lên R2. R2 chỉ giữ bản mới nhất.')
      void loadBackups()
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể đồng bộ.')
    } finally {
      setBackupSyncing(null)
    }
  }

  const onSyncPull = async () => {
    if (!token?.access_token) return
    if (!window.confirm('Kéo bản sao lưu mới nhất từ R2 về danh sách backup?')) return
    setBackupSyncing('pull')
    setBackupError(null)
    setBackupMessage(null)
    try {
      const remoteBackups = await fileApi.list(token.access_token, {
        category: 'backup',
        ref_type: 'store_backup',
        per_page: 200,
      })
      if (!remoteBackups.files.length) {
        throw new ApiError('Không có bản sao lưu nào trên R2.', 404)
      }

      const latest = remoteBackups.files
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

      const presigned = await fileApi.presignDownload(token.access_token, latest.id)
      const response = await fetch(presigned.url)
      if (!response.ok) {
        throw new ApiError(`Không thể tải file từ R2 (${response.status})`, response.status)
      }
      const blob = await response.blob()
      const backupFile = new File([blob], latest.original_name || latest.filename, {
        type: blob.type || latest.content_type || 'application/gzip',
      })
      await storeApi.uploadBackup(token.access_token, backupFile)
      setBackupMessage('Đã kéo bản sao lưu mới nhất từ R2.')
      void loadBackups()
    } catch (err) {
      if (err instanceof ApiError) setBackupError(err.message)
      else setBackupError('Không thể đồng bộ.')
    } finally {
      setBackupSyncing(null)
    }
  }

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
    if (!file || !token?.access_token || !storeInfo?.id) return

    if (!canManageStore) {
      setStoreInfoError('Chỉ owner/admin được cập nhật logo cửa hàng.')
      return
    }

    setLogoSubmitting(true)
    setStoreInfoError(null)
    setStoreInfoMessage(null)

    try {
      await fileApi.deleteByRef(token.access_token, LOGO_REF_TYPE, storeInfo.id).catch(() => undefined)
      const uploaded = await fileApi.upload(token.access_token, file, {
        category: 'logo',
        refType: LOGO_REF_TYPE,
        refId: storeInfo.id,
      })
      if (!uploaded.url) {
        throw new Error('Logo URL is empty')
      }
      const response = await storeApi.updateInfo(token.access_token, {
        logo_url: uploaded.url,
      })
      setStoreInfo(response.data)
      setStoreInfoForm(mapStoreInfoToForm(response.data))
      setDocumentFavicon(uploaded.url)
      setStoreInfoMessage('Đã cập nhật logo cửa hàng.')
    } catch (uploadError) {
      if (uploadError instanceof ApiError) setStoreInfoError(uploadError.message)
      else setStoreInfoError('Không thể tải logo lên.')
    } finally {
      setLogoSubmitting(false)
    }
  }

  const onDeleteLogo = async () => {
    if (!token?.access_token || !storeInfo?.logo_url || !storeInfo.id) return

    if (!canManageStore) {
      setStoreInfoError('Chỉ owner/admin được xóa logo cửa hàng.')
      return
    }

    setLogoSubmitting(true)
    setStoreInfoError(null)
    setStoreInfoMessage(null)

    try {
      await fileApi.deleteByRef(token.access_token, LOGO_REF_TYPE, storeInfo.id).catch(() => undefined)
      const response = await storeApi.updateInfo(token.access_token, {
        logo_url: '',
      })
      setStoreInfo(response.data)
      setStoreInfoForm(mapStoreInfoToForm(response.data))
      setDocumentFavicon(null)
      setStoreInfoMessage('Đã xóa logo cửa hàng.')
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setStoreInfoError(deleteError.message)
      else setStoreInfoError('Không thể xóa logo cửa hàng.')
    } finally {
      setLogoSubmitting(false)
    }
  }

  const onApplyUploadedAds = (files: FileRecord[] = adsFiles) => {
    const urls = mapFilesToAdsUrls(files)
    setStoreSettingsForm((prev) => ({
      ...prev,
      customerDisplayAds: urls.join('\n'),
    }))
  }

  const onUploadAdsFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || !token?.access_token) return

    if (!canManageStore) {
      setSettingsError('Chỉ owner/admin được quản lý danh sách ảnh quảng cáo.')
      return
    }

    setAdsFilesUploading(true)
    setSettingsError(null)
    setSettingsMessage(null)

    try {
      await fileApi.uploadMultiple(token.access_token, files, {
        category: 'general',
        refType: ADS_REF_TYPE,
        refId: ADS_REF_ID,
      })
      const refreshed = await fileApi.list(token.access_token, {
        category: 'general',
        ref_type: ADS_REF_TYPE,
        ref_id: ADS_REF_ID,
        per_page: 200,
      })
      setAdsFiles(refreshed.files)
      onApplyUploadedAds(refreshed.files)
      setSettingsMessage('Đã tải ảnh quảng cáo. Nhấn "Cập nhật cấu hình" để áp dụng cho màn hình khách.')
    } catch (uploadError) {
      if (uploadError instanceof ApiError) setSettingsError(uploadError.message)
      else setSettingsError('Không thể tải ảnh quảng cáo lên.')
    } finally {
      setAdsFilesUploading(false)
    }
  }

  const onDeleteAdsFile = async (fileRecord: FileRecord) => {
    if (!token?.access_token) return
    if (!canManageStore) {
      setSettingsError('Chỉ owner/admin được xóa ảnh quảng cáo.')
      return
    }

    const confirmed = window.confirm(`Xóa ảnh quảng cáo "${fileRecord.original_name}"?`)
    if (!confirmed) return

    setSettingsError(null)
    setSettingsMessage(null)

    try {
      await fileApi.delete(token.access_token, fileRecord.id)
      const nextFiles = adsFiles.filter((item) => item.id !== fileRecord.id)
      setAdsFiles(nextFiles)
      onApplyUploadedAds(nextFiles)
      setSettingsMessage('Đã xóa ảnh quảng cáo. Nhấn "Cập nhật cấu hình" để áp dụng cho màn hình khách.')
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setSettingsError(deleteError.message)
      else setSettingsError('Không thể xóa ảnh quảng cáo.')
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
    const cashRoundingStep = Number(storeSettingsForm.cashRoundingStep)
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
    if (!Number.isFinite(cashRoundingStep) || cashRoundingStep < 1) {
      setSettingsError('Bac lam tron tien mat khong hop le.')
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
          'sale.cash_rounding_enabled': storeSettingsForm.cashRoundingEnabled,
          'sale.cash_rounding_step': Math.trunc(cashRoundingStep),
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
    return resolveAssetUrl(storeInfo?.logo_url)
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
            <p className="mt-2 text-xs text-ink-500">Logo sẽ được dùng làm favicon của trang web.</p>
            {logoPreviewUrl && !logoPreviewFailed ? (
              <img
                src={logoPreviewUrl}
                alt="Store logo"
                className="mt-3 h-14 w-auto object-contain"
                onError={() => setLogoPreviewFailed(true)}
              />
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
          <label className="flex items-center gap-2 text-sm text-ink-700 md:col-span-2">
            <input
              type="checkbox"
              checked={storeSettingsForm.cashRoundingEnabled}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  cashRoundingEnabled: event.target.checked,
                }))
              }
              disabled={!canManageStore || storeLoading}
            />
            Bật làm tròn tiền mặt khi thanh toán
          </label>
          <label className="space-y-2 text-sm text-ink-700">
            <span>Bậc làm tròn tiền mặt (đồng)</span>
            <input
              type="number"
              min={1}
              value={storeSettingsForm.cashRoundingStep}
              onChange={(event) =>
                setStoreSettingsForm((prev) => ({
                  ...prev,
                  cashRoundingStep: event.target.value,
                }))
              }
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
              disabled={!canManageStore || storeLoading || !storeSettingsForm.cashRoundingEnabled}
            />
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
            Màn hình khách: hiển thị giá bán từng dòng thuốc
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
            Màn hình khách: hiển thị tổng tiền hóa đơn
          </label>

          <div className="space-y-3 text-sm text-ink-700 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Danh sách ads màn hình khách</span>
              {canManageStore ? (
                <div className="flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-full border border-ink-900/10 bg-white px-4 py-1.5 text-xs font-semibold text-ink-900">
                    {adsFilesUploading ? 'Đang tải...' : 'Tải ảnh quảng cáo'}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={adsFilesUploading || storeLoading}
                      onChange={(event) => {
                        void onUploadAdsFiles(event)
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => onApplyUploadedAds()}
                    disabled={!adsUrlsFromFiles.length || storeLoading}
                    className="rounded-full border border-ink-900/10 bg-white px-4 py-1.5 text-xs font-semibold text-ink-900 disabled:opacity-60"
                  >
                    Dùng danh sách ảnh đã tải lên
                  </button>
                </div>
              ) : null}
            </div>

            {adsFilesLoading ? (
              <p className="text-xs text-ink-500">Đang tải danh sách ảnh quảng cáo...</p>
            ) : null}
            {!adsFilesLoading && adsFilesSorted.length === 0 ? (
              <p className="text-xs text-ink-500">Chưa có ảnh quảng cáo trên File Service.</p>
            ) : null}
            {adsFilesSorted.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {adsFilesSorted.map((item) => {
                  const previewUrl = resolveAssetUrl(item.url)
                  return (
                    <div key={item.id} className="rounded-2xl border border-ink-900/10 bg-white p-2">
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt={item.original_name}
                          className="h-24 w-full rounded-xl object-cover"
                        />
                      ) : (
                        <div className="flex h-24 items-center justify-center rounded-xl bg-fog-50 text-xs text-ink-500">
                          Không có preview
                        </div>
                      )}
                      <p className="mt-2 truncate text-xs font-medium text-ink-800">{item.original_name}</p>
                      <p className="text-[11px] text-ink-500">{formatFileSize(item.size)}</p>
                      <div className="mt-2 flex gap-2">
                        {previewUrl ? (
                          <a
                            href={previewUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-full border border-ink-900/10 px-3 py-1 text-[11px] font-semibold text-ink-900"
                          >
                            Xem trước
                          </a>
                        ) : null}
                        {canManageStore ? (
                          <button
                            type="button"
                            onClick={() => void onDeleteAdsFile(item)}
                            className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-[11px] font-semibold text-coral-500"
                          >
                            Xóa
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}

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
              Mỗi dòng 1 URL ảnh. Bạn có thể dùng ảnh từ File Service hoặc dán URL thủ công.
            </p>
          </div>

          <label className="space-y-2 text-sm text-ink-700">
            <span>Kiểu transition ads</span>
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
            <span>Chu kỳ đổi ads (giây)</span>
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
            <span>Thời gian transition (ms)</span>
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

      {/* --- Backup & Sync --- */}
      {canManageStore ? (
        <section className="glass-card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-ink-900">Sao lưu & Đồng bộ dữ liệu</h3>
              <p className="mt-1 text-sm text-ink-600">
                Tạo bản sao lưu database, tải về, tải lên bản sao lưu cũ hoặc đồng bộ với server khác.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadBackups()}
              disabled={backupLoading}
              className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
            >
              Tải lại
            </button>
          </div>

          {!pgDumpOk ? (
            <p className="mt-3 text-sm text-amber-700">
              `pg_dump` chưa được cài đặt trên server. Tính năng tạo sao lưu tự động sẽ không hoạt động.
              Tuy nhiên bạn vẫn có thể tải lên và khôi phục từ file sao lưu.
            </p>
          ) : null}

          {backupError ? <p className="mt-3 text-sm text-coral-500">{backupError}</p> : null}
          {backupMessage ? <p className="mt-3 text-sm text-brand-600">{backupMessage}</p> : null}

          {/* Backup actions */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onCreateBackup()}
              disabled={backupCreating || !pgDumpOk}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {backupCreating ? 'Đang tạo...' : 'Tạo bản sao lưu'}
            </button>
            <label className="cursor-pointer rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900">
              {backupUploading ? 'Đang tải lên...' : 'Tải lên bản sao lưu'}
              <input
                type="file"
                accept=".sql,.sql.gz,.gz"
                className="hidden"
                disabled={backupUploading}
                onChange={(event) => { void onUploadBackup(event) }}
              />
            </label>
          </div>

          {/* Backup list */}
          {backupLoading ? <p className="mt-4 text-sm text-ink-600">Đang tải danh sách...</p> : null}
          {!backupLoading && backups.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">Chưa có bản sao lưu nào.</p>
          ) : null}
          {backups.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ink-900/10 text-xs uppercase tracking-wider text-ink-500">
                    <th className="pb-2 pr-4">Tên file</th>
                    <th className="pb-2 pr-4">Kích thước</th>
                    <th className="pb-2 pr-4">Thời gian</th>
                    <th className="pb-2 pr-4">Ghi chú</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.id} className="border-b border-ink-900/5">
                      <td className="py-2 pr-4 font-mono text-xs text-ink-800">{b.filename}</td>
                      <td className="py-2 pr-4 text-ink-600">{formatFileSize(b.size_bytes)}</td>
                      <td className="py-2 pr-4 text-ink-600">{formatDateTime(b.created_at)}</td>
                      <td className="py-2 pr-4 text-ink-500">{b.note ?? '-'}</td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => void onDownloadBackup(b.id, b.filename)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
                          >
                            Tải về
                          </button>
                          <button
                            type="button"
                            onClick={() => void onRestoreBackup(b.id)}
                            disabled={backupRestoring === b.id}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-50 disabled:opacity-60"
                          >
                            {backupRestoring === b.id ? 'Đang khôi phục...' : 'Khôi phục'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteBackup(b.id)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-coral-500 hover:bg-coral-50"
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Auto backup settings */}
          <div className="mt-6 border-t border-ink-900/10 pt-4">
            <h4 className="text-sm font-semibold uppercase tracking-wider text-ink-500">Sao lưu tự động</h4>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={bkAutoEnabled}
                  onChange={(e) => setBkAutoEnabled(e.target.checked)}
                  disabled={!pgDumpOk}
                />
                Bật sao lưu tự động
              </label>
              <label className="space-y-1 text-sm text-ink-700">
                <span>Chu kỳ (giờ)</span>
                <input
                  type="number"
                  min={1}
                  value={bkAutoInterval}
                  onChange={(e) => setBkAutoInterval(e.target.value)}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  disabled={!bkAutoEnabled}
                />
              </label>
              <label className="space-y-1 text-sm text-ink-700">
                <span>Số bản tối đa</span>
                <input
                  type="number"
                  min={1}
                  value={bkMaxFiles}
                  onChange={(e) => setBkMaxFiles(e.target.value)}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
            </div>
          </div>

          {/* Sync settings */}
          <div className="mt-6 border-t border-ink-900/10 pt-4">
            <h4 className="text-sm font-semibold uppercase tracking-wider text-ink-500">Đồng bộ với R2</h4>
            <p className="mt-1 text-xs text-ink-500">
              Đẩy bản sao lưu mới nhất lên R2 hoặc kéo bản sao lưu mới nhất từ R2 về danh sách local.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onSaveBackupSettings()}
                disabled={bkSettingsSaving}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {bkSettingsSaving ? 'Đang lưu...' : 'Lưu cấu hình sao lưu'}
              </button>
              <button
                type="button"
                onClick={() => void onSyncPush()}
                disabled={backupSyncing !== null}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
              >
                {backupSyncing === 'push' ? 'Đang đẩy...' : 'Đẩy lên R2'}
              </button>
              <button
                type="button"
                onClick={() => void onSyncPull()}
                disabled={backupSyncing !== null}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
              >
                {backupSyncing === 'pull' ? 'Đang kéo...' : 'Kéo từ R2'}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
