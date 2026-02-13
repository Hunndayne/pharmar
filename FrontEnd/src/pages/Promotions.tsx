import { useState } from 'react'

type Promotion = {
  id: string
  name: string
  type: 'discount' | 'buy_get'
  value: string
  startDate: string
  endDate: string
  active: boolean
}

const initialPromotions: Promotion[] = [
  {
    id: 'pr1',
    name: 'Giảm 10% nhóm vitamin',
    type: 'discount',
    value: '10%',
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    active: true,
  },
  {
    id: 'pr2',
    name: 'Panadol mua 10 tặng 1',
    type: 'buy_get',
    value: 'Mua 10 tặng 1',
    startDate: '2026-02-05',
    endDate: '2026-03-05',
    active: true,
  },
]

const formatDate = (value: string) => {
  const [y, m, d] = value.split('-')
  if (!y || !m || !d) return value
  return `${d}/${m}/${y}`
}

export function Promotions() {
  const [rows, setRows] = useState(initialPromotions)

  const toggleStatus = (id: string) => {
    setRows((prev) => prev.map((item) => (item.id === id ? { ...item, active: !item.active } : item)))
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Marketing</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Khuyến mãi</h2>
        </div>
        <button
          type="button"
          className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift"
        >
          Tạo chương trình
        </button>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="min-w-[920px] w-full text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.24em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Tên chương trình</th>
                <th className="px-6 py-4">Loại</th>
                <th className="px-6 py-4">Giá trị</th>
                <th className="px-6 py-4">Thời gian</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.name}</td>
                  <td className="px-6 py-4 text-ink-700">{item.type === 'discount' ? 'Giảm giá' : 'Mua tặng'}</td>
                  <td className="px-6 py-4 text-ink-700">{item.value}</td>
                  <td className="px-6 py-4 text-ink-700">
                    {formatDate(item.startDate)} - {formatDate(item.endDate)}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        item.active
                          ? 'border border-brand-500/30 bg-brand-500/15 text-brand-600'
                          : 'border border-ink-600/20 bg-ink-600/10 text-ink-600'
                      }`}
                    >
                      {item.active ? 'Đang áp dụng' : 'Tạm dừng'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      type="button"
                      onClick={() => toggleStatus(item.id)}
                      className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                    >
                      {item.active ? 'Tạm dừng' : 'Kích hoạt'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
