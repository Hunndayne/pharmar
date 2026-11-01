# Việc frontend cho tính năng "Nhập từ hóa đơn"

Đọc `AI Service/README.md` trước: đó là hợp đồng API (multipart `pages` / `originals` / `sources` / `pdf_text`,
response JSON, endpoint `mappings`, các trường hóa đơn trên phiếu nhập, phần "Xem lại hóa đơn gốc", setting Store).
Quy ước dự án trong `CLAUDE.md`: mobile-first (`sm:hidden` thẻ + `hidden sm:block` bảng), TypeScript strict
không `any`, Tailwind, chữ tiếng Việt có dấu đầy đủ. Chỉ sửa trong `FrontEnd/`.

## 1. API client
- File mới `src/api/aiService.ts`, theo khuôn `src/api/fileService.ts` / `src/api/httpClient.ts`:
  `extractPurchaseInvoice(token, {pages, originals, sources, pdfText})` (multipart, request có thể mất 60–90 giây,
  không đặt timeout ngắn, không tự retry), `confirmMappings`, `getUsageToday`. Lỗi backend trả `{"detail": "..."}`.
- `src/api/fileService.ts`: thêm `getFile(id)` (`GET /api/v1/file/{id}`) và `presignDownload(id)`
  (`GET /api/v1/file/presign/download/{id}`) nếu chưa có.

## 2. Kiểu dữ liệu Inventory
`src/api/inventoryService.ts`: thêm tùy chọn `invoice_serial`, `invoice_number`, `invoice_date`, `invoice_file_ids`
vào payload tạo/sửa phiếu nhập và vào kiểu view (chi tiết + list). Đều optional vì backend cũ không trả.

## 3. Chuẩn bị file (module mới, ví dụ `src/utils/invoiceFiles.ts`)
- Ảnh: `createImageBitmap(file, { imageOrientation: 'from-image' })` → thu nhỏ cạnh dài ≤ 1600px (không phóng to)
  → canvas nền trắng → `toBlob('image/jpeg', 0.85)`. Không decode được (HEIC trên trình duyệt không phải Safari)
  → báo tiếng Việt yêu cầu JPEG/PNG.
- PDF: thêm `pdfjs-dist` (ghim version chính xác), worker kiểu Vite
  (`pdfjs-dist/build/pdf.worker.min.mjs?url`), `import()` động để không phình bundle chính. Render từng trang
  cạnh dài ~1600px → JPEG; `getTextContent` lấy text layer; `has_text` = text đã trim dài > ~50 ký tự;
  giữ File gốc cho `originals`.
- Giới hạn: tổng ≤ 10 trang, mỗi PDF ≤ 10 MB.
- Tạo mảng `sources` đúng như README, và `pdf_text` (ghép lại, ≤ 50.000 ký tự).

## 4. Trang Nhập hàng (`src/pages/Purchases.tsx`)
- Nút "Nhập từ hóa đơn" cạnh nút tạo phiếu → modal:
  chọn file `image/*,application/pdf` nhiều file (không đặt `capture` để vẫn chọn được thư viện ảnh),
  danh sách file theo thứ tự có xóa / lên / xuống, nút "Đọc hóa đơn" với trạng thái
  "Đang chuẩn bị ảnh…" → "AI đang đọc hóa đơn… (có thể mất 30–60 giây)", hiện lỗi.
- Bước kết quả: nhà cung cấp (khớp / "chưa khớp" + select chọn NCC có sẵn), ký hiệu / số / ngày hóa đơn,
  kiểm tra tổng + `warnings`, cảnh báo nổi bật nếu có `duplicate_receipts` (vẫn cho tiếp tục),
  số dòng và số dòng tự khớp, chi phí nhỏ → nút "Mở phiếu nháp".
