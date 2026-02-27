import { ApiError, buildUsersApiUrl } from './usersService'

export type CatalogPageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

export type DrugGroupItem = {
  id: string
  code: string
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
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

export type ProductGroupRef = {
  id: string
  code: string
  name: string
}

export type ProductManufacturerRef = {
  id: string
  code: string
  name: string
}

export type ProductUnitItem = {
  id: string
  product_id: string
  unit_name: string
  conversion_rate: number
  barcode: string | null
  selling_price: string | number
  is_base_unit: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export type ProductListItem = {
  id: string
  code: string
  barcode: string | null
  name: string
  active_ingredient: string | null
  registration_number: string | null
  group_name: string | null
  manufacturer_name: string | null
  base_unit: string | null
  base_price: string | number | null
  vat_rate: string | number
  other_tax_rate: string | number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type ProductDetailItem = {
  id: string
  code: string
  barcode: string | null
  name: string
  active_ingredient: string | null
  registration_number: string | null
  group: ProductGroupRef | null
  manufacturer: ProductManufacturerRef | null
  instructions: string | null
  note: string | null
  vat_rate: string | number
  other_tax_rate: string | number
  is_active: boolean
  units: ProductUnitItem[]
  created_at: string
  updated_at: string
}

export type DrugReferenceUnitHint = {
  single_unit: boolean
  has_intermediate: boolean
  import_unit_name: string | null
  import_conversion: number | null
  intermediate_unit_name: string | null
  intermediate_conversion: number | null
  retail_unit_name: string
  retail_conversion: number
}

export type DrugReferenceItem = {
  registration_number: string
  name: string
  active_ingredient: string | null
  strength: string | null
  dosage_form: string | null
  packaging: string | null
  manufacturer: string | null
  manufacturer_country: string | null
  registrant: string | null
  instruction_url: string | null
  is_otc: boolean
  unit_hint: DrugReferenceUnitHint | null
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

export type MasterDataImportResult = {
  imported: number
  failed: number
  errors: string[]
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

type ListDrugGroupsParams = {
  search?: string
  is_active?: boolean
  page?: number
  size?: number
}

type DrugGroupCreatePayload = {
  code?: string | null
  name: string
  description?: string | null
  is_active?: boolean
}

type DrugGroupUpdatePayload = {
  code?: string | null
  name?: string
  description?: string | null
  is_active?: boolean
}

type ListProductsParams = {
  search?: string
  group_id?: string
  manufacturer_id?: string
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

type ProductCreatePayload = {
  code?: string | null
  barcode?: string | null
  name: string
  active_ingredient?: string | null
  registration_number?: string | null
  group_id?: string | null
  manufacturer_id?: string | null
  instructions?: string | null
  note?: string | null
  vat_rate?: string | number
  other_tax_rate?: string | number
  is_active?: boolean
  base_unit?: {
    unit_name: string
    selling_price: string | number
  } | null
}

type ProductUpdatePayload = {
  code?: string | null
  barcode?: string | null
  name?: string
  active_ingredient?: string | null
  registration_number?: string | null
  group_id?: string | null
  manufacturer_id?: string | null
  instructions?: string | null
  note?: string | null
  vat_rate?: string | number
  other_tax_rate?: string | number
  is_active?: boolean
}

type ProductUnitCreatePayload = {
  unit_name: string
  conversion_rate: number
  barcode?: string | null
  selling_price: string | number
  is_base_unit?: boolean
  is_active?: boolean
}

type ProductUnitUpdatePayload = {
  unit_name?: string
  conversion_rate?: number
  barcode?: string | null
  selling_price?: string | number
  is_base_unit?: boolean
  is_active?: boolean
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
              ? `${loc}: ${item?.msg ?? 'Dữ liệu không hợp lệ'}`
              : (item?.msg ?? 'Dữ liệu không hợp lệ')
          })
          .join('; ')
      : undefined
    const detail =
      detailMessage ??
      payload?.detail ??
      payload?.message ??
      `Yêu cầu thất bại (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

const requestCatalogBlob = async (
  path: string,
  token: string,
  params?: Record<string, string | number | boolean | undefined>,
) => {
  const response = await fetch(buildUsersApiUrl(path, params), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('application/json') ? await response.json() : null
    const detail = payload?.detail ?? payload?.message ?? `Request failed (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return response.blob()
}

const uploadCatalogFile = async <T>(
  path: string,
  token: string,
  file: File,
) => {
  const form = new FormData()
  form.append('file', file)

  const response = await fetch(buildUsersApiUrl(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail = payload?.detail ?? payload?.message ?? `Request failed (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const catalogApi = {
  listDrugGroups: (token: string, params?: ListDrugGroupsParams) =>
    requestCatalogJson<CatalogPageResponse<DrugGroupItem>>(
      '/catalog/drug-groups',
      token,
      { method: 'GET' },
      params,
    ),

  getDrugGroup: (token: string, groupId: string) =>
    requestCatalogJson<DrugGroupItem>(
      `/catalog/drug-groups/${groupId}`,
      token,
      { method: 'GET' },
    ),

  createDrugGroup: (token: string, payload: DrugGroupCreatePayload) =>
    requestCatalogJson<DrugGroupItem>(
      '/catalog/drug-groups',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateDrugGroup: (token: string, groupId: string, payload: DrugGroupUpdatePayload) =>
    requestCatalogJson<DrugGroupItem>(
      `/catalog/drug-groups/${groupId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteDrugGroup: (token: string, groupId: string) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/drug-groups/${groupId}`,
      token,
      { method: 'DELETE' },
    ),

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

  exportManufacturers: (token: string) =>
    requestCatalogBlob('/catalog/manufacturers/export', token),

  importManufacturers: (token: string, file: File) =>
    uploadCatalogFile<MasterDataImportResult>('/catalog/manufacturers/import', token, file),

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

  exportSuppliers: (token: string) =>
    requestCatalogBlob('/catalog/suppliers/export', token),

  importSuppliers: (token: string, file: File) =>
    uploadCatalogFile<MasterDataImportResult>('/catalog/suppliers/import', token, file),

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

  listProducts: (token: string, params?: ListProductsParams) =>
    requestCatalogJson<CatalogPageResponse<ProductListItem>>(
      '/catalog/products',
      token,
      { method: 'GET' },
      params,
    ),

  searchDrugReferences: (
    token: string,
    params: { q: string; limit?: number; otc_only?: boolean },
  ) =>
    requestCatalogJson<DrugReferenceItem[]>(
      '/catalog/reference/drugs/search',
      token,
      { method: 'GET' },
      params,
    ),

  getDrugReferenceByRegistration: (
    token: string,
    registrationNumber: string,
    params?: { otc_only?: boolean },
  ) =>
    requestCatalogJson<DrugReferenceItem>(
      `/catalog/reference/drugs/registration/${encodeURIComponent(registrationNumber)}`,
      token,
      { method: 'GET' },
      params,
    ),

  getProduct: (token: string, productId: string) =>
    requestCatalogJson<ProductDetailItem>(
      `/catalog/products/${productId}`,
      token,
      { method: 'GET' },
    ),

  createProduct: (token: string, payload: ProductCreatePayload) =>
    requestCatalogJson<ProductDetailItem>(
      '/catalog/products',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateProduct: (token: string, productId: string, payload: ProductUpdatePayload) =>
    requestCatalogJson<ProductDetailItem>(
      `/catalog/products/${productId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteProduct: (token: string, productId: string) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/products/${productId}`,
      token,
      { method: 'DELETE' },
    ),

  createProductUnit: (token: string, productId: string, payload: ProductUnitCreatePayload) =>
    requestCatalogJson<ProductUnitItem>(
      `/catalog/products/${productId}/units`,
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  updateProductUnit: (
    token: string,
    productId: string,
    unitId: string,
    payload: ProductUnitUpdatePayload,
  ) =>
    requestCatalogJson<ProductUnitItem>(
      `/catalog/products/${productId}/units/${unitId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  deleteProductUnit: (token: string, productId: string, unitId: string) =>
    requestCatalogJson<{ message: string }>(
      `/catalog/products/${productId}/units/${unitId}`,
      token,
      { method: 'DELETE' },
    ),
}
