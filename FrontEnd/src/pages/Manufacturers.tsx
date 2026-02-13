import { useState } from 'react'

type Manufacturer = {
  id: string
  code: string
  name: string
  country: string
  phone: string
}

const initialRows: Manufacturer[] = [
  { id: 'm1', code: 'NSX001', name: 'GSK', country: 'UK', phone: '028 3811 8888' },
  { id: 'm2', code: 'NSX002', name: 'DHG', country: 'Việt Nam', phone: '0292 3891 433' },
  { id: 'm3', code: 'NSX003', name: 'Imexpharm', country: 'Việt Nam', phone: '0277 3851 941' },
]

export function Manufacturers() {
  const [rows] = useState(initialRows)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Công ty sản xuất</h2>
        </div>
        <button className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
          Thêm NSX
        </button>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã</th>
                <th className="px-6 py-4">Tên công ty</th>
                <th className="px-6 py-4">Quốc gia</th>
                <th className="px-6 py-4">SĐT</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                  <td className="px-6 py-4 text-ink-900">{item.name}</td>
                  <td className="px-6 py-4 text-ink-700">{item.country}</td>
                  <td className="px-6 py-4 text-ink-700">{item.phone}</td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      <button className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900">Sửa</button>
                      <button className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500">Xóa</button>
                    </div>
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
