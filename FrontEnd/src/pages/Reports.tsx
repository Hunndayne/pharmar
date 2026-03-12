import { useCallback, useEffect, useMemo, useState } from 'react'
import { catalogApi, type SupplierItem } from '../api/catalogService'
import { customerApi, type CustomerRecord } from '../api/customerService'
import { inventoryApi, type InventoryStockSummary } from '../api/inventoryService'
import {
  reportApi,
  type ProfitBreakdownGroup,
  type ProfitInvoiceBreakdownRow,
  type ProfitPeriodBreakdownRow,
  type ProfitProductBreakdownRow,
  type ProfitSummaryResponse,
  type ReportPageResponse,
  type ReportEvent,
} from '../api/reportService'
import { saleApi, type SaleInvoiceListItem } from '../api/saleService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { downloadCsv } from '../utils/csv'

type ReportTab = 'revenue' | 'profit' | 'inventory' | 'debt' | 'customer'

type RevenueDailyRow = {
  date: string
  invoiceCount: number
  totalAmount: number
  paidAmount: number
  debtAmount: number
}

type RevenueReportData = {
  invoiceCount: number
  canceledCount: number
  totalAmount: number
  paidAmount: number
  debtAmount: number
  averageAmount: number
  dailyRows: RevenueDailyRow[]
  paymentRows: Array<{ method: string; invoiceCount: number; amount: number }>
  debtInvoices: Array<{ code: string; customerName: string; createdAt: string; debtAmount: number }>
}

type InventoryReportData = {
  totalItems: number
  outOfStock: number
  expiringSoon: number
  nearDate: number
  expired: number
  lowStock: number
  rows: InventoryStockSummary[]
}

type DebtReportData = {
  customerDebtTotal: number
  supplierDebtTotal: number
  debtInvoiceRows: Array<{ code: string; customerName: string; createdAt: string; debtAmount: number }>
  supplierRows: Array<{ name: string; phone: string; debtAmount: number }>
}

type CustomerReportData = {
  totalCustomers: number
  activeCustomers: number
  newCustomers: number
  totalPoints: number
  totalSpent: number
  topSpenders: CustomerRecord[]
  rows: CustomerRecord[]
}

type ProfitReportData = {
  summary: ProfitSummaryResponse
  breakdown: ReportPageResponse<
    ProfitInvoiceBreakdownRow | ProfitPeriodBreakdownRow | ProfitProductBreakdownRow
  >
  topProducts: ProfitProductBreakdownRow[]
}

const tabs: Array<{ id: ReportTab; label: string }> = [
  { id: 'revenue', label: 'Doanh thu' },
  { id: 'profit', label: 'Lợi nhuận' },
  { id: 'inventory', label: 'Tồn kho' },
  { id: 'debt', label: 'Công nợ' },
  { id: 'customer', label: 'Khách hàng' },
]

const MAX_REPORT_PAGES = 5
const PAGE_SIZE = 50
const PROFIT_PAGE_SIZE = 20
const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const REPORT_DATE_KEY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const REPORT_DATE_DISPLAY_FORMATTER = new Intl.DateTimeFormat('vi-VN', {
  timeZone: REPORT_TIME_ZONE,
})

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

const toNumberLoose = (value: unknown) => {
  if (typeof value === 'number' || typeof value === 'string') return toNumber(value)
  return 0
}

const formatCurrency = (value: number) => `${Math.round(value || 0).toLocaleString('vi-VN')}đ`

const toDateParts = (date: Date) => {
  const parts = REPORT_DATE_KEY_FORMATTER.formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value ?? ''
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const day = parts.find((part) => part.type === 'day')?.value ?? ''
  return { year, month, day }
}

const formatDateKey = (value: string) => {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return value
  return `${match[3]}/${match[2]}/${match[1]}`
}

const formatDate = (value: string) => {
  if (!value) return '-'
  const normalized = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return formatDateKey(normalized)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return REPORT_DATE_DISPLAY_FORMATTER.format(date)
}

const toDateKey = (value: string) => {
  if (!value) return ''
  const normalized = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  const { year, month, day } = toDateParts(date)
  if (!year || !month || !day) return value.slice(0, 10)
  return `${year}-${month}-${day}`
}

