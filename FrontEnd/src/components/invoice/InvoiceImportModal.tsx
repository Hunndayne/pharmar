import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { aiApi, type AiInvoiceExtraction, type AiUsageToday } from '../../api/aiService'
import { ApiError } from '../../api/httpClient'
import {
  InvoicePrepError,
  MAX_INVOICE_PAGES,
  isPdfFile,
  prepareInvoiceFiles,
  validateInvoiceFile,
} from '../../utils/invoiceFiles'
import type { InvoiceImportResult } from './types'

type SupplierOption = { id: string; name: string }

type InvoiceImportModalProps = {
  accessToken: string
  suppliers: SupplierOption[]
  onClose: () => void
  onOpenDraft: (result: InvoiceImportResult) => void
}

type SelectedFile = {
  id: string
  file: File
  previewUrl: string | null
}

type Phase = 'idle' | 'preparing' | 'reading'

const formatMoney = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : `${Math.round(value).toLocaleString('vi-VN')}đ`

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const formatIsoDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

const describeError = (error: unknown) => {
  if (error instanceof InvoicePrepError) return error.message
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    if (error.status === 413) return 'Ảnh hoặc file quá lớn để gửi lên máy chủ.'
    if (error.status === 504) return 'Máy chủ AI phản hồi quá lâu. Vui lòng thử lại sau.'
    return error.message
  }
  if (error instanceof TypeError) return 'Không kết nối được máy chủ AI. Kiểm tra mạng rồi thử lại.'
  return 'Không đọc được hóa đơn. Vui lòng thử lại.'
}

let fileSeq = 0

