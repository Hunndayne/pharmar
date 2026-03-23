import { ApiError, buildUsersApiUrl, type ApiValidationDetailItem } from './usersService'
import { controlledFetch } from './fetchControl'

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

export type InventoryPaymentStatus = 'paid' | 'debt'
export type InventoryPaymentMethod = 'bank' | 'ewallet' | 'card'
export type InventoryPromoType = 'none' | 'buy_x_get_y' | 'discount_percent'
export type InventoryBatchStatus = 'active' | 'expired' | 'depleted' | 'cancelled'
export type InventoryStockStatus =
  | 'out_of_stock'
  | 'expired'
  | 'expiring_soon'
  | 'near_date'
  | 'low_stock'
  | 'normal'

export type InventoryMetaDrug = {
  id: string
  code: string
  name: string
  group: string
  instructions?: string | null
  base_unit: string
  reorder_level: number
  units: InventoryMetaUnit[]
  unit_prices: InventoryMetaUnitPrice[]
  sku_aliases: string[]
}

export type InventoryReceiptLineUnitPrice = {
  unit_id: string
  unit_name: string
  conversion: number
  price: number
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
  barcode: string
  promo_type: InventoryPromoType
  promo_buy_qty: number | null
  promo_get_qty: number | null
  promo_discount_percent: number | null
  unit_prices: InventoryReceiptLineUnitPrice[]
  promo_note: string | null
  line_total: number
  batch_status: InventoryBatchStatus
}

export type InventoryReceipt = {
  id: string
  code: string
  receipt_date: string
  supplier_id: string
  supplier_name: string
  supplier_contact: string
  shipping_carrier: string | null
  payment_status: InventoryPaymentStatus
  payment_method: InventoryPaymentMethod
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

export type InventoryReceiptListItem = {
  id: string
  code: string
  receipt_date: string
  supplier_id: string
  supplier_name: string
  supplier_contact: string
  shipping_carrier: string | null
  payment_status: InventoryPaymentStatus
  payment_method: InventoryPaymentMethod
  status: 'confirmed' | 'cancelled'
  total_value: number
  line_count: number
  created_at: string
  updated_at: string
  can_edit: boolean
}

export type InventoryBatch = {
  id: string
  batch_code: string
  lot_number: string
  receipt_id: string
  drug_id: string
  drug_code: string
  drug_name: string
  drug_group: string
  supplier_id: string
  supplier_name: string
  supplier_contact: string
  received_date: string
  mfg_date: string
  exp_date: string
  days_to_expiry: number
  qty_in: number
  qty_remaining: number
  import_price: number
  barcode: string
  promo_type: InventoryPromoType
  promo_buy_qty: number | null
  promo_get_qty: number | null
  promo_discount_percent: number | null
  unit_prices: InventoryReceiptLineUnitPrice[]
  promo_note: string | null
  status: InventoryBatchStatus
  created_at: string
  updated_at: string
}

export type PaginatedResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export type InventoryImportReceiptPagedResponse = PaginatedResponse<InventoryReceiptListItem>

export type InventoryBatchPagedResponse = PaginatedResponse<InventoryBatch> & {
  summary: {
    total_drugs: number
    out_of_stock: number
    near_date: number
    expired: number
  }
}

export type InventoryStockListItem = {
  drug_id: string
  drug_code: string
  drug_name: string
  drug_group: string
  base_unit: string
  reorder_level: number
  total_qty: number
  nearest_expiry: string | null
  days_to_nearest_expiry: number | null
  active_batch_count: number
  status: InventoryStockStatus
  units: InventoryMetaUnit[]
}

export type InventoryStockDrugPagedResponse = PaginatedResponse<InventoryStockListItem> & {
  summary: {
    total_drugs: number
    out_of_stock: number
    near_date: number
    expired: number
  }
}

export type InventoryMovement = {
  id: string
  event_type: string
  drug_id: string
  drug_code: string | null
  drug_name: string | null
  batch_id: string
  batch_code: string | null
  lot_number: string | null
  quantity_delta: number
  reference_type: string
  reference_id: string
  actor: string | null
  note: string | null
  occurred_at: string
}

export type InventoryBatchDetail = {
  batch: InventoryBatch
  history: InventoryMovement[]
}

export type InventoryIssueSuggestionAllocation = {
  batch_id: string
  batch_code: string
  lot_number: string
  drug_id: string
  drug_code: string
  drug_name: string
  received_date: string
  exp_date: string
  available: number
  allocated: number
  strategy: 'fefo' | 'fifo'
}

export type InventoryIssueSuggestion = {
  drug_id: string
  drug_code: string
  drug_name: string
  requested: number
  allocated: number
  shortage: number
  rule: {
    enable_fefo?: boolean
    fefo_threshold_days: number
    description: string
  }
  allocations: InventoryIssueSuggestionAllocation[]
}

export type InventoryStockSummary = {
  drug_id: string
  drug_code: string
  drug_name: string
  drug_group: string
  base_unit: string
  reorder_level: number
  total_qty: number
  nearest_expiry: string | null
  days_to_nearest_expiry: number | null
  status: InventoryStockStatus
}

export type InventoryStockDrugDetail = {
  drug: InventoryMetaDrug
  summary: {
    total_qty: number
    status: InventoryStockStatus
    reorder_level: number
  }
  batches: InventoryBatch[]
}

export type InventoryAdjustStockPayload = {
  batch_id: string
  reason: string
  note?: string | null
  quantity_delta?: number
  new_quantity?: number
}

export type InventoryAdjustStockResponse = {
  message: string
  batch: InventoryBatch
  adjustment: InventoryMovement
}

export type InventoryCreateReceiptPayload = {
  receipt_date: string
  supplier_id: string
  shipping_carrier?: string | null
  payment_status?: InventoryPaymentStatus
  payment_method?: InventoryPaymentMethod
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
    barcode?: string | null
    promo_type?: InventoryPromoType
    promo_buy_qty?: number | null
    promo_get_qty?: number | null
    promo_discount_percent?: number | null
    unit_prices?: InventoryReceiptLineUnitPrice[]
    promo_note?: string | null
  }>
}

