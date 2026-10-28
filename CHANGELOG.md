# Changelog — Pharmar

---

## V1.14 — 2026-10-28

### Tính năng mới
- **Inventory — endpoint gộp thuốc mồ côi `POST /api/v1/inventory/admin/merge-drugs`** (chỉ owner/admin): đổi mọi tham chiếu `drug_id`, `unit_id` và `sku` của dòng giữ chỗ (lô, dòng phiếu nhập, movement, giữ chỗ, kiểm kê, thu hồi…) từ thuốc nguồn sang thuốc đích rồi xóa bản ghi nguồn. Mặc định `dry_run=true` chỉ trả báo cáo; ghi thật phải gửi `dry_run=false`. Chạy dưới `runtime_state.lock`, chụp snapshot vào `inventory_runtime_state_history` trước khi ghi, tự hoàn tác trong bộ nhớ nếu lưu thất bại. Từ chối khi: thuốc nguồn còn trong Catalog (kể cả đã xóa mềm, vì đồng bộ không lọc `is_active` nên sẽ kéo nó về lại), thuốc đích không có trong Catalog, tên hai thuốc khác nhau, hoặc thuốc đích thiếu đơn vị mà nguồn đang dùng. Việc kiểm tra Catalog chỉ coi là "không có" khi Catalog trả đúng 404; timeout/5xx trả 502 thay vì fail-open. Logic nằm ở `Source/drug_merge.py`, có 22 test (`tests/test_drug_merge.py`) gồm một test chạy trên backup production thật khi đặt `PHARMAR_BACKUP_SQL` và hai test end-to-end trên Postgres khi đặt thêm `INVENTORY_TEST_DSN`.

### Sửa lỗi
- **Arginine xuất hiện hai lần trên POS (T0182 và T0386, mã T0386 trùng với Natri clorid).** Nguyên nhân: sản phẩm Arginine T0386 bị xóa khỏi Catalog ngày 27/05/2026 trong khi Inventory còn lô của nó; Inventory giữ lại bản cũ không cập nhật theo Catalog, còn mã T0386 được Catalog cấp lại cho Natri clorid. Dùng endpoint gộp ở trên để xử lý; kiểm tra xóa fail-open của Catalog và log cảnh báo khi đồng bộ vẫn chưa được sửa.

---

## V1.13 — 2026-10-15

### Cải thiện
- **Inventory — lưu kho theo từng bản ghi thay vì một blob JSON duy nhất (giai đoạn 1 của chuyển Inventory sang DB thật)**: mỗi thuốc, lô, phiếu nhập, movement, giữ chỗ, kiểm kê, thu hồi… nằm trên một dòng riêng (`inventory_drugs`, `inventory_batches`, `inventory_receipts`, `inventory_movements`, …), toàn bộ field giữ nguyên trong cột `data JSONB` kèm các cột trích xuất có index (drug_id, exp_date, receipt_date, occurred_at…) để truy vấn SQL sau này. Không còn cảnh một lần ghi lỗi là mất trắng cả kho. Logic nghiệp vụ của 36 endpoint giữ nguyên.
- **Mỗi lần lưu chỉ ghi các dòng thực sự thay đổi**; mọi dòng bị xóa (hoặc bị ghi đè bất thường) đều được chép vào `inventory_deleted_rows` trước khi xóa — không có đường xóa dữ liệu nào không để lại bản lưu.
- **Migrate tự động và an toàn khi khởi động**: lần đầu chạy bản mới, dữ liệu được chuyển từ blob sang bảng trong một transaction, đọc lại và so khớp từng bản ghi; lệch bất kỳ chỗ nào thì rollback và tự chạy tiếp ở chế độ blob như cũ.
- **Rollback tức thì không cần build lại**: đặt `INVENTORY_STATE_STORAGE_MODE=blob` để quay về cách lưu cũ. Blob cũ vẫn được ghi song song (`INVENTORY_STATE_LEGACY_BLOB_DUAL_WRITE=true`, mặc định) nên luôn cập nhật; nếu sau đó bật lại chế độ bảng, hệ thống tự phát hiện blob mới hơn và migrate lại.
- `/health` của Inventory thêm trường `state_storage` (`relational` / `blob` / `blob-fallback` / `file`).
- Thêm 43 test (`tests/test_relational_store.py`, `tests/test_storage_modes.py`) và script `scripts/verify_relational_roundtrip.py` kiểm chứng trọn vòng migrate → ghi → khởi động lại trên dữ liệu kho thật (chỉ chạy trên database test).

