import { createApiUrlBuilder, requestJson, requestResponse } from './httpClient'

export type AiInvoiceSource =
  | { kind: 'image'; pages: number[] }
  | { kind: 'pdf'; pages: number[]; original_index: number; has_text: boolean }

export type AiInvoiceFile = {
  file_id: string
  kind: 'image' | 'pdf'
  content_type: string
  page: number | null
  page_count?: number
  size: number
}

// Text fields come back as "" (not null) when the AI could not read them.
export type AiInvoiceHeader = {
  supplier_name: string
  supplier_tax_code: string
  serial: string
  number: string
  date: string
  lookup_code: string
  subtotal: number | null
  vat_rate: number | null
  vat_amount: number | null
  total: number | null
}

export type AiSupplierCandidate = {
  supplier_id: string
  name: string
  tax_code?: string
  score?: number
}

export type AiSupplierMatch = {
  matched: boolean
  supplier_id?: string
  name?: string
  reason?: string
  candidates: AiSupplierCandidate[] | null
}

export type AiDuplicateReceipt = {
  id: string
  code: string
  receipt_date: string
  supplier_id?: string
  status?: string
}

export type AiLineMatch = {
  product_id: string
  product_code: string
  product_name: string
  unit_id: string | null
  unit_name: string | null
  conversion: number
  confidence: number
  source: 'agent' | 'memory'
  reason: string
}

export type AiInvoiceLine = {
  index: number
  raw_name: string
  raw_unit: string
  quantity: number
  unit_price: number | null
  amount: number | null
  vat_rate: number | null
  is_free: boolean
  match: AiLineMatch | null
  draft: { quantity: number; import_price: number }
  notes: string[] | null
}

export type AiInvoiceUsage = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  cost_usd: number
}

export type AiInvoiceExtraction = {
  extraction_id: string
  files: AiInvoiceFile[] | null
  invoice: AiInvoiceHeader
  supplier: AiSupplierMatch
  duplicate_receipts: AiDuplicateReceipt[] | null
  price_includes_vat: boolean
  lines: AiInvoiceLine[]
  warnings: string[] | null
  usage: AiInvoiceUsage
}

export type AiMappingItem = {
  raw_name: string
  raw_unit: string
  product_id: string
  unit_id: string | null
}

export type AiUsageToday = {
  date: string
  cost_usd: number
  budget_usd: number
  requests: number
}

export const buildAiApiUrl = createApiUrlBuilder({
  envPrefix: import.meta.env.VITE_AI_API_PREFIX,
  fallbackPrefix: '/api/v1/ai',
  devGatewayPort: 8000,
})

export const aiApi = {
  // Plain fetch (no controlled retry): the AI call is slow and billed, so a 429 must surface, not be retried.
  extractPurchaseInvoice: (
    token: string,
    input: { pages: Blob[]; originals: File[]; sources: AiInvoiceSource[]; pdfText: string },
    signal?: AbortSignal,
  ) => {
    const formData = new FormData()
    input.pages.forEach((page, index) => {
      formData.append('pages', page, `page-${index + 1}.jpg`)
    })
    input.originals.forEach((file) => formData.append('originals', file, file.name))
    formData.append('sources', JSON.stringify(input.sources))
    if (input.pdfText.trim()) formData.append('pdf_text', input.pdfText)

    return requestJson<AiInvoiceExtraction>(buildAiApiUrl, '/purchase-invoices/extract', {
      token,
      init: { method: 'POST', body: formData, signal },
      defaultErrorMessage: 'Không đọc được hóa đơn',
    })
  },

  confirmMappings: async (token: string, payload: { supplier_id: string; items: AiMappingItem[] }) => {
    await requestResponse(buildAiApiUrl, '/purchase-invoices/mappings', {
      token,
      init: { method: 'POST', body: JSON.stringify(payload) },
      defaultErrorMessage: 'Không lưu được ghi nhớ tên thuốc',
    })
  },

  getUsageToday: (token: string) =>
    requestJson<AiUsageToday>(buildAiApiUrl, '/usage/today', {
      token,
      init: { method: 'GET' },
      defaultErrorMessage: 'Không tải được chi phí AI hôm nay',
    }),
}
