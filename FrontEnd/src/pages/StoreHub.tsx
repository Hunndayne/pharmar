import { Link } from 'react-router-dom'

const storeModules = [
  {
    title: 'Nhà sản xuất',
    description: 'Quản lý danh sách công ty sản xuất và thông tin liên hệ.',
    path: '/nha-san-xuat',
  },
  {
    title: 'Nhà phân phối',
    description: 'Quản lý đối tác nhập hàng, công nợ và đầu mối liên hệ.',
    path: '/nha-phan-phoi',
  },
  {
    title: 'Lịch sử bán hàng',
    description: 'Tra cứu hóa đơn, tình trạng đơn và theo dõi giao dịch.',
    path: '/lich-su-ban-hang',
  },
  {
    title: 'Khách hàng',
    description: 'Quản lý hồ sơ khách hàng, điểm tích lũy và hạng thành viên.',
    path: '/khach-hang',
  },
  {
    title: 'Khuyến mãi',
    description: 'Thiết lập chương trình giảm giá và theo dõi hiệu quả.',
    path: '/khuyen-mai',
  },
]

export function StoreHub() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Cửa hàng</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Quản lý vận hành cửa hàng</h2>
        <p className="mt-2 text-sm text-ink-600">
          Tập trung các trang nghiệp vụ liên quan đến đối tác, khách hàng và giao dịch bán hàng.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {storeModules.map((item) => (
          <article key={item.path} className="glass-card rounded-3xl p-5">
            <h3 className="text-lg font-semibold text-ink-900">{item.title}</h3>
            <p className="mt-2 text-sm text-ink-600">{item.description}</p>
            <Link
              to={item.path}
              className="mt-4 inline-flex rounded-full border border-ink-900/15 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
            >
              Mở trang
            </Link>
          </article>
        ))}
      </section>
    </div>
  )
}
