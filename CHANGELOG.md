# Changelog — Pharmar

---

## V1.10 — 2026-07-07

### Cải thiện
- **Bảo mật — Gateway chặn endpoint nội bộ**: client ngoài không còn gọi được `/api/v1/*/internal/*` (trả 404, chặn cả biến thể dot-segment `x/../internal/…`); header `X-Internal-API-Key` bị strip khỏi mọi request đi qua gateway
- **Bảo mật — chống giả mạo IP**: gateway chỉ tin header IP client khi request đến từ proxy trong `TRUSTED_PROXY_IPS` (mặc định không tin ai) — hết bypass rate limit bằng header giả; ưu tiên `CF-Connecting-IP` khi chạy sau Cloudflare Tunnel (phần tử đầu của `X-Forwarded-For` vẫn giả được dù đi qua Cloudflare); thêm rate limit riêng `PUBLIC_RATE_LIMIT_RPM` (30 req/phút) cho các endpoint `public/*` chống dò quét số điện thoại qua tra cứu hóa đơn công khai
- **Bảo mật — Store service**: 3 endpoint đọc settings giờ yêu cầu đăng nhập và ẩn `backup.sync_api_key` với người không phải chủ cửa hàng — vá chuỗi tấn công đọc key công khai rồi tải toàn bộ backup database qua `/backup/latest/download`; `/expenses/summary` (dữ liệu chi phí) chỉ còn owner xem được
- **Bảo mật — chống brute-force theo tài khoản**: đăng nhập sai 5 lần cùng một username → khóa 15 phút (trả 429, không tiết lộ username có tồn tại), lưu Redis và fail-open khi Redis lỗi; bổ sung cho rate limit theo IP sẵn có
- **Bảo mật — docker-compose từ chối chạy với secret mặc định**: mọi secret (`JWT_SECRET_KEY`, `POSTGRES_PASSWORD`, `CUSTOMER_INTERNAL_API_KEY`, RabbitMQ) chuyển sang cú pháp bắt buộc `:?` — thiếu là compose báo lỗi ngay thay vì chạy ngầm với `change-this-secret`/`postgres`/`guest`; Postgres chỉ còn bind `127.0.0.1`; RabbitMQ dùng credentials riêng (đã sinh tự động vào `.env`)

### Khác
- Gỡ `Users/.env` khỏi git (chỉ chứa giá trị dev mặc định, không có secret thật); xóa 4 file rác `*.go.<số>` bị track trong `Store/`

---

## V1.9 — 2026-07-07

### Cải thiện
- **API Gateway — blacklist token & rate limit chuyển sang Redis**: logout được thực thi bền vững qua restart/nhiều replica; TTL blacklist đọc từ `exp` thật của JWT thay vì hardcode 30 phút; fail-open có log khi Redis lỗi để không làm sập API
- **Bảo mật mạng — đóng port trực tiếp của 10 service nội bộ** trong docker-compose: client chỉ còn đi qua gateway (8000), không bypass được rate limit/blacklist; giữ postgres 5432 cho dev
- **Sale — shared HTTP client** có connection pooling cho mọi call liên service (Inventory/Customer/Store) thay vì tạo client mới mỗi lần → giảm latency tạo hóa đơn; timeout từng call giữ nguyên
- **Khởi động nhanh hơn sau restart**: healthcheck cho cả 10 service + `depends_on: service_healthy` để gateway chỉ nhận traffic khi backend sẵn sàng (hết 502 phút đầu); Report service tự warm-up cache dashboard (revenue 14 ngày, top sản phẩm tháng, gợi ý nhập hàng) sau 15s khởi động — tắt được qua `REPORT_CACHE_WARMUP_ENABLED`
- **Inventory — hết mất dữ liệu âm thầm khi lưu state thất bại**: lỗi persist được log đầy đủ, tự retry nền mỗi 30s (giữ cùng lock với nghiệp vụ), `/health` thêm trường `state_persistence: ok|failing`
- **POS — tạo hóa đơn nhanh hơn**: fetch khách hàng + tier discount chạy song song (trước đây tuần tự); in hóa đơn fetch store info + settings song song; earn points + stats update sau checkout chạy đồng thời
- **Báo cáo nhanh hơn**: Report kéo hóa đơn từ Sale theo trang 1000 thay vì 200 (giảm ~5 lần số call), các trang và các chunk batch-costs fetch song song (giới hạn 4 đồng thời)
- **API Gateway — GZip response** (JSON lớn nhẹ hơn nhiều trên mạng chậm), state màn hình phụ POS chuyển sang Redis (TTL 6h), gateway chạy 2 worker

