import { useState } from 'react'

type Customer = {
  id: string
  code: string
  name: string
  phone: string
  rank: 'Đồng' | 'Bạc' | 'Vàng' | 'Kim cương'
  points: number
  lastPurchase: string
}

const initialRows: Customer[] = [
  {
    id: 'c1',
    code: 'KH0001',
    name: 'Nguyễn Lan',
    phone: '0901234567',
    rank: 'Vàng',
    points: 6800,
    lastPurchase: '12/02/2026',
  },
  {
    id: 'c2',
    code: 'KH0002',
    name: 'Trần Minh',
    phone: '0919888777',
    rank: 'Bạc',
    points: 2100,
    lastPurchase: '11/02/2026',
  },
]

export function Customers() {
  const [rows] = useState(initialRows)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Khách hàng</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Quản lý khách hàng</h2>
        </div>
        <button className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
          Thêm khách hàng
        </button>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã KH</th>
                <th className="px-6 py-4">Tên</th>
                <th className="px-6 py-4">SĐT</th>
                <th className="px-6 py-4">Hạng</th>
                <th className="px-6 py-4">Điểm</th>
                <th className="px-6 py-4">Mua gần nhất</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                  <td className="px-6 py-4 text-ink-900">{item.name}</td>
                  <td className="px-6 py-4 text-ink-700">{item.phone}</td>
                  <td className="px-6 py-4 text-ink-700">{item.rank}</td>
                  <td className="px-6 py-4 text-ink-700">{item.points.toLocaleString('vi-VN')}</td>
                  <td className="px-6 py-4 text-ink-700">{item.lastPurchase}</td>
                  <td className="px-6 py-4">
                    <button className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">
                      Chi tiết
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
