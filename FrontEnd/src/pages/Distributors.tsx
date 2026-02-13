import { useMemo, useState } from 'react'

type Distributor = {
  id: string
  code: string
  name: string
  contactName: string
  phone: string
  address: string
  debt: number
}

const initialRows: Distributor[] = [
  {
    id: 's1',
    code: 'NPP001',
    name: 'Phương Đông',
    contactName: 'Nguyễn Minh Hà',
    phone: '028 3838 8899',
    address: 'Q1, TP.HCM',
    debt: 12800000,
  },
  {
    id: 's2',
    code: 'NPP002',
    name: 'Phú Hưng',
    contactName: 'Trần Quốc Bảo',
    phone: '028 3799 1166',
    address: 'Bình Thạnh, TP.HCM',
    debt: 9200000,
  },
]

const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')}đ`

export function Distributors() {
  const [rows] = useState(initialRows)
  const totalDebt = useMemo(() => rows.reduce((sum, item) => sum + item.debt, 0), [rows])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Danh mục</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Nhà phân phối</h2>
        </div>
        <button className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white shadow-lift">
          Thêm NPP
        </button>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">Tổng NPP</p>
          <p className="mt-2 text-3xl font-semibold text-ink-900">{rows.length}</p>
        </article>
        <article className="glass-card rounded-3xl p-5 sm:col-span-2">
          <p className="text-xs uppercase tracking-[0.22em] text-ink-600">Tổng công nợ</p>
          <p className="mt-2 text-3xl font-semibold text-coral-500">{formatCurrency(totalDebt)}</p>
        </article>
      </section>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã NPP</th>
                <th className="px-6 py-4">Tên</th>
                <th className="px-6 py-4">Liên hệ</th>
                <th className="px-6 py-4">SĐT</th>
                <th className="px-6 py-4">Địa chỉ</th>
                <th className="px-6 py-4">Công nợ</th>
                <th className="px-6 py-4">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                  <td className="px-6 py-4 text-ink-900">{item.name}</td>
                  <td className="px-6 py-4 text-ink-700">{item.contactName}</td>
                  <td className="px-6 py-4 text-ink-700">{item.phone}</td>
                  <td className="px-6 py-4 text-ink-700">{item.address}</td>
                  <td className="px-6 py-4 font-semibold text-coral-500">{formatCurrency(item.debt)}</td>
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
