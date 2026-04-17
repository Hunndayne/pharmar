import { useCallback, useEffect, useMemo, useState } from 'react'
import { type CustomerRecord } from '../api/customerService'
import { inventoryApi, type InventoryStockSummary } from '../api/inventoryService'
import {
  reportApi,
  type ProfitBreakdownGroup,
  type ProfitInvoiceBreakdownRow,
  type ProfitPeriodBreakdownRow,
  type ProfitProductBreakdownRow,
  type ProfitSummaryResponse,
  type ReportPageResponse,
} from '../api/reportService'
import {
  storeApi,
  type OperatingExpense,
  type CreateExpensePayload,
  type StoreInfo,
} from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'
import { downloadCsv } from '../utils/csv'
import { exportToExcel, exportToPdf } from '../utils/exportFile'
import { formatDateInTimeZone } from '../utils/timezone'

const EXPENSE_CATEGORIES = [
  { value: 'electricity', label: 'Tiền điện' },
  { value: 'water', label: 'Tiền nước' },
  { value: 'internet', label: 'Internet' },
  { value: 'rent', label: 'Mặt bằng' },
  { value: 'salary', label: 'Lương nhân viên' },
  { value: 'maintenance', label: 'Bảo trì' },
  { value: 'other', label: 'Khác' },
] as const

const EXPENSE_CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORIES.map((c) => [c.value, c.label]),
)

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

const PROFIT_PAGE_SIZE = 20
const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh'

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}


const formatCurrency = (value: number) => `${Math.round(value || 0).toLocaleString('vi-VN')}đ`

const formatDate = (value: string) => formatDateInTimeZone(value, REPORT_TIME_ZONE)


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


