import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

export type ExportValue = string | number | boolean | null | undefined

// ── Excel Export ─────────────────────────────────────────────────────────────

export const exportToExcel = (
  filename: string,
  sheetName: string,
  headers: string[],
  rows: ExportValue[][],
) => {
  const data = [headers, ...rows]
  const worksheet = XLSX.utils.aoa_to_sheet(data)

  // Auto-width columns
  const colWidths = headers.map((h, i) => {
    let maxLen = h.length
    for (const row of rows) {
      const cellLen = String(row[i] ?? '').length
      if (cellLen > maxLen) maxLen = cellLen
    }
    return { wch: Math.min(maxLen + 2, 50) }
  })
  worksheet['!cols'] = colWidths

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
}

// ── PDF Export ───────────────────────────────────────────────────────────────

export type PdfExportOptions = {
  orientation?: 'portrait' | 'landscape'
  subtitle?: string
  footerText?: string
}

export const exportToPdf = (
  filename: string,
  title: string,
  headers: string[],
  rows: ExportValue[][],
  options?: PdfExportOptions,
) => {
  const orientation = options?.orientation ?? 'landscape'
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' })

  // Title
  doc.setFontSize(16)
  doc.text(title, 14, 15)

  if (options?.subtitle) {
    doc.setFontSize(10)
    doc.text(options.subtitle, 14, 22)
  }

  const startY = options?.subtitle ? 28 : 22

  // Table
  autoTable(doc, {
    head: [headers],
    body: rows.map((row) => row.map((cell) => String(cell ?? ''))),
    startY,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [41, 41, 41], textColor: 255, fontSize: 8 },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    margin: { left: 14, right: 14 },
  })

  // Footer
  if (options?.footerText) {
    const pageCount = doc.getNumberOfPages()
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i)
      doc.setFontSize(8)
      doc.text(options.footerText, 14, doc.internal.pageSize.height - 10)
      doc.text(`Trang ${i}/${pageCount}`, doc.internal.pageSize.width - 30, doc.internal.pageSize.height - 10)
    }
  }

  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`)
}

// ── Invoice PDF Export ───────────────────────────────────────────────────────

export type InvoicePdfData = {
  storeName: string
  storeAddress?: string
  storePhone?: string
  invoiceCode: string
  createdAt: string
  cashierName?: string
  customerName?: string
  customerPhone?: string
  items: Array<{
    name: string
    unit: string
    quantity: number
    unitPrice: number
    discount: number
    lineTotal: number
  }>
  subtotal: number
  discountTotal: number
  total: number
  amountPaid: number
  changeAmount: number
  paymentMethod: string
}

export const exportInvoicePdf = (data: InvoicePdfData) => {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [80, 200] })

  let y = 8
  const centerX = 40

  // Store header
  doc.setFontSize(10)
  doc.text(data.storeName, centerX, y, { align: 'center' })
  y += 4
  if (data.storeAddress) {
    doc.setFontSize(7)
    doc.text(data.storeAddress, centerX, y, { align: 'center' })
    y += 3
  }
  if (data.storePhone) {
    doc.text(`DT: ${data.storePhone}`, centerX, y, { align: 'center' })
    y += 3
  }

  // Invoice title
  y += 2
  doc.setFontSize(11)
  doc.text('HOA DON BAN HANG', centerX, y, { align: 'center' })
  y += 5

  // Invoice info
  doc.setFontSize(7)
  doc.text(`Ma HD: ${data.invoiceCode}`, 4, y)
  y += 3
  doc.text(`Ngay: ${data.createdAt}`, 4, y)
  y += 3
  if (data.cashierName) {
    doc.text(`Thu ngan: ${data.cashierName}`, 4, y)
    y += 3
  }
  if (data.customerName) {
    doc.text(`Khach hang: ${data.customerName}`, 4, y)
    y += 3
  }

  // Items table
  y += 1
  doc.line(4, y, 76, y)
  y += 3

  autoTable(doc, {
    startY: y,
    head: [['STT', 'San pham', 'SL', 'Don gia', 'T.Tien']],
    body: data.items.map((item, i) => [
      i + 1,
      item.name,
      item.quantity,
      Math.round(item.unitPrice).toLocaleString('vi-VN'),
      Math.round(item.lineTotal).toLocaleString('vi-VN'),
    ]),
    styles: { fontSize: 6, cellPadding: 1 },
    headStyles: { fillColor: [255, 255, 255], textColor: 0, fontSize: 6, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 6 },
      1: { cellWidth: 30 },
      2: { cellWidth: 7, halign: 'right' },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 15, halign: 'right' },
    },
    margin: { left: 4, right: 4 },
    tableWidth: 72,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable?.finalY ?? y + 20
  y += 2
  doc.line(4, y, 76, y)
  y += 4

  // Totals
  const fmt = (v: number) => Math.round(v).toLocaleString('vi-VN')
  doc.setFontSize(7)
  doc.text(`Tam tinh: ${fmt(data.subtotal)}`, 76, y, { align: 'right' })
  y += 3
  if (data.discountTotal > 0) {
    doc.text(`Giam gia: -${fmt(data.discountTotal)}`, 76, y, { align: 'right' })
    y += 3
  }
  doc.setFontSize(9)
  doc.text(`TONG CONG: ${fmt(data.total)}`, 76, y, { align: 'right' })
  y += 4
  doc.setFontSize(7)
  doc.text(`Thanh toan: ${fmt(data.amountPaid)}`, 76, y, { align: 'right' })
  y += 3
  doc.text(`Tien thua: ${fmt(data.changeAmount)}`, 76, y, { align: 'right' })
  y += 5

  doc.text('Cam on quy khach!', centerX, y, { align: 'center' })

  doc.save(`hoa-don-${data.invoiceCode}.pdf`)
}