const shiftDateKey = (value: string, days: number) => {
  const normalized = value.trim()
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return normalized
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const eventDateKey = (event: ReportEvent) =>
  toDateKey(
    firstString(
      event.created_at,
      event.createdAt,
      event.sale_created_at,
      event.timestamp,
      event.date,
    ),
  )

const eventPaymentMethod = (event: ReportEvent) =>
  firstString(event.payment_method, event.paymentMethod, event.method, event.payment)

const eventCode = (event: ReportEvent) =>
  firstString(event.invoice_code, event.code, event.invoiceId, event.id)

const eventCustomerName = (event: ReportEvent) =>
  firstString(event.customer_name, event.customerName, event.customer)

const inDateRange = (value: string, from: string, to: string) => {
  const key = toDateKey(value)
  if (!key) return false
  if (from && key < from) return false
  if (to && key > to) return false
  return true
}

const paymentLabel = (method: string) => {
  const key = method.trim().toLowerCase()
  if (!key) return 'Khác'
  if (key === 'cash') return 'Tiền mặt'
  if (key === 'card') return 'Thẻ'
  if (key === 'bank') return 'Ngân hàng'
  if (key === 'ewallet') return 'Ví điện tử'
  if (key === 'debt') return 'Mua nợ'
  return method
}

const stockStatusLabel = (status: string) => {
  switch (status) {
    case 'out_of_stock':
      return 'Hết hàng'
    case 'expired':
      return 'Hết hạn'
    case 'expiring_soon':
      return 'Sắp hết hạn'
    case 'near_date':
      return 'Cận date'
    case 'low_stock':
      return 'Sắp hết hàng'
    default:
      return 'Bình thường'
  }
}

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

const buildRevenueFromInvoices = (
  invoices: SaleInvoiceListItem[],
  from = '',
  to = '',
): RevenueReportData => {
  const dailyMap = new Map<string, RevenueDailyRow>()
  const paymentMap = new Map<string, { method: string; invoiceCount: number; amount: number }>()

  let canceledCount = 0
  let totalAmount = 0
  let paidAmount = 0
  let debtAmount = 0
  let validCount = 0

  const debtInvoices: Array<{ code: string; customerName: string; createdAt: string; debtAmount: number }> = []

  invoices.forEach((invoice) => {
    const status = invoice.status.trim().toLowerCase()
    const isCanceled = status === 'cancelled' || status === 'canceled'
    const invoiceTotal = toNumber(invoice.total_amount)
    const invoicePaid = toNumber(invoice.amount_paid)
    const invoiceDebt = Math.max(0, invoiceTotal - invoicePaid)
    const localDateKey = toDateKey(invoice.created_at)

    if (isCanceled) {
      canceledCount += 1
      return
    }
    if (!localDateKey) return
    if (from && localDateKey < from) return
    if (to && localDateKey > to) return

    validCount += 1
    totalAmount += invoiceTotal
    paidAmount += invoicePaid
    debtAmount += invoiceDebt

    const current = dailyMap.get(localDateKey) ?? {
      date: localDateKey,
      invoiceCount: 0,
      totalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
    }
    current.invoiceCount += 1
    current.totalAmount += invoiceTotal
    current.paidAmount += invoicePaid
    current.debtAmount += invoiceDebt
    dailyMap.set(localDateKey, current)

    const method = paymentLabel(invoice.payment_method)
    const payment = paymentMap.get(method) ?? { method, invoiceCount: 0, amount: 0 }
    payment.invoiceCount += 1
    payment.amount += invoiceTotal
    paymentMap.set(method, payment)

    if (invoiceDebt > 0) {
      debtInvoices.push({
        code: invoice.code,
        customerName: invoice.customer_name || 'Khách vãng lai',
        createdAt: invoice.created_at,
        debtAmount: invoiceDebt,
      })
    }
  })

  const dailyRows = Array.from(dailyMap.values()).sort((left, right) =>
    right.date.localeCompare(left.date),
  )
  const paymentRows = Array.from(paymentMap.values()).sort((left, right) => right.amount - left.amount)
  const averageAmount = validCount > 0 ? totalAmount / validCount : 0

  return {
    invoiceCount: validCount,
    canceledCount,
    totalAmount,
    paidAmount,
    debtAmount,
    averageAmount,
    dailyRows,
    paymentRows,
    debtInvoices: debtInvoices
      .sort((left, right) => right.debtAmount - left.debtAmount)
      .slice(0, 12),
  }
}

export function Reports() {
  const { token } = useAuth()

  const [tab, setTab] = useState<ReportTab>('revenue')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [revenueData, setRevenueData] = useState<RevenueReportData | null>(null)
  const [profitGroupBy, setProfitGroupBy] = useState<ProfitBreakdownGroup>('invoice')
  const [profitData, setProfitData] = useState<ProfitReportData | null>(null)
  const [inventoryData, setInventoryData] = useState<InventoryReportData | null>(null)
  const [debtData, setDebtData] = useState<DebtReportData | null>(null)
  const [customerData, setCustomerData] = useState<CustomerReportData | null>(null)

  const fetchInvoices = useCallback(
    async (accessToken: string) => {
      const invoices: SaleInvoiceListItem[] = []
      let page = 1
      let totalPages = 1
      const requestDateFrom = dateFrom ? shiftDateKey(dateFrom, -1) : undefined
      const requestDateTo = dateTo ? shiftDateKey(dateTo, 1) : undefined

      while (page <= totalPages && page <= MAX_REPORT_PAGES) {
        const response = await saleApi.listInvoices(accessToken, {
          page,
          size: PAGE_SIZE,
          date_from: requestDateFrom,
          date_to: requestDateTo,
        })
        invoices.push(...response.items)
        totalPages = Math.max(1, response.pages || 1)
        page += 1
      }

      return invoices.filter((invoice) => inDateRange(invoice.created_at, dateFrom, dateTo))
    },
    [dateFrom, dateTo],
  )

  const fetchSuppliers = useCallback(async (accessToken: string) => {
    const suppliers: SupplierItem[] = []
    let page = 1
    let totalPages = 1

    while (page <= totalPages && page <= MAX_REPORT_PAGES) {
      const response = await catalogApi.listSuppliers(accessToken, {
        page,
        size: PAGE_SIZE,
      })
      suppliers.push(...response.items)
      totalPages = Math.max(1, response.pages || 1)
      page += 1
    }

    return suppliers
  }, [])

  const fetchCustomers = useCallback(async (accessToken: string) => {
    const customers: CustomerRecord[] = []
    let page = 1
    let totalPages = 1

    while (page <= totalPages && page <= MAX_REPORT_PAGES) {
      const response = await customerApi.listCustomers(accessToken, {
        page,
        size: PAGE_SIZE,
      })
      customers.push(...response.items)
      totalPages = Math.max(1, response.pages || 1)
      page += 1
    }

    return customers
  }, [])

  const loadRevenueReport = useCallback(
    async (accessToken: string) => {
      const fallbackFromSaleInvoices = async () => {
        const invoices = await fetchInvoices(accessToken)
        setRevenueData(buildRevenueFromInvoices(invoices, dateFrom, dateTo))
      }

      try {
        const [summary, events] = await Promise.all([
          reportApi.getSummary(accessToken),
          reportApi.listEvents(accessToken),
        ])

        const filteredEvents = events.filter((event) => {
          const key = eventDateKey(event)
          if (!key) return false
          if (dateFrom && key < dateFrom) return false
          if (dateTo && key > dateTo) return false
          return true
        })

        const hasSummaryOnly =
          !dateFrom &&
          !dateTo &&
          filteredEvents.length === 0 &&
          (toNumber(summary.total_sales) > 0 || toNumber(summary.total_revenue) > 0)

        if (!filteredEvents.length && !hasSummaryOnly) {
          await fallbackFromSaleInvoices()
          return
        }

        if (hasSummaryOnly) {
          const invoiceCount = Math.max(0, Math.round(toNumber(summary.total_sales)))
          const totalAmount = Math.max(0, toNumber(summary.total_revenue))
          setRevenueData({
            invoiceCount,
            canceledCount: 0,
            totalAmount,
            paidAmount: totalAmount,
            debtAmount: 0,
            averageAmount: invoiceCount > 0 ? totalAmount / invoiceCount : 0,
            dailyRows: [],
            paymentRows: [],
            debtInvoices: [],
          })
          return
        }

        const dailyMap = new Map<string, RevenueDailyRow>()
        const paymentMap = new Map<string, { method: string; invoiceCount: number; amount: number }>()
        const debtInvoices: Array<{ code: string; customerName: string; createdAt: string; debtAmount: number }> = []

        let canceledCount = 0
        let totalAmount = 0
        let paidAmount = 0
        let debtAmount = 0
        let validCount = 0

        filteredEvents.forEach((event) => {
          const status = firstString(event.status, event.invoice_status).toLowerCase()
          const isCanceled = status === 'cancelled' || status === 'canceled'
          if (isCanceled) {
            canceledCount += 1
            return
          }

          const eventTotal = toNumberLoose(event.total_amount ?? event.totalAmount ?? event.amount)
          const hasAmountPaidField = event.amount_paid !== undefined || event.amountPaid !== undefined
          const eventPaid = hasAmountPaidField
            ? toNumberLoose(event.amount_paid ?? event.amountPaid)
            : eventTotal
          const eventDebt = Math.max(0, eventTotal - eventPaid)

          validCount += 1
          totalAmount += eventTotal
          paidAmount += eventPaid
          debtAmount += eventDebt

          const dayKey = eventDateKey(event)
          if (dayKey) {
            const current = dailyMap.get(dayKey) ?? {
              date: dayKey,
              invoiceCount: 0,
              totalAmount: 0,
              paidAmount: 0,
              debtAmount: 0,
            }
            current.invoiceCount += 1
            current.totalAmount += eventTotal
            current.paidAmount += eventPaid
            current.debtAmount += eventDebt
            dailyMap.set(dayKey, current)
          }

          const method = paymentLabel(eventPaymentMethod(event))
          const payment = paymentMap.get(method) ?? { method, invoiceCount: 0, amount: 0 }
          payment.invoiceCount += 1
          payment.amount += eventTotal
          paymentMap.set(method, payment)

          if (eventDebt > 0) {
            debtInvoices.push({
              code: eventCode(event) || '-',
              customerName: eventCustomerName(event) || 'Khách vãng lai',
              createdAt: firstString(event.created_at, event.createdAt, event.date) || '',
              debtAmount: eventDebt,
            })
          }
        })

        const dailyRows = Array.from(dailyMap.values()).sort((left, right) =>
          right.date.localeCompare(left.date),
        )
        const paymentRows = Array.from(paymentMap.values()).sort((left, right) => right.amount - left.amount)

        setRevenueData({
          invoiceCount: validCount,
          canceledCount,
          totalAmount,
          paidAmount,
          debtAmount,
          averageAmount: validCount > 0 ? totalAmount / validCount : 0,
          dailyRows,
          paymentRows,
          debtInvoices: debtInvoices
            .sort((left, right) => right.debtAmount - left.debtAmount)
            .slice(0, 12),
        })
      } catch {
        await fallbackFromSaleInvoices()
      }
    },
    [dateFrom, dateTo, fetchInvoices],
  )

  const loadProfitReport = useCallback(
    async (accessToken: string) => {
      const [summary, breakdown, topProducts] = await Promise.all([
        reportApi.getProfitSummary(accessToken, {
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        }),
        reportApi.getProfitBreakdown<
          ProfitInvoiceBreakdownRow | ProfitPeriodBreakdownRow | ProfitProductBreakdownRow
        >(accessToken, {
          group_by: profitGroupBy,
          page: 1,
          size: PROFIT_PAGE_SIZE,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        }),
        reportApi.getProfitTopProducts(accessToken, {
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          limit: 10,
        }),
      ])

      setProfitData({
        summary,
        breakdown,
        topProducts,
      })
    },
    [dateFrom, dateTo, profitGroupBy],
  )

  const loadInventoryReport = useCallback(
    async (accessToken: string) => {
      const rows = await inventoryApi.getStockSummary(accessToken)
      setInventoryData({
        totalItems: rows.length,
        outOfStock: rows.filter((item) => item.status === 'out_of_stock').length,
        expiringSoon: rows.filter((item) => item.status === 'expiring_soon').length,
        nearDate: rows.filter((item) => item.status === 'near_date').length,
        expired: rows.filter((item) => item.status === 'expired').length,
        lowStock: rows.filter((item) => item.status === 'low_stock').length,
        rows,
      })
    },
    [],
  )

  const loadDebtReport = useCallback(
    async (accessToken: string) => {
      const [invoices, suppliers] = await Promise.all([
        fetchInvoices(accessToken),
        fetchSuppliers(accessToken),
      ])

      const debtInvoiceRows = invoices
        .map((invoice) => {
          const status = invoice.status.trim().toLowerCase()
          if (status === 'cancelled' || status === 'canceled') return null
          const total = toNumber(invoice.total_amount)
          const paid = toNumber(invoice.amount_paid)
          const debt = Math.max(0, total - paid)
          if (debt <= 0) return null
          return {
            code: invoice.code,
            customerName: invoice.customer_name || 'Khách vãng lai',
            createdAt: invoice.created_at,
            debtAmount: debt,
          }
        })
        .filter((item): item is { code: string; customerName: string; createdAt: string; debtAmount: number } => item !== null)
        .sort((left, right) => right.debtAmount - left.debtAmount)

      const supplierRows = suppliers
        .map((supplier) => ({
          name: supplier.name,
          phone: supplier.phone || '-',
          debtAmount: Math.max(0, toNumber(supplier.current_debt)),
        }))
        .filter((supplier) => supplier.debtAmount > 0)
        .sort((left, right) => right.debtAmount - left.debtAmount)

      const customerDebtTotal = debtInvoiceRows.reduce((sum, item) => sum + item.debtAmount, 0)
      const supplierDebtTotal = supplierRows.reduce((sum, item) => sum + item.debtAmount, 0)

      setDebtData({
        customerDebtTotal,
        supplierDebtTotal,
        debtInvoiceRows: debtInvoiceRows.slice(0, 20),
        supplierRows: supplierRows.slice(0, 20),
      })
    },
    [fetchInvoices, fetchSuppliers],
  )

  const loadCustomerReport = useCallback(
    async (accessToken: string) => {
      const rows = await fetchCustomers(accessToken)

      const totalCustomers = rows.length
      const activeCustomers = rows.filter((item) => item.is_active).length
      const newCustomers = rows.filter((item) => inDateRange(item.created_at, dateFrom, dateTo)).length
      const totalPoints = rows.reduce((sum, item) => sum + Math.max(0, item.current_points), 0)
      const totalSpent = rows.reduce((sum, item) => sum + Math.max(0, toNumber(item.total_spent)), 0)
      const topSpenders = rows
        .slice()
        .sort((left, right) => toNumber(right.total_spent) - toNumber(left.total_spent))
        .slice(0, 12)

      setCustomerData({
        totalCustomers,
        activeCustomers,
        newCustomers,
        totalPoints,
        totalSpent,
        topSpenders,
        rows,
      })
    },
    [fetchCustomers, dateFrom, dateTo],
  )

  const loadReport = useCallback(
    async (targetTab: ReportTab) => {
      const accessToken = token?.access_token
      if (!accessToken) {
        setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
        return
      }

      setLoading(true)
      setError(null)
      try {
        if (targetTab === 'revenue') {
          await loadRevenueReport(accessToken)
        } else if (targetTab === 'profit') {
          await loadProfitReport(accessToken)
        } else if (targetTab === 'inventory') {
          await loadInventoryReport(accessToken)
        } else if (targetTab === 'debt') {
          await loadDebtReport(accessToken)
        } else {
          await loadCustomerReport(accessToken)
        }
      } catch (reportError) {
        setError(getErrorMessage(reportError, 'Không thể tải dữ liệu báo cáo.'))
      } finally {
        setLoading(false)
      }
    },
    [
      loadCustomerReport,
      loadDebtReport,
      loadInventoryReport,
      loadProfitReport,
      loadRevenueReport,
      token?.access_token,
    ],
  )

  useEffect(() => {
    void loadReport(tab)
  }, [tab, loadReport])

  const exportCurrentTab = useCallback(() => {
    const dateKey = new Date().toISOString().slice(0, 10)

    if (tab === 'revenue' && revenueData) {
      const headers = ['Ngày', 'Số hóa đơn', 'Doanh thu', 'Thu thực tế', 'Còn nợ']
      const rows = revenueData.dailyRows.map((item) => [
        item.date,
        item.invoiceCount,
        Math.round(item.totalAmount),
        Math.round(item.paidAmount),
        Math.round(item.debtAmount),
      ])
      downloadCsv(`bao-cao-doanh-thu-${dateKey}.csv`, headers, rows)
      return
    }

    if (tab === 'profit' && profitData) {
      if (profitGroupBy === 'invoice') {
        const rows = (profitData.breakdown.items as ProfitInvoiceBreakdownRow[]).map((item) => [
          item.invoice_code,
          item.customer_name,
          formatDate(item.created_at),
          Math.round(item.net_revenue),
          Math.round(item.cogs),
          Math.round(item.gross_profit),
          Math.round(item.collected_profit),
          Math.round(item.debt_amount),
        ])
        downloadCsv(
          `bao-cao-loi-theo-don-${dateKey}.csv`,
          ['Mã hóa đơn', 'Khách hàng', 'Ngày', 'Doanh thu thuần', 'Giá vốn', 'Lợi nhuận', 'Lời thực thu', 'Còn nợ'],
          rows,
        )
        return
      }

      if (profitGroupBy === 'product') {
        const rows = (profitData.breakdown.items as ProfitProductBreakdownRow[]).map((item) => [
          item.product_code,
          item.product_name,
          item.sold_base_qty,
          Math.round(item.net_revenue),
          Math.round(item.cogs),
          Math.round(item.gross_profit),
          item.margin_percent,
        ])
        downloadCsv(
          `bao-cao-loi-theo-san-pham-${dateKey}.csv`,
          ['Mã thuốc', 'Tên thuốc', 'SL bán (đơn vị gốc)', 'Doanh thu thuần', 'Giá vốn', 'Lợi nhuận', 'Biên lợi nhuận %'],
          rows,
        )
        return
      }

      const rows = (profitData.breakdown.items as ProfitPeriodBreakdownRow[]).map((item) => [
        item.period_key,
        item.invoice_count,
        Math.round(item.net_revenue),
        Math.round(item.cogs),
        Math.round(item.gross_profit),
        Math.round(item.collected_profit),
      ])
      downloadCsv(
        `bao-cao-loi-theo-${profitGroupBy}-${dateKey}.csv`,
        ['Kỳ', 'Số hóa đơn', 'Doanh thu thuần', 'Giá vốn', 'Lợi nhuận', 'Lời thực thu'],
        rows,
      )
      return
    }

    if (tab === 'inventory' && inventoryData) {
      const headers = ['Mã thuốc', 'Tên thuốc', 'Nhóm', 'Tồn', 'Đơn vị', 'HSD gần nhất', 'Trạng thái']
      const rows = inventoryData.rows.map((item) => [
        item.drug_code,
        item.drug_name,
        item.drug_group,
        item.total_qty,
        item.base_unit,
        item.nearest_expiry || '-',
        stockStatusLabel(item.status),
      ])
      downloadCsv(`bao-cao-ton-kho-${dateKey}.csv`, headers, rows)
      return
    }

    if (tab === 'debt' && debtData) {
      const headers = ['Loại công nợ', 'Mã/Đối tượng', 'Ngày', 'Giá trị']
      const rows = [
        ...debtData.debtInvoiceRows.map((item) => [
          'Khách hàng',
          `${item.code} - ${item.customerName}`,
          formatDate(item.createdAt),
          Math.round(item.debtAmount),
        ]),
        ...debtData.supplierRows.map((item) => [
          'Nhà phân phối',
          `${item.name} (${item.phone})`,
          '-',
          Math.round(item.debtAmount),
        ]),
      ]
      downloadCsv(`bao-cao-cong-no-${dateKey}.csv`, headers, rows)
      return
    }

    if (tab === 'customer' && customerData) {
      const headers = ['Mã KH', 'Tên khách hàng', 'Số điện thoại', 'Hạng', 'Tổng đơn', 'Tổng chi', 'Điểm hiện tại', 'Ngày tạo']
      const rows = customerData.rows.map((item) => [
        item.code,
        item.name,
        item.phone,
        item.tier,
        item.total_orders,
        Math.round(toNumber(item.total_spent)),
        item.current_points,
        formatDate(item.created_at),
      ])
      downloadCsv(`bao-cao-khach-hang-${dateKey}.csv`, headers, rows)
    }
  }, [customerData, debtData, inventoryData, profitData, profitGroupBy, revenueData, tab])

  const printCurrentTab = useCallback(() => {
    window.print()
  }, [])

  const summaryCards = useMemo(() => {
    if (tab === 'revenue' && revenueData) {
      return [
        { label: 'Hóa đơn hợp lệ', value: revenueData.invoiceCount.toLocaleString('vi-VN') },
        { label: 'Doanh thu', value: formatCurrency(revenueData.totalAmount) },
        { label: 'Thực thu', value: formatCurrency(revenueData.paidAmount) },
        { label: 'Còn nợ', value: formatCurrency(revenueData.debtAmount) },
      ]
    }

    if (tab === 'profit' && profitData) {
      return [
        { label: 'Doanh thu thuần', value: formatCurrency(profitData.summary.net_revenue) },
        { label: 'Giá vốn', value: formatCurrency(profitData.summary.cogs) },
        { label: 'Lời theo hóa đơn', value: formatCurrency(profitData.summary.gross_profit) },
        { label: 'Lời theo thực thu', value: formatCurrency(profitData.summary.collected_profit) },
      ]
    }

    if (tab === 'inventory' && inventoryData) {
      return [
        { label: 'Tổng mặt hàng', value: inventoryData.totalItems.toLocaleString('vi-VN') },
        { label: 'Hết hàng', value: inventoryData.outOfStock.toLocaleString('vi-VN') },
        { label: 'Cận date', value: inventoryData.nearDate.toLocaleString('vi-VN') },
        { label: 'Hết hạn', value: inventoryData.expired.toLocaleString('vi-VN') },
      ]
    }

    if (tab === 'debt' && debtData) {
      return [
        { label: 'Công nợ khách hàng', value: formatCurrency(debtData.customerDebtTotal) },
        { label: 'Công nợ nhà phân phối', value: formatCurrency(debtData.supplierDebtTotal) },
        { label: 'Số hóa đơn nợ', value: debtData.debtInvoiceRows.length.toLocaleString('vi-VN') },
        { label: 'Số NPP còn nợ', value: debtData.supplierRows.length.toLocaleString('vi-VN') },
      ]
    }

    if (tab === 'customer' && customerData) {
      return [
        { label: 'Tổng khách hàng', value: customerData.totalCustomers.toLocaleString('vi-VN') },
        { label: 'Đang hoạt động', value: customerData.activeCustomers.toLocaleString('vi-VN') },
        { label: 'Khách mới theo kỳ', value: customerData.newCustomers.toLocaleString('vi-VN') },
        { label: 'Tổng chi tiêu', value: formatCurrency(customerData.totalSpent) },
      ]
    }

    return []
  }, [customerData, debtData, inventoryData, profitData, revenueData, tab])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Thống kê</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Báo cáo</h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={exportCurrentTab}
            className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Export Excel
          </button>
          <button
            type="button"
            onClick={printCurrentTab}
            className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Export PDF
          </button>
        </div>
      </header>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                tab === item.id
                  ? 'bg-ink-900 text-white'
                  : 'border border-ink-900/10 bg-white text-ink-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'profit' ? (
          <div className="flex flex-wrap gap-2">
            {([
              ['invoice', 'Theo đơn'],
              ['day', 'Theo ngày'],
              ['week', 'Theo tuần'],
              ['month', 'Theo tháng'],
              ['product', 'Theo sản phẩm'],
            ] as Array<[ProfitBreakdownGroup, string]>).map(([groupId, label]) => (
              <button
                key={groupId}
                type="button"
                onClick={() => setProfitGroupBy(groupId)}
                className={`rounded-full px-4 py-2 text-sm font-semibold ${
                  profitGroupBy === groupId
                    ? 'bg-sky-100 text-sky-700'
                    : 'border border-ink-900/10 bg-white text-ink-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[1fr,1fr,auto,auto]">
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            disabled={tab === 'inventory'}
          />
          <input
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            disabled={tab === 'inventory'}
          />
          <button
            type="button"
            onClick={() => {
              void loadReport(tab)
            }}
            className="rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Áp dụng
          </button>
          <button
            type="button"
            onClick={() => {
              setDateFrom('')
              setDateTo('')
              window.setTimeout(() => {
                void loadReport(tab)
              }, 0)
            }}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Reset
          </button>
        </div>

        {tab === 'inventory' ? (
          <p className="text-xs text-ink-500">Báo cáo tồn kho không áp dụng lọc thời gian.</p>
        ) : null}
      </section>

      {summaryCards.length > 0 ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map((item) => (
            <article key={item.label} className="glass-card rounded-3xl p-5">
              <p className="text-xs uppercase tracking-[0.25em] text-ink-600">{item.label}</p>
              <p className="mt-3 text-2xl font-semibold text-ink-900">{item.value}</p>
            </article>
          ))}
        </section>
      ) : null}

      {loading ? <p className="text-sm text-ink-600">Đang tải dữ liệu báo cáo...</p> : null}
      {error ? <p className="text-sm text-coral-500">{error}</p> : null}

      {tab === 'revenue' && revenueData ? (
        <section className="grid gap-4 xl:grid-cols-2">
          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Doanh thu theo ngày</h3>
            <p className="mt-1 text-xs text-ink-500">Hóa đơn trung bình: {formatCurrency(revenueData.averageAmount)}</p>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[560px] w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                  <tr>
                    <th className="py-2">Ngày</th>
                    <th className="py-2">Số HĐ</th>
                    <th className="py-2">Doanh thu</th>
                    <th className="py-2">Thực thu</th>
                    <th className="py-2">Còn nợ</th>
                  </tr>
                </thead>
                <tbody>
                  {revenueData.dailyRows.slice(0, 20).map((row) => (
                    <tr key={row.date} className="border-t border-ink-900/5">
                      <td className="py-2">{formatDate(row.date)}</td>
                      <td className="py-2">{row.invoiceCount}</td>
                      <td className="py-2">{formatCurrency(row.totalAmount)}</td>
                      <td className="py-2">{formatCurrency(row.paidAmount)}</td>
                      <td className="py-2 text-coral-500">{formatCurrency(row.debtAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Cơ cấu thanh toán</h3>
            <div className="mt-4 space-y-2">
              {revenueData.paymentRows.length === 0 ? (
                <p className="text-sm text-ink-600">Không có dữ liệu thanh toán.</p>
              ) : (
                revenueData.paymentRows.map((row) => (
                  <div key={row.method} className="flex items-center justify-between rounded-2xl border border-ink-900/10 bg-white px-4 py-3 text-sm">
                    <div>
                      <p className="font-semibold text-ink-900">{row.method}</p>
                      <p className="text-xs text-ink-600">{row.invoiceCount} hóa đơn</p>
                    </div>
                    <p className="font-semibold text-ink-900">{formatCurrency(row.amount)}</p>
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      ) : null}

      {tab === 'profit' && profitData ? (
        <section className="grid gap-4 xl:grid-cols-[1.15fr,0.85fr]">
          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Phân tích lợi nhuận</h3>
            <p className="mt-1 text-xs text-ink-500">
              Biên lợi nhuận gộp: {toNumber(profitData.summary.gross_margin_percent).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}% ·
              Phí dịch vụ ghi nhận: {formatCurrency(profitData.summary.service_fee_total)}
            </p>

            <div className="mt-4 overflow-x-auto">
              {profitGroupBy === 'invoice' ? (
                <table className="min-w-[900px] w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Mã HĐ</th>
                      <th className="py-2">Ngày</th>
                      <th className="py-2">Khách hàng</th>
                      <th className="py-2">Doanh thu thuần</th>
                      <th className="py-2">Giá vốn</th>
                      <th className="py-2">Lợi nhuận</th>
                      <th className="py-2">Lời thực thu</th>
                      <th className="py-2">Còn nợ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(profitData.breakdown.items as ProfitInvoiceBreakdownRow[]).map((row) => (
                      <tr key={row.invoice_id} className="border-t border-ink-900/5">
                        <td className="py-2 font-semibold text-ink-900">{row.invoice_code}</td>
                        <td className="py-2">{formatDate(row.created_at)}</td>
                        <td className="py-2">{row.customer_name || 'Khách vãng lai'}</td>
                        <td className="py-2">{formatCurrency(row.net_revenue)}</td>
                        <td className="py-2">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="py-2">{formatCurrency(row.collected_profit)}</td>
                        <td className="py-2 text-coral-500">{formatCurrency(row.debt_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : profitGroupBy === 'product' ? (
                <table className="min-w-[820px] w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Mã thuốc</th>
                      <th className="py-2">Tên thuốc</th>
                      <th className="py-2">SL bán</th>
                      <th className="py-2">Doanh thu thuần</th>
                      <th className="py-2">Giá vốn</th>
                      <th className="py-2">Lợi nhuận</th>
                      <th className="py-2">Biên LN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(profitData.breakdown.items as ProfitProductBreakdownRow[]).map((row) => (
                      <tr key={row.product_id || row.product_code} className="border-t border-ink-900/5">
                        <td className="py-2 font-semibold text-ink-900">{row.product_code || '-'}</td>
                        <td className="py-2">{row.product_name}</td>
                        <td className="py-2">{toNumber(row.sold_base_qty).toLocaleString('vi-VN')}</td>
                        <td className="py-2">{formatCurrency(row.net_revenue)}</td>
                        <td className="py-2">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="py-2">{toNumber(row.margin_percent).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="min-w-[720px] w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Kỳ</th>
                      <th className="py-2">Số HĐ</th>
                      <th className="py-2">Doanh thu thuần</th>
                      <th className="py-2">Giá vốn</th>
                      <th className="py-2">Lợi nhuận</th>
                      <th className="py-2">Lời thực thu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(profitData.breakdown.items as ProfitPeriodBreakdownRow[]).map((row) => (
                      <tr key={row.period_key} className="border-t border-ink-900/5">
                        <td className="py-2 font-semibold text-ink-900">{row.period_key}</td>
                        <td className="py-2">{row.invoice_count}</td>
                        <td className="py-2">{formatCurrency(row.net_revenue)}</td>
                        <td className="py-2">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="py-2">{formatCurrency(row.collected_profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </article>

          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Top sản phẩm lời cao</h3>
            <div className="mt-4 space-y-3">
              {profitData.topProducts.length === 0 ? (
                <p className="text-sm text-ink-600">Không có dữ liệu sản phẩm.</p>
              ) : (
                profitData.topProducts.map((item, index) => (
                  <div
                    key={`${item.product_id}-${index}`}
                    className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-ink-900">
                          {index + 1}. {item.product_name}
                        </p>
                        <p className="text-xs text-ink-500">
                          {item.product_code || '-'} · {toNumber(item.sold_base_qty).toLocaleString('vi-VN')} đơn vị gốc
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-emerald-600">
                        {formatCurrency(item.gross_profit)}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                      <span>Doanh thu thuần {formatCurrency(item.net_revenue)}</span>
                      <span>Biên LN {toNumber(item.margin_percent).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      ) : null}

      {tab === 'inventory' && inventoryData ? (
        <section className="glass-card rounded-3xl p-6">
          <h3 className="text-lg font-semibold text-ink-900">Chi tiết tồn kho</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[880px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                <tr>
                  <th className="py-2">Mã thuốc</th>
                  <th className="py-2">Tên thuốc</th>
                  <th className="py-2">Nhóm</th>
                  <th className="py-2">Tồn</th>
                  <th className="py-2">Đơn vị</th>
                  <th className="py-2">HSD gần nhất</th>
                  <th className="py-2">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {inventoryData.rows.map((item) => (
                  <tr key={item.drug_id} className="border-t border-ink-900/5">
                    <td className="py-2 font-semibold text-ink-900">{item.drug_code}</td>
                    <td className="py-2">{item.drug_name}</td>
                    <td className="py-2">{item.drug_group || '-'}</td>
                    <td className="py-2">{item.total_qty.toLocaleString('vi-VN')}</td>
                    <td className="py-2">{item.base_unit}</td>
                    <td className="py-2">{item.nearest_expiry ? formatDate(item.nearest_expiry) : '-'}</td>
                    <td className="py-2">{stockStatusLabel(item.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === 'debt' && debtData ? (
        <section className="grid gap-4 xl:grid-cols-2">
          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Hóa đơn còn nợ</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[520px] w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                  <tr>
                    <th className="py-2">Mã HĐ</th>
                    <th className="py-2">Khách hàng</th>
                    <th className="py-2">Ngày</th>
                    <th className="py-2">Còn nợ</th>
                  </tr>
                </thead>
                <tbody>
                  {debtData.debtInvoiceRows.map((item) => (
                    <tr key={item.code} className="border-t border-ink-900/5">
                      <td className="py-2 font-semibold text-ink-900">{item.code}</td>
                      <td className="py-2">{item.customerName}</td>
                      <td className="py-2">{formatDate(item.createdAt)}</td>
                      <td className="py-2 text-coral-500">{formatCurrency(item.debtAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="glass-card rounded-3xl p-6">
            <h3 className="text-lg font-semibold text-ink-900">Nhà phân phối còn công nợ</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[460px] w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                  <tr>
                    <th className="py-2">Nhà phân phối</th>
                    <th className="py-2">Số điện thoại</th>
                    <th className="py-2">Còn nợ</th>
                  </tr>
                </thead>
                <tbody>
                  {debtData.supplierRows.map((item) => (
                    <tr key={`${item.name}-${item.phone}`} className="border-t border-ink-900/5">
                      <td className="py-2 font-semibold text-ink-900">{item.name}</td>
                      <td className="py-2">{item.phone}</td>
                      <td className="py-2 text-coral-500">{formatCurrency(item.debtAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      ) : null}

      {tab === 'customer' && customerData ? (
        <section className="glass-card rounded-3xl p-6">
          <h3 className="text-lg font-semibold text-ink-900">Top khách hàng theo chi tiêu</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                <tr>
                  <th className="py-2">Mã KH</th>
                  <th className="py-2">Tên khách hàng</th>
                  <th className="py-2">SĐT</th>
                  <th className="py-2">Hạng</th>
                  <th className="py-2">Tổng đơn</th>
                  <th className="py-2">Tổng chi</th>
                  <th className="py-2">Điểm</th>
                </tr>
              </thead>
              <tbody>
                {customerData.topSpenders.map((item) => (
                  <tr key={item.id} className="border-t border-ink-900/5">
                    <td className="py-2 font-semibold text-ink-900">{item.code}</td>
                    <td className="py-2">{item.name}</td>
                    <td className="py-2">{item.phone}</td>
                    <td className="py-2">{item.tier}</td>
                    <td className="py-2">{item.total_orders.toLocaleString('vi-VN')}</td>
                    <td className="py-2">{formatCurrency(toNumber(item.total_spent))}</td>
                    <td className="py-2">{item.current_points.toLocaleString('vi-VN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
