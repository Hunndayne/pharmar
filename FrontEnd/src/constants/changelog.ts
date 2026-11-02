export type ChangelogFeature = {
  text: string
  route?: string
}

export type ChangelogEntry = {
  version: string
  date: string
  features: ChangelogFeature[]
}

export const CURRENT_VERSION = 'V2.0'

export const WHATS_NEW_STORAGE_KEY = 'pharmar.whats_new_seen'

export const changelogEntries: ChangelogEntry[] = [
  {
    version: 'V2.0',
    date: '2026-11-03',
    features: [
      { text: 'Thanh toán thất bại không còn làm tăng tồn kho ảo; điểm tích lũy được hoàn đúng khi hủy hóa đơn hoặc trả hàng', route: '/lich-su-ban-hang' },
      { text: 'Hủy hóa đơn đã trả một phần chỉ nhập lại phần chưa trả; hoàn tất kiểm kê không còn ghi đè tồn của hàng bán trong lúc kiểm', route: '/kiem-ke-kho' },
      { text: 'Phiên đăng nhập tự làm mới, không còn bị lỗi sau khoảng 30 phút khi để máy mở' },
      { text: 'Bán hàng: các đơn đang soạn được giữ lại khi chuyển trang hoặc tải lại trang', route: '/ban-hang' },
      { text: 'Tìm thuốc nhận đúng chữ đ/Đ (ví dụ gõ "dau" ra "Đau dạ dày")', route: '/ban-hang' },
      { text: 'Nhập hàng: cảnh báo khi HSD còn dưới 90 ngày, chặn HSD đã qua; nhập giá kiểu "12.000" được hiểu đúng', route: '/nhap-hang' },
      { text: 'Màn hình khách giữ mã ghép nối sau khi đăng xuất', route: '/ban-hang' },
    ],
  },
  {
    version: 'V1.18',
    date: '2026-11-01',
    features: [
      { text: 'Nhập phiếu nhập hàng từ ảnh hoặc PDF hóa đơn bằng AI: bấm "Đọc hóa đơn tự động" trong form tạo phiếu', route: '/nhap-hang' },
      { text: 'AI tự ghép thuốc, nhà cung cấp, quy đổi đơn vị và cộng VAT; số lô, NSX, HSD vẫn do bạn điền' },
      { text: 'Xem lại hóa đơn gốc ngay trong chi tiết phiếu nhập (phóng to, chuyển trang, tải về)', route: '/nhap-hang' },
      { text: 'Báo hóa đơn đã nhập trước đó và tìm phiếu nhập theo số/ký hiệu hóa đơn', route: '/nhap-hang' },
      { text: 'Nút "Hủy" trong form tạo phiếu xóa bản nháp; nút × chỉ đóng và giữ nháp cho lần sau', route: '/nhap-hang' },
    ],
  },
  {
    version: 'V1.17',
    date: '2026-11-01',
    features: [
      { text: 'Dashboard gọn hơn: thẻ chỉ số, biểu đồ cột 14 ngày và khối "Cần xử lý" bấm là sang đúng trang', route: '/' },
      { text: 'Tồn kho có bảng riêng cho máy tính, bấm vào dòng để xem các lô', route: '/ton-kho' },
      { text: 'Bán hàng: nút nhập nhanh tiền khách đưa và đơn thuốc mẫu tìm được theo tên', route: '/ban-hang' },
      { text: 'Trang Nhập hàng tải nhanh hơn, không còn chờ từng phiếu', route: '/nhap-hang' },
      { text: 'Sửa lỗi doanh thu tháng bị thiếu các ngày đầu tháng từ ngày 15 trở đi', route: '/' },
    ],
  },
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
