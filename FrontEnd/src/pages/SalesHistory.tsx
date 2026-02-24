import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  saleApi,
  type SaleInvoiceListItem,
  type SaleInvoicePrintData,
  type SaleInvoiceResponse,
} from '../api/saleService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { downloadCsv } from '../utils/csv'

type InvoiceStatusFilter = 'all' | 'completed' | 'cancelled' | 'returned' | 'pending'
type ReturnCondition = 'good' | 'damaged' | 'expired'
type RefundMethod = 'cash' | 'card' | 'points'

type ReturnLineForm = {
  invoice_item_id: string
  product_name: string
  unit_name: string
  max_quantity: number
  quantity: number
  condition: ReturnCondition
  reason: string
}

type ReturnModalState = {
  invoice_id: string
  invoice_code: string
  refund_method: RefundMethod
  reason: string
  lines: ReturnLineForm[]
}

const pageSize = 10

const paymentMethodLabels: Record<string, string> = {
  cash: 'Tiền mặt',
  card: 'Thẻ',
  transfer: 'Chuyển khoản',
  momo: 'Ví MoMo',
  zalopay: 'Ví ZaloPay',
  vnpay: 'VNPay',
  mixed: 'Hỗn hợp',
}

const statusLabels: Record<string, string> = {
  completed: 'Hoàn thành',
  cancelled: 'Đã hủy',
  returned: 'Đã trả hàng',
  pending: 'Chờ xử lý',
}

const statusStyles: Record<string, string> = {
  completed: 'border border-brand-500/30 bg-brand-500/15 text-brand-600',
  cancelled: 'border border-coral-500/30 bg-coral-500/10 text-coral-500',
  returned: 'border border-sun-500/30 bg-sun-500/10 text-sun-600',
  pending: 'border border-ink-900/20 bg-ink-900/10 text-ink-700',
}

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const formatCurrency = (value: string | number | null | undefined) => `${toNumber(value).toLocaleString('vi-VN')}đ`

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const getPaymentMethodLabel = (value: string) => paymentMethodLabels[value] ?? value
const getStatusLabel = (value: string) => statusLabels[value] ?? value
const getStatusStyle = (value: string) => statusStyles[value] ?? statusStyles.pending
const debtAmountOfInvoice = (totalAmount: string | number, amountPaid: string | number) =>
  Math.max(0, toNumber(totalAmount) - toNumber(amountPaid))

const toReturnableQty = (line: SaleInvoiceResponse['items'][number]) =>
  Math.max(0, line.quantity - line.returned_quantity)

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const resolveAssetUrl = (value: string | null | undefined) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw
  const apiBase = String(import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (apiBase) {
    const path = raw.startsWith('/') ? raw : `/${raw}`
    return `${apiBase}${path}`
  }
  return raw
}

