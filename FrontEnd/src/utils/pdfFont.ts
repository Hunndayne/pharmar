import { type jsPDF } from 'jspdf'

export const FONT_FAMILY = 'NotoSans'

const FONT_FILES = {
  normal: '/fonts/NotoSans-Regular.ttf',
  bold: '/fonts/NotoSans-Bold.ttf',
  italic: '/fonts/NotoSans-Italic.ttf',
  bolditalic: '/fonts/NotoSans-Bold.ttf', // jsPDF v4 uses 'bolditalic' style key
} as const

type FontStyle = keyof typeof FONT_FILES

const fontCache: Partial<Record<FontStyle, string>> = {}

async function loadFontBase64(style: FontStyle): Promise<string> {
  if (fontCache[style]) return fontCache[style]!

  const res = await fetch(FONT_FILES[style])
  if (!res.ok) throw new Error(`Failed to fetch font ${FONT_FILES[style]}: ${res.status}`)

  const buffer = await res.arrayBuffer()
  // Use TextDecoder-safe base64 encoding for large binary buffers
  const bytes = new Uint8Array(buffer)
  const chunkSize = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  const base64 = btoa(binary)
  fontCache[style] = base64
  return base64
}

const registeredDocs = new WeakSet<jsPDF>()

export async function registerVietnameseFont(doc: jsPDF): Promise<void> {
  if (registeredDocs.has(doc)) return

  const [normalB64, boldB64, italicB64] = await Promise.all([
    loadFontBase64('normal'),
    loadFontBase64('bold'),
    loadFontBase64('italic'),
  ])

  doc.addFileToVFS('NotoSans-Regular.ttf', normalB64)
  doc.addFont('NotoSans-Regular.ttf', FONT_FAMILY, 'normal')

  doc.addFileToVFS('NotoSans-Bold.ttf', boldB64)
  doc.addFont('NotoSans-Bold.ttf', FONT_FAMILY, 'bold')

  doc.addFileToVFS('NotoSans-Italic.ttf', italicB64)
  doc.addFont('NotoSans-Italic.ttf', FONT_FAMILY, 'italic')

  // jsPDF v4 requires 'bolditalic' registered separately
  doc.addFont('NotoSans-Bold.ttf', FONT_FAMILY, 'bolditalic')

  registeredDocs.add(doc)
}
