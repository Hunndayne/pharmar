# Changelog — Pharmar

---

## V2.0 — 2026-11-03

Đợt sửa lớn sau rà soát toàn diện (bảo mật, tiền/tồn kho, frontend, vận hành). **Không đổi schema DB, không migrate dữ liệu**; mọi thay đổi API đều tương thích ngược. Deploy cần build lại: `api-gateway`, `users-service`, `sale-service`, `customer-service`, `inventory-service`, `report-service`, `store-service`, `file-service`, `frontend`. **Compose mới cần `JWT_SECRET_KEY` cho `api-gateway`** (đã có trong `.env`).

### Sửa lỗi tiền và tồn kho
- **Thanh toán thất bại không còn tạo tồn ảo.** Sale chỉ hoàn kho khi Inventory đã thực sự trừ kho (reserve thành công). Trước đây mọi checkout bị từ chối (thiếu hàng, lô hết hạn, lỗi mạng) đều cộng thêm hàng vào kho.
- **Điểm đã dùng được hoàn khi hủy hóa đơn, trả hàng hoặc checkout lỗi.** Mã tham chiếu gửi sang Customer dài 21 ký tự vượt giới hạn 20 nên bị từ chối âm thầm; đã rút ngắn (`inv_create_failed`, `inv_cancel_redeem`, `inv_return_redeem`). Checkout lỗi chỉ hoàn số điểm thực sự đã trừ.
- **Trả hàng không còn cộng nhầm điểm.** Sale gửi chiều rollback tường minh (`mode: reverse_earn | reverse_redeem`); Customer vẫn nhận thiếu `mode` để tương thích; với `mode` tường minh, số điểm vượt mức còn hoàn được sẽ bị kẹp thay vì từ chối.
- **Hoàn tiền trả hàng theo giá thực trả** (sau giảm giá dòng, hạng thành viên, khuyến mãi, điểm; phân bổ theo tỷ lệ), không còn theo giá gốc. Tổng hoàn của một hóa đơn không bao giờ vượt tổng tiền đã thu. Phí dịch vụ tách riêng không hoàn.
- **Không trả hàng được hai lần cho cùng một món:** phiếu trả đang chờ được trừ khi kiểm tra số lượng, chặn trùng `invoice_item_id` trong một phiếu, duyệt trả kiểm tra lại và khóa dòng (`SELECT … FOR UPDATE`); hủy hóa đơn cũng khóa dòng nên không hủy trùng.
- **Tiếp tục đơn tạm (held order) không tạo hai hóa đơn** khi bấm hai lần: đơn được "claim" nguyên tử; claim quá 5 phút chưa xong tự mở lại.
- **Hủy hóa đơn đã trả một phần** chỉ nhập kho phần chưa trả và chỉ hoàn/thu hồi phần điểm còn lại.
- **Reserve nhiều dòng cùng một lô** không còn làm tồn lô âm (cả chọn lô tay lẫn FEFO).
- **Hoàn tất kiểm kê** áp chênh lệch lên tồn hiện tại thay vì ghi đè, nên hàng bán trong lúc kiểm kê không bị hoàn lại.
- **Tồn có thể bán không tính lô hết hạn** (POS, trang tồn kho, cảnh báo sắp hết hàng); lô bị đánh dấu hết hạn thủ công hiện đúng trong cảnh báo "đã hết hạn".
- **Sổ thu hồi và danh sách kiểm kê** không còn lỗi 500 sau khi restart; phiếu kiểm kê hiện đúng mã thuốc.
- **Dashboard hôm nay** không trừ hóa đơn hủy hai lần; thống kê thu ngân dùng phiếu trả thật.
- `GET /sale/returns` tải sẵn dòng hàng (trước đây lỗi 500 MissingGreenlet khi có dữ liệu; lộ ra vì Report mới gọi endpoint này).
- **Báo cáo doanh thu:** tiền đã thu không còn gồm tiền thối; trừ phiếu trả đã duyệt (theo ngày duyệt, có `return_count`, `returns_amount`); số hóa đơn hủy đếm đúng trong khoảng ngày; phân bổ theo phương thức thanh toán dùng từng khoản thanh toán thật (tiền mặt/chuyển khoản/nợ) thay vì gán cả hóa đơn vào một phương thức.