### Tính năng mới
- **POS — tách ô nhập mã thuốc riêng**: ô tìm kiếm thuốc chiếm trọn một hàng; hàng dưới có ô "Mã thuốc" riêng — gõ mã (hoặc barcode) rồi Enter để chọn đúng thuốc và nhảy sang ô số lượng, mã sai báo đỏ ngay dưới ô. Hai ô tự đồng bộ khi chọn thuốc từ ô tìm kiếm.

---

## V1.12 — 2026-07-27

### Sửa lỗi

- **🔴 NGHIÊM TRỌNG — Sửa lỗi Inventory tự xóa trắng toàn bộ dữ liệu kho.** Toàn bộ tồn kho được lưu trong MỘT row Postgres (`inventory_runtime_state` id=1). Khi khởi động, `load_runtime_state_safe()` nuốt mọi exception và trả về `False` — không phân biệt được "đọc lỗi" với "chưa có dữ liệu" — nên `reload_runtime_state_from_storage()` seed state rỗng rồi **ghi đè lên bản dữ liệu duy nhất**. Chỉ cần một ngày tháng sai trong một dòng phiếu nhập (`_parse_iso_date` ở dòng phiếu nhập / `occurred_at` của movement / `reserved_at` của reservation đều không có try-except) là đủ để mất sạch kho ở lần restart kế tiếp, kể cả khi Postgres hoàn toàn bình thường. Đã kiểm chứng bằng test so sánh code cũ/mới: code cũ 40 thuốc → 0, code mới giữ nguyên 40.
- **Bỏ hẳn tính năng tự reset dữ liệu**: xóa `seed_demo_data()` và `cleanup_legacy_seed_data()` — không còn bất kỳ code path nào tự động xóa dữ liệu kho. Thay bằng `initialize_empty_state()` chỉ dựng cấu trúc rỗng **trong bộ nhớ** và không bao giờ ghi xuống DB; row trong DB chỉ được tạo bởi nghiệp vụ thật đầu tiên.
- **Tăng cửa sổ khôi phục backup**: `backup.max_files` mặc định 10 → 168 (= 24 giờ × 7 ngày). Với backup tự động mỗi giờ, mặc định cũ chỉ cho ~11 giờ lịch sử — một sự cố xảy ra đêm hôm trước là mọi bản backup còn lại đều đã nhiễm lỗi. Đây là lý do sự cố 27/7/2026 không khôi phục được về mốc gần nhất. Ở nhịp backup thực tế 70 phút, 168 bản cho ~8,2 ngày; chi phí lưu trữ tối đa ~285 MB mỗi phía (đĩa local và R2).

### Cải thiện

- **Phân biệt "đọc lỗi" với "chưa có dữ liệu"**: thêm exception `StateLoadError`. Lỗi đọc không bao giờ bị hiểu thành "máy mới" nữa.
- **Retry khi khởi động**: nạp state thử tối đa 10 lần (backoff tới 30s), tự bỏ pool kết nối chết khi Postgres vừa restart. Xử lý được trường hợp container Inventory tự restart lúc Postgres chưa sẵn sàng — `depends_on: service_healthy` chỉ có tác dụng ở `docker compose up`, không áp dụng cho restart theo `restart: unless-stopped`.
- **Tripwire chặn ghi**: nếu chưa nạp được state, `save_runtime_state_safe()` từ chối ghi và log ERROR — dữ liệu trong DB được bảo toàn thay vì bị state rỗng trong bộ nhớ ghi đè.
- **Endpoint trả 503 thay vì báo kho rỗng**: 36 endpoint nghiệp vụ Inventory trả 503 khi chưa nạp được state, tránh POS/báo cáo thấy tồn kho 0 một cách thuyết phục. `/api/v1/inventory/admin/runtime-state/reload` cố tình KHÔNG bị chặn để owner còn đường khôi phục tay.
- **Tự phục hồi**: tiến trình nền thử nạp lại state mỗi 30s; nạp được là service phục vụ bình thường trở lại, không cần restart.
- **Lịch sử snapshot để cứu dữ liệu**: thêm bảng `inventory_runtime_state_history` (giữ 96 bản). Mọi lệnh ghi làm mất sạch một nhóm dữ liệu, hoặc mất hơn một nửa số bản ghi, đều archive bản cũ lại trước khi ghi và log ERROR. Dùng cột đếm `drug_count`/`batch_count`/`receipt_count` (rẻ, không phải detoast blob JSON vài MB mỗi lần ghi).
- **Dữ liệu lỗi chỉ làm hỏng chính bản ghi đó**: mọi chỗ parse ngày tháng khi nạp state đều bọc try-except, ghi log cảnh báo và bỏ qua field lỗi thay vì làm cả lần nạp thất bại.
- **`/health` báo `state_persistence: "unavailable"`** khi chưa nạp được state (nặng hơn `"failing"`).
- Thêm 16 test hồi quy (`Inventory Service/tests/test_state_persistence.py`), chạy trên Postgres thật qua `INVENTORY_TEST_DSN`, tự skip khi không có DB.

