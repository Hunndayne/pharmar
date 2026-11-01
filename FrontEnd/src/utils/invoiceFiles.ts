import type { AiInvoiceSource } from '../api/aiService'

export const MAX_INVOICE_PAGES = 10
export const MAX_INVOICE_PDF_BYTES = 10 * 1024 * 1024
const MAX_PAGE_LONG_EDGE = 1600
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const JPEG_QUALITY = 0.85
const MAX_PDF_TEXT_CHARS = 50_000
const MIN_MEANINGFUL_TEXT_CHARS = 50

export type PreparedInvoice = {
  pages: Blob[]
  originals: File[]
  sources: AiInvoiceSource[]
  pdfText: string
}

export class InvoicePrepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvoicePrepError'
  }
}

export const isPdfFile = (file: File) =>
  file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

export const isImageFile = (file: File) =>
  file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(file.name)

const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const canvasToJpeg = async (canvas: HTMLCanvasElement): Promise<Blob> => {
  const encode = (quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))

  let blob = await encode(JPEG_QUALITY)
  // Very busy scans can exceed the backend's 4 MB/page cap at 0.85; step quality down instead of failing.
  for (const quality of [0.75, 0.6]) {
    if (!blob || blob.size <= MAX_PAGE_BYTES) break
    blob = await encode(quality)
  }
  if (!blob) throw new InvoicePrepError('Trình duyệt không nén được ảnh. Vui lòng thử lại.')
  return blob
}

const releaseCanvas = (canvas: HTMLCanvasElement) => {
  // Safari keeps canvas backing stores alive until resized; this frees memory between pages.
  canvas.width = 0
  canvas.height = 0
}

type DrawableImage = { source: CanvasImageSource; width: number; height: number; release: () => void }

const decodeWithImageElement = (file: File) =>
  new Promise<DrawableImage>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () =>
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      })
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    image.src = url
  })

const decodeImage = async (file: File): Promise<DrawableImage> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // Older Safari rejects the options bag; <img> applies EXIF orientation by default there.
    }
  }
  return decodeWithImageElement(file)
}

const prepareImagePage = async (file: File): Promise<Blob> => {
  let image: DrawableImage
  try {
    image = await decodeImage(file)
  } catch {
    throw new InvoicePrepError(
      `Không đọc được ảnh "${file.name}". Trình duyệt này không hỗ trợ định dạng ảnh đó (ví dụ HEIC), vui lòng dùng ảnh JPEG hoặc PNG.`,
    )
  }

  try {
    if (!image.width || !image.height) {
      throw new InvoicePrepError(`Ảnh "${file.name}" bị lỗi hoặc rỗng.`)
    }
    const scale = Math.min(1, MAX_PAGE_LONG_EDGE / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new InvoicePrepError('Trình duyệt không hỗ trợ xử lý ảnh.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image.source, 0, 0, canvas.width, canvas.height)
    const blob = await canvasToJpeg(canvas)
    releaseCanvas(canvas)
    return blob
  } finally {
    image.release()
  }
}

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfJsPromise: Promise<PdfJsModule> | null = null

// The legacy build is used so older phone browsers (pre-2024 Safari/Chrome) can still render PDFs.
const loadPdfJs = () => {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
      .then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        return pdfjs
      })
      .catch((error: unknown) => {
        pdfJsPromise = null
        throw error
      })
  }
  return pdfJsPromise
}

type PreparedPdf = { pages: Blob[]; text: string; hasText: boolean }

const preparePdf = async (file: File, remainingPages: number): Promise<PreparedPdf> => {
  let pdfjs: PdfJsModule
  try {
    pdfjs = await loadPdfJs()
  } catch {
    throw new InvoicePrepError('Không tải được bộ đọc PDF. Kiểm tra kết nối mạng rồi thử lại.')
  }

  // pdf.js transfers the buffer to its worker, so give it a copy and keep the File intact for `originals`.
  const data = new Uint8Array(await file.arrayBuffer())
  const loadingTask = pdfjs.getDocument({ data })
  let pdfDocument: Awaited<typeof loadingTask.promise>
  try {
    pdfDocument = await loadingTask.promise
  } catch (error) {
    void loadingTask.destroy()
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new InvoicePrepError(`File "${file.name}" có mật khẩu, vui lòng dùng bản không khóa.`)
    }
    throw new InvoicePrepError(`Không mở được file PDF "${file.name}".`)
  }

  try {
    if (pdfDocument.numPages > remainingPages) {
      throw new InvoicePrepError(
        `Tổng số trang vượt quá ${MAX_INVOICE_PAGES}. File "${file.name}" có ${pdfDocument.numPages} trang.`,
      )
    }

    const pages: Blob[] = []
    const textParts: string[] = []
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = MAX_PAGE_LONG_EDGE / Math.max(baseViewport.width, baseViewport.height)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      await page.render({ canvas, viewport, background: '#ffffff' }).promise
      pages.push(await canvasToJpeg(canvas))
      releaseCanvas(canvas)

      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
        .join('')
      textParts.push(pageText)
      page.cleanup()
    }

    const text = textParts.join('\n').replace(/[ \t]+/g, ' ').trim()
    return { pages, text, hasText: text.length > MIN_MEANINGFUL_TEXT_CHARS }
  } finally {
    void loadingTask.destroy()
  }
}

export const validateInvoiceFile = (file: File): string | null => {
  if (isPdfFile(file)) {
    if (file.size > MAX_INVOICE_PDF_BYTES) {
      return `File "${file.name}" (${formatMb(file.size)}) vượt quá giới hạn 10 MB cho mỗi PDF.`
    }
    return null
  }
  if (isImageFile(file)) return null
  return `File "${file.name}" không phải ảnh hoặc PDF.`
}

export const prepareInvoiceFiles = async (files: File[]): Promise<PreparedInvoice> => {
  if (!files.length) throw new InvoicePrepError('Chưa chọn file hóa đơn.')
  const imageCount = files.filter((file) => !isPdfFile(file)).length
  if (imageCount > MAX_INVOICE_PAGES) {
    throw new InvoicePrepError(`Tối đa ${MAX_INVOICE_PAGES} trang cho mỗi lần đọc.`)
  }
  for (const file of files) {
    const problem = validateInvoiceFile(file)
    if (problem) throw new InvoicePrepError(problem)
  }

  const pages: Blob[] = []
  const originals: File[] = []
  const sources: AiInvoiceSource[] = []
  const textBlocks: string[] = []

  for (const file of files) {
    if (isPdfFile(file)) {
      const remaining = MAX_INVOICE_PAGES - pages.length
      const pdf = await preparePdf(file, remaining)
      const pageIndexes = pdf.pages.map((_, offset) => pages.length + offset)
      pages.push(...pdf.pages)
      sources.push({
        kind: 'pdf',
        pages: pageIndexes,
        original_index: originals.length,
        has_text: pdf.hasText,
      })
      originals.push(file)
      if (pdf.hasText) textBlocks.push(`--- ${file.name} ---\n${pdf.text}`)
      continue
    }

    if (pages.length >= MAX_INVOICE_PAGES) {
      throw new InvoicePrepError(`Tối đa ${MAX_INVOICE_PAGES} trang cho mỗi lần đọc.`)
    }
    const blob = await prepareImagePage(file)
    sources.push({ kind: 'image', pages: [pages.length] })
    pages.push(blob)
  }

  return {
    pages,
    originals,
    sources,
    pdfText: textBlocks.join('\n\n').slice(0, MAX_PDF_TEXT_CHARS),
  }
}