### Bảo mật
- **Màn hình khách:** gateway xác thực JWT thật khi POS cập nhật; `screen_id` là mã ngẫu nhiên theo trình duyệt (không còn `default`), bắt buộc 16–64 ký tự; trang hiển thị bỏ tham số `api_base` và không còn chèn HTML từ dữ liệu (hết XSS).
- **Đăng nhập:** rate-limit và khóa tài khoản tính theo IP thật của client (gateway gửi `X-Client-IP`, bỏ giá trị client tự gửi) và theo cặp (tài khoản, IP) nên người lạ không khóa được tài khoản chủ tiệm; tài khoản bị tấn công phân tán chỉ bị làm chậm dần, không khóa. Lịch sử đăng nhập ghi IP thật.
- **Gateway:** chặn bypass rate-limit login qua `auth/./login`; body thường tối đa 2 MB (100 MB chỉ cho upload file, AI, backup, import Excel, logo), kiểm tra trước khi đọc và cả với chunked; `/system/health` chỉ trả chi tiết cho owner/manager.
- **File Service:** backup DB (`category=backup`) chỉ owner được liệt kê/tải/upload; giới hạn dung lượng upload thật; Content-Type lấy từ nội dung file, không tin client.
- **Store:** sàn `backup.max_files` ≥ 48; backup thất bại không đánh dấu "đã backup" (sẽ thử lại) và log `BACKUP_FAILED`; restore chạy `psql --no-psqlrc`, từ chối file có meta-command (`\!`) hoặc `COPY … PROGRAM`.

### Cải thiện giao diện
- **Hiệu ứng tải trang:** mọi trang hiện khung xương (skeleton) có dải sáng quét ngang khi đang tải lần đầu — thẻ số liệu, biểu đồ, danh sách và bảng (cả dạng card trên mobile) — thay cho chữ "Đang tải…". Tôn trọng cài đặt giảm chuyển động của hệ điều hành. (bổ sung 2026-11-03, không đổi version)
- **Phiên đăng nhập tự làm mới:** gặp 401 thì tự refresh token một lần rồi gửi lại, không còn chết sau 30 phút phải F5.
- **Giỏ hàng POS giữ lại** khi chuyển trang/tải lại (lưu theo tài khoản); mỗi đơn có `client_request_id` gửi kèm khi thanh toán (chuẩn bị chống tạo trùng).
- Tính lại tự động phân bổ lô không còn ghi đè thao tác vừa nhập; ô quét mã xóa ngay khi Enter và chọn lại khi lỗi.
- Tìm thuốc nhận đúng chữ đ/Đ ở POS và danh mục.
- Nhập hàng: giá kiểu "12.000" hiểu đúng; số lượng phải là số nguyên; chặn HSD trước ngày nhập và NSX sau hôm nay, cảnh báo HSD dưới 90 ngày; dòng hàng tặng từ AI (giá 0) lưu được.
- Ngày mặc định ở nhập hàng và sổ thu hồi theo múi giờ cửa hàng, không còn lệch trước 7h sáng.
- Duyệt trả hàng lỗi giữa chừng không tạo phiếu trả thứ hai (nút "Duyệt lại"); chặn bấm đúp tạo phiếu kiểm kê; trang thông báo và cài đặt cảnh báo hiện lỗi thay vì im lặng.
- Đăng xuất xóa nháp cục bộ (giữ múi giờ, mã màn hình khách và cờ "đã xem tính năng mới").
- **Popup "Tính năng mới" hiện trở lại:** version popup từng kẹt ở V1.7 nên không hiện từ tháng 4; nay Sidebar và popup dùng chung `CURRENT_VERSION` trong `FrontEnd/src/constants/changelog.ts`.

