export type ChangelogFeature = {
  text: string
  route?: string
}

export type ChangelogEntry = {
  version: string
  date: string
  features: ChangelogFeature[]
}

export const CURRENT_VERSION = 'V1.7'

export const WHATS_NEW_STORAGE_KEY = 'pharmar.whats_new_seen'

export const changelogEntries: ChangelogEntry[] = [
  {
    version: 'V1.7',
    date: '2026-04-22',
    features: [
      { text: 'GPP — Sổ theo dõi thuốc bị thu hồi / đình chỉ lưu hành', route: '/thuoc-thu-hoi' },
    ],
  },
  {
    version: 'V1.6',
    date: '2026-04-19',
    features: [
      { text: 'GPP — Sổ thông tin bệnh nhân: thêm trường "Tiền sử dị ứng" và "Tiền sử bệnh"', route: '/khach-hang' },
      { text: 'GPP — Sổ kiểm soát chất lượng: phiếu kiểm kê ghi nhận người kiểm và loại kiểm', route: '/kiem-ke-kho' },
      { text: 'GPP — Sổ thuốc bán theo đơn: hóa đơn ghi nhận số đơn, tên bác sĩ, chẩn đoán', route: '/ban-hang' },
      { text: 'Lịch sử bán hàng: lọc theo đơn thuốc và lọc mua nợ', route: '/lich-su-ban-hang' },
      { text: 'POS — tối ưu tải dữ liệu: gộp thành 1 endpoint /pos/catalog, giảm ~60% payload', route: '/ban-hang' },
    ],
  },
  {
    version: 'V1.5',
    date: '2026-04-14',
    features: [
      { text: 'Trang gợi ý nhập hàng tự động', route: '/goi-y-nhap-hang' },
      { text: 'Email gợi ý nhập hàng lúc 7:00 sáng (cấu hình được)', route: '/cua-hang/cai-dat' },
      { text: 'Lịch sử bán hàng: lọc theo hình thức thanh toán', route: '/lich-su-ban-hang' },
      { text: 'Export CSV / Excel / PDF trong Báo cáo', route: '/bao-cao' },
    ],
  },
]