const renderInvoicePrintHtml = (printData: SaleInvoicePrintData) => {
  const logoUrl = resolveAssetUrl(printData.store?.logo_url)
  const logoHtml = logoUrl
    ? `<img class="store-logo" src="${escapeHtml(logoUrl)}" alt="Store logo" />`
    : ''
  const windowValue = Math.max(0, Math.trunc(toNumber(printData.footer?.return_window_value ?? 7)))
  const windowUnitRaw = String(printData.footer?.return_window_unit ?? '').trim().toLowerCase()
  const windowUnitLabel = ['hour', 'hours', 'gio', 'h'].includes(windowUnitRaw) ? 'giờ' : 'ngày'
  const returnPolicyText =
    String(printData.footer?.return_policy ?? '').trim() ||
    `Đổi trả trong ${windowValue} ${windowUnitLabel} với hóa đơn`

  const rowsHtml = (printData.items ?? [])
    .map((item, index) => {
      const qty = toNumber(item.qty)
      const price = toNumber(item.price)
      const amount = toNumber(item.amount)
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(item.name || '-')}</td>
          <td class="center">${escapeHtml(item.unit || '-')}</td>
          <td class="right">${qty.toLocaleString('vi-VN')}</td>
          <td class="right">${formatCurrency(price)}</td>
          <td class="right">${formatCurrency(amount)}</td>
        </tr>
      `
    })
    .join('')

  return `
    <!doctype html>
    <html lang="vi">
      <head>
        <meta charset="utf-8" />
        <title>Hóa đơn ${escapeHtml(printData.invoice?.code || '')}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 16px; font-family: "Segoe UI", Arial, sans-serif; color: #111827; background: #fff; }
          .wrap { max-width: 780px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; }
          h1 { margin: 0 0 10px 0; font-size: 24px; text-align: center; }
          .store-head { border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 10px; }
          .store-row { display: flex; align-items: center; gap: 12px; }
          .store-info { flex: 1; min-width: 0; text-align: left; }
          .store-logo { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; border: 1px solid #e5e7eb; padding: 4px; background: #fff; }
          .store-name { margin: 0; font-size: 18px; font-weight: 700; }
          .store-sub { margin-top: 4px; font-size: 12px; color: #4b5563; }
          .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; font-size: 13px; margin-bottom: 12px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px; }
          th, td { border: 1px solid #d1d5db; padding: 6px 8px; }
          th { background: #f3f4f6; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
          .right { text-align: right; }
          .center { text-align: center; }
          .summary { margin-left: auto; max-width: 300px; font-size: 13px; }
          .summary-row { display: flex; justify-content: space-between; padding: 3px 0; }
          .summary-row.total { border-top: 1px solid #d1d5db; margin-top: 4px; padding-top: 6px; font-weight: 700; }
          .footer { margin-top: 10px; border-top: 1px dashed #d1d5db; padding-top: 8px; font-size: 12px; color: #4b5563; text-align: center; }
          @media print {
            body { padding: 0; }
            .wrap { border: 0; border-radius: 0; max-width: 100%; padding: 8px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="store-head">
            <div class="store-row">
              ${logoHtml}
              <div class="store-info">
                <p class="store-name">${escapeHtml(printData.store?.name || 'Nhà thuốc')}</p>
                <div class="store-sub">SDT: ${escapeHtml(printData.store?.phone || '-')}</div>
                <div class="store-sub">Địa chỉ: ${escapeHtml(printData.store?.address || '-')}</div>
              </div>
            </div>
          </div>

          <h1>Hóa đơn bán hàng</h1>

          <div class="meta">
            <div><strong>Mã:</strong> ${escapeHtml(printData.invoice?.code || '-')}</div>
            <div><strong>Ngày:</strong> ${escapeHtml(printData.invoice?.date || '-')}</div>
            <div><strong>Thu ngân:</strong> ${escapeHtml(printData.invoice?.cashier || '-')}</div>
            <div><strong>Khách:</strong> ${escapeHtml(printData.customer?.name || 'Khách vãng lai')}</div>
          </div>

          <table>
            <thead>
              <tr>
                <th>STT</th>
                <th>Tên thuốc</th>
                <th>Đơn vị</th>
                <th>SL</th>
                <th>Đơn giá</th>
                <th>Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="6" class="center">Không có dòng hàng</td></tr>'}
            </tbody>
          </table>

          <div class="summary">
            <div class="summary-row"><span>Tạm tính</span><strong>${formatCurrency(printData.summary?.subtotal || 0)}</strong></div>
            <div class="summary-row"><span>Giảm giá</span><strong>${formatCurrency(toNumber(printData.summary?.tier_discount || 0) + toNumber(printData.summary?.promotion?.amount || 0) + toNumber(printData.summary?.points_discount || 0))}</strong></div>
            <div class="summary-row total"><span>Tổng thanh toán</span><strong>${formatCurrency(printData.summary?.total || 0)}</strong></div>
            <div class="summary-row"><span>Khách đưa</span><strong>${formatCurrency(printData.payment?.amount_paid || 0)}</strong></div>
            <div class="summary-row"><span>Tiền thừa</span><strong>${formatCurrency(printData.payment?.change || 0)}</strong></div>
          </div>

          <div class="footer">
            <div>${escapeHtml(printData.footer?.message || 'Cảm ơn quý khách!')}</div>
            <div>${escapeHtml(returnPolicyText)}</div>
          </div>
        </div>
      </body>
    </html>
  `
}

export function SalesHistory() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''

  const canCancel = user?.role === 'owner' || user?.role === 'manager' || user?.username === 'admin'
  const canApproveReturn = canCancel

  const [rows, setRows] = useState<SaleInvoiceListItem[]>([])
  const [detailsById, setDetailsById] = useState<Record<string, SaleInvoiceResponse>>({})

  const [loading, setLoading] = useState(false)
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [printingId, setPrintingId] = useState<string | null>(null)
  const [returningId, setReturningId] = useState<string | null>(null)
  const [returnModal, setReturnModal] = useState<ReturnModalState | null>(null)
  const [returnModalError, setReturnModalError] = useState<string | null>(null)
  const [submittingReturn, setSubmittingReturn] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    if (!accessToken) {
      setRows([])
      setTotal(0)
      setTotalPages(1)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const response = await saleApi.listInvoices(accessToken, {
        search: search.trim() || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        date_from: fromDate || undefined,
        date_to: toDate || undefined,
        page,
        size: pageSize,
      })

      setRows(response.items)
      setTotal(response.total)
      setTotalPages(Math.max(1, response.pages || 1))

      if (response.pages > 0 && page > response.pages) {
        setPage(response.pages)
      }
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải lịch sử bán hàng.')
    } finally {
      setLoading(false)
    }
  }, [accessToken, fromDate, page, search, statusFilter, toDate])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const summary = useMemo(() => {
    const completedOnPage = rows.filter((item) => item.status === 'completed').length
    const cancelledOnPage = rows.filter((item) => item.status === 'cancelled').length
    const debtInvoicesOnPage = rows.filter((item) => debtAmountOfInvoice(item.total_amount, item.amount_paid) > 0).length
    const debtTotalOnPage = rows.reduce(
      (sum, item) => sum + debtAmountOfInvoice(item.total_amount, item.amount_paid),
      0,
    )
    return {
      total,
      completedOnPage,
      cancelledOnPage,
      debtInvoicesOnPage,
      debtTotalOnPage,
    }
  }, [rows, total])

  const refreshInvoiceDetail = useCallback(
    async (invoiceId: string) => {
      if (!accessToken) return null
      const detail = await saleApi.getInvoiceById(accessToken, invoiceId)
      setDetailsById((prev) => ({ ...prev, [invoiceId]: detail }))
      return detail
    },
    [accessToken],
  )

  const ensureInvoiceDetail = useCallback(
    async (invoiceId: string) => {
      if (!accessToken) return null
      const cached = detailsById[invoiceId]
      if (cached) return cached

      setDetailLoadingId(invoiceId)
      try {
        return await refreshInvoiceDetail(invoiceId)
      } finally {
        setDetailLoadingId((prev) => (prev === invoiceId ? null : prev))
      }
    },
    [accessToken, detailsById, refreshInvoiceDetail],
  )

  const toggleDetail = async (item: SaleInvoiceListItem) => {
    if (!accessToken) return

    if (expandedId === item.id) {
      setExpandedId(null)
      return
    }

    setExpandedId(item.id)
    if (detailsById[item.id] || detailLoadingId === item.id) return

    setError(null)
    try {
      await ensureInvoiceDetail(item.id)
    } catch (detailError) {
      if (detailError instanceof ApiError) setError(detailError.message)
      else setError('Không thể tải chi tiết hóa đơn.')
    }
  }

  const handleCancel = async (item: SaleInvoiceListItem) => {
    if (!accessToken || !canCancel) return

    const reasonInput = window.prompt('Nhập lý do hủy hóa đơn:', 'Khách đổi ý')
    const reason = reasonInput?.trim() ?? ''
    if (!reason) return

    setCancellingId(item.id)
    setError(null)
    setNotice(null)

    try {
      await saleApi.cancelInvoice(accessToken, item.id, reason)
      setNotice(`Đã hủy hóa đơn ${item.code}.`)
      setDetailsById((prev) => {
        if (!prev[item.id]) return prev
        return {
          ...prev,
          [item.id]: {
            ...prev[item.id],
            status: 'cancelled',
            cancel_reason: reason,
            cancelled_at: new Date().toISOString(),
            cancelled_by: user?.username ?? prev[item.id].cancelled_by,
          },
        }
      })
      await loadRows()
    } catch (cancelError) {
      if (cancelError instanceof ApiError) setError(cancelError.message)
      else setError('Không thể hủy hóa đơn.')
    } finally {
      setCancellingId((prev) => (prev === item.id ? null : prev))
    }
  }

  const handlePrintInvoice = async (item: SaleInvoiceListItem) => {
    if (!accessToken) return

    setPrintingId(item.id)
    setError(null)

    try {
      const printData = await saleApi.getInvoicePrintData(accessToken, item.id)
      const printWindow = window.open('', '_blank', 'width=900,height=680')
      if (!printWindow) {
        throw new ApiError('Trình duyệt đang chặn cửa sổ in. Hãy bật popup và thử lại.', 400)
      }

      const html = renderInvoicePrintHtml(printData)
      printWindow.document.open()
      printWindow.document.write(html)
      printWindow.document.close()
      printWindow.focus()
      window.setTimeout(() => {
        printWindow.print()
        printWindow.close()
      }, 150)
    } catch (printError) {
      if (printError instanceof ApiError) setError(printError.message)
      else setError('Không thể in hóa đơn.')
    } finally {
      setPrintingId((prev) => (prev === item.id ? null : prev))
    }
  }

  const handleReturnByItem = async (item: SaleInvoiceListItem) => {
    if (!accessToken) return

    setError(null)
    setNotice(null)
    setReturnModalError(null)
    setReturningId(item.id)

    try {
      const detail = (await ensureInvoiceDetail(item.id)) ?? detailsById[item.id]
      if (!detail) return

      const returnableLines = detail.items
        .filter((line) => toReturnableQty(line) > 0)
        .map<ReturnLineForm>((line) => ({
          invoice_item_id: line.id,
          product_name: line.product_name,
          unit_name: line.unit_name,
          max_quantity: toReturnableQty(line),
          quantity: 0,
          condition: 'good',
          reason: '',
        }))

      if (!returnableLines.length) {
        throw new ApiError(`Hóa đơn ${item.code} không còn số lượng để trả hàng.`, 400)
      }

      setReturnModal({
        invoice_id: item.id,
        invoice_code: item.code,
        refund_method: 'cash',
        reason: '',
        lines: returnableLines,
      })
    } catch (returnError) {
      if (returnError instanceof ApiError) setError(returnError.message)
      else setError('Không thể xử lý trả hàng.')
    } finally {
      setReturningId((prev) => (prev === item.id ? null : prev))
    }
  }

  const updateReturnLine = (
    invoiceItemId: string,
    updater: (line: ReturnLineForm) => ReturnLineForm,
  ) => {
    setReturnModal((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        lines: prev.lines.map((line) =>
          line.invoice_item_id === invoiceItemId ? updater(line) : line,
        ),
      }
    })
  }

  const submitReturn = async () => {
    if (!accessToken || !returnModal) return

    const chosenLines = returnModal.lines
      .filter((line) => line.quantity > 0)
      .map((line) => ({
        invoice_item_id: line.invoice_item_id,
        quantity: line.quantity,
        condition: line.condition,
        reason: line.reason.trim() || undefined,
      }))

    if (!chosenLines.length) {
      setReturnModalError('Vui lòng nhập số lượng trả cho ít nhất 1 dòng thuốc.')
      return
    }

    setSubmittingReturn(true)
    setReturnModalError(null)
    setError(null)
    setNotice(null)

    try {
      const created = await saleApi.createReturn(accessToken, {
        invoice_id: returnModal.invoice_id,
        refund_method: returnModal.refund_method,
        reason: returnModal.reason.trim() || null,
        items: chosenLines,
      })

      let message = `Đã tạo phiếu trả ${created.code}.`
      if (canApproveReturn) {
        const approved = await saleApi.approveReturn(accessToken, created.id)
        message = `${message} ${approved.message}.`
      } else {
        message = `${message} Chờ quản lý duyệt.`
      }

      setNotice(message)
      setReturnModal(null)
      await Promise.all([loadRows(), refreshInvoiceDetail(created.invoice_id)])
    } catch (returnError) {
      if (returnError instanceof ApiError) setReturnModalError(returnError.message)
      else setReturnModalError('Không thể xử lý trả hàng.')
    } finally {
      setSubmittingReturn(false)
    }
  }

  const resetFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setFromDate('')
    setToDate('')
    setPage(1)
  }

  const exportCsv = () => {
    if (rows.length === 0) return

    const headers = [
      'Mã hóa đơn',
      'Ngày giờ',
      'Khách hàng',
      'Số điện thoại',
      'Thành tiền',
      'Đã thanh toán',
      'Còn nợ',
      'Phương thức thanh toán',
      'Trạng thái',
      'Thu ngân',
    ]

    const exportRows = rows.map((item) => {
      const debt = debtAmountOfInvoice(item.total_amount, item.amount_paid)
      return [
        item.code,
        formatDateTime(item.created_at),
        item.customer_name ?? 'Khách vãng lai',
        item.customer_phone ?? '-',
        toNumber(item.total_amount),
        toNumber(item.amount_paid),
        debt,
        getPaymentMethodLabel(item.payment_method),
        getStatusLabel(item.status),
        item.cashier_name ?? '-',
      ]
    })

    downloadCsv(`lich-su-ban-hang-trang-${page}.csv`, headers, exportRows)
  }

  const showingFrom = rows.length === 0 ? 0 : (page - 1) * pageSize + 1
  const showingTo = Math.min(page * pageSize, total)

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Bán hàng</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Lịch sử bán hàng</h2>
        <p className="mt-2 text-sm text-ink-600">Dữ liệu đồng bộ từ Sale Service.</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Tổng hóa đơn</p>
          <p className="mt-3 text-2xl font-semibold text-ink-900">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Hoàn thành (trang)</p>
          <p className="mt-3 text-2xl font-semibold text-brand-600">{summary.completedOnPage}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đã hủy (trang)</p>
          <p className="mt-3 text-2xl font-semibold text-coral-500">{summary.cancelledOnPage}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Đã trả hàng (trang)</p>
          <p className="mt-3 text-xl font-semibold text-sun-600">{formatCurrency(summary.debtTotalOnPage)}</p>
          <p className="mt-1 text-xs text-ink-600">{summary.debtInvoicesOnPage} hóa đơn</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-4 sm:p-6 space-y-4">
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.5fr,1fr,1fr,1fr,auto,auto,auto]">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            placeholder="Tìm theo mã HĐ, tên KH, SĐT"
          />

          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as InvoiceStatusFilter)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="completed">Hoàn thành</option>
            <option value="cancelled">Đã hủy</option>
            <option value="returned">Đã trả hàng</option>
            <option value="pending">Chờ xử lý</option>
          </select>

          <input
            type="date"
            value={fromDate}
            onChange={(event) => {
              setFromDate(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />

          <input
            type="date"
            value={toDate}
            onChange={(event) => {
              setToDate(event.target.value)
              setPage(1)
            }}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />

          <button
            type="button"
            onClick={resetFilters}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Reset
          </button>

          <button
            type="button"
            onClick={() => void loadRows()}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Tải lại
          </button>

          <button
            type="button"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="rounded-2xl border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
          >
            Xuất Excel
          </button>
        </div>

        {notice ? <p className="text-sm text-brand-600">{notice}</p> : null}
        {error ? <p className="text-sm text-coral-500">{error}</p> : null}
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="space-y-3 p-3 md:hidden">
          {loading ? (
            <p className="rounded-2xl bg-white px-4 py-3 text-sm text-ink-600">Äang táº£i dá»¯ liá»‡u...</p>
          ) : null}
          {!loading && rows.length === 0 ? (
            <p className="rounded-2xl bg-white px-4 py-3 text-sm text-ink-600">KhÃ´ng cÃ³ hÃ³a Ä‘Æ¡n phÃ¹ há»£p bá»™ lá»c.</p>
          ) : null}

          {!loading
            ? rows.map((item) => {
                const detail = detailsById[item.id]
                const isExpanded = expandedId === item.id
                const isLoadingDetail = detailLoadingId === item.id
                const debtAmount = debtAmountOfInvoice(item.total_amount, item.amount_paid)

                return (
                  <article
                    key={item.id}
                    className="rounded-2xl bg-white p-4 text-sm text-ink-700 shadow-[0_1px_0_rgba(17,24,39,0.04)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-ink-900">{item.code}</p>
                        <p className="text-xs text-ink-600">{formatDateTime(item.created_at)}</p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusStyle(item.status)}`}>
                        {getStatusLabel(item.status)}
                      </span>
                    </div>

                    <div className="mt-3 space-y-1 text-xs text-ink-600">
                      <p>Khách: {item.customer_name || 'Khách vãng lai'}</p>
                      <p>SĐT: {item.customer_phone || '-'}</p>
                      <p>Thanh toán: {getPaymentMethodLabel(item.payment_method)}</p>
                      <p>Thành tiền: <span className="font-semibold text-ink-900">{formatCurrency(item.total_amount)}</span></p>
                      {debtAmount > 0 ? (
                        <p>Còn nợ: <span className="font-semibold text-coral-500">{formatCurrency(debtAmount)}</span></p>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void toggleDetail(item)}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                      >
                        {isExpanded ? 'Ẩn chi tiết' : 'Chi tiết'}
                      </button>

                      <button
                        type="button"
                        disabled={printingId === item.id}
                        onClick={() => void handlePrintInvoice(item)}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                      >
                        {printingId === item.id ? 'Đang in...' : 'In hóa đơn'}
                      </button>

                      {(item.status === 'completed' || item.status === 'returned') ? (
                        <button
                          type="button"
                          disabled={returningId === item.id}
                          onClick={() => void handleReturnByItem(item)}
                          className="rounded-full border border-sun-500/30 bg-sun-500/10 px-3 py-1 text-xs font-semibold text-sun-700 disabled:opacity-60"
                        >
                          {returningId === item.id ? 'Đang trả...' : 'Trả hàng'}
                        </button>
                      ) : null}

                      {canCancel && item.status === 'completed' ? (
                        <button
                          type="button"
                          disabled={cancellingId === item.id}
                          onClick={() => void handleCancel(item)}
                          className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                        >
                          {cancellingId === item.id ? 'Đang hủy...' : 'Hủy hóa đơn'}
                        </button>
                      ) : null}
                    </div>

                    {isExpanded ? (
                      <div className="mt-3 rounded-xl border border-ink-900/10 bg-fog-50 p-3 text-xs text-ink-700">
                        {isLoadingDetail ? <p>Đang tải chi tiết...</p> : null}
                        {!isLoadingDetail && detail ? (
                          <div className="space-y-1">
                            <p>Thu ngân: {detail.created_by_name || detail.created_by}</p>
                            <p>Tạm tính: {formatCurrency(detail.subtotal)}</p>
                            <p>Giảm giá: {formatCurrency(detail.discount_amount)}</p>
                            <p className="font-semibold text-ink-900">Tổng: {formatCurrency(detail.total_amount)}</p>
                            {detail.items.slice(0, 5).map((line) => (
                              <p key={line.id}>
                                {line.product_name} x{line.quantity} {line.unit_name} - {formatCurrency(line.line_total)}
                              </p>
                            ))}
                            {detail.items.length > 5 ? <p>... {detail.items.length - 5} dòng khác</p> : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                )
              })
            : null}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1240px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã hóa đơn</th>
                <th className="px-6 py-4">Ngày giờ</th>
                <th className="px-6 py-4">Khách hàng</th>
                <th className="px-6 py-4">Thành tiền</th>
                <th className="px-6 py-4">Da tra</th>
                <th className="px-6 py-4">PT thanh toán</th>
                <th className="px-6 py-4">Thu ngân</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tac</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {loading ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={9}>
                    Đang tải dữ liệu...
                  </td>
                </tr>
              ) : null}

              {!loading && rows.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-sm text-ink-600" colSpan={9}>
                    Không có hóa đơn phù hợp bộ lọc.
                  </td>
                </tr>
              ) : null}

              {!loading
                ? rows.map((item) => {
                    const detail = detailsById[item.id]
                    const isExpanded = expandedId === item.id
                    const isLoadingDetail = detailLoadingId === item.id

                    return (
                      <Fragment key={item.id}>
                        <tr className="hover:bg-white/80">
                          <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                          <td className="px-6 py-4 text-ink-700">{formatDateTime(item.created_at)}</td>
                          <td className="px-6 py-4 text-ink-900">
                            <p>{item.customer_name || 'Khách vãng lai'}</p>
                            <p className="mt-1 text-xs text-ink-600">{item.customer_phone || '-'}</p>
                          </td>
                          <td className="px-6 py-4 font-semibold text-ink-900">{formatCurrency(item.total_amount)}</td>
                          <td className="px-6 py-4 text-ink-700">
                            <p>{formatCurrency(item.amount_paid)}</p>
                            {debtAmountOfInvoice(item.total_amount, item.amount_paid) > 0 ? (
                              <p className="mt-1 text-xs text-coral-500">Còn nợ: {formatCurrency(debtAmountOfInvoice(item.total_amount, item.amount_paid))}</p>
                            ) : null}
                          </td>
                          <td className="px-6 py-4 text-ink-700">{getPaymentMethodLabel(item.payment_method)}</td>
                          <td className="px-6 py-4 text-ink-700">{item.cashier_name || '-'}</td>
                          <td className="px-6 py-4">
                            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${getStatusStyle(item.status)}`}>
                              {getStatusLabel(item.status)}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void toggleDetail(item)}
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                              >
                                {isExpanded ? 'Ẩn chi tiết' : 'Chi tiết'}
                              </button>

                              <button
                                type="button"
                                disabled={printingId === item.id}
                                onClick={() => void handlePrintInvoice(item)}
                                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-60"
                              >
                                {printingId === item.id ? 'Đang in...' : 'In hóa đơn'}
                              </button>

                              {(item.status === 'completed' || item.status === 'returned') ? (
                                <button
                                  type="button"
                                  disabled={returningId === item.id}
                                  onClick={() => void handleReturnByItem(item)}
                                  className="rounded-full border border-sun-500/30 bg-sun-500/10 px-3 py-1 text-xs font-semibold text-sun-700 disabled:opacity-60"
                                >
                                  {returningId === item.id ? 'Đang trả...' : 'Trả hàng'}
                                </button>
                              ) : null}

                              {canCancel && item.status === 'completed' ? (
                                <button
                                  type="button"
                                  disabled={cancellingId === item.id}
                                  onClick={() => void handleCancel(item)}
                                  className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500 disabled:opacity-60"
                                >
                                  {cancellingId === item.id ? 'Đang hủy...' : 'Hủy hóa đơn'}
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>

                        {isExpanded ? (
                          <tr>
                            <td colSpan={9} className="px-6 pb-6">
                              <div className="rounded-2xl bg-white/80 p-4">
                                {isLoadingDetail ? (
                                  <p className="text-sm text-ink-600">Đang tải chi tiết...</p>
                                ) : null}

                                {!isLoadingDetail && detail ? (
                                  <div className="space-y-4">
                                    <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
                                      <div className="space-y-2 text-sm text-ink-700">
                                        <p><span className="font-semibold text-ink-900">Mã hóa đơn:</span> {detail.code}</p>
                                        <p><span className="font-semibold text-ink-900">Ngày tạo:</span> {formatDateTime(detail.created_at)}</p>
                                        <p><span className="font-semibold text-ink-900">Khách hàng:</span> {detail.customer_name || 'Khách vãng lai'}</p>
                                        <p><span className="font-semibold text-ink-900">SĐT:</span> {detail.customer_phone || '-'}</p>
                                        <p><span className="font-semibold text-ink-900">Thanh toán:</span> {getPaymentMethodLabel(detail.payment_method)}</p>
                                        <p><span className="font-semibold text-ink-900">Thu ngân:</span> {detail.created_by_name || detail.created_by}</p>
                                        {detail.cancel_reason ? (
                                          <p><span className="font-semibold text-ink-900">Lý do hủy:</span> {detail.cancel_reason}</p>
                                        ) : null}
                                        {detail.cancelled_at ? (
                                          <p><span className="font-semibold text-ink-900">Hủy lúc:</span> {formatDateTime(detail.cancelled_at)}</p>
                                        ) : null}
                                      </div>

                                      <div className="rounded-2xl border border-ink-900/10 bg-white p-4 text-sm text-ink-700">
                                        <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Tổng hợp</p>
                                        <div className="mt-3 space-y-2">
                                          <p className="flex items-center justify-between gap-3"><span>Tạm tính</span><span className="font-semibold text-ink-900">{formatCurrency(detail.subtotal)}</span></p>
                                          <p className="flex items-center justify-between gap-3"><span>Giảm giá</span><span className="font-semibold text-ink-900">{formatCurrency(detail.discount_amount)}</span></p>
                                          <p className="flex items-center justify-between gap-3 border-t border-ink-900/10 pt-2"><span>Thành tiền</span><span className="text-base font-semibold text-ink-900">{formatCurrency(detail.total_amount)}</span></p>
                                          <p className="flex items-center justify-between gap-3"><span>Khách đưa</span><span className="font-semibold text-ink-900">{formatCurrency(detail.amount_paid)}</span></p>
                                          <p className="flex items-center justify-between gap-3"><span>Tiền thừa</span><span className="font-semibold text-ink-900">{formatCurrency(detail.change_amount)}</span></p>
                                          {debtAmountOfInvoice(detail.total_amount, detail.amount_paid) > 0 ? (
                                            <p className="flex items-center justify-between gap-3 text-coral-500"><span>Còn nợ</span><span className="font-semibold">{formatCurrency(debtAmountOfInvoice(detail.total_amount, detail.amount_paid))}</span></p>
                                          ) : null}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="overflow-x-auto rounded-2xl border border-ink-900/10 bg-white">
                                      <table className="w-full min-w-[820px] text-left text-sm">
                                        <thead className="bg-fog-50 text-xs uppercase tracking-[0.18em] text-ink-600">
                                          <tr>
                                            <th className="px-4 py-3">Thuốc</th>
                                            <th className="px-4 py-3">Lô</th>
                                            <th className="px-4 py-3">Đơn vị</th>
                                            <th className="px-4 py-3">SL</th>
                                            <th className="px-4 py-3">Đơn giá</th>
                                            <th className="px-4 py-3">Giảm</th>
                                            <th className="px-4 py-3">Thành tiền</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-ink-900/5">
                                          {detail.items.length === 0 ? (
                                            <tr>
                                              <td className="px-4 py-4 text-ink-600" colSpan={7}>
                                                Hóa đơn chưa có dòng thuốc.
                                              </td>
                                            </tr>
                                          ) : null}

                                          {detail.items.map((line) => (
                                            <tr key={line.id}>
                                              <td className="px-4 py-3">
                                                <p className="font-semibold text-ink-900">{line.product_name}</p>
                                                <p className="text-xs text-ink-600">{line.product_code}</p>
                                              </td>
                                              <td className="px-4 py-3 text-ink-700">{line.lot_number || line.batch_id}</td>
                                              <td className="px-4 py-3 text-ink-700">{line.unit_name}</td>
                                              <td className="px-4 py-3 text-ink-700">{line.quantity}</td>
                                              <td className="px-4 py-3 text-ink-700">{formatCurrency(line.unit_price)}</td>
                                              <td className="px-4 py-3 text-ink-700">{formatCurrency(line.discount_amount)}</td>
                                              <td className="px-4 py-3 font-semibold text-ink-900">{formatCurrency(line.line_total)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })
                : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-600">
        <span>
          Hiển thị {showingFrom} - {showingTo} trong {total} hóa đơn
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
          >
            Trước
          </button>
          <span>{page}/{totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
            className="rounded-full border border-ink-900/10 bg-white/80 px-3 py-1 text-xs font-semibold text-ink-900 disabled:opacity-50"
          >
            Sau
          </button>
        </div>
      </section>

      {returnModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-5xl max-h-[90vh] flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-5">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-ink-600">Trả hàng</p>
                <h3 className="mt-2 text-xl font-semibold text-ink-900">Hóa đơn {returnModal.invoice_code}</h3>
              </div>
              <button
                type="button"
                disabled={submittingReturn}
                onClick={() => {
                  setReturnModal(null)
                  setReturnModalError(null)
                }}
                className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
              >
                Đóng
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid gap-3 md:grid-cols-[1fr,1.2fr]">
                <label className="space-y-2 text-sm text-ink-700">
                  <span>Hình thức hoàn tiền</span>
                  <select
                    value={returnModal.refund_method}
                    onChange={(event) =>
                      setReturnModal((prev) =>
                        prev ? { ...prev, refund_method: event.target.value as RefundMethod } : prev,
                      )
                    }
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                  >
                    <option value="cash">Tiền mặt</option>
                    <option value="card">Thẻ</option>
                    <option value="points">Điểm</option>
                  </select>
                </label>

                <label className="space-y-2 text-sm text-ink-700">
                  <span>Ghi chú trả hàng</span>
                  <input
                    value={returnModal.reason}
                    onChange={(event) =>
                      setReturnModal((prev) =>
                        prev ? { ...prev, reason: event.target.value } : prev,
                      )
                    }
                    className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                    placeholder="Lý do trả hàng (không bắt buộc)"
                  />
                </label>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-ink-900/10">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-fog-50 text-xs uppercase tracking-[0.18em] text-ink-600">
                    <tr>
                      <th className="px-4 py-3">Thuốc</th>
                      <th className="px-4 py-3">Đơn vị</th>
                      <th className="px-4 py-3">Tối đa</th>
                      <th className="px-4 py-3">SL tra</th>
                      <th className="px-4 py-3">Tình trạng</th>
                      <th className="px-4 py-3">Lý do dòng</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-900/5">
                    {returnModal.lines.map((line) => (
                      <tr key={line.invoice_item_id}>
                        <td className="px-4 py-3 font-semibold text-ink-900">{line.product_name}</td>
                        <td className="px-4 py-3 text-ink-700">{line.unit_name}</td>
                        <td className="px-4 py-3 text-ink-700">{line.max_quantity}</td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            min={0}
                            max={line.max_quantity}
                            value={line.quantity}
                            onChange={(event) =>
                              updateReturnLine(line.invoice_item_id, (current) => {
                                const nextValue = Number.parseInt(event.target.value || '0', 10)
                                const normalized = Number.isFinite(nextValue) ? nextValue : 0
                                return {
                                  ...current,
                                  quantity: Math.min(
                                    current.max_quantity,
                                    Math.max(0, normalized),
                                  ),
                                }
                              })
                            }
                            className="w-24 rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={line.condition}
                            onChange={(event) =>
                              updateReturnLine(line.invoice_item_id, (current) => ({
                                ...current,
                                condition: event.target.value as ReturnCondition,
                              }))
                            }
                            className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                          >
                            <option value="good">Tốt</option>
                            <option value="damaged">Hư hỏng</option>
                            <option value="expired">Hết hạn</option>
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={line.reason}
                            onChange={(event) =>
                              updateReturnLine(line.invoice_item_id, (current) => ({
                                ...current,
                                reason: event.target.value,
                              }))
                            }
                            placeholder="Ghi chú dòng"
                            className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {returnModalError ? (
                <p className="text-sm text-coral-500">{returnModalError}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-900/10 px-6 py-4">
              <p className="text-sm text-ink-600">
                Đã chọn {returnModal.lines.filter((line) => line.quantity > 0).length} dòng để trả
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={submittingReturn}
                  onClick={() => {
                    setReturnModal(null)
                    setReturnModalError(null)
                  }}
                  className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  disabled={submittingReturn}
                  onClick={() => void submitReturn()}
                  className="rounded-full bg-sun-500 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {submittingReturn ? 'Đang xử lý...' : 'Trả hàng'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  )
}