### Vận hành
- Compose: `restart: unless-stopped` + healthcheck cho postgres/redis; giới hạn log json-file 10 MB × 5 cho mọi service; RabbitMQ có `hostname` và volume cố định; volume `store_uploads` cho logo; `api-gateway` nhận `JWT_SECRET_KEY`.
- `.dockerignore` cho 10 service (không còn copy `.env` vào image).
- `deploy.sh`: giữ `FrontEnd/nginx.conf` của server, pg_dumpall trước khi đổi, build + up các service chỉ định, chờ healthy, so số thuốc/lô/tồn trước–sau, prune image.
- Test mới: Sale 21, Customer 19, Inventory 14, Gateway 4, Go (File/Store).

## V1.18 — 2026-11-01

### Tính năng mới
- **Nhập phiếu nhập hàng từ ảnh/PDF hóa đơn bằng AI.** Trong form "Tạo phiếu nhập" có nút "Đọc hóa đơn tự động" (cạnh "Thêm dòng thuốc"). AI điền thẳng vào phiếu đang tạo, có hỏi trước khi thay các dòng đã nhập tay; sau khi điền, đầu form hiện "Đã điền từ hóa đơn … · Xem hóa đơn" để đối chiếu trong lúc nhập số lô.
  - **Đầu vào:** chọn nhiều ảnh hoặc PDF (hóa đơn nhiều trang). Ảnh được nén ngay trên trình duyệt (JPEG, cạnh dài 1600px); PDF render bằng pdf.js, lấy kèm lớp chữ nếu có.
  - **Service mới `ai-service` (Go, cổng 8011)** gọi DeepSeek (`deepseek-flash`):
    1. Đọc nhà cung cấp, mã số thuế, ký hiệu/số/ngày hóa đơn, các dòng hàng, VAT và tổng tiền.
    2. Code tự kiểm tra số lượng × đơn giá và tổng tiền, báo hóa đơn đã nhập trước đó (trùng ký hiệu + số), khớp nhà cung cấp theo mã số thuế.
    3. Ghép thuốc: tìm sẵn ứng viên trong danh mục theo tên đã bỏ dấu (chịu được lỗi đọc dấu như "TRÍ"/"TRĨ"), rồi để agent DeepSeek chọn hoặc tự tra thêm.
  - **Kết quả là phiếu nháp:**
    - Tự quy đổi về đơn vị nhập và cộng VAT vào giá (tùy chọn trong Cài đặt, mặc định giá gồm VAT).
    - Dòng hàng tặng giữ giá 0 kèm nhãn "Hàng tặng – tự xử lý".
    - Số lô, NSX, HSD để người dùng tự điền vì hóa đơn VAT không có.
    - Mỗi dòng hiện tên trên hóa đơn và độ tin cậy của AI.
  - **Ghi nhớ:** sau khi lưu, cặp "tên trên hóa đơn → thuốc" được ghi nhớ theo nhà cung cấp, lần sau khớp ngay không cần gọi AI.
  - **Chi phí và giới hạn:** hạn mức chi tiêu AI theo ngày (`AI_DAILY_BUDGET_USD`, mặc định $1). Chạy thử với hóa đơn thật: khoảng 9 giây, khoảng $0,001–0,002 mỗi hóa đơn, ghép đúng 4/4 dòng ở cả 3 lần chạy.
- **Lưu và xem lại hóa đơn gốc.**
  - **Cách lưu lên R2:** ảnh lưu dạng AVIF 1600px (hóa đơn mẫu 120 KB/trang, chữ nhỏ vẫn đọc rõ). PDF văn bản nhẹ (≤ 1 MB) lưu nguyên file; PDF scan hoặc nặng chỉ lưu ảnh các trang.
  - **Phiếu nhập lưu thêm** ký hiệu, số, ngày hóa đơn và danh sách file.
  - **Xem lại:** trong khung chi tiết phiếu có nút "Xem hóa đơn". Popup cho phóng to/kéo ảnh, chuyển trang (nút và phím ←/→), xem PDF ngay trong trang, mở tab mới hoặc tải về.