---

## V1.11 — 2026-07-15

### Tính năng mới
- **Liên kết nhóm thuốc Store ↔ Catalog bằng ID (`catalog_group_id`)**: thêm cột `catalog_group_id UUID` vào `store.drug_groups` (auto-migrate); form tạo/sửa nhóm thuốc Store có selector "Nhóm Catalog liên kết" kèm auto-gợi ý theo tên khi tạo mới; danh sách nhóm hiển thị badge "⚠ Chưa liên kết" (vàng) hoặc "Đã liên kết: <tên nhóm>" (xanh)
- **Backfill tự động khi Store service khởi động**: job nền (retry 5 lần, backoff 5s→60s) gọi Catalog `GET /api/v1/catalog/drug-groups` (tự mint JWT HS256 nội bộ) và match theo tên chuẩn hóa (trim + lowercase, khớp logic `normalizeGroupKey` của FE); tên trùng sau chuẩn hóa → bỏ qua (để NULL cho owner chọn tay); idempotent — chỉ xử lý row còn NULL

### Cải thiện
- **Trang Danh mục thuốc join bằng ID thay vì tên**: ưu tiên join store-group ↔ catalog-group qua `catalog_group_id`; chỉ fallback join theo tên/code tự sinh cho nhóm chưa liên kết; nhóm đã liên kết không còn bị tự tạo nhóm Catalog trùng (code `SG<id>`)
- Store service thêm config `CATALOG_SERVICE_URL` (compose đã khai báo sẵn, mặc định `http://catalog-service:8006`)

---

## V1.10 — 2026-07-07

### Cải thiện
- **Bảo mật — Gateway chặn endpoint nội bộ**: client ngoài không còn gọi được `/api/v1/*/internal/*` (trả 404, chặn cả biến thể dot-segment `x/../internal/…`); header `X-Internal-API-Key` bị strip khỏi mọi request đi qua gateway
- **Bảo mật — chống giả mạo IP**: gateway chỉ tin header IP client khi request đến từ proxy trong `TRUSTED_PROXY_IPS` (mặc định không tin ai) — hết bypass rate limit bằng header giả; ưu tiên `CF-Connecting-IP` khi chạy sau Cloudflare Tunnel (phần tử đầu của `X-Forwarded-For` vẫn giả được dù đi qua Cloudflare); thêm rate limit riêng `PUBLIC_RATE_LIMIT_RPM` (30 req/phút) cho các endpoint `public/*` chống dò quét số điện thoại qua tra cứu hóa đơn công khai
- **Bảo mật — Store service**: `backup.sync_api_key` bị ẩn khỏi mọi response đọc settings trừ khi caller là owner (token hợp lệ) — vá chuỗi tấn công đọc key công khai rồi tải toàn bộ backup database qua `/backup/latest/download`; settings GET vẫn mở cho các service nội bộ (Sale/Inventory/Customer đọc không kèm token); `/expenses/summary` (dữ liệu chi phí) chỉ còn owner xem được
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