export type InventoryUpdateReceiptPayload = InventoryCreateReceiptPayload

const requestInventoryJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
  fetchOptions?: {
    dedupe?: boolean
    dedupeKey?: string
    getCacheMs?: number
    retryOn429?: boolean
    max429Retries?: number
  },
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await controlledFetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  }, fetchOptions)

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const validationDetail = Array.isArray(payload?.detail)
      ? (payload.detail as ApiValidationDetailItem[])
      : undefined
    const detailMessage = validationDetail
      ? validationDetail
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

    throw new ApiError(detail, response.status, {
      detail: payload?.detail,
      validationDetail,
    })
  }

  return payload as T
}

export const inventoryApi = {
  getMetaSuppliers: (token?: string) =>
    requestInventoryJson<InventoryMetaSupplier[]>('/inventory/meta/suppliers', { method: 'GET' }, token),

  getMetaDrugs: (token?: string) =>
    requestInventoryJson<InventoryMetaDrug[]>('/inventory/meta/drugs', { method: 'GET' }, token),

  listImportReceipts: (params?: {
    date_from?: string
    date_to?: string
    supplier_id?: string
    status?: 'confirmed' | 'cancelled'
  }) => requestInventoryJson<InventoryReceipt[]>('/inventory/import-receipts', { method: 'GET' }, undefined, params),

  listImportReceiptsPaged: (params?: {
    page?: number
    size?: number
    date_from?: string
    date_to?: string
    supplier_id?: string
    status?: 'confirmed' | 'cancelled'
    payment_status?: InventoryPaymentStatus
    search?: string
  }) =>
    requestInventoryJson<InventoryImportReceiptPagedResponse>(
      '/inventory/import-receipts/paged',
      { method: 'GET' },
      undefined,
      params,
    ),

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

  listBatches: (params?: {
    search?: string
    drug?: string
    supplier_id?: string
    status?: InventoryBatchStatus
    exp_from?: string
    exp_to?: string
    hide_zero?: boolean
  }) => requestInventoryJson<InventoryBatch[]>('/inventory/batches', { method: 'GET' }, undefined, params),

  listBatchesPaged: (params?: {
    page?: number
    size?: number
    search?: string
    drug?: string
    supplier_id?: string
    status?: InventoryBatchStatus
    exp_from?: string
    exp_to?: string
    hide_zero?: boolean
  }) =>
    requestInventoryJson<InventoryBatchPagedResponse>(
      '/inventory/batches/paged',
      { method: 'GET' },
      undefined,
      params,
    ),

  getBatchDetail: (batchId: string) =>
    requestInventoryJson<InventoryBatchDetail>(`/inventory/batches/${batchId}`, { method: 'GET' }),

  getBatchByQr: (qrValue: string, token?: string) =>
    requestInventoryJson<InventoryBatchDetail>(
      `/inventory/batches/qr/${encodeURIComponent(qrValue)}`,
      { method: 'GET' },
      token,
    ),

  suggestIssueByDrug: (params: {
    quantity: number
    drug_id?: string
    drug_code?: string
    as_of?: string
  }, token?: string) =>
    requestInventoryJson<InventoryIssueSuggestion>(
      '/inventory/batches/suggest-issue',
      { method: 'GET' },
      token,
      params,
    ),

  getStockSummary: (token?: string) =>
    requestInventoryJson<InventoryStockSummary[]>(
      '/inventory/stock/summary',
      { method: 'GET' },
      token,
      undefined,
      { getCacheMs: 4000, max429Retries: 2 },
    ),

  listStockDrugsPaged: (params?: {
    page?: number
    size?: number
    search?: string
    drug?: string
    supplier_id?: string
    exp_from?: string
    exp_to?: string
    quick_filter?: 'all' | 'out' | 'near' | 'expired'
  }) =>
    requestInventoryJson<InventoryStockDrugPagedResponse>(
      '/inventory/stock/drugs/paged',
      { method: 'GET' },
      undefined,
      params,
    ),

  getStockDrugDetail: (drugId: string, token?: string) =>
    requestInventoryJson<InventoryStockDrugDetail>(
      `/inventory/stock/drugs/${drugId}`,
      { method: 'GET' },
      token,
    ),

  adjustStock: (token: string, payload: InventoryAdjustStockPayload) =>
    requestInventoryJson<InventoryAdjustStockResponse>(
      '/inventory/stock/adjustments',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      token,
    ),
}
