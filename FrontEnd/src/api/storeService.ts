import {
  createApiUrlBuilder,
  requestJson,
  requestResponse,
  type ApiFetchOptions,
} from './httpClient'

export type StoreInfo = {
  id: string
  name: string
  address: string | null
  phone: string | null
  email: string | null
  tax_code: string | null
  license_number: string | null
  owner_name: string | null
  logo_url: string | null
  bank_account: string | null
  bank_name: string | null
  bank_branch: string | null
  created_at: string
  updated_at: string
}

export type UpdateStoreInfoPayload = {
  name?: string
  address?: string | null
  phone?: string | null
  email?: string | null
  tax_code?: string | null
  license_number?: string | null
  owner_name?: string | null
  logo_url?: string | null
  bank_account?: string | null
  bank_name?: string | null
  bank_branch?: string | null
}

export type StoreSettingItem = {
  key: string
  value: unknown
  group_name: string
  data_type: 'boolean' | 'number' | 'string' | 'json'
  description: string
  is_public: boolean
  updated_at: string
  updated_by: string | null
}

export type StoreSettingsMap = Record<string, unknown>

export type StoreDrugGroup = {
  id: string
  category_id: string
  name: string
  description: string | null
  vat_rate: number | string
  other_tax_rate: number | string
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type StoreDrugCategory = {
  id: string
  name: string
  description: string | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
  groups: StoreDrugGroup[]
}

export type ListDrugCategoriesResponse = {
  items: StoreDrugCategory[]
  total_categories: number
  total_groups: number
}

export type CreateDrugCategoryPayload = {
  name: string
  description?: string | null
  is_active?: boolean
  sort_order?: number
}

export type UpdateDrugCategoryPayload = {
  name?: string
  description?: string | null
  is_active?: boolean
  sort_order?: number
}

export type CreateDrugGroupPayload = {
  category_id: string
  name: string
  description?: string | null
  vat_rate?: number
  other_tax_rate?: number
  is_active?: boolean
  sort_order?: number
}

export type UpdateDrugGroupPayload = {
  category_id?: string
  name?: string
  description?: string | null
  vat_rate?: number
  other_tax_rate?: number
  is_active?: boolean
  sort_order?: number
}

export type BackupRecord = {
  id: string
  filename: string
  size_bytes: number
  databases: string[]
  note: string | null
  created_at: string
  created_by: string | null
}

export type OperatingExpense = {
  id: string
  category: string
  name: string
  amount: number
  expense_date: string
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type CreateExpensePayload = {
  category: string
  name: string
  amount: number
  expense_date: string
  note?: string | null
}

export type UpdateExpensePayload = {
  category?: string
  name?: string
  amount?: number
  expense_date?: string
  note?: string | null
}

export const buildStoreApiUrl = createApiUrlBuilder({
  envPrefix: import.meta.env.VITE_STORE_API_PREFIX,
  fallbackPrefix: '/api/v1/store',
})

const requestStoreJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
  fetchOptions?: ApiFetchOptions,
): Promise<T> =>
  requestJson<T>(buildStoreApiUrl, path, {
    init,
    token,
    params,
    fetchMode: 'controlled',
    fetchOptions,
  })

export const storeApi = {
  health: () => requestStoreJson<{ service: string; status: string }>('/health', { method: 'GET' }),

  getInfo: () =>
    requestStoreJson<StoreInfo>('/info', { method: 'GET' }, undefined, undefined, {
      getCacheMs: 10000,
      max429Retries: 2,
    }),

  updateInfo: (token: string, payload: UpdateStoreInfoPayload) =>
    requestStoreJson<{ message: string; data: StoreInfo }>(
      '/info',
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  uploadLogo: async (token: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return requestJson<{ message: string; logo_url: string; data: StoreInfo }>(buildStoreApiUrl, '/info/logo', {
      token,
      init: {
        method: 'POST',
        body: formData,
      },
    })
  },

  deleteLogo: (token: string) =>
    requestStoreJson<{ message: string; data: StoreInfo }>(
      '/info/logo',
      { method: 'DELETE' },
      token,
    ),

  getAllSettings: () => requestStoreJson<StoreSettingsMap>('/settings', { method: 'GET' }),

  getSettingsByGroup: (group: string) =>
    requestStoreJson<StoreSettingsMap>(`/settings/group/${encodeURIComponent(group)}`, {
      method: 'GET',
    }),

  getSetting: (key: string) =>
    requestStoreJson<StoreSettingItem>(`/settings/${encodeURIComponent(key)}`, { method: 'GET' }),

  updateSetting: (token: string, key: string, value: unknown) =>
    requestStoreJson<{ message: string; key: string; value: unknown }>(
      `/settings/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ value }),
      },
      token,
    ),

  updateSettingsBulk: (token: string, settings: StoreSettingsMap) =>
    requestStoreJson<{ message: string; updated: number }>(
      '/settings',
      {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      },
      token,
    ),

  resetAllSettings: (token: string) =>
    requestStoreJson<{ message: string; updated: number }>(
      '/settings/reset',
      { method: 'POST' },
      token,
    ),

  resetSetting: (token: string, key: string) =>
    requestStoreJson<{ message: string; key: string; value: unknown }>(
      `/settings/reset/${encodeURIComponent(key)}`,
      { method: 'POST' },
      token,
    ),

  listDrugCategories: (params?: { include_inactive?: boolean; search?: string }) =>
    requestStoreJson<ListDrugCategoriesResponse>('/drug-categories', { method: 'GET' }, undefined, params),

  createDrugCategory: (token: string, payload: CreateDrugCategoryPayload) =>
    requestStoreJson<{ message: string; data: StoreDrugCategory }>(
      '/drug-categories',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateDrugCategory: (token: string, categoryId: string, payload: UpdateDrugCategoryPayload) =>
    requestStoreJson<{ message: string; data: StoreDrugCategory }>(
      `/drug-categories/${encodeURIComponent(categoryId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  deleteDrugCategory: (token: string, categoryId: string) =>
    requestStoreJson<{ message: string; id: string }>(
      `/drug-categories/${encodeURIComponent(categoryId)}`,
      { method: 'DELETE' },
      token,
    ),

  createDrugGroup: (token: string, payload: CreateDrugGroupPayload) =>
    requestStoreJson<{ message: string; data: StoreDrugGroup }>(
      '/drug-groups',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateDrugGroup: (token: string, groupId: string, payload: UpdateDrugGroupPayload) =>
    requestStoreJson<{ message: string; data: StoreDrugGroup }>(
      `/drug-groups/${encodeURIComponent(groupId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  deleteDrugGroup: (token: string, groupId: string) =>
    requestStoreJson<{ message: string; id: string }>(
      `/drug-groups/${encodeURIComponent(groupId)}`,
      { method: 'DELETE' },
      token,
    ),

  // --- Backup ---

  listBackups: (token: string) =>
    requestStoreJson<{ items: BackupRecord[]; total: number; pg_dump_ok: boolean }>(
      '/backup/list',
      { method: 'GET' },
      token,
    ),

  createBackup: (token: string, note?: string) =>
    requestStoreJson<{ message: string; data: BackupRecord }>(
      '/backup/create',
      {
        method: 'POST',
        body: JSON.stringify({ note: note ?? '' }),
      },
      token,
    ),

  downloadBackup: async (token: string, backupId: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await requestResponse(
      buildStoreApiUrl,
      `/backup/download/${encodeURIComponent(backupId)}`,
      {
        token,
        init: { method: 'GET' },
      },
    )
    const filename = response.headers.get('x-backup-filename') ?? 'backup.sql.gz'
    const blob = await response.blob()
    return { blob, filename }
  },

  deleteBackup: (token: string, backupId: string) =>
    requestStoreJson<{ message: string; id: string }>(
      `/backup/${encodeURIComponent(backupId)}`,
      { method: 'DELETE' },
      token,
    ),

  uploadBackup: async (token: string, file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return requestJson<{ message: string; data: BackupRecord }>(buildStoreApiUrl, '/backup/upload', {
      token,
      init: {
        method: 'POST',
        body: formData,
      },
    })
  },

  restoreBackup: (token: string, backupId: string) =>
    requestStoreJson<{ message: string }>(
      `/backup/restore/${encodeURIComponent(backupId)}`,
      { method: 'POST' },
      token,
    ),

  syncPush: (token: string) =>
    requestStoreJson<{ message: string }>('/backup/sync/push', { method: 'POST' }, token),

  syncPull: (token: string) =>
    requestStoreJson<{ message: string }>('/backup/sync/pull', { method: 'POST' }, token),

  // --- Expenses ---

  listExpenses: (token: string, params?: { date_from?: string; date_to?: string; category?: string }) =>
    requestStoreJson<{ items: OperatingExpense[]; total: number }>('/expenses', { method: 'GET' }, token, params),

  createExpense: (token: string, payload: CreateExpensePayload) =>
    requestStoreJson<{ message: string; data: OperatingExpense }>(
      '/expenses',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateExpense: (token: string, expenseId: string, payload: UpdateExpensePayload) =>
    requestStoreJson<{ message: string; data: OperatingExpense }>(
      `/expenses/${encodeURIComponent(expenseId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  deleteExpense: (token: string, expenseId: string) =>
    requestStoreJson<{ message: string; id: string }>(
      `/expenses/${encodeURIComponent(expenseId)}`,
      { method: 'DELETE' },
      token,
    ),
}
