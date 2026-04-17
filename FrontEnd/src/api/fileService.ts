import { createApiUrlBuilder, requestJson } from './httpClient'

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

export const buildFileApiUrl = createApiUrlBuilder({
  envPrefix: import.meta.env.VITE_FILE_API_PREFIX,
  fallbackPrefix: '/api/v1/file',
})

const requestFileJson = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> =>
  requestJson<T>(buildFileApiUrl, path, {
    init,
    token,
    params,
  })

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

    return requestJson<FileRecord>(buildFileApiUrl, '/upload', {
      token,
      init: {
        method: 'POST',
        body: formData,
      },
    })
  },

  uploadMultiple: async (token: string, files: File[], options?: UploadOptions) => {
    const formData = new FormData()
    files.forEach((file) => formData.append('files', file))
    appendUploadFields(formData, options)

    return requestJson<{ files: FileRecord[]; errors: string[]; total: number }>(
      buildFileApiUrl,
      '/upload/multiple',
      {
        token,
        init: {
          method: 'POST',
          body: formData,
        },
      },
    )
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
