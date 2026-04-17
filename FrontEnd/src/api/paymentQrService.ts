import { requestJson } from './httpClient'
import { buildUsersApiUrl } from './usersService'

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
): Promise<T> =>
  requestJson<T>(buildUsersApiUrl, path, {
    init,
    token,
  })

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