### Sửa lỗi
- **Sale — chặn NaN lọt vào tổng tiền hóa đơn**: `quantize_money` từ chối giá trị non-finite (NaN từ JSON response ngoài trước đây đi xuyên qua `safe_decimal` mà không rơi về default)

### Khác
- **Bộ test đầu tiên của project**: 79 pytest cases cho các helper tiền/điểm/thời gian của Sale service (`Sale/tests/`, chạy bằng `cd Sale && python -m pytest tests/ -q`)

---

## V1.8 — 2026-04-26

### Cải thiện
- **Reports — tối ưu Top sản phẩm bán chạy** [`/bao-cao`]: endpoint mới `/reports/top-products-aggregated` ở Sale service để DB tự tổng hợp, thay vòng lặp phân trang 7 trang cũ; kết quả cache Redis theo khoảng ngày
- **Catalog — batch product lookup**: endpoint `POST /products/batch` lấy chi tiết tối đa 200 sản phẩm trong 1 call (kèm group, manufacturer, units) thay vì gọi từng sản phẩm
- **Inventory — hỗ trợ tra cứu giá vốn theo lô** phục vụ báo cáo top sản phẩm nhanh hơn
- **Docker — giảm kích thước image & thời gian khởi động**: bỏ `uvicorn[standard]` extras không cần thiết, tinh gọn requirements của 8 Python services

---

## V1.7 — 2026-04-22

### Tính năng mới
- **GPP — Sổ theo dõi thuốc bị thu hồi / đình chỉ lưu hành** [`/thuoc-thu-hoi`]: nhập đầy đủ theo mẫu GPP (số công văn, ngày ban hành, tên thuốc, nồng độ/hàm lượng, số lô/hạn dùng, số lượng mua/bán/tồn/thu hồi từ khách, công ty SX, khách hàng, người nhận, xử lý, lý do); xuất Excel; lọc theo ngày ban hành

---

## V1.6 — 2026-04-19

### Tính năng mới
- **GPP — Sổ thông tin bệnh nhân** [`/khach-hang`]: thêm trường "Tiền sử dị ứng" và "Tiền sử bệnh" vào hồ sơ khách hàng
- **GPP — Sổ kiểm soát chất lượng** [`/kiem-ke-kho`]: phiếu kiểm kê ghi nhận người kiểm và loại kiểm (định kỳ / đột xuất)
- **GPP — Sổ thuốc bán theo đơn** [`/ban-hang`]: hóa đơn ghi nhận số đơn thuốc, tên bác sĩ, chẩn đoán; POS có checkbox "Bán theo đơn"
- **SalesHistory — lọc theo đơn thuốc** [`/lich-su-ban-hang`]: filter "Theo đơn / Không theo đơn / Tất cả"
- **SalesHistory — lọc mua nợ** [`/lich-su-ban-hang`]: filter "Mua nợ / Tất cả thanh toán"

### Cải thiện
- **POS — tối ưu tải dữ liệu** [`/ban-hang`]: gộp 2 API calls (`/meta/drugs` + `/stock/summary`) thành 1 endpoint `/pos/catalog`, giảm ~60% payload và 1 round trip khi mở trang bán hàng

---

## V1.5 — (trước 2026-04-19)

### Tính năng mới
- **Trang gợi ý nhập hàng** [`/goi-y-nhap-hang`]
- **Scheduler email** [`/cua-hang/cai-dat`]: gợi ý nhập hàng lúc 7:00 sáng (cấu hình được)
- **Lịch sử bán hàng** [`/lich-su-ban-hang`]: filter thanh toán

### Cải thiện
- Mobile optimization: Reports, NotificationSettings, StoreSettings
- **Export CSV / Excel / PDF** [`/bao-cao`] trong Reports
- Backup list mobile-friendly
