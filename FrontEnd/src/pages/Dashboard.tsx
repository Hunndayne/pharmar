const kpiItems = [
  { title: 'Doanh thu hôm nay', value: '12.450.000đ', note: 'so với hôm qua +8.4%' },
  { title: 'Doanh thu tháng này', value: '342.800.000đ', note: 'so với tháng trước +12.1%' },
  { title: 'Số đơn hàng', value: '186', note: 'trong 24 giờ' },
  { title: 'Tồn kho an toàn', value: '92%', note: '34 sản phẩm cần theo dõi' },
]

const hotProducts = [
  { name: 'Panadol Extra', count: 86, revenue: '6.9tr' },
  { name: 'Vitamin C 1000', count: 73, revenue: '5.4tr' },
  { name: 'Men tiêu hóa Bio', count: 65, revenue: '3.2tr' },
  { name: 'Oresol', count: 54, revenue: '2.8tr' },
]

export function Dashboard() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Tổng quan</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Dashboard nhà thuốc</h2>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpiItems.map((item) => (
          <article key={item.title} className="glass-card rounded-3xl p-5">
            <p className="text-xs uppercase tracking-[0.24em] text-ink-600">{item.title}</p>
            <p className="mt-3 text-3xl font-semibold text-ink-900">{item.value}</p>
            <p className="mt-2 text-sm text-ink-600">{item.note}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.6fr,1fr]">
        <article className="glass-card rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Doanh thu</p>
              <h3 className="mt-2 text-2xl font-semibold text-ink-900">Xu hướng 14 ngày</h3>
            </div>
            <span className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-sm font-semibold text-ink-700">
              01/02 - 14/02
            </span>
          </div>
          <div className="mt-6 rounded-2xl bg-white/80 p-6 text-sm text-ink-600">
            Biểu đồ doanh thu sẽ nối API báo cáo theo ngày.
          </div>
        </article>

        <article className="glass-card rounded-3xl p-6">
          <p className="text-xs uppercase tracking-[0.24em] text-ink-600">Thuốc bán chạy</p>
          <h3 className="mt-2 text-2xl font-semibold text-ink-900">Top sản phẩm</h3>
          <div className="mt-5 space-y-4">
            {hotProducts.map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-ink-900">{item.name}</p>
                  <p className="text-sm text-ink-600">{item.count} sản phẩm</p>
                </div>
                <p className="font-semibold text-ink-700">{item.revenue}</p>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  )
}
