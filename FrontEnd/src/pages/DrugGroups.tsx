import { useState } from 'react'

type DrugGroup = {
  id: string
  code: string
  name: string
  note: string
  totalDrugs: number
}

const initialRows: DrugGroup[] = [
  { id: 'g1', code: 'NT001', name: 'Giảm đau', note: '', totalDrugs: 24 },
  { id: 'g2', code: 'NT002', name: 'Kháng sinh', note: '', totalDrugs: 18 },
  { id: 'g3', code: 'NT003', name: 'Vitamin', note: '', totalDrugs: 36 },
]

export function DrugGroups() {
  const [rows] = useState(initialRows)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Nhóm thuốc</h2>
        </div>
        <button className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
          Thêm nhóm
        </button>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã nhóm</th>
                <th className="px-6 py-4">Tên nhóm</th>
                <th className="px-6 py-4">Số thuốc</th>
                <th className="px-6 py-4">Ghi chú</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                  <td className="px-6 py-4 text-ink-900">{item.name}</td>
                  <td className="px-6 py-4 text-ink-700">{item.totalDrugs}</td>
                  <td className="px-6 py-4 text-ink-700">{item.note || '-'}</td>
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
