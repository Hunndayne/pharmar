import { ApiError, buildUsersApiUrl } from './usersService'
import { controlledFetch } from './fetchControl'

export type SaleInvoiceCreateItem = {
  sku?: string | null
  product_id: string
  product_code?: string | null
  product_name?: string | null
  unit_id: string
  unit_name?: string | null
  conversion_rate?: number
  batch_id: string
  lot_number?: string | null
  expiry_date?: string | null
  quantity: number
  unit_price: number
  discount_amount?: number
}

export type SaleInvoiceCreatePayload = {
  customer_id?: string | null
  items: SaleInvoiceCreateItem[]
  promotion_code?: string | null
  points_used?: number
  payment_method?: string
  service_fee_amount?: number
  service_fee_mode?: 'split' | 'separate'
  amount_paid?: number
  note?: string | null
}

export type PageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export type SaleInvoiceItem = {
  id: string
  invoice_id: string
  product_id: string
  product_code: string
  product_name: string
  unit_id: string
  unit_name: string
  conversion_rate: number
  batch_id: string
  lot_number: string | null
  expiry_date: string | null
  unit_price: string | number
  quantity: number
  discount_amount: string | number
  line_total: string | number
  returned_quantity: number
  created_at: string
}

export type SaleInvoicePayment = {
  id: string
  invoice_id: string
  payment_method: string
  amount: string | number
  reference_code: string | null
  card_type: string | null
  card_last_4: string | null
  note: string | null
  created_at: string
}

export type SaleInvoiceResponse = {
  id: string
  code: string
  customer_id: string | null
  customer_code: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_tier: string | null
  subtotal: string | number
  discount_amount: string | number
  tier_discount: string | number
  promotion_discount: string | number
  points_discount: string | number
  total_amount: string | number
  points_used: number
  points_earned: number
  promotion_code: string | null
  payment_method: string
  service_fee_amount: string | number
  service_fee_mode: string
  amount_paid: string | number
  change_amount: string | number
  status: string
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_by: string
  created_by_name: string | null
  cashier_code: string | null
  note: string | null
  created_at: string
  updated_at: string
  items: SaleInvoiceItem[]
  payments: SaleInvoicePayment[]
}

export type SaleInvoiceListItem = {
  id: string
  code: string
  customer_name: string | null
  customer_phone: string | null
  total_amount: string | number
  amount_paid: string | number
  payment_method: string
  service_fee_amount: string | number
  service_fee_mode: string
  status: string
  cashier_name: string | null
  created_at: string
}

export type PublicSaleInvoiceListItem = {
  id: string
  code: string
  customer_name: string | null
  customer_phone: string | null
  total_amount: string | number
  amount_paid: string | number
  payment_method: string
  service_fee_amount: string | number
  service_fee_mode: string
  status: string
  created_at: string
}

export type PublicSaleInvoiceItem = {
  id: string
  product_code: string
  product_name: string
  unit_name: string
  lot_number: string | null
  expiry_date: string | null
  unit_price: string | number
  quantity: number
  discount_amount: string | number
  line_total: string | number
  returned_quantity: number
  created_at: string
}

export type PublicSaleInvoicePayment = {
  id: string
  payment_method: string
  amount: string | number
  note: string | null
  created_at: string
}

export type PublicSaleInvoiceResponse = {
  id: string
  code: string
  customer_name: string | null
  customer_phone: string | null
  customer_tier: string | null
  subtotal: string | number
  discount_amount: string | number
  tier_discount: string | number
  promotion_discount: string | number
  points_discount: string | number
  total_amount: string | number
  points_used: number
  points_earned: number
  promotion_code: string | null
  payment_method: string
  service_fee_amount: string | number
  service_fee_mode: string
  amount_paid: string | number
  change_amount: string | number
  status: string
  cancel_reason: string | null
  note: string | null
  created_at: string
  updated_at: string
  items: PublicSaleInvoiceItem[]
  payments: PublicSaleInvoicePayment[]
}

export type SaleInvoiceListParams = {
  status?: string
  date_from?: string
  date_to?: string
  cashier_id?: string
  search?: string
  page?: number
  size?: number
}

export type SaleStatsTodayResponse = {
  date: string
  total_invoices: number
  total_sales: string | number
  total_returns: string | number
  total_cancelled: string | number
  net_sales: string | number
}

export type SaleInvoiceCancelResponse = {
  message: string
  invoice: {
    id: string
    code: string
    status: string
    cancelled_at: string | null
    cancelled_by: string | null
    cancel_reason: string | null
  }
  rollback: {
    stock_returned?: boolean
    points_refunded?: number
    points_earned_revoked?: number
    promotion_usage_revoked?: boolean
  }
}

