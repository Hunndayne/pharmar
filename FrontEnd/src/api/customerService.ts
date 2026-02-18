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
}