- **Inventory:**
  - Thêm `GET /api/v1/inventory/import-receipts/by-invoice?serial=&number=` để kiểm tra hóa đơn đã nhập; số hóa đơn so sánh bỏ số 0 đầu.
  - Ô tìm kiếm trang Nhập hàng tìm được theo số/ký hiệu hóa đơn.
- **Store:** setting mới `purchase.ai_price_includes_vat` (tự thêm khi khởi động, không cần migration).

### Cải thiện
- Form tạo/sửa phiếu nhập: hàng nút dưới cùng có icon. Trên điện thoại chỉ hiện icon (riêng nút lưu vẫn ghi "Lưu") nên vừa một dòng; trên máy tính giữ cả icon lẫn chữ. Nút "Đóng" ở góc trên đổi thành biểu tượng ×.
- Nút "Hủy" trong form tạo phiếu giờ **xóa bản nháp** (hỏi xác nhận trước). Nút × chỉ đóng form và giữ bản nháp cho lần sau. Khi sửa phiếu cũ thì không có nút "Hủy".
- API Gateway cho request `/api/v1/ai/*` chờ tối đa 120 giây; nginx frontend `proxy_read_timeout 150s`, CSP thêm `frame-src 'self' https:` để xem PDF từ R2, phục vụ worker `.mjs` của pdf.js đúng MIME.
- Docker build frontend dùng Node 22 (pdf.js 6 yêu cầu Node ≥ 22.13).

### Sửa lỗi
- Nhập từ hóa đơn: "Ngày nhập" của phiếu không còn bị đổi thành ngày xuất hóa đơn; ngày nhập giữ ngày đang nhập lên hệ thống (mặc định hôm nay), ngày hóa đơn vẫn lưu riêng ở `invoice_date` và hiện trong dòng "Đã điền từ hóa đơn … ngày …".
- Menu bên trái: bấm một mục trong "Sổ GPP" khi đang ở trang dùng chung đường dẫn với nhóm "Cửa hàng" (ví dụ từ "Sổ thuốc thu hồi" sang "Sổ kiểm soát chất lượng") làm nhóm "Cửa hàng" tự bung ra dù người dùng vừa đóng, khiến menu bị nhảy. Ngay lúc bấm, menu đã nhớ mục mới nhưng đường dẫn vẫn là trang cũ, nên tạm chọn mục cùng đường dẫn của "Cửa hàng" và mở nhóm đó. Nay menu chỉ tự mở nhóm khi trang thật sự đổi, và ưu tiên giữ mục trong cùng nhóm với mục vừa bấm.

### Ghi chú triển khai
- **Build lại:** `ai-service` (mới), `inventory-service`, `store-service`, `api-gateway`, `frontend`.
- **`.env` server:** thêm `DEEPSEEK_API_KEY`, có thể thêm `AI_DAILY_BUDGET_USD`. Thiếu key thì chỉ tính năng đọc hóa đơn báo "Chưa cấu hình AI", phần còn lại chạy bình thường. Gateway không phụ thuộc vào `ai-service` khi khởi động.
- **`nginx.conf` trên server** đang tách khỏi git (CSP riêng), nên phải tự thêm 3 thay đổi trên: `frame-src`, `location ~* \.mjs$`, `proxy_read_timeout 150s`.
- **RAM:** `ai-service` dùng khoảng 210–260 MB khi mã hóa AVIF.

---

## V1.17 — 2026-11-01

