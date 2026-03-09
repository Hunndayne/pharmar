import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  saleApi,
  type PublicSaleInvoiceListItem,
  type PublicSaleInvoiceResponse,
} from '../api/saleService'
import { storeApi, type StoreInfo } from '../api/storeService'
import { ApiError } from '../api/usersService'
import { resolveAssetUrl } from '../utils/assets'

type SearchMode = 'code' | 'phone'

const formatCurrency = (value: string | number) =>
  `${Math.max(0, Number(value || 0)).toLocaleString('vi-VN')}đ`

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const paymentLabel = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'cash') return 'Tiền mặt'
  if (normalized === 'bank' || normalized === 'transfer') return 'Chuyển khoản'
  if (normalized === 'card') return 'Thẻ'
  if (normalized === 'momo') return 'MoMo'
  if (normalized === 'zalopay') return 'ZaloPay'
  if (normalized === 'vnpay') return 'VNPay'
  if (normalized === 'mixed') return 'Nhiều phương thức'
  return value || '-'
}

const statusLabel = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'completed') return 'Hoàn thành'
  if (normalized === 'cancelled') return 'Đã hủy'
  if (normalized === 'returned') return 'Đã trả hàng'
  if (normalized === 'pending') return 'Đang xử lý'
  return value || '-'
}