export function InvoiceImportModal({ accessToken, suppliers, onClose, onOpenDraft }: InvoiceImportModalProps) {
  const [files, setFiles] = useState<SelectedFile[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AiInvoiceExtraction | null>(null)
  const [supplierId, setSupplierId] = useState('')
  const [invoiceSerial, setInvoiceSerial] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [usage, setUsage] = useState<AiUsageToday | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewUrlsRef = useRef<Set<string>>(new Set())
  const controllersRef = useRef<Set<AbortController>>(new Set())

  useEffect(() => {
    const urls = previewUrlsRef.current
    const controllers = controllersRef.current
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
    }
  }, [])

  useEffect(() => {
    if (!accessToken) return
    let active = true
    aiApi
      .getUsageToday(accessToken)
      .then((value) => {
        if (active) setUsage(value)
      })
      .catch(() => {
        // usage is informational only
      })
    return () => {
      active = false
    }
  }, [accessToken])

  const busy = phase !== 'idle'

  const handleClose = () => {
    controllersRef.current.forEach((controller) => controller.abort())
    onClose()
  }

  const handlePickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!picked.length) return
    const problems: string[] = []
    const accepted: SelectedFile[] = []
    picked.forEach((file) => {
      const problem = validateInvoiceFile(file)
      if (problem) {
        problems.push(problem)
        return
      }
      let previewUrl: string | null = null
      if (!isPdfFile(file)) {
        previewUrl = URL.createObjectURL(file)
        previewUrlsRef.current.add(previewUrl)
      }
      fileSeq += 1
      accepted.push({ id: `invoice-file-${fileSeq}`, file, previewUrl })
    })
    setFiles((prev) => [...prev, ...accepted])
    setError(problems.length ? problems.join(' ') : null)
  }

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        previewUrlsRef.current.delete(target.previewUrl)
      }
      return prev.filter((item) => item.id !== id)
    })
  }

  const moveFile = (index: number, delta: number) => {
    setFiles((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const readInvoice = async () => {
    if (!accessToken) {
      setError('Bạn cần đăng nhập để dùng tính năng này.')
      return
    }
    setError(null)
    setPhase('preparing')
    const controller = new AbortController()
    controllersRef.current.add(controller)
    try {
      const prepared = await prepareInvoiceFiles(files.map((item) => item.file))
      if (controller.signal.aborted) return
      setPhase('reading')
      const extraction = await aiApi.extractPurchaseInvoice(accessToken, prepared, controller.signal)
      if (controller.signal.aborted) return
      const matchedSupplier =
        extraction.supplier.matched && extraction.supplier.supplier_id
          ? suppliers.find((item) => item.id === extraction.supplier.supplier_id)
          : undefined
      setResult(extraction)
      setSupplierId(matchedSupplier?.id ?? '')
      setInvoiceSerial(extraction.invoice.serial ?? '')
      setInvoiceNumber(extraction.invoice.number ?? '')
      setInvoiceDate(isIsoDate(extraction.invoice.date ?? '') ? extraction.invoice.date : '')
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(describeError(caught))
    } finally {
      controllersRef.current.delete(controller)
      if (!controller.signal.aborted) setPhase('idle')
    }
  }

  const openDraft = () => {
    if (!result || !supplierId) return
    onOpenDraft({
      extraction: result,
      supplierId,
      invoiceSerial: invoiceSerial.trim(),
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate: isIsoDate(invoiceDate) ? invoiceDate : '',
    })
  }

  const backToFiles = () => {
    setResult(null)
    setError(null)
  }

  const candidates = (result?.supplier.candidates ?? []).filter((candidate) =>
    suppliers.some((item) => item.id === candidate.supplier_id),
  )
  const lineCount = result?.lines.length ?? 0
  const matchedCount = result?.lines.filter((line) => line.match).length ?? 0
  const memoryCount = result?.lines.filter((line) => line.match?.source === 'memory').length ?? 0
  const freeCount = result?.lines.filter((line) => line.is_free).length ?? 0
  const draftTotal =
    result?.lines.reduce((sum, line) => sum + (line.draft.quantity || 0) * (line.draft.import_price || 0), 0) ?? 0
  const warnings = result?.warnings ?? []
  const duplicates = result?.duplicate_receipts ?? []
  const savedFileCount = result?.files?.length ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Nhập từ hóa đơn"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-lift sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3 border-b border-ink-900/10 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.3em] text-ink-600">Nhập từ hóa đơn</p>
            <p className="mt-1 text-sm text-ink-600">
              {result
                ? 'Kiểm tra kết quả AI đọc được trước khi mở phiếu nháp.'
                : 'Chụp hoặc chọn ảnh / PDF hóa đơn của nhà cung cấp, AI sẽ điền sẵn phiếu nhập.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="shrink-0 rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Đóng
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {!result ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={handlePickFiles}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="flex w-full flex-col items-center gap-1 rounded-2xl border-2 border-dashed border-ink-900/15 bg-fog-50 px-4 py-6 text-center disabled:opacity-60"
              >
                <span className="text-sm font-semibold text-ink-900">Chọn ảnh hoặc PDF hóa đơn</span>
                <span className="text-xs text-ink-500">
                  Chọn nhiều file theo đúng thứ tự trang. Tối đa {MAX_INVOICE_PAGES} trang, mỗi PDF ≤ 10 MB.
                </span>
              </button>

              {files.length ? (
                <ul className="space-y-2">
                  {files.map((item, index) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 rounded-2xl border border-ink-900/10 bg-white px-3 py-2"
                    >
                      {item.previewUrl ? (
                        <img
                          src={item.previewUrl}
                          alt=""
                          className="h-12 w-10 shrink-0 rounded-lg border border-ink-900/10 object-cover"
                        />
                      ) : (
                        <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-coral-500/10 text-[10px] font-bold text-coral-500">
                          PDF
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {index + 1}. {item.file.name}
                        </p>
                        <p className="text-xs text-ink-500">{formatSize(item.file.size)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveFile(index, -1)}
                          disabled={busy || index === 0}
                          aria-label="Lên"
                          className="h-8 w-8 rounded-full border border-ink-900/10 text-sm text-ink-700 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveFile(index, 1)}
                          disabled={busy || index === files.length - 1}
                          aria-label="Xuống"
                          className="h-8 w-8 rounded-full border border-ink-900/10 text-sm text-ink-700 disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFile(item.id)}
                          disabled={busy}
                          aria-label="Xóa"
                          className="h-8 w-8 rounded-full border border-coral-500/30 bg-coral-500/10 text-sm text-coral-500 disabled:opacity-30"
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}

              {phase !== 'idle' ? (
                <div className="flex items-center gap-3 rounded-2xl border border-brand-500/20 bg-brand-500/10 px-4 py-3 text-sm text-brand-700">
                  <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                  <span>
                    {phase === 'preparing'
                      ? 'Đang chuẩn bị ảnh…'
                      : 'AI đang đọc hóa đơn… (có thể mất 30–60 giây)'}
                  </span>
                </div>
              ) : null}

              {usage ? (
                <p className="text-xs text-ink-500">
                  Hôm nay đã dùng ${usage.cost_usd.toFixed(3)}
                  {usage.budget_usd > 0 ? ` / $${usage.budget_usd.toFixed(2)}` : ''} ({usage.requests} lượt gọi AI).
                </p>
              ) : null}
            </>
          ) : (
            <>
              {duplicates.length ? (
                <div className="rounded-2xl border border-coral-500/40 bg-coral-500/10 px-4 py-3 text-sm text-ink-800">
                  <p className="font-semibold text-coral-500">Hóa đơn này có thể đã được nhập trước đó</p>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {duplicates.map((item) => (
                      <li key={item.id}>
                        Phiếu {item.code} – ngày {formatIsoDate(item.receipt_date)}
                        {item.status === 'cancelled' ? ' (đã hủy)' : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-ink-600">Bạn vẫn có thể tiếp tục nếu chắc chắn đây là hóa đơn khác.</p>
                </div>
              ) : null}

              <section className="space-y-2 rounded-2xl border border-ink-900/10 bg-fog-50 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-ink-500">Nhà cung cấp</p>
                <p className="text-sm text-ink-900">
                  {result.invoice.supplier_name || 'Không đọc được tên'}
                  {result.invoice.supplier_tax_code ? (
                    <span className="text-ink-500"> · MST {result.invoice.supplier_tax_code}</span>
                  ) : null}
                </p>
                {result.supplier.matched && supplierId === result.supplier.supplier_id ? (
                  <span className="inline-block rounded-full bg-brand-500/15 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                    Đã khớp: {result.supplier.name}
                  </span>
                ) : (
                  <span className="inline-block rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                    Chưa khớp – chọn nhà cung cấp bên dưới
                  </span>
                )}
                {candidates.length && !supplierId ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-ink-500">Gợi ý:</span>
                    {candidates.map((candidate) => (
                      <button
                        key={candidate.supplier_id}
                        type="button"
                        onClick={() => setSupplierId(candidate.supplier_id)}
                        className="rounded-full border border-ink-900/10 bg-white px-2.5 py-1 font-medium text-ink-800"
                      >
                        {candidate.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                <select
                  value={supplierId}
                  onChange={(event) => setSupplierId(event.target.value)}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
                >
                  <option value="">-- Chọn nhà cung cấp --</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </section>

              <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs text-ink-600">
                  Ký hiệu hóa đơn
                  <input
                    value={invoiceSerial}
                    onChange={(event) => setInvoiceSerial(event.target.value)}
                    maxLength={32}
                    className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                  />
                </label>
                <label className="space-y-1 text-xs text-ink-600">
                  Số hóa đơn
                  <input
                    value={invoiceNumber}
                    onChange={(event) => setInvoiceNumber(event.target.value)}
                    maxLength={32}
                    className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                  />
                </label>
                <label className="col-span-2 space-y-1 text-xs text-ink-600 sm:col-span-1">
                  Ngày hóa đơn
                  <input
                    type="date"
                    value={invoiceDate}
                    onChange={(event) => setInvoiceDate(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                  />
                </label>
              </section>

              <section className="rounded-2xl border border-ink-900/10 bg-white p-4 text-sm">
                <p className="text-xs uppercase tracking-[0.22em] text-ink-500">Kiểm tra tổng</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-ink-700">
                  <dt>Tiền hàng</dt>
                  <dd className="text-right font-medium text-ink-900">{formatMoney(result.invoice.subtotal)}</dd>
                  <dt>
                    VAT
                    {result.invoice.vat_rate !== null ? ` (${Math.round(result.invoice.vat_rate * 1000) / 10}%)` : ''}
                  </dt>
                  <dd className="text-right font-medium text-ink-900">{formatMoney(result.invoice.vat_amount)}</dd>
                  <dt>Tổng thanh toán</dt>
                  <dd className="text-right font-semibold text-ink-900">{formatMoney(result.invoice.total)}</dd>
                  <dt>Tổng phiếu nháp</dt>
                  <dd className="text-right font-medium text-ink-900">{formatMoney(draftTotal)}</dd>
                </dl>
                <p className="mt-2 text-xs text-ink-500">
                  Giá nhập trong phiếu nháp {result.price_includes_vat ? 'đã gồm VAT' : 'chưa gồm VAT'} (theo cài đặt cửa hàng).
                </p>
                {warnings.length ? (
                  <ul className="mt-2 list-disc space-y-0.5 rounded-xl bg-amber-50 py-2 pl-7 pr-3 text-xs text-amber-800">
                    {warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs font-medium text-brand-700">Các số liệu trên hóa đơn khớp nhau.</p>
                )}
              </section>

              <section className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-2xl bg-fog-50 px-3 py-2">
                  <p className="text-lg font-semibold text-ink-900">{lineCount}</p>
                  <p className="text-[11px] text-ink-500">dòng hàng</p>
                </div>
                <div className="rounded-2xl bg-fog-50 px-3 py-2">
                  <p className="text-lg font-semibold text-ink-900">
                    {matchedCount}/{lineCount}
                  </p>
                  <p className="text-[11px] text-ink-500">tự khớp thuốc</p>
                </div>
                <div className="rounded-2xl bg-fog-50 px-3 py-2">
                  <p className="text-lg font-semibold text-ink-900">{memoryCount}</p>
                  <p className="text-[11px] text-ink-500">nhớ từ lần trước</p>
                </div>
                <div className="rounded-2xl bg-fog-50 px-3 py-2">
                  <p className="text-lg font-semibold text-ink-900">{freeCount}</p>
                  <p className="text-[11px] text-ink-500">hàng tặng</p>
                </div>
              </section>

              <p className="text-xs text-ink-500">
                {savedFileCount
                  ? `Đã lưu ${savedFileCount} file hóa đơn gốc để xem lại.`
                  : 'Chưa lưu được file hóa đơn gốc.'}
                {' '}Chi phí AI lần này: ${result.usage.cost_usd.toFixed(4)}.
              </p>
            </>
          )}

          {error ? (
            <div className="rounded-2xl border border-coral-500/40 bg-coral-500/10 px-4 py-3 text-sm text-coral-500">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-900/10 px-4 py-3 sm:px-6">
          {result ? (
            <>
              {!supplierId ? (
                <span className="mr-auto text-xs text-amber-700">Chọn nhà cung cấp để tiếp tục.</span>
              ) : null}
              <button
                type="button"
                onClick={backToFiles}
                className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
              >
                Chọn lại file
              </button>
              <button
                type="button"
                onClick={openDraft}
                disabled={!supplierId}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-50"
              >
                Mở phiếu nháp
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void readInvoice()}
              disabled={busy || files.length === 0}
              className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-50"
            >
              {busy ? 'Đang đọc…' : 'Đọc hóa đơn'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
