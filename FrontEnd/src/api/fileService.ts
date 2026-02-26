import { ApiError } from './usersService'

export type FileCategory =
  | 'product'
  | 'invoice'
  | 'document'
  | 'avatar'
  | 'logo'
  | 'backup'
  | 'general'

export type FileRecord = {
  id: string
  filename: string
  original_name: string
  content_type: string
  size: number
  r2_key: string
  url: string
  category: FileCategory | string
  ref_type?: string
  ref_id?: string
  uploaded_by: string
  created_at: string
}

export type FileListResponse = {
  files: FileRecord[]
  total: number
  page: number
  per_page: number
  total_pages: number
}

export type PresignedUrlResponse = {
  url: string
  expires_in: number
}

type UploadOptions = {
  category?: FileCategory | string
  refType?: string
  refId?: string
}

const sanitizePrefix = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

const sanitizeBase = (value: string) => value.trim().replace(/\/+$/, '')

const API_BASE = sanitizeBase(import.meta.env.VITE_API_BASE_URL ?? '')
const FILE_PREFIX = sanitizePrefix(import.meta.env.VITE_FILE_API_PREFIX ?? '/api/v1/file')

export const buildFileApiUrl = (
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const target = `${API_BASE}${FILE_PREFIX}${normalizedPath}`
  const url = new URL(target, window.location.origin)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return
      url.searchParams.set(key, String(value))
    })
  }
  return url.toString()
}

const requestFileJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildFileApiUrl(path, params), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail = payload?.detail ?? payload?.message ?? `Yeu cau that bai (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

const appendUploadFields = (formData: FormData, options?: UploadOptions) => {
  if (!options) return
  if (options.category?.trim()) formData.append('category', options.category.trim())
  if (options.refType?.trim()) formData.append('ref_type', options.refType.trim())
  if (options.refId?.trim()) formData.append('ref_id', options.refId.trim())
}

export const fileApi = {
  list: (
    token: string,
    params?: {
      category?: FileCategory | string
      ref_type?: string
      ref_id?: string
      search?: string
      page?: number
      per_page?: number
    },
  ) => requestFileJson<FileListResponse>('/list', { method: 'GET' }, token, params),

  upload: async (token: string, file: File, options?: UploadOptions) => {
    const formData = new FormData()
    formData.append('file', file)
    appendUploadFields(formData, options)

    const response = await fetch(buildFileApiUrl('/upload'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(payload?.detail ?? `Yeu cau that bai (${response.status})`, response.status)
    }
    return payload as FileRecord
  },

  uploadMultiple: async (token: string, files: File[], options?: UploadOptions) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    appendUploadFields(formData, options)

    const response = await fetch(buildFileApiUrl('/upload/multiple'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok && response.status !== 207) {
      throw new ApiError(payload?.detail ?? `Yeu cau that bai (${response.status})`, response.status)
    }
    return payload as { files: FileRecord[]; errors: string[]; total: number }
  },

  delete: (token: string, fileId: string) =>
    requestFileJson<{ message: string }>(
      `/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' },
      token,
    ),

  deleteByRef: (token: string, refType: string, refId: string) =>
    requestFileJson<{ message: string; deleted: number }>(
      `/ref/${encodeURIComponent(refType)}/${encodeURIComponent(refId)}`,
      { method: 'DELETE' },
      token,
    ),

  presignDownload: (token: string, fileId: string) =>
    requestFileJson<PresignedUrlResponse>(
      `/presign/download/${encodeURIComponent(fileId)}`,
      { method: 'GET' },
      token,
    ),
}
