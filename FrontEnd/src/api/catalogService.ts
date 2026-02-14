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

type ListManufacturersParams = {
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
            return loc ? `${loc}: ${item?.msg ?? 'Du lieu khong hop le'}` : (item?.msg ?? 'Du lieu khong hop le')
          })
          .join('; ')
      : undefined
    const detail =
      detailMessage ??
      payload?.detail ??
      payload?.message ??
      `Yeu cau that bai (${response.status})`
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
}