### Cải thiện
- **Dashboard làm lại cho gọn.** Bốn thẻ chỉ số đầu trang: doanh thu hôm nay (so với hôm qua, kèm tiền trả/hủy nếu có), số đơn hôm nay (giá trị trung bình mỗi đơn), doanh thu 7 ngày qua (% so với 7 ngày trước đó) và doanh thu tháng. Xu hướng 14 ngày đổi từ các thanh ngang thành biểu đồ cột: hôm nay tô đậm, rê chuột vào cột để xem doanh thu và số đơn. Gợi ý nhập hàng rút còn 6 dòng với 5 cột chính (tồn, bán/ngày, còn đủ, nên nhập, mức ưu tiên). Top bán chạy có thêm thanh so sánh doanh thu. Có khung chờ khi đang tải, nút tải lại hiện trạng thái quay.
- **Thay khối "AI Insight" bằng khối "Cần xử lý".** Snapshot AI chủ yếu chạy bản fallback (worker AI tắt mặc định), nên chỉ lặp lại các con số đã có trên dashboard. Khối mới đếm trực tiếp từ tồn kho và gợi ý nhập: lô hết hạn, hết hàng, cần nhập gấp, sắp hết hạn, cận date, tồn thấp. Mỗi dòng bấm vào là sang đúng trang xử lý, kèm thanh tỷ lệ tồn kho an toàn. API `/report/ai/dashboard-insights` ở Report service vẫn giữ nguyên, chỉ không còn hiển thị trên dashboard.
- **Trang Tồn kho có bảng riêng cho máy tính.** Trước đây mỗi thuốc là một thẻ lớn xếp chồng, 20 thẻ mỗi trang. Nay màn hình từ cỡ `sm` trở lên hiện bảng gồm: thuốc (mã, nhóm), tồn kho (quy đổi hộp/vỉ/viên), số lô, HSD gần nhất (số ngày còn lại tô màu theo ngưỡng cảnh báo), trạng thái dạng badge màu. Bấm vào dòng để mở bảng lô con (số lô, lô NCC, hạn dùng, tồn, nhà phân phối, nút Điều chỉnh / In QR). Bộ lọc gom về một hàng, có nhãn cho ô ngày; "Reset" đổi thành "Xóa lọc". Khi tải lại, danh sách cũ vẫn hiện (làm mờ) thay vì biến mất. Bản điện thoại giữ nguyên dạng thẻ.
- **Bán hàng — nút nhập nhanh tiền khách đưa.** Dưới ô "Khách đưa" có 4 nút: số tiền vừa đủ và các mức tròn gần nhất (ví dụ đơn 15.000đ → 15.000 / 20.000 / 50.000 / 100.000). Bấm là điền luôn và tính tiền trả lại. Chỉ hiện khi thanh toán tiền mặt và đơn đã có thuốc.
- **Bán hàng — đơn thuốc mẫu tìm được theo tên và dùng được khi bật "Bán theo lô".** Trước đây nút "Đơn thuốc mẫu" bị ẩn khi bật cài đặt bán theo lô (`sale.enforce_lot_policy`, mặc định bật), nên nhà thuốc không thấy nút. Nay nút luôn hiện khi có đơn mẫu đang bật. Bấm vào mở bảng có ô tìm theo tên hoặc mã, không phân biệt dấu (gõ "da day" ra "Đau dạ dày"); dùng phím mũi tên lên/xuống + Enter để chọn, Esc để đóng. Khi áp đơn mẫu, từng thuốc đi qua cùng luồng với nút "Thêm theo gợi ý" (tự chọn lô theo FEFO khi bán theo lô, tự phân bổ lô khi không). Thuốc nào không thêm được (hết hàng, đã xóa khỏi danh mục…) được liệt kê lý do, các thuốc còn lại vẫn được thêm.
- **Bán hàng — khung thanh toán gọn hơn.** Phí dịch vụ và cách tính phí nằm chung một hàng. Hình thức thanh toán đổi từ ô chọn sang nút gạt Tiền mặt / Mua nợ. Tiền trả lại / còn nợ gói vào một dòng. Sửa các nhãn bị mất dấu ("Tam tinh thuoc", "Thanh tien", "Tien tra lai", "Khách đưa chua du tien"…) và bỏ dòng hướng dẫn điểm bị lặp.
- **Menu bên trái.** Vài mục trong "Sổ GPP" dùng chung đường dẫn với mục khác (ví dụ "Sổ thông tin bệnh nhân" và "Khách hàng" cùng là `/khach-hang`), nên trước đây hai mục sáng cùng lúc và cả hai nhóm tự mở. Nay chỉ mục vừa bấm sáng, ghi nhớ trong phiên; vào trang bằng đường khác thì sáng mục đầu tiên khớp. Tiêu đề nhóm ("Cửa hàng", "Sổ GPP") không còn tô nền đậm như mục đang chọn, có mũi tên xoay khi mở/đóng, mục con có đường kẻ dọc dẫn hướng.
- **Trang Nhập hàng tải nhanh hơn (bỏ N+1 request).** Trước đây trang lấy danh sách phiếu rồi gọi thêm `GET /import-receipts/{id}` cho từng phiếu (20 request mỗi trang), chờ xong hết mới hiển thị. `GET /api/v1/inventory/import-receipts/paged` nhận thêm `include_lines=true` để trả luôn chi tiết dòng thuốc trong 1 request; mặc định vẫn trả dạng rút gọn như cũ. Frontend dùng tham số này, gặp Inventory bản cũ chưa có thì tự quay lại cách gọi từng phiếu. Thêm 3 test (`Inventory Service/tests/test_import_receipts_paged.py`).
- **Danh mục thuốc: bấm "Chi tiết" hiện ngay.** API danh sách sản phẩm (`/catalog/products`, `/products/search`, tra barcode, batch) trả thêm `instructions`, `note`, `group`, `manufacturer`, `unit_config_status`, giống API chi tiết, nên bảng không phải gọi chi tiết từng thuốc khi mở "Chi tiết" hoặc "Sửa". Catalog bản cũ vẫn chạy theo cách cũ. Thêm 2 test vào `Catalog Service/tests/test_product_list_units.py`.

