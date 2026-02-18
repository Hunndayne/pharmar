import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'

export type LabelPrintLot = {
  id: string
  qrValue: string
  code: string
  lotNumber?: string
  productName: string
  price: number
  defaultCount: number
}

type LotLabelPrintPageProps = {
  title: string
  subtitle: string
  storeName: string
  printerName?: string
  labelWidthMm: number
  labelHeightMm: number
  lots: LabelPrintLot[]
  onBack: () => void
  backLabel?: string
}

const sanitizeDigits = (value: string) => value.replace(/\D+/g, '')
const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')}đ`
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function LotLabelPrintPage({
  title,
  subtitle,
  storeName,
  printerName = 'Clabel 211B',
  labelWidthMm,
  labelHeightMm,
  lots,
  onBack,
  backLabel = 'Quay lại',
}: LotLabelPrintPageProps) {
  const normalizedLots = useMemo(
    () =>
      lots.map((lot) => ({
        ...lot,
        defaultCount: Math.max(1, Math.floor(lot.defaultCount || 1)),
      })),
    [lots]
  )

  const [counts, setCounts] = useState<Record<string, string>>({})
  const [printError, setPrintError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    const nextCounts: Record<string, string> = {}
    normalizedLots.forEach((lot) => {
      nextCounts[lot.id] = String(lot.defaultCount)
    })
    setCounts(nextCounts)
    setPrintError(null)
  }, [normalizedLots])

  const getPrintCount = (lot: LabelPrintLot) => {
    const raw = counts[lot.id] ?? ''
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return lot.defaultCount
    return Math.max(0, Math.floor(parsed))
  }

  const printLots = async (targetLots: LabelPrintLot[]) => {
    setPrintError(null)
    const selectedLots = targetLots
      .map((lot) => ({
        lot,
        count: getPrintCount(lot),
      }))
      .filter((item) => item.count > 0)

    if (!selectedLots.length) {
      setPrintError('Số tem in phải lớn hơn 0.')
      return
    }

    setPrinting(true)
    try {
      const qrByLot = new Map<string, string>()
      for (const { lot } of selectedLots) {
        const qrDataUrl = await QRCode.toDataURL(lot.qrValue, {
          width: 980,
          margin: 0,
          errorCorrectionLevel: 'M',
        })
        qrByLot.set(lot.id, qrDataUrl)
      }

      const labelsHtml = selectedLots
        .flatMap(({ lot, count }) => {
          const qrDataUrl = qrByLot.get(lot.id) ?? ''
          const priceText = formatCurrency(lot.price)
          return Array.from({ length: count }, () => `
            <section class="label">
              <div class="qr-wrap">
                <img class="qr" src="${qrDataUrl}" alt="QR ${escapeHtml(lot.code)}" />
              </div>
              <div class="content">
                <div class="store">${escapeHtml(storeName)}</div>
                <div class="drug">${escapeHtml(lot.productName)}</div>
                <div class="price">${escapeHtml(priceText)}</div>
              </div>
            </section>
          `)
        })
        .join('')

      const html = `
        <!doctype html>
        <html lang="vi">
          <head>
            <meta charset="utf-8" />
            <title>In nhãn QR lô</title>
            <style>
              @page {
                size: ${labelWidthMm}mm ${labelHeightMm}mm;
                margin: 0;
              }
              * { box-sizing: border-box; }
              html, body {
                margin: 0;
                padding: 0;
                font-family: "Segoe UI", Arial, sans-serif;
                background: #fff;
              }
              .label {
                width: ${labelWidthMm}mm;
                height: ${labelHeightMm}mm;
                padding: 1.2mm 1.2mm 1.2mm 0.7mm;
                page-break-after: always;
                display: grid;
                grid-template-columns: 14.5mm 1fr;
                align-items: center;
                gap: 0mm;
                overflow: hidden;
              }
              .qr-wrap {
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 0;
                border-radius: 0;
                padding: 0;
              }
              .content {
                min-width: 0;
                height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 0.8mm;
                padding-left: 0.6mm;
              }
              .store {
                width: 100%;
                text-align: left;
                font-size: 2.3mm;
                font-weight: 700;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .drug {
                width: 100%;
                text-align: left;
                font-size: 2.7mm;
                font-weight: 600;
                line-height: 1.1;
                overflow: hidden;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
              }
              .qr {
                width: 11.8mm;
                height: 11.8mm;
                display: block;
                object-fit: contain;
                image-rendering: crisp-edges;
              }
              .price {
                width: 100%;
                text-align: left;
                font-size: 2.9mm;
                font-weight: 800;
                line-height: 1.15;
              }
            </style>
          </head>
          <body>
            ${labelsHtml}
          </body>
        </html>
      `

      const printWindow = window.open('', '_blank', 'width=760,height=420')
      if (!printWindow) {
        setPrintError('Trình duyệt đang chặn cửa sổ in. Hãy bật popup và thử lại.')
        return
      }
      printWindow.document.open()
      printWindow.document.write(html)
      printWindow.document.close()
      printWindow.focus()
      setTimeout(() => {
        printWindow.print()
        printWindow.close()
      }, 350)
    } catch {
      setPrintError('Không thể tạo tem QR để in. Vui lòng thử lại.')
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 tablet:flex-row tablet:items-center tablet:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Xác nhận in nhãn</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">{title}</h2>
          <p className="mt-2 text-sm text-ink-600">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => printLots(normalizedLots)}
            disabled={printing}
            className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift disabled:opacity-60"
          >
            {printing ? 'Đang xử lý...' : 'In tất cả tem'}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-full border border-ink-900/10 bg-white/80 px-5 py-2 text-sm font-semibold text-ink-900"
          >
            {backLabel}
          </button>
        </div>
      </header>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Nhà thuốc</p>
            <p className="mt-2 font-semibold text-ink-900">{storeName}</p>
          </div>
          <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Máy in dự kiến</p>
            <p className="mt-2 font-semibold text-ink-900">{printerName}</p>
          </div>
          <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm text-ink-700">
            <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Kích thước tem</p>
            <p className="mt-2 font-semibold text-ink-900">{labelWidthMm}mm x {labelHeightMm}mm (ngang)</p>
          </div>
        </div>

        {printError ? <p className="text-sm text-coral-500">{printError}</p> : null}

        <div className="space-y-3">
          {normalizedLots.map((lot) => {
            const printCount = counts[lot.id] ?? String(lot.defaultCount)
            return (
              <div key={lot.id} className="rounded-2xl bg-white p-4">
                <div className="grid gap-3 md:grid-cols-[1.2fr,1fr,1fr,1fr,auto] md:items-end">
                  <div>
                    <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Mã lô</p>
                    <p className="mt-1 text-sm font-semibold text-ink-900">{lot.code}</p>
                    <p className="text-xs text-ink-600">{lot.productName}{lot.lotNumber ? ` · ${lot.lotNumber}` : ''}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Số lượng gợi ý</p>
                    <p className="mt-1 text-sm font-semibold text-ink-900">{lot.defaultCount.toLocaleString('vi-VN')}</p>
                  </div>
                  <label className="space-y-1 text-xs text-ink-600">
                    Số tem in
                    <input
                      value={printCount}
                      onChange={(event) =>
                        setCounts((prev) => ({ ...prev, [lot.id]: sanitizeDigits(event.target.value) }))
                      }
                      className="w-full rounded-xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-900"
                    />
                  </label>
                  <div>
                    <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Giá trên tem</p>
                    <p className="mt-1 text-sm font-semibold text-ink-900">{formatCurrency(lot.price)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => printLots([lot])}
                    disabled={printing}
                    className="rounded-full border border-ink-900/10 bg-white/80 px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
                  >
                    In tem lô
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