- Mở phiếu nháp dùng lại luồng tạo phiếu: `openCreate` (~dòng 1507) nhận thêm một `OrderFormState` điền sẵn
  (ưu tiên tham số rõ ràng thay vì localStorage). Điền: `date` = ngày hóa đơn (không có thì hôm nay),
  `supplierId`, `note` = `HĐ {serial} số {number}`, các dòng: `drugId` = `match.product_id` (null → trống),
  `quantity` = `draft.quantity`, `price` = `draft.import_price`; để trống `lotNumber` / `mfgDate` / `expDate`;
  dòng `is_free` giá 0. Giữ các trường hóa đơn (serial, number, date, `files[].file_id`) trong state để gửi kèm khi lưu.
- Gợi ý AI trong form: map phụ `lineId → {raw_name, raw_unit, confidence, source, reason, is_free, notes}`.
  Dưới mỗi dòng: tên + đơn vị trên hóa đơn, "AI {confidence}%" hoặc "Đã nhớ", tô đỏ/vàng khi chưa khớp hoặc
  confidence < 0.8, badge "Hàng tặng – tự xử lý", notes. Người dùng đổi thuốc bình thường.
- Lưu thành công phiếu tạo từ AI → gọi `confirmMappings` với `supplier_id` và mỗi dòng có drugId + gợi ý:
  `{raw_name, raw_unit, product_id: drugId, unit_id}` (`unit_id` = `match.unit_id` nếu người dùng không đổi thuốc,
  ngược lại null). Gọi lỗi thì chỉ `console.warn`, không chặn lưu. Xóa state AI sau khi lưu hoặc hủy.
- Payload lưu (`buildInventoryPayloadFromForm` ~dòng 790) gửi thêm 4 trường hóa đơn; khi sửa phiếu cũ thì
  map các trường này vào form và gửi lại để không mất.

## 5. Xem lại hóa đơn gốc
- **Nút "Xem hóa đơn" trong khung chi tiết phiếu nhập** (khung mở ra khi bấm "Chi tiết" trên danh sách, gồm thẻ
  "Thông tin phiếu", "Tổng tiền", "Dòng thuốc"…): đặt ở góc trên thẻ "Thông tin phiếu", cạnh badge trạng thái
  thanh toán; kèm số file nếu > 1, ví dụ "Xem hóa đơn (2)". Chỉ hiện khi phiếu có `invoice_file_ids`.
  Làm cả trên giao diện desktop lẫn thẻ mobile.
- Bấm nút → **popup (modal) hiển thị hóa đơn đã chụp/tải lên**, mở ở trang đầu tiên. Không cần lưới ảnh thu nhỏ
  nằm sẵn trong khung chi tiết.

Component dùng lại được, ví dụ `src/components/InvoiceFilesViewer.tsx` (modal xem file), khi có `invoice_file_ids`: 
- Tải metadata (`GET /api/v1/file/{id}`) + URL presign khi bấm nút, không tải trước.
- Modal gần toàn màn hình, nền tối. Nếu có nhiều file: thanh chuyển trang ("Trang 1/3", nút trước/sau, phím ←/→)
  và dải ảnh thu nhỏ nhỏ ở dưới để nhảy trang.
- File ảnh (`image/*`, gồm AVIF): hiển thị vừa khung; phóng to bằng nút +/− hoặc bấm vào ảnh, kéo để di chuyển khi
  đang phóng to (hỗ trợ cảm ứng trên điện thoại).
- File PDF: hiển thị bằng `<iframe>` URL presign trong modal, kèm "Mở tab mới" và "Tải về".
- Đóng bằng nút ×, phím Esc hoặc bấm nền. URL presign hết hạn thì lấy lại khi mở lại.

## 6. Cài đặt
`src/pages/StoreSettings.tsx`: công tắc "Giá nhập từ hóa đơn (AI) đã gồm VAT", key
`purchase.ai_price_includes_vat` (mặc định `true`), đọc/lưu giống `sale.enforce_lot_policy` (~dòng 293 và ~1026),
kèm một dòng giải thích.

## Kiểm tra
Trong `FrontEnd/`: `npm install`, `npx tsc -b` sạch, `npx eslint` các file đã sửa không thêm lỗi so với HEAD,
`npx vite build` để chắc worker pdf.js bundle được.
