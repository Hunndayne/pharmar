const sanitizeBase = (value: string) => value.trim().replace(/\/+$/, '')

const API_BASE = sanitizeBase(import.meta.env.VITE_API_BASE_URL ?? '')

export const resolveAssetUrl = (value: string | null | undefined): string | null => {
  if (!value) return null
  const raw = value.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('//')) return `${window.location.protocol}${raw}`

  if (raw.startsWith('/')) {
    if (API_BASE) return `${API_BASE}${raw}`
    return `${window.location.origin}${raw}`
  }

  if (API_BASE) return `${API_BASE}/${raw}`
  return `${window.location.origin}/${raw}`
}

export const setDocumentFavicon = (iconUrl: string | null | undefined) => {
  const url = resolveAssetUrl(iconUrl) ?? '/vite.svg'
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = url
}
