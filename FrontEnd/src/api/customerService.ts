import { ApiError, buildUsersApiUrl } from './usersService'

export type CustomerRecord = {
  id: string
  code: string
  name: string
  phone: string
  email: string | null
  date_of_birth: string | null
  gender: 'male' | 'female' | 'other' | null
  address: string | null
  current_points: number
  total_points_earned: number
  total_points_used: number
  points_expire_at: string | null
  tier: string
  tier_updated_at: string | null
  total_orders: number
  total_spent: string | number
  last_purchase_at: string | null
  is_active: boolean
  note: string | null
  created_at: string
  updated_at: string
}

export type CustomerStatsResponse = {
  customer_id: string
  customer_code: string
  customer_name: string
  tier: string
  tier_discount_percent: number
  total_orders: number
  total_spent: number
  last_purchase_at: string | null
  current_points: number
  total_points_earned: number
  total_points_used: number
  points_expire_at: string | null
}

export type CustomerCreatePayload = {
  name: string
  phone: string
  email?: string | null
  date_of_birth?: string | null
  gender?: 'male' | 'female' | 'other' | null
  address?: string | null
  note?: string | null
  is_active?: boolean
}

export type CustomerUpdatePayload = {
  name?: string | null
  phone?: string | null
  email?: string | null
  date_of_birth?: string | null
  gender?: 'male' | 'female' | 'other' | null
  address?: string | null
  note?: string | null
  is_active?: boolean
}

export type CustomerListParams = {
  search?: string
  tier?: string
  is_active?: boolean
  page?: number
  size?: number
}

export type PageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export type TierConfigRecord = {
  tier_name: string
  min_points: number
  point_multiplier: string | number
  discount_percent: string | number
  benefits: string | null
  display_order: number
  created_at: string
  updated_at: string
}

export type PromotionDiscountType = 'percent' | 'fixed'

export type PromotionRecord = {
  id: string
  code: string
  name: string
  description: string | null
  discount_type: PromotionDiscountType
  discount_value: string | number
  max_discount: string | number | null
  min_order_amount: string | number | null
  start_date: string
  end_date: string
  applicable_tiers: string[] | null
  applicable_products: string[] | null
  applicable_groups: string[] | null
  usage_limit: number | null
  usage_per_customer: number | null
  current_usage: number
  is_active: boolean
  auto_apply: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export type PromotionUsageRecord = {
  id: string
  promotion_id: string
  customer_id: string | null
  invoice_id: string
  invoice_code: string | null
  discount_amount: string | number
  is_cancelled: boolean
  cancelled_reason: string | null
  cancelled_at: string | null
  created_at: string
}

export type PromotionCreatePayload = {
  code: string
  name: string
  description?: string | null
  discount_type: PromotionDiscountType
  discount_value: string | number
  max_discount?: string | number | null
  min_order_amount?: string | number | null
  start_date: string
  end_date: string
  applicable_tiers?: string[] | null
  applicable_products?: string[] | null
  applicable_groups?: string[] | null
  usage_limit?: number | null
  usage_per_customer?: number | null
  is_active?: boolean
  auto_apply?: boolean
}

export type PromotionUpdatePayload = {
  code?: string | null
  name?: string | null
  description?: string | null
  discount_type?: PromotionDiscountType
  discount_value?: string | number | null
  max_discount?: string | number | null
  min_order_amount?: string | number | null
  start_date?: string | null
  end_date?: string | null
  applicable_tiers?: string[] | null
  applicable_products?: string[] | null
  applicable_groups?: string[] | null
  usage_limit?: number | null
  usage_per_customer?: number | null
  is_active?: boolean
  auto_apply?: boolean
}

export type PromotionListParams = {
  search?: string
  is_active?: boolean
  auto_apply?: boolean
  page?: number
  size?: number
}

const requestCustomerJson = async <T>(
  path: string,
  token: string,
  init: RequestInit = {},
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)

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
            return loc
              ? `${loc}: ${item?.msg ?? 'Du lieu khong hop le'}`
              : (item?.msg ?? 'Du lieu khong hop le')
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

export const customerApi = {
  listCustomers: (token: string, params?: CustomerListParams) =>
    requestCustomerJson<PageResponse<CustomerRecord>>(
      '/customer/customers',
      token,
      { method: 'GET' },
      params,
    ),

  getCustomerById: (token: string, customerId: string) =>
    requestCustomerJson<CustomerRecord>(
      `/customer/customers/${encodeURIComponent(customerId)}`,
      token,
      { method: 'GET' },
    ),

  getCustomerByPhone: (token: string, phone: string) =>
    requestCustomerJson<CustomerRecord>(
      `/customer/customers/phone/${encodeURIComponent(phone.trim())}`,
      token,
      { method: 'GET' },
    ),

  getCustomerStats: (token: string, customerId: string) =>
    requestCustomerJson<CustomerStatsResponse>(
      `/customer/customers/${encodeURIComponent(customerId)}/stats`,
      token,
      { method: 'GET' },
    ),

  createCustomer: (token: string, payload: CustomerCreatePayload) =>
    requestCustomerJson<CustomerRecord>(
      '/customer/customers',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateCustomer: (token: string, customerId: string, payload: CustomerUpdatePayload) =>
    requestCustomerJson<CustomerRecord>(
      `/customer/customers/${encodeURIComponent(customerId)}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteCustomer: (token: string, customerId: string) =>
    requestCustomerJson<{ message: string }>(
      `/customer/customers/${encodeURIComponent(customerId)}`,
      token,
      { method: 'DELETE' },
    ),

  listTiers: (token: string) =>
    requestCustomerJson<TierConfigRecord[]>(
      '/customer/tiers',
      token,
      { method: 'GET' },
    ),

  listPromotions: (token: string, params?: PromotionListParams) =>
    requestCustomerJson<PageResponse<PromotionRecord>>(
      '/customer/promotions',
      token,
      { method: 'GET' },
      params,
    ),

  listActivePromotions: (token: string) =>
    requestCustomerJson<PromotionRecord[]>(
      '/customer/promotions/active',
      token,
      { method: 'GET' },
    ),

  getPromotionById: (token: string, promotionId: string) =>
    requestCustomerJson<PromotionRecord>(
      `/customer/promotions/${encodeURIComponent(promotionId)}`,
      token,
      { method: 'GET' },
    ),

  createPromotion: (token: string, payload: PromotionCreatePayload) =>
    requestCustomerJson<PromotionRecord>(
      '/customer/promotions',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updatePromotion: (token: string, promotionId: string, payload: PromotionUpdatePayload) =>
    requestCustomerJson<PromotionRecord>(
      `/customer/promotions/${encodeURIComponent(promotionId)}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deletePromotion: (token: string, promotionId: string) =>
    requestCustomerJson<{ message: string }>(
      `/customer/promotions/${encodeURIComponent(promotionId)}`,
      token,
      { method: 'DELETE' },
    ),

  listPromotionUsages: (
    token: string,
    promotionId: string,
    params?: { page?: number; size?: number },
  ) =>
    requestCustomerJson<PageResponse<PromotionUsageRecord>>(
      `/customer/promotions/${encodeURIComponent(promotionId)}/usages`,
      token,
      { method: 'GET' },
      params,
    ),
}
