import { ApiError, buildUsersApiUrl } from './usersService'

export type CatalogPageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export type ManufacturerItem = {
  id: string
  code: string
  name: string
  country: string | null
  address: string | null
  phone: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type SupplierItem = {
  id: string
  code: string
  name: string
  address: string | null
  phone: string
  email: string | null
  tax_code: string | null
  contact_person: string | null
  current_debt: string | number
  is_active: boolean
  note: string | null
  created_at: string
  updated_at: string
}

export type SupplierDebtHistoryItem = {
  id: string
  supplier_id: string
  type: string
  amount: string | number
  balance_after: string | number
  reference_type: string | null
  reference_id: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

export type SupplierDebtResponse = {
  supplier_id: string
  supplier_code: string
  supplier_name: string
  current_debt: string | number
  history: CatalogPageResponse<SupplierDebtHistoryItem>
}

type ListManufacturersParams = {
  search?: string
  is_active?: boolean
  page?: number
  size?: number
}

type ListSuppliersParams = {
  search?: string
  is_active?: boolean
  page?: number
  size?: number
}

type ManufacturerCreatePayload = {
  code?: string | null
  name: string
  country?: string | null
  address?: string | null
  phone?: string | null
  is_active?: boolean
}

type ManufacturerUpdatePayload = {
  code?: string | null
  name?: string
  country?: string | null
  address?: string | null
  phone?: string | null
  is_active?: boolean
}

type SupplierCreatePayload = {
  code?: string | null
  name: string
  address?: string | null
  phone: string
  email?: string | null
  tax_code?: string | null
  contact_person?: string | null
  current_debt?: string | number
  is_active?: boolean
  note?: string | null
}

type SupplierUpdatePayload = {
  code?: string | null
  name?: string
  address?: string | null
  phone?: string
  email?: string | null
  tax_code?: string | null
  contact_person?: string | null
  is_active?: boolean
  note?: string | null
}

type SupplierDebtPaymentPayload = {
  amount: string | number
  note?: string | null
  reference_id?: string | null
}

const requestCatalogJson = async <T>(
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
              ? `${loc}: ${item?.msg ?? 'D\u1eef li\u1ec7u kh\u00f4ng h\u1ee3p l\u1ec7'}`
              : (item?.msg ?? 'D\u1eef li\u1ec7u kh\u00f4ng h\u1ee3p l\u1ec7')
          })
          .join('; ')
      : undefined
    const detail =
      detailMessage ??
      payload?.detail ??
      payload?.message ??
      `Y\u00eau c\u1ea7u th\u1ea5t b\u1ea1i (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const catalogApi = {
  listManufacturers: (token: string, params?: ListManufacturersParams) =>
    requestCatalogJson<CatalogPageResponse<ManufacturerItem>>(
      '/catalog/manufacturers',
      token,
      { method: 'GET' },
      params,
    ),

  getManufacturer: (token: string, manufacturerId: string) =>
    requestCatalogJson<ManufacturerItem>(
      `/catalog/manufacturers/${manufacturerId}`,
      token,
      { method: 'GET' },
    ),

  createManufacturer: (token: string, payload: ManufacturerCreatePayload) =>
    requestCatalogJson<ManufacturerItem>(
      '/catalog/manufacturers',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateManufacturer: (token: string, manufacturerId: string, payload: ManufacturerUpdatePayload) =>
    requestCatalogJson<ManufacturerItem>(
      `/catalog/manufacturers/${manufacturerId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteManufacturer: (token: string, manufacturerId: string) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/manufacturers/${manufacturerId}`,
      token,
      { method: 'DELETE' },
    ),

  listSuppliers: (token: string, params?: ListSuppliersParams) =>
    requestCatalogJson<CatalogPageResponse<SupplierItem>>(
      '/catalog/suppliers',
      token,
      { method: 'GET' },
      params,
    ),

  getSupplier: (token: string, supplierId: string) =>
    requestCatalogJson<SupplierItem>(
      `/catalog/suppliers/${supplierId}`,
      token,
      { method: 'GET' },
    ),

  createSupplier: (token: string, payload: SupplierCreatePayload) =>
    requestCatalogJson<SupplierItem>(
      '/catalog/suppliers',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateSupplier: (token: string, supplierId: string, payload: SupplierUpdatePayload) =>
    requestCatalogJson<SupplierItem>(
      `/catalog/suppliers/${supplierId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteSupplier: (token: string, supplierId: string) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/suppliers/${supplierId}`,
      token,
      { method: 'DELETE' },
    ),

  getSupplierDebt: (token: string, supplierId: string, params?: { page?: number; size?: number }) =>
    requestCatalogJson<SupplierDebtResponse>(
      `/catalog/suppliers/${supplierId}/debt`,
      token,
      { method: 'GET' },
      params,
    ),

  paySupplierDebt: (token: string, supplierId: string, payload: SupplierDebtPaymentPayload) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/suppliers/${supplierId}/debt/payment`,
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
}