export function Reports() {
  const { token } = useAuth()

  const [tab, setTab] = useState<ReportTab>('revenue')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [revenueData, setRevenueData] = useState<RevenueReportData | null>(null)
  const [profitGroupBy, setProfitGroupBy] = useState<ProfitBreakdownGroup>('invoice')
  const [profitData, setProfitData] = useState<ProfitReportData | null>(null)
  const [inventoryData, setInventoryData] = useState<InventoryReportData | null>(null)
  const [debtData, setDebtData] = useState<DebtReportData | null>(null)
  const [customerData, setCustomerData] = useState<CustomerReportData | null>(null)

  // Expense management state
  const [expenses, setExpenses] = useState<OperatingExpense[]>([])
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [editingExpense, setEditingExpense] = useState<OperatingExpense | null>(null)
  const [expenseForm, setExpenseForm] = useState<CreateExpensePayload>({
    category: 'electricity',
    name: '',
    amount: 0,
    expense_date: '',
    note: '',
  })
  const [expenseSaving, setExpenseSaving] = useState(false)


  const loadRevenueReport = useCallback(
    async (accessToken: string) => {
      const data = await reportApi.getRevenueSummary(accessToken, {
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      })
      setRevenueData({
        invoiceCount: data.invoice_count,
        canceledCount: data.cancelled_count,
        totalAmount: data.total_amount,
        paidAmount: data.paid_amount,
        debtAmount: data.debt_amount,
        averageAmount: data.average_amount,
        dailyRows: data.daily_rows.map((r) => ({
          date: r.date,
          invoiceCount: r.invoice_count,
          totalAmount: r.total_amount,
          paidAmount: r.paid_amount,
          debtAmount: r.debt_amount,
        })),
        paymentRows: data.payment_rows.map((r) => ({
          method: r.method,
          invoiceCount: r.invoice_count,
          amount: r.amount,
        })),
        debtInvoices: data.debt_invoices.map((r) => ({
          code: r.code,
          customerName: r.customer_name,
          createdAt: r.created_at,
          debtAmount: r.debt_amount,
        })),
      })
    },
    [dateFrom, dateTo],
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

      // Load expense list (non-blocking - runs in parallel)
      storeApi.listExpenses(accessToken, {
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      }).then((res) => setExpenses(res.items ?? []))
        .catch(() => setExpenses([]))
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
      const data = await reportApi.getDebtSummary(accessToken, {
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      })
      setDebtData({
        customerDebtTotal: data.customer_debt_total,
        supplierDebtTotal: data.supplier_debt_total,
        debtInvoiceRows: data.debt_invoice_rows.map((r) => ({
          code: r.code,
          customerName: r.customer_name,
          createdAt: r.created_at,
          debtAmount: r.debt_amount,
        })),
        supplierRows: data.supplier_rows.map((r) => ({
          name: r.name,
          phone: r.phone,
          debtAmount: r.debt_amount,
        })),
      })
    },
    [dateFrom, dateTo],
  )

  const loadCustomerReport = useCallback(
    async (accessToken: string) => {
      const data = await reportApi.getCustomerSummary(accessToken, {
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      })
      setCustomerData({
        totalCustomers: data.total_customers,
        activeCustomers: data.active_customers,
        newCustomers: data.new_customers,
        totalPoints: data.total_points,
        totalSpent: data.total_spent,
        topSpenders: data.top_spenders,
      rows: data.rows,
      })
    },
    [dateFrom, dateTo],
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

  useEffect(() => {
    storeApi.getInfo().then(setStoreInfo).catch(() => null)
  }, [])

  const getExportData = useCallback(() => {
    const dateKey = new Date().toISOString().slice(0, 10)

    if (tab === 'revenue' && revenueData) {
      return {
        filename: `bao-cao-doanh-thu-${dateKey}`,
        sheetName: 'Doanh thu',
        title: 'Báo cáo doanh thu',
        headers: ['Ngày', 'Số hóa đơn', 'Doanh thu', 'Thu thực tế', 'Còn nợ'],
        rows: revenueData.dailyRows.map((item) => [
          item.date,
          item.invoiceCount,
          Math.round(item.totalAmount),
          Math.round(item.paidAmount),
          Math.round(item.debtAmount),
        ]),
      }
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
      return {
        filename: `bao-cao-ton-kho-${dateKey}`,
        sheetName: 'Tồn kho',
        title: 'Báo cáo tồn kho',
        headers: ['Mã thuốc', 'Tên thuốc', 'Nhóm', 'Tồn', 'Đơn vị', 'HSD gần nhất', 'Trạng thái'],
        rows: inventoryData.rows.map((item) => [
          item.drug_code,
          item.drug_name,
          item.drug_group,
          item.total_qty,
          item.base_unit,
          item.nearest_expiry || '-',
          stockStatusLabel(item.status),
        ]),
      }
    }

    if (tab === 'debt' && debtData) {
      return {
        filename: `bao-cao-cong-no-${dateKey}`,
        sheetName: 'Công nợ',
        title: 'Báo cáo công nợ',
        headers: ['Loại công nợ', 'Mã/Đối tượng', 'Ngày', 'Giá trị'],
        rows: [
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
        ],
      }
    }

    if (tab === 'customer' && customerData) {
      return {
        filename: `bao-cao-khach-hang-${dateKey}`,
        sheetName: 'Khách hàng',
        title: 'Báo cáo khách hàng',
        headers: ['Mã KH', 'Tên khách hàng', 'Số điện thoại', 'Hạng', 'Tổng đơn', 'Tổng chi', 'Điểm hiện tại', 'Ngày tạo'],
        rows: customerData.rows.map((item) => [
          item.code,
          item.name,
          item.phone,
          item.tier,
          item.total_orders,
          Math.round(toNumber(item.total_spent)),
          item.current_points,
          formatDate(item.created_at),
        ]),
      }
    }

    return null
  }, [customerData, debtData, inventoryData, profitData, profitGroupBy, revenueData, tab])

  const exportCurrentTabExcel = useCallback(() => {
    const data = getExportData()
    if (data) exportToExcel(data.filename, data.sheetName, data.headers, data.rows)
  }, [getExportData])

  const exportCurrentTabPdf = useCallback(() => {
    const data = getExportData()
    if (data) {
      void exportToPdf(data.filename, data.title, data.headers, data.rows, {
        storeHeader: storeInfo
          ? { name: storeInfo.name, address: storeInfo.address, phone: storeInfo.phone }
          : undefined,
      })
    }
  }, [getExportData, storeInfo])

  const exportCurrentTabCsv = useCallback(() => {
    const data = getExportData()
    if (data) downloadCsv(`${data.filename}.csv`, data.headers, data.rows)
  }, [getExportData])

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
        { label: 'Lợi nhuận gộp', value: formatCurrency(profitData.summary.gross_profit) },
        { label: 'Chi phí vận hành', value: formatCurrency(profitData.summary.operating_expenses) },
        { label: 'Lợi nhuận thực', value: formatCurrency(profitData.summary.net_profit) },
        { label: 'Biên LN thực', value: `${toNumber(profitData.summary.net_margin_percent).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%` },
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
        <div className="flex gap-1.5">
          {/* Mobile: single dropdown */}
          <div className="relative sm:hidden">
            <button
              type="button"
              onClick={() => setExportMenuOpen((o) => !o)}
              className="flex items-center gap-1 rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
            >
              Xuất
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`}>
                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
              </svg>
            </button>
            {exportMenuOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-2xl border border-ink-900/10 bg-white py-1 shadow-lift">
                <button type="button" onClick={() => { exportCurrentTabCsv(); setExportMenuOpen(false) }} className="w-full px-4 py-2 text-left text-sm text-ink-700 hover:bg-fog-50">CSV</button>
                <button type="button" onClick={() => { exportCurrentTabExcel(); setExportMenuOpen(false) }} className="w-full px-4 py-2 text-left text-sm text-ink-700 hover:bg-fog-50">Excel</button>
                <button type="button" onClick={() => { exportCurrentTabPdf(); setExportMenuOpen(false) }} className="w-full px-4 py-2 text-left text-sm text-ink-700 hover:bg-fog-50">PDF</button>
              </div>
            ) : null}
          </div>
          {/* Desktop: 3 separate buttons */}
          <button
            type="button"
            onClick={exportCurrentTabCsv}
            className="hidden rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 sm:block"
          >
            Xuất CSV
          </button>
          <button
            type="button"
            onClick={exportCurrentTabExcel}
            className="hidden rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 sm:block"
          >
            Xuất Excel
          </button>
          <button
            type="button"
            onClick={exportCurrentTabPdf}
            className="hidden rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white sm:block"
          >
            Xuất PDF
          </button>
        </div>
      </header>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${tab === item.id
                  ? 'bg-ink-900 text-white'
                  : 'border border-ink-900/10 bg-white text-ink-700'
                }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'profit' ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
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
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${profitGroupBy === groupId
                    ? 'bg-sky-100 text-sky-700'
                    : 'border border-ink-900/10 bg-white text-ink-700'
                  }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-[1fr,1fr,auto,auto]">
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
            onClick={() => { void loadReport(tab) }}
            className="col-span-1 rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white md:col-auto"
          >
            Áp dụng
          </button>
          <button
            type="button"
            onClick={() => {
              setDateFrom('')
              setDateTo('')
              window.setTimeout(() => { void loadReport(tab) }, 0)
            }}
            className="col-span-1 rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900 md:col-auto"
          >
            Reset
          </button>
        </div>

        {tab === 'inventory' ? (
          <p className="text-xs text-ink-500">Báo cáo tồn kho không áp dụng lọc thời gian.</p>
        ) : null}
      </section>

      {summaryCards.length > 0 ? (
        <section className={`grid gap-4 sm:grid-cols-2 ${tab === 'profit' ? 'xl:grid-cols-3' : 'xl:grid-cols-4'}`}>
          {summaryCards.map((item) => (
            <article key={item.label} className="glass-card rounded-3xl p-5">
              <p className="text-xs uppercase tracking-[0.25em] text-ink-600">{item.label}</p>
              <p className={`mt-3 text-2xl font-semibold ${item.label === 'Lợi nhuận thực' ? (profitData && profitData.summary.net_profit >= 0 ? 'text-emerald-600' : 'text-coral-500') : 'text-ink-900'}`}>
                {item.value}
              </p>
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
            {/* Mobile cards */}
            <div className="mt-4 space-y-2 sm:hidden">
              {revenueData.dailyRows.slice(0, 20).map((row) => (
                <div key={row.date} className="flex items-center justify-between rounded-xl border border-ink-900/10 bg-white/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{formatDate(row.date)}</p>
                    <p className="text-xs text-ink-500">{row.invoiceCount} hóa đơn</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-ink-900">{formatCurrency(row.totalAmount)}</p>
                    {row.debtAmount > 0 ? (
                      <p className="text-xs text-coral-500">Nợ {formatCurrency(row.debtAmount)}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="mt-4 hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
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
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Mã HĐ</th>
                      <th className="py-2">Ngày</th>
                      <th className="hidden py-2 sm:table-cell">Khách hàng</th>
                      <th className="hidden py-2 sm:table-cell">Doanh thu thuần</th>
                      <th className="hidden py-2 md:table-cell">Giá vốn</th>
                      <th className="py-2">Lợi nhuận</th>
                      <th className="hidden py-2 md:table-cell">Lời thực thu</th>
                      <th className="py-2">Còn nợ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(profitData.breakdown.items as ProfitInvoiceBreakdownRow[]).map((row) => (
                      <tr key={row.invoice_id} className="border-t border-ink-900/5">
                        <td className="py-2 font-semibold text-ink-900">{row.invoice_code}</td>
                        <td className="py-2">{formatDate(row.created_at)}</td>
                        <td className="hidden py-2 sm:table-cell">{row.customer_name || 'Khách vãng lai'}</td>
                        <td className="hidden py-2 sm:table-cell">{formatCurrency(row.net_revenue)}</td>
                        <td className="hidden py-2 md:table-cell">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="hidden py-2 md:table-cell">{formatCurrency(row.collected_profit)}</td>
                        <td className="py-2 text-coral-500">{formatCurrency(row.debt_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : profitGroupBy === 'product' ? (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Mã thuốc</th>
                      <th className="py-2">Tên thuốc</th>
                      <th className="py-2">SL bán</th>
                      <th className="hidden py-2 sm:table-cell">Doanh thu thuần</th>
                      <th className="hidden py-2 sm:table-cell">Giá vốn</th>
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
                        <td className="hidden py-2 sm:table-cell">{formatCurrency(row.net_revenue)}</td>
                        <td className="hidden py-2 sm:table-cell">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="py-2">{toNumber(row.margin_percent).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    <tr>
                      <th className="py-2">Kỳ</th>
                      <th className="py-2">Số HĐ</th>
                      <th className="py-2">Doanh thu thuần</th>
                      <th className="hidden py-2 sm:table-cell">Giá vốn</th>
                      <th className="py-2">Lợi nhuận</th>
                      <th className="hidden py-2 sm:table-cell">Lời thực thu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(profitData.breakdown.items as ProfitPeriodBreakdownRow[]).map((row) => (
                      <tr key={row.period_key} className="border-t border-ink-900/5">
                        <td className="py-2 font-semibold text-ink-900">{row.period_key}</td>
                        <td className="py-2">{row.invoice_count}</td>
                        <td className="py-2">{formatCurrency(row.net_revenue)}</td>
                        <td className="hidden py-2 sm:table-cell">{formatCurrency(row.cogs)}</td>
                        <td className="py-2 font-semibold text-emerald-600">{formatCurrency(row.gross_profit)}</td>
                        <td className="hidden py-2 sm:table-cell">{formatCurrency(row.collected_profit)}</td>
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

      {tab === 'profit' ? (
        <section className="glass-card rounded-3xl p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink-900">Chi phí vận hành</h3>
            <button
              type="button"
              onClick={() => {
                setEditingExpense(null)
                setExpenseForm({ category: 'electricity', name: '', amount: 0, expense_date: '', note: '' })
                setShowExpenseForm(true)
              }}
              className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
            >
              + Thêm chi phí
            </button>
          </div>

          {profitData && profitData.summary.expense_breakdown.length > 0 ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {profitData.summary.expense_breakdown.map((item) => (
                <div key={item.category} className="rounded-2xl border border-ink-900/10 bg-white px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-ink-600">
                    {EXPENSE_CATEGORY_LABEL[item.category] || item.category}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-ink-900">{formatCurrency(item.total_amount)}</p>
                  <p className="text-xs text-ink-500">{item.count} khoản</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-ink-500">Chưa có chi phí nào trong kỳ báo cáo.</p>
          )}

          {expenses.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.2em] text-ink-600">
                  <tr>
                    <th className="py-2">Loại</th>
                    <th className="py-2">Tên chi phí</th>
                    <th className="py-2">Số tiền</th>
                    <th className="py-2">Ngày</th>
                    <th className="hidden py-2 sm:table-cell">Ghi chú</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((item) => (
                    <tr key={item.id} className="border-t border-ink-900/5">
                      <td className="py-2">{EXPENSE_CATEGORY_LABEL[item.category] || item.category}</td>
                      <td className="py-2 font-semibold text-ink-900">{item.name}</td>
                      <td className="py-2">{formatCurrency(item.amount)}</td>
                      <td className="py-2">{formatDate(item.expense_date)}</td>
                      <td className="hidden py-2 text-ink-500 sm:table-cell">{item.note || '-'}</td>
                      <td className="py-2">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingExpense(item)
                              setExpenseForm({
                                category: item.category,
                                name: item.name,
                                amount: item.amount,
                                expense_date: item.expense_date,
                                note: item.note || '',
                              })
                              setShowExpenseForm(true)
                            }}
                            className="text-xs text-sky-600 hover:underline"
                          >
                            Sửa
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              if (!token || !confirm('Xóa chi phí này?')) return
                              try {
                                await storeApi.deleteExpense(token.access_token, item.id)
                                setExpenses((prev) => prev.filter((e) => e.id !== item.id))
                              } catch {}
                            }}
                            className="text-xs text-coral-500 hover:underline"
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {showExpenseForm ? (
            <div className="mt-4 rounded-2xl border border-ink-900/10 bg-white p-5">
              <h4 className="text-sm font-semibold text-ink-900">
                {editingExpense ? 'Cập nhật chi phí' : 'Thêm chi phí mới'}
              </h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="block text-xs text-ink-600 mb-1">Loại chi phí</label>
                  <select
                    value={expenseForm.category}
                    onChange={(e) => setExpenseForm((f) => ({ ...f, category: e.target.value }))}
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  >
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-ink-600 mb-1">Tên chi phí</label>
                  <input
                    type="text"
                    value={expenseForm.name}
                    onChange={(e) => setExpenseForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="VD: Tiền điện tháng 3"
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-ink-600 mb-1">Số tiền</label>
                  <input
                    type="number"
                    value={expenseForm.amount || ''}
                    onChange={(e) => setExpenseForm((f) => ({ ...f, amount: Number(e.target.value) || 0 }))}
                    placeholder="1500000"
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-ink-600 mb-1">Ngày</label>
                  <input
                    type="date"
                    value={expenseForm.expense_date}
                    onChange={(e) => setExpenseForm((f) => ({ ...f, expense_date: e.target.value }))}
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-ink-600 mb-1">Ghi chú</label>
                  <input
                    type="text"
                    value={expenseForm.note || ''}
                    onChange={(e) => setExpenseForm((f) => ({ ...f, note: e.target.value }))}
                    placeholder="Ghi chú tùy chọn"
                    className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={expenseSaving}
                  onClick={async () => {
                    if (!token || !expenseForm.name.trim() || !expenseForm.amount || !expenseForm.expense_date) return
                    setExpenseSaving(true)
                    try {
                      if (editingExpense) {
                        const res = await storeApi.updateExpense(token.access_token, editingExpense.id, {
                          category: expenseForm.category,
                          name: expenseForm.name,
                          amount: expenseForm.amount,
                          expense_date: expenseForm.expense_date,
                          note: expenseForm.note || undefined,
                        })
                        setExpenses((prev) => prev.map((e) => (e.id === editingExpense.id ? res.data : e)))
                      } else {
                        const res = await storeApi.createExpense(token.access_token, expenseForm)
                        setExpenses((prev) => [res.data, ...prev])
                      }
                      setShowExpenseForm(false)
                      setEditingExpense(null)
                    } catch {}
                    setExpenseSaving(false)
                  }}
                  className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {expenseSaving ? 'Đang lưu...' : editingExpense ? 'Cập nhật' : 'Lưu'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExpenseForm(false)
                    setEditingExpense(null)
                  }}
                  className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-700"
                >
                  Hủy
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'inventory' && inventoryData ? (
        <section className="glass-card rounded-3xl p-6">
          <h3 className="text-lg font-semibold text-ink-900">Chi tiết tồn kho</h3>
          {/* Mobile cards */}
          <div className="mt-4 space-y-2 sm:hidden">
            {inventoryData.rows.map((item) => (
              <div key={item.drug_id} className="rounded-xl border border-ink-900/10 bg-white/60 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{item.drug_name}</p>
                    <p className="text-xs text-ink-500">{item.drug_code} · {item.drug_group || '-'}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-ink-700">{stockStatusLabel(item.status)}</span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-ink-600">
                  <span>Tồn: <strong className="text-ink-900">{item.total_qty.toLocaleString('vi-VN')} {item.base_unit}</strong></span>
                  <span>HSD: <strong className="text-ink-900">{item.nearest_expiry ? formatDate(item.nearest_expiry) : '-'}</strong></span>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table */}
          <div className="mt-4 hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
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
            {/* Mobile cards */}
            <div className="mt-4 space-y-2 sm:hidden">
              {debtData.debtInvoiceRows.map((item) => (
                <div key={item.code} className="flex items-center justify-between rounded-xl border border-ink-900/10 bg-white/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{item.code}</p>
                    <p className="text-xs text-ink-500">{item.customerName} · {formatDate(item.createdAt)}</p>
                  </div>
                  <p className="text-sm font-semibold text-coral-500">{formatCurrency(item.debtAmount)}</p>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="mt-4 hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
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
            {/* Mobile cards */}
            <div className="mt-4 space-y-2 sm:hidden">
              {debtData.supplierRows.map((item) => (
                <div key={`${item.name}-${item.phone}`} className="flex items-center justify-between rounded-xl border border-ink-900/10 bg-white/60 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-900">{item.name}</p>
                    <p className="text-xs text-ink-500">{item.phone}</p>
                  </div>
                  <p className="text-sm font-semibold text-coral-500">{formatCurrency(item.debtAmount)}</p>
                </div>
              ))}
            </div>
            {/* Desktop table */}
            <div className="mt-4 hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
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
          {/* Mobile cards */}
          <div className="mt-4 space-y-2 sm:hidden">
            {customerData.topSpenders.map((item) => (
              <div key={item.id} className="rounded-xl border border-ink-900/10 bg-white/60 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{item.name}</p>
                    <p className="text-xs text-ink-500">{item.code} · {item.phone}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">{item.tier}</span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-ink-600">
                  <span>{item.total_orders.toLocaleString('vi-VN')} đơn</span>
                  <span className="font-semibold text-ink-900">{formatCurrency(toNumber(item.total_spent))}</span>
                  <span>{item.current_points.toLocaleString('vi-VN')} điểm</span>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table */}
          <div className="mt-4 hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
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
