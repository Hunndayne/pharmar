import type { AiInvoiceExtraction } from '../../api/aiService'

export type AiLineHintData = {
  rawName: string
  rawUnit: string
  productId: string | null
  productName: string | null
  unitId: string | null
  unitName: string | null
  confidence: number | null
  source: 'agent' | 'memory' | null
  reason: string
  isFree: boolean
  notes: string[]
}

export type InvoiceImportResult = {
  extraction: AiInvoiceExtraction
  supplierId: string
  invoiceSerial: string
  invoiceNumber: string
  invoiceDate: string
}

export const buildAiLineHint = (line: AiInvoiceExtraction['lines'][number]): AiLineHintData => ({
  rawName: line.raw_name,
  rawUnit: line.raw_unit ?? '',
  productId: line.match?.product_id ?? null,
  productName: line.match?.product_name ?? null,
  unitId: line.match?.unit_id ?? null,
  unitName: line.match?.unit_name ?? null,
  confidence: line.match ? line.match.confidence : null,
  source: line.match?.source ?? null,
  reason: line.match?.reason ?? '',
  isFree: line.is_free,
  notes: line.notes ?? [],
})
