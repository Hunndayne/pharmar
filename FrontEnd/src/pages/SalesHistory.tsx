import { useState } from 'react'

type Invoice = {
  id: string
  code: string
  createdAt: string
  customerName: string
  total: number
  discount: number
  finalAmount: number
  cashier: string
  status: 'Hoàn thành' | 'Đã hủy' | 'Đã trả hàng'
}

const initialRows: Invoice[] = [
  {
    id: 'inv1',
    code: 'HD20260212001',
    createdAt: '2026-02-12 09:12',
    customerName: 'Khách lẻ',
    total: 420000,
    discount: 20000,
    finalAmount: 400000,
    cashier: 'Thanh Huy',
    status: 'Hoàn thành',
  },
  {
    id: 'inv2',
    code: 'HD20260212002',
    createdAt: '2026-02-12 10:05',
    customerName: 'Nguyễn Lan',
    total: 185000,
    discount: 0,
    finalAmount: 185000,
    cashier: 'Thanh Huy',
    status: 'Hoàn thành',
  },
]

const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')}đ`

export function SalesHistory() {
  const [rows] = useState(initialRows)

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Bán hàng</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Lịch sử bán hàng</h2>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/60 bg-white/70">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left text-sm">
            <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
              <tr>
                <th className="px-6 py-4">Mã hóa đơn</th>
                <th className="px-6 py-4">Ngày giờ</th>
                <th className="px-6 py-4">Khách hàng</th>
                <th className="px-6 py-4">Tổng tiền</th>
                <th className="px-6 py-4">Giảm giá</th>
                <th className="px-6 py-4">Thành tiền</th>
                <th className="px-6 py-4">Nhân viên</th>
                <th className="px-6 py-4">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/70">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-white/80">
                  <td className="px-6 py-4 font-semibold text-ink-900">{item.code}</td>
                  <td className="px-6 py-4 text-ink-700">{item.createdAt}</td>
                  <td className="px-6 py-4 text-ink-900">{item.customerName}</td>
                  <td className="px-6 py-4 text-ink-700">{formatCurrency(item.total)}</td>
                  <td className="px-6 py-4 text-ink-700">{formatCurrency(item.discount)}</td>
                  <td className="px-6 py-4 font-semibold text-ink-900">{formatCurrency(item.finalAmount)}</td>
                  <td className="px-6 py-4 text-ink-700">{item.cashier}</td>
                  <td className="px-6 py-4">
                    <span className="rounded-full border border-brand-500/30 bg-brand-500/15 px-3 py-1 text-xs font-semibold text-brand-600">
                      {item.status}
                    </span>
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