export type SaleInvoicePrintData = {
  store: {
    name?: string | null
    address?: string | null
    phone?: string | null
    tax_code?: string | null
    license_number?: string | null
    logo_url?: string | null
  }
  invoice: {
    code?: string | null
    date?: string | null
    cashier?: string | null
  }
  customer: {
    name?: string | null
    phone?: string | null
    tier?: string | null
  }
  items: Array<{
    name?: string | null
    unit?: string | null
    qty?: number | string | null
    price?: number | string | null
    amount?: number | string | null
  }>
  summary: {
    subtotal?: number | string | null
    tier_discount?: number | string | null
    promotion?: {
      code?: string | null
      amount?: number | string | null
    } | null
    points_discount?: number | string | null
    service_fee_amount?: number | string | null
    service_fee_mode?: string | null
    total?: number | string | null
  }
  payment: {
    method?: string | null
    amount_paid?: number | string | null
    change?: number | string | null
  }
  points: {
    used?: number | string | null
    earned?: number | string | null
  }
  footer: {
    message?: string | null
    return_policy?: string | null
    return_window_value?: number | string | null
    return_window_unit?: string | null
  }
}

export type SaleReturnCreatePayload = {
  invoice_id: string
  items: Array<{
    invoice_item_id: string
    quantity: number
    reason?: string | null
    condition?: 'good' | 'damaged' | 'expired'
  }>
  refund_method?: 'cash' | 'card' | 'points'
  reason?: string | null
}

export type SaleReturnResponse = {
  id: string
  code: string
  invoice_id: string
  invoice_code: string
  status: string
}

export type SaleReturnApproveResponse = {
  message: string
  return: {
    id: string
    code: string
    status: string
    approved_by?: string | null
    approved_at?: string | null
  }
  actions?: {
    stock_returned?: boolean
    points_adjusted?: number
    refund_amount?: number | string
  }
}

const requestSaleJson = async <T>(
  path: string,
  token: string,
  init: RequestInit = {},
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
  headers.set('Authorization', `Bearer ${token}`)

  const response = await controlledFetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  }, fetchOptions)

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

const requestPublicSaleJson = async <T>(
  path: string,
  init: RequestInit = {},
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

  const response = await controlledFetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  }, fetchOptions)

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detailMessage = Array.isArray(payload?.detail)
      ? payload.detail
          .map((item: { msg?: string; loc?: (string | number)[] }) => {
            const loc = Array.isArray(item?.loc) ? item.loc.join('.') : ''
            return loc ? `${loc}: ${item?.msg ?? 'Du lieu khong hop le'}` : (item?.msg ?? 'Du lieu khong hop le')
          })
          .join('; ')
      : undefined

    const detail =
      detailMessage ??
      (typeof payload?.detail === 'string' ? payload.detail : undefined) ??
      payload?.message ??
      `Yeu cau that bai (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const saleApi = {
  listInvoices: (token: string, params?: SaleInvoiceListParams) =>
    requestSaleJson<PageResponse<SaleInvoiceListItem>>('/sale/invoices', token, { method: 'GET' }, params),

  getInvoiceById: (token: string, invoiceId: string) =>
    requestSaleJson<SaleInvoiceResponse>(
      `/sale/invoices/${encodeURIComponent(invoiceId)}`,
      token,
      { method: 'GET' },
    ),

  getInvoiceByCode: (token: string, code: string) =>
    requestSaleJson<SaleInvoiceResponse>(
      `/sale/invoices/code/${encodeURIComponent(code.trim())}`,
      token,
      { method: 'GET' },
    ),

  getInvoicePrintData: (token: string, invoiceId: string) =>
    requestSaleJson<SaleInvoicePrintData>(
      `/sale/invoices/${encodeURIComponent(invoiceId)}/print`,
      token,
      { method: 'GET' },
    ),

  createInvoice: (token: string, payload: SaleInvoiceCreatePayload) =>
    requestSaleJson<SaleInvoiceResponse>(
      '/sale/invoices',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  cancelInvoice: (token: string, invoiceId: string, reason: string) =>
    requestSaleJson<SaleInvoiceCancelResponse>(
      `/sale/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),

  createReturn: (token: string, payload: SaleReturnCreatePayload) =>
    requestSaleJson<SaleReturnResponse>(
      '/sale/returns',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  approveReturn: (token: string, returnId: string) =>
    requestSaleJson<SaleReturnApproveResponse>(
      `/sale/returns/${encodeURIComponent(returnId)}/approve`,
      token,
      {
        method: 'POST',
      },
    ),

  getStatsToday: (token: string) =>
    requestSaleJson<SaleStatsTodayResponse>(
      '/sale/stats/today',
      token,
      { method: 'GET' },
      undefined,
      { getCacheMs: 5000, max429Retries: 2 },
    ),

  publicGetInvoiceByCode: (code: string) =>
    requestPublicSaleJson<PublicSaleInvoiceResponse>(
      `/sale/public/invoices/code/${encodeURIComponent(code.trim())}`,
      { method: 'GET' },
      undefined,
      { retryOn429: true, max429Retries: 1 },
    ),

  publicListInvoicesByPhone: (phone: string, params?: { page?: number; size?: number }) =>
    requestPublicSaleJson<PageResponse<PublicSaleInvoiceListItem>>(
      `/sale/public/invoices/phone/${encodeURIComponent(phone.trim())}`,
      { method: 'GET' },
      params,
      { retryOn429: true, max429Retries: 1 },
    ),
}
