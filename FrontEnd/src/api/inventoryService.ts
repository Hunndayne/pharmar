import { ApiError, buildUsersApiUrl } from './usersService'

export type InventoryMetaSupplier = {
  id: string
  name: string
  contact_name: string
  phone: string
  address: string
}

export type InventoryMetaUnit = {
  id: string
  name: string
  conversion: number
  barcode: string
}

export type InventoryMetaUnitPrice = {
  unit_id: string
  price: number
}

export type InventoryMetaDrug = {
  id: string
  code: string
  name: string
  group: string
  base_unit: string
  reorder_level: number
  units: InventoryMetaUnit[]
  unit_prices: InventoryMetaUnitPrice[]
  sku_aliases: string[]
}

export type InventoryReceiptLine = {
  id: string
  batch_id: string
  drug_id: string
  drug_code: string
  drug_name: string
  lot_number: string
  batch_code: string
  quantity: number
  mfg_date: string
  exp_date: string
  import_price: number
  promo_note: string | null
  line_total: number
  batch_status: 'active' | 'expired' | 'depleted' | 'cancelled'
}

export type InventoryReceipt = {
  id: string
  code: string
  receipt_date: string
  supplier_id: string
  supplier_name: string
  supplier_contact: string
  note: string | null
  status: 'confirmed' | 'cancelled'
  created_by: string
  created_at: string
  updated_at: string
  total_value: number
  line_count: number
  lines: InventoryReceiptLine[]
  can_edit: boolean
}

export type InventoryCreateReceiptPayload = {
  receipt_date: string
  supplier_id: string
  note?: string | null
  lines: Array<{
    drug_id?: string
    drug_code?: string
    batch_code?: string
    lot_number: string
    quantity: number
    mfg_date: string
    exp_date: string
    import_price: number
    promo_note?: string | null
  }>
}

export type InventoryUpdateReceiptPayload = InventoryCreateReceiptPayload

const requestInventoryJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detailMessage = Array.isArray(payload?.detail)
      ? payload.detail
          .map((item: { msg?: string; loc?: (string | number)[] }) => {
            const loc = Array.isArray(item?.loc) ? item.loc.join('.') : ''
            return loc ? `${loc}: ${item?.msg ?? 'Dữ liệu không hợp lệ'}` : (item?.msg ?? 'Dữ liệu không hợp lệ')
          })
          .join('; ')
      : undefined
    const detail =
      detailMessage ??
      (typeof payload?.detail === 'string' ? payload.detail : undefined) ??
      payload?.message ??
      `Yêu cầu thất bại (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const inventoryApi = {
  getMetaSuppliers: () =>
    requestInventoryJson<InventoryMetaSupplier[]>('/inventory/meta/suppliers', { method: 'GET' }),

  getMetaDrugs: () =>
    requestInventoryJson<InventoryMetaDrug[]>('/inventory/meta/drugs', { method: 'GET' }),

  listImportReceipts: (params?: {
    date_from?: string
    date_to?: string
    supplier_id?: string
    status?: 'confirmed' | 'cancelled'
  }) => requestInventoryJson<InventoryReceipt[]>('/inventory/import-receipts', { method: 'GET' }, undefined, params),

  getImportReceipt: (receiptId: string) =>
    requestInventoryJson<InventoryReceipt>(`/inventory/import-receipts/${receiptId}`, { method: 'GET' }),

  createImportReceipt: (token: string, payload: InventoryCreateReceiptPayload) =>
    requestInventoryJson<InventoryReceipt>(
      '/inventory/import-receipts',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),

  updateImportReceipt: (token: string, receiptId: string, payload: InventoryUpdateReceiptPayload) =>
    requestInventoryJson<InventoryReceipt>(
      `/inventory/import-receipts/${receiptId}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      token,
    ),

  cancelImportReceipt: (token: string, receiptId: string) =>
    requestInventoryJson<{ message: string; receipt: InventoryReceipt }>(
      `/inventory/import-receipts/${receiptId}/cancel`,
      { method: 'POST' },
      token,
    ),
}
