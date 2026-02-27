type FetchControlOptions = {
  dedupe?: boolean
  dedupeKey?: string
  retryOn429?: boolean
  max429Retries?: number
  baseRetryDelayMs?: number
  getCacheMs?: number
}

const inflightRequests = new Map<string, Promise<Response>>()
const getResponseCache = new Map<string, { expiresAt: number; response: Response }>()

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const normalizeMethod = (value: string | undefined) => (value || 'GET').trim().toUpperCase()

const getHeaderValue = (headers: HeadersInit | undefined, key: string) => {
  if (!headers) return ''
  const normalizedKey = key.toLowerCase()

  if (headers instanceof Headers) {
    return headers.get(key) ?? headers.get(normalizedKey) ?? ''
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([entryKey]) => entryKey.toLowerCase() === normalizedKey)
    return found?.[1] ?? ''
  }

  const record = headers as Record<string, string>
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey.toLowerCase() === normalizedKey) return value
  }
  return ''
}

const buildRequestKey = (input: RequestInfo | URL, init: RequestInit | undefined, method: string) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const authHeader = getHeaderValue(init?.headers, 'authorization')
  return `${method}::${url}::${authHeader}`
}

const cleanupGetCache = () => {
  if (getResponseCache.size < 300) return
  const now = Date.now()
  for (const [key, entry] of getResponseCache.entries()) {
    if (entry.expiresAt <= now) getResponseCache.delete(key)
  }

  if (getResponseCache.size < 300) return
  const keys = Array.from(getResponseCache.keys())
  for (let i = 0; i < Math.min(100, keys.length); i += 1) {
    getResponseCache.delete(keys[i])
  }
}

export const controlledFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchControlOptions = {},
): Promise<Response> => {
  const method = normalizeMethod(init.method)
  const isGet = method === 'GET'
  const dedupe = options.dedupe ?? isGet
  const retryOn429 = options.retryOn429 ?? true
  const max429Retries = Math.max(0, options.max429Retries ?? 1)
  const baseRetryDelayMs = Math.max(100, options.baseRetryDelayMs ?? 400)
  const getCacheMs = isGet ? Math.max(0, options.getCacheMs ?? 0) : 0
  const requestKey = options.dedupeKey || buildRequestKey(input, init, method)

  if (getCacheMs > 0) {
    const cacheEntry = getResponseCache.get(requestKey)
    if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
      return cacheEntry.response.clone()
    }
    if (cacheEntry) {
      getResponseCache.delete(requestKey)
    }
  }

  if (dedupe) {
    const existing = inflightRequests.get(requestKey)
    if (existing) {
      const response = await existing
      return response.clone()
    }
  }

  const runner = (async () => {
    let attempt = 0
    while (true) {
      const response = await fetch(input, init)
      if (!(retryOn429 && response.status === 429 && attempt < max429Retries)) {
        if (getCacheMs > 0 && response.ok) {
          getResponseCache.set(requestKey, {
            expiresAt: Date.now() + getCacheMs,
            response: response.clone(),
          })
          cleanupGetCache()
        }
        return response
      }

      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN
      const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.floor(retryAfterSeconds * 1000)
        : Math.min(5000, baseRetryDelayMs * 2 ** attempt)

      await sleep(retryDelay)
      attempt += 1
    }
  })()

  if (dedupe) inflightRequests.set(requestKey, runner)

  try {
    const response = await runner
    return dedupe ? response.clone() : response
  } finally {
    if (dedupe) inflightRequests.delete(requestKey)
  }
}

