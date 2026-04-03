import * as XLSX from 'xlsx-js-style'
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

export type InvoiceExcelData = {
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
    lineTotal: number
  }>
  subtotal: number
  discountTotal: number
  total: number
  amountPaid: number
  changeAmount: number
  paymentMethod: string
}

export const exportInvoiceExcel = (data: InvoiceExcelData) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Cell = { v: any; t: string; s?: Record<string, unknown> }
  const font = (name = 'Times New Roman', sz = 11, bold = false, italic = false) =>
    ({ name, sz, bold, italic })
  const alignment = (horizontal: string, vertical = 'center') =>
    ({ horizontal, vertical, wrapText: false })
  const border = (style = 'thin') => ({
    top: { style }, bottom: { style }, left: { style }, right: { style },
  })

  const storeNameStyle = { font: font('Times New Roman', 16, true, true), alignment: alignment('center') }
  const addressStyle = { font: font('Times New Roman', 11, false, true), alignment: alignment('center') }
  const titleStyle = { font: font('Times New Roman', 14, true), alignment: alignment('center') }
  const labelStyle = { font: font('Times New Roman', 11), alignment: alignment('left') }
  const valStyle = { font: font('Times New Roman', 11), alignment: alignment('left') }
  const thStyle = { font: font('Times New Roman', 11, true), alignment: alignment('left'), border: border() }
  const thRightStyle = { font: font('Times New Roman', 11, true), alignment: alignment('right'), border: border() }
  const tdStyle = { font: font('Times New Roman', 11), alignment: alignment('left'), border: border() }
  const tdRightStyle = { font: font('Times New Roman', 11), alignment: alignment('right'), border: border() }
  const sumLabelStyle = { font: font('Times New Roman', 11), alignment: alignment('right') }
  const sumValStyle = { font: font('Times New Roman', 11), alignment: alignment('right') }
  const sigStyle = { font: font('Times New Roman', 11, true), alignment: alignment('center') }

  // Build rows as styled cells
  const wsRows: Cell[][] = []

  // Row 0: Store name (merged A-E)
  wsRows.push([
    { v: data.storeName, t: 's', s: storeNameStyle },
    { v: '', t: 's', s: storeNameStyle },
    { v: '', t: 's', s: storeNameStyle },
    { v: '', t: 's', s: storeNameStyle },
    { v: '', t: 's', s: storeNameStyle },
  ])
  // Row 1: Address (merged A-E)
  wsRows.push([
    { v: data.storeAddress ? `Địa chỉ: ${data.storeAddress}` : '', t: 's', s: addressStyle },
    { v: '', t: 's', s: addressStyle },
    { v: '', t: 's', s: addressStyle },
    { v: '', t: 's', s: addressStyle },
    { v: '', t: 's', s: addressStyle },
  ])
  // Row 2: SDT
  wsRows.push([
    { v: '', t: 's' }, { v: '', t: 's' },
    { v: 'SDT:', t: 's', s: { font: font('Times New Roman', 11), alignment: alignment('right') } },
    { v: data.storePhone ?? '', t: 's', s: valStyle },
    { v: '', t: 's' },
  ])
  // Row 3: Title (merged A-E)
  wsRows.push([
    { v: 'HÓA ĐƠN BÁN HÀNG', t: 's', s: titleStyle },
    { v: '', t: 's', s: titleStyle },
    { v: '', t: 's', s: titleStyle },
    { v: '', t: 's', s: titleStyle },
    { v: '', t: 's', s: titleStyle },
  ])
  // Row 4: empty
  wsRows.push([{ v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }])
  // Row 5: Invoice code + date
  wsRows.push([
    { v: 'Mã hóa đơn:', t: 's', s: labelStyle },
    { v: data.invoiceCode, t: 's', s: valStyle },
    { v: 'Ngày bán hàng:', t: 's', s: labelStyle },
    { v: data.createdAt, t: 's', s: valStyle },
    { v: '', t: 's' },
  ])
  // Row 6: Customer + phone
  wsRows.push([
    { v: 'Tên khách hàng:', t: 's', s: labelStyle },
    { v: data.customerName ?? '', t: 's', s: valStyle },
    { v: 'Số điện thoại:', t: 's', s: labelStyle },
    { v: data.customerPhone ?? '', t: 's', s: valStyle },
    { v: '', t: 's' },
  ])
  // Row 7-8: empty
  wsRows.push([{ v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }])
  wsRows.push([{ v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }])
  // Row 9: Table headers
  wsRows.push([
    { v: 'Sản phẩm', t: 's', s: thStyle },
    { v: 'Đơn vị', t: 's', s: thStyle },
    { v: 'Số lượng', t: 's', s: thRightStyle },
    { v: 'Đơn giá', t: 's', s: thRightStyle },
    { v: 'Thành tiền', t: 's', s: thRightStyle },
  ])
  // Item rows
  for (const item of data.items) {
    wsRows.push([
      { v: item.name, t: 's', s: tdStyle },
      { v: item.unit, t: 's', s: tdStyle },
      { v: item.quantity, t: 'n', s: tdRightStyle },
      { v: item.unitPrice, t: 'n', s: tdRightStyle },
      { v: item.lineTotal, t: 'n', s: tdRightStyle },
    ])
  }
  // Empty row
  wsRows.push([{ v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }])
  // Summary rows
  const summaryLines: [string, number | string][] = [
    ['Tạm tính:', data.subtotal],
    ['Giảm giá:', data.discountTotal],
    ['Tổng cộng:', data.total],
    ['Đã thanh toán:', data.amountPaid],
    ['Tiền thừa:', data.changeAmount],
    ['Phương thức thanh toán:', data.paymentMethod],
  ]
  for (const [label, val] of summaryLines) {
    wsRows.push([
      { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' },
      { v: label, t: 's', s: sumLabelStyle },
      typeof val === 'number'
        ? { v: val, t: 'n', s: sumValStyle }
        : { v: val, t: 's', s: sumValStyle },
    ])
  }
  // Empty row
  wsRows.push([{ v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }, { v: '', t: 's' }])
  // Signature row
  wsRows.push([
    { v: 'Người mua hàng', t: 's', s: sigStyle },
    { v: '', t: 's' }, { v: '', t: 's' },
    { v: 'Người bán hàng', t: 's', s: sigStyle },
    { v: '', t: 's' },
  ])

  // Build worksheet from cell objects
  const ws: XLSX.WorkSheet = {}
  const totalRows = wsRows.length
  const totalCols = 5
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalRows - 1, c: totalCols - 1 } })

  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < totalCols; c++) {
      const cell = wsRows[r]?.[c]
      if (cell) {
        ws[XLSX.utils.encode_cell({ r, c })] = cell
      }
    }
  }

  // Merges
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },  // Store name
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },  // Address
    { s: { r: 3, c: 0 }, e: { r: 3, c: 4 } },  // Title
  ]

  // Column widths
  ws['!cols'] = [
    { wch: 28 },
    { wch: 10 },
    { wch: 10 },
    { wch: 24 },
    { wch: 15 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `HĐ ${data.invoiceCode}`)
  XLSX.writeFile(wb, `hoa-don-${data.invoiceCode}.xlsx`)
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