### Sửa lỗi
- Từ ngày 15 trở đi, "Doanh thu tháng này" trên dashboard bị tính thiếu: dashboard chỉ lấy dữ liệu 14 ngày gần nhất rồi lọc theo tháng, nên mất các ngày đầu tháng. Nay dữ liệu được lấy từ đầu tháng (hoặc từ đầu cửa sổ 14 ngày nếu ngày đó sớm hơn).

---

## V1.16 — 2026-10-29

### Cải thiện
- **Danh mục thuốc hiện đơn vị & giá ngay trên bảng.** Trước đây cột "Đơn vị & giá" chỉ hiện "Mở chi tiết để xem" cho tới khi bấm Chi tiết từng thuốc, vì API danh sách sản phẩm không trả đơn vị (dù truy vấn đã nạp sẵn). `GET /api/v1/catalog/products` và `/products/search` nay trả thêm `units` (cùng định dạng với API chi tiết, giữ nguyên `base_unit`/`base_price` cho client cũ); bảng desktop liệt kê mỗi đơn vị một dòng kèm giá, thẻ mobile dùng chung dữ liệu. Thêm 2 test (`Catalog Service/tests/test_product_list_units.py`).

### Sửa lỗi
- Badge trạng thái "Đang bán"/"Ngừng bán" trong Danh mục thuốc bị vỡ thành hai dòng khi cột hẹp.

---

## V1.15 — 2026-10-29

### Sửa lỗi
- **Catalog xóa được sản phẩm đang còn lô trong Inventory (gốc lỗi Arginine T0386 ở V1.14).** Kiểm tra trước khi xóa trong `DELETE /api/v1/catalog/products/{id}` từng fail-open: Inventory lỗi kết nối, timeout, 5xx hay 503 (đang nạp state) đều bị hiểu là "không có lô", còn 404 bất kỳ (kể cả sai URL/route) bị hiểu là "chưa có lịch sử" nên cho xóa hẳn. Nay fail-closed: chỉ coi là "chưa có lịch sử" khi Inventory trả đúng 404 `Drug not found`, chỉ tin danh sách lô khi Inventory trả 200 kèm một mảng; mọi trường hợp khác trả 503 "Không kiểm tra được tồn kho" và không xóa gì. Gộp hai lần gọi Inventory thành một (`fetch_inventory_batches_for_product`). 15 test mới ở `Catalog Service/tests/test_delete_product_guard.py` (10 test fail trên code cũ).

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
