import { useMemo, useState } from 'react'

type ReportTab = 'revenue' | 'inventory' | 'debt' | 'customer'

const tabs: { id: ReportTab; label: string }[] = [
  { id: 'revenue', label: 'Doanh thu' },
  { id: 'inventory', label: 'Tồn kho' },
  { id: 'debt', label: 'Công nợ' },
  { id: 'customer', label: 'Khách hàng' },
]

export function Reports() {
  const [tab, setTab] = useState<ReportTab>('revenue')

  const content = useMemo(() => {
    switch (tab) {
      case 'revenue':
        return 'Báo cáo doanh thu theo ngày/tuần/tháng, so sánh kỳ trước.'
      case 'inventory':
        return 'Báo cáo tồn kho, thuốc cận date, xuất PDF/Excel.'
      case 'debt':
        return 'Báo cáo công nợ nhà phân phối, lịch sử thanh toán.'
      case 'customer':
        return 'Báo cáo khách hàng mới, khách hàng quay lại, top khách hàng.'
      default:
        return ''
    }
  }, [tab])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Thống kê</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Báo cáo</h2>
        </div>
        <div className="flex gap-2">
          <button className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900">
            Export Excel
          </button>
          <button className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
            Export PDF
          </button>
        </div>
      </header>

      <section className="glass-card rounded-3xl p-6">
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

        <div className="mt-6 rounded-2xl border border-ink-900/10 bg-white p-6">
          <p className="text-sm text-ink-700">{content}</p>
          <p className="mt-4 text-xs text-ink-500">
            Khung báo cáo đã sẵn sàng để nối API report-service.
          </p>
        </div>
      </section>
    </div>
  )
}
