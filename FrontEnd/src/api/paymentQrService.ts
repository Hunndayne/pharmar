import { ApiError, buildUsersApiUrl } from './usersService'

export type GenerateBankQrPayload = {
  accountNo: string
  accountName: string
  acqId: string
  addInfo: string
  amount: number
}

export type GenerateBankQrResponse = {
  code: string
  desc: string
  data: {
    qrCode: string
    qrDataURL: string
  }
}

const requestPaymentQrJson = async <T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json() : null
  if (!response.ok) {
    const detail = payload?.detail ?? payload?.message ?? `Yeu cau that bai (${response.status})`
    throw new ApiError(detail, response.status)
  }
  return payload as T
}

export const paymentQrApi = {
  generateBankQr: (token: string, payload: GenerateBankQrPayload) =>
    requestPaymentQrJson<GenerateBankQrResponse>(
      '/payment-qr/generate',
      token,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
}