export function PublicInvoiceLookup() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [mode, setMode] = useState<SearchMode>('code')
  const [codeInput, setCodeInput] = useState('')
  const [phoneInput, setPhoneInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingDetailCode, setLoadingDetailCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invoiceList, setInvoiceList] = useState<PublicSaleInvoiceListItem[]>([])
  const [selectedInvoice, setSelectedInvoice] = useState<PublicSaleInvoiceResponse | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let mounted = true
    const loadStore = async () => {
      try {
        const info = await storeApi.getInfo()
        if (!mounted) return
        setStore(info)
      } catch {
        if (!mounted) return
        setStore(null)
      }
    }
    void loadStore()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const nextMode = searchParams.get('mode') === 'phone' ? 'phone' : 'code'
    const nextCode = searchParams.get('code')?.trim() ?? ''
    const nextPhone = searchParams.get('phone')?.trim() ?? ''
    const nextPage = Math.max(1, Number(searchParams.get('page') || '1') || 1)

    setMode(nextMode)
    setCodeInput(nextCode)
    setPhoneInput(nextPhone)
    setPage(nextPage)

    const loadFromParams = async () => {
      if (nextMode === 'code' && nextCode) {
        setLoading(true)
        setError(null)
        setInvoiceList([])
        setTotal(0)
        setTotalPages(0)
        try {
          const detail = await saleApi.publicGetInvoiceByCode(nextCode)
          setSelectedInvoice(detail)
        } catch (lookupError) {
          setSelectedInvoice(null)
          if (lookupError instanceof ApiError) setError(lookupError.message)
          else setError('Không thể tra cứu hóa đơn.')
        } finally {
          setLoading(false)
        }
        return
      }

      if (nextMode === 'phone' && nextPhone) {
        setLoading(true)
        setError(null)
        setSelectedInvoice(null)
        try {
          const result = await saleApi.publicListInvoicesByPhone(nextPhone, { page: nextPage, size: 10 })
          setInvoiceList(result.items)
          setTotal(result.total)
          setTotalPages(result.pages)
        } catch (lookupError) {
          setInvoiceList([])
          setTotal(0)
          setTotalPages(0)
          if (lookupError instanceof ApiError) setError(lookupError.message)
          else setError('Không thể tra cứu danh sách hóa đơn.')
        } finally {
          setLoading(false)
        }
        return
      }

      setInvoiceList([])
      setSelectedInvoice(null)
      setError(null)
      setTotal(0)
      setTotalPages(0)
    }

    void loadFromParams()
  }, [searchParams])

  const runCodeSearch = async (event: FormEvent) => {
    event.preventDefault()
    const code = codeInput.trim()
    if (!code) {
      setError('Vui lòng nhập mã hóa đơn.')
      return
    }
    setSearchParams({ mode: 'code', code })
  }

  const runPhoneSearch = async (event: FormEvent) => {
    event.preventDefault()
    const phone = phoneInput.trim()
    if (!phone) {
      setError('Vui lòng nhập số điện thoại.')
      return
    }
    setSearchParams({ mode: 'phone', phone, page: '1' })
  }

  const loadDetail = async (code: string) => {
    setLoadingDetailCode(code)
    setError(null)
    try {
      const detail = await saleApi.publicGetInvoiceByCode(code)
      setSelectedInvoice(detail)
    } catch (lookupError) {
      if (lookupError instanceof ApiError) setError(lookupError.message)
      else setError('Không thể tải chi tiết hóa đơn.')
    } finally {
      setLoadingDetailCode(null)
    }
  }

  const goToPage = (nextPage: number) => {
    const phone = phoneInput.trim()
    if (!phone) return
    setSearchParams({ mode: 'phone', phone, page: String(nextPage) })
  }

  const logoUrl = resolveAssetUrl(store?.logo_url)

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(191,219,254,0.45),_transparent_32%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-[28px] border border-white/60 bg-white/85 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              {logoUrl ? (
                <img src={logoUrl} alt="Store logo" className="h-16 w-16 rounded-2xl border border-ink-900/10 object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ink-900 text-lg font-semibold text-white">
                  {store?.name?.slice(0, 2).toUpperCase() || 'PH'}
                </div>
              )}
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-ink-500">Tra cứu hóa đơn</p>
                <h1 className="mt-2 text-3xl font-semibold text-ink-900">{store?.name || 'Nhà thuốc'}</h1>
                <p className="mt-1 text-sm text-ink-600">
                  Nhập mã hóa đơn hoặc số điện thoại khách hàng thân thiết để xem giao dịch.
                </p>
              </div>
            </div>
            <div className="text-sm text-ink-600">
              <p>SĐT: {store?.phone || '-'}</p>
              <p>Địa chỉ: {store?.address || '-'}</p>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/60 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setMode('code')
                setError(null)
              }}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                mode === 'code' ? 'bg-ink-900 text-white' : 'border border-ink-900/10 bg-white text-ink-700'
              }`}
            >
              Theo mã hóa đơn
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('phone')
                setError(null)
              }}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                mode === 'phone' ? 'bg-ink-900 text-white' : 'border border-ink-900/10 bg-white text-ink-700'
              }`}
            >
              Theo số điện thoại
            </button>
          </div>

          {mode === 'code' ? (
            <form onSubmit={runCodeSearch} className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value)}
                placeholder="Ví dụ: HD20260306001"
                className="flex-1 rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-900"
              />
              <button type="submit" className="rounded-2xl bg-ink-900 px-5 py-3 text-sm font-semibold text-white">
                Tra cứu
              </button>
            </form>
          ) : (
            <form onSubmit={runPhoneSearch} className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                value={phoneInput}
                onChange={(event) => setPhoneInput(event.target.value)}
                placeholder="Nhập số điện thoại khách hàng"
                className="flex-1 rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm text-ink-900"
              />
              <button type="submit" className="rounded-2xl bg-ink-900 px-5 py-3 text-sm font-semibold text-white">
                Tìm hóa đơn
              </button>
            </form>
          )}

          {error ? <p className="mt-3 text-sm text-coral-500">{error}</p> : null}
          {loading ? <p className="mt-3 text-sm text-ink-600">Đang tra cứu...</p> : null}
        </section>

        {mode === 'phone' && invoiceList.length ? (
          <section className="rounded-[28px] border border-white/60 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-500">Kết quả</p>
                <h2 className="mt-2 text-xl font-semibold text-ink-900">Danh sách hóa đơn</h2>
              </div>
              <p className="text-sm text-ink-600">
                Tổng {total} hóa đơn{totalPages > 0 ? ` • Trang ${page}/${totalPages}` : ''}
              </p>
            </div>

            <div className="mt-4 grid gap-3">
              {invoiceList.map((invoice) => (
                <button
                  key={invoice.id}
                  type="button"
                  onClick={() => void loadDetail(invoice.code)}
                  className="rounded-2xl border border-ink-900/10 bg-white px-4 py-4 text-left transition hover:border-ink-900/20 hover:shadow-sm"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-ink-900">{invoice.code}</p>
                      <p className="mt-1 text-xs text-ink-600">
                        {invoice.customer_name || 'Khách hàng'} • {invoice.customer_phone || '-'}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">{formatDateTime(invoice.created_at)}</p>
                    </div>
                    <div className="text-left sm:text-right">
                      <p className="text-sm font-semibold text-ink-900">{formatCurrency(invoice.total_amount)}</p>
                      <p className="mt-1 text-xs text-ink-600">
                        {statusLabel(invoice.status)} • {paymentLabel(invoice.payment_method)}
                      </p>
                      {loadingDetailCode === invoice.code ? (
                        <p className="mt-1 text-xs text-ink-500">Đang tải chi tiết...</p>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  className="rounded-xl border border-ink-900/10 bg-white px-4 py-2 text-sm text-ink-700 disabled:opacity-40"
                >
                  Trước
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages}
                  className="rounded-xl border border-ink-900/10 bg-white px-4 py-2 text-sm text-ink-700 disabled:opacity-40"
                >
                  Sau
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {selectedInvoice ? (
          <section className="rounded-[28px] border border-white/60 bg-white/92 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-500">Chi tiết hóa đơn</p>
                <h2 className="mt-2 text-2xl font-semibold text-ink-900">{selectedInvoice.code}</h2>
                <p className="mt-1 text-sm text-ink-600">{formatDateTime(selectedInvoice.created_at)}</p>
              </div>
              <div className="grid gap-2 text-sm text-ink-700">
                <p><span className="font-semibold text-ink-900">Khách hàng:</span> {selectedInvoice.customer_name || 'Khách vãng lai'}</p>
                <p><span className="font-semibold text-ink-900">Số điện thoại:</span> {selectedInvoice.customer_phone || '-'}</p>
                <p><span className="font-semibold text-ink-900">Thanh toán:</span> {paymentLabel(selectedInvoice.payment_method)}</p>
                <p><span className="font-semibold text-ink-900">Trạng thái:</span> {statusLabel(selectedInvoice.status)}</p>
              </div>
            </div>

            <div className="mt-5 overflow-x-auto rounded-2xl border border-ink-900/10 bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-fog-50 text-xs uppercase tracking-[0.2em] text-ink-600">
                  <tr>
                    <th className="px-4 py-3">Thuốc</th>
                    <th className="px-4 py-3">Đơn vị</th>
                    <th className="px-4 py-3">SL</th>
                    <th className="px-4 py-3">Đơn giá</th>
                    <th className="px-4 py-3">Thành tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedInvoice.items.map((item) => (
                    <tr key={item.id} className="border-t border-ink-900/5">
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink-900">{item.product_name}</p>
                        <p className="mt-1 text-xs text-ink-500">
                          {item.product_code} {item.lot_number ? `• Lô ${item.lot_number}` : ''} {item.expiry_date ? `• HSD ${item.expiry_date}` : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{item.unit_name}</td>
                      <td className="px-4 py-3 text-ink-700">{item.quantity.toLocaleString('vi-VN')}</td>
                      <td className="px-4 py-3 text-ink-700">{formatCurrency(item.unit_price)}</td>
                      <td className="px-4 py-3 font-medium text-ink-900">{formatCurrency(item.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-2xl border border-ink-900/10 bg-white p-4 text-sm text-ink-700">
                <p className="font-semibold text-ink-900">Thông tin thêm</p>
                <div className="mt-3 grid gap-2">
                  <p><span className="font-semibold text-ink-900">Ghi chú:</span> {selectedInvoice.note || '-'}</p>
                  <p><span className="font-semibold text-ink-900">Lý do hủy:</span> {selectedInvoice.cancel_reason || '-'}</p>
                  <p><span className="font-semibold text-ink-900">Điểm dùng:</span> {selectedInvoice.points_used.toLocaleString('vi-VN')}</p>
                  <p><span className="font-semibold text-ink-900">Điểm nhận:</span> {selectedInvoice.points_earned.toLocaleString('vi-VN')}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-ink-900/10 bg-ink-900 p-4 text-sm text-white">
                <p className="text-xs uppercase tracking-[0.24em] text-white/60">Tổng thanh toán</p>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Tạm tính</span>
                    <span>{formatCurrency(selectedInvoice.subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Giảm giá</span>
                    <span>{formatCurrency(selectedInvoice.discount_amount)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Đã thanh toán</span>
                    <span>{formatCurrency(selectedInvoice.amount_paid)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Tiền thừa</span>
                    <span>{formatCurrency(selectedInvoice.change_amount)}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-lg font-semibold">
                    <span>Tổng cộng</span>
                    <span>{formatCurrency(selectedInvoice.total_amount)}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
