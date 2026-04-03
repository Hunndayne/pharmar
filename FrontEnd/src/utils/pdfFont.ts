import { type jsPDF } from 'jspdf'

type FontVariant = 'normal' | 'bold' | 'italic'

const FONT_FAMILY = 'Roboto'
const FONT_FILES: Record<FontVariant, string> = {
  normal: '/fonts/Roboto-Regular.ttf',
  bold: '/fonts/Roboto-Bold.ttf',
  italic: '/fonts/Roboto-Italic.ttf',
}

// Cache fetched base64 per variant so we only fetch once per session
const fontCache: Partial<Record<FontVariant, string>> = {}

async function loadFontBase64(variant: FontVariant): Promise<string> {
  if (fontCache[variant]) return fontCache[variant]!

  const res = await fetch(FONT_FILES[variant])
  if (!res.ok) throw new Error(`Failed to fetch font: ${FONT_FILES[variant]}`)

  const buffer = await res.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  fontCache[variant] = base64
  return base64
}

let registeredDoc: WeakSet<jsPDF> | null = null

export async function registerVietnameseFont(doc: jsPDF): Promise<void> {
  if (!registeredDoc) registeredDoc = new WeakSet()
  if (registeredDoc.has(doc)) return

  const variants: FontVariant[] = ['normal', 'bold', 'italic']
  const [normalB64, boldB64, italicB64] = await Promise.all(variants.map(loadFontBase64))

  doc.addFileToVFS('Roboto-Regular.ttf', normalB64)
  doc.addFont('Roboto-Regular.ttf', FONT_FAMILY, 'normal')

  doc.addFileToVFS('Roboto-Bold.ttf', boldB64)
  doc.addFont('Roboto-Bold.ttf', FONT_FAMILY, 'bold')

  doc.addFileToVFS('Roboto-Italic.ttf', italicB64)
  doc.addFont('Roboto-Italic.ttf', FONT_FAMILY, 'italic')

  registeredDoc.add(doc)
}

export { FONT_FAMILY }
