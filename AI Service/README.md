# AI Service — nhập phiếu nhập hàng từ hóa đơn

Service Go (chi), cổng **8011**, mount route dưới `/api/v1/ai`. Khuôn theo `File Service`
(config/env, JWT HS256 dùng chung `JWT_SECRET_KEY`, healthcheck `GET /health`, dockerfile multi-stage).
Gọi DeepSeek qua API tương thích OpenAI. Không tự ghi phiếu nhập: chỉ trả **phiếu nháp** để người dùng
kiểm tra, điền số lô/NSX/HSD rồi tự lưu.

## Luồng

1. Frontend chọn 1..N file (ảnh hoặc PDF). Mỗi trang được render/nén **trên trình duyệt** thành JPEG,
   cạnh dài ≤ 1600px, chất lượng ~0.85. PDF render bằng pdf.js; text layer của PDF (nếu có) gửi kèm.
2. `POST /api/v1/ai/purchase-invoices/extract` (multipart):
   - `pages` (lặp lại, theo đúng thứ tự trang): `image/jpeg`, mỗi file ≤ 4 MB, tối đa 10 trang.
   - `originals` (lặp lại, tùy chọn): file PDF gốc người dùng chọn, mỗi file ≤ 10 MB.
   - `sources` (bắt buộc, JSON string): mô tả nguồn gốc từng trang, theo thứ tự người dùng chọn file:
     `[{"kind": "image", "pages": [0]}, {"kind": "pdf", "pages": [1, 2], "original_index": 0, "has_text": true}]`
     (`pages` là chỉ số trong `pages`, `original_index` là chỉ số trong `originals`, `has_text` = pdf.js
     trích được text layer có nghĩa, tức PDF văn bản chứ không phải PDF scan).
   - `pdf_text` (tùy chọn, ≤ 50.000 ký tự): text trích từ các PDF.
3. Service:
   1. Kiểm tra hạn mức chi tiêu ngày (`AI_DAILY_BUDGET_USD`); vượt → `429` kèm thông báo tiếng Việt.
   2. Lưu lưu trữ lên R2 qua File Service (`POST http://file-service:8009/api/v1/file/upload`,
      field `file`, `category=invoice`, `ref_type=purchase_invoice`, `ref_id=<extraction_id>`,
      chuyển tiếp header `Authorization` của người dùng):
      - nguồn `image` → trang JPEG mã hóa lại **AVIF** (giữ kích thước, quality ~60), upload tên `p{n}.avif`;
      - nguồn `pdf` **văn bản và nhẹ** (`has_text = true` và kích thước ≤ `AI_KEEP_PDF_MAX_BYTES`,
        mặc định 1 MB) → upload **nguyên file PDF**, KHÔNG lưu ảnh các trang của nó;
      - nguồn `pdf` còn lại (PDF scan, hoặc nặng) → chỉ lưu AVIF từng trang như ảnh, bỏ file PDF.
      Mục đích: tiết kiệm dung lượng R2 nhưng vẫn giữ bản gốc nét nhất có thể.
   3. **Bước đọc** (1 request DeepSeek, model `DEEPSEEK_VISION_MODEL`, mặc định `deepseek-flash`,
      thinking tắt, `response_format: json_object`): mọi trang JPEG (base64 data URL) trong **một** user
      message theo thứ tự, kèm `pdf_text` nếu có. Model trả JSON gồm header hóa đơn + các dòng hàng.
      Số phải là number JSON (VN dùng `.` ngăn nghìn, `,` thập phân: `57.142,857` = 57142.857).
   4. **Kiểm tra bằng code** (không dùng AI): `quantity × unit_price ≈ amount` từng dòng
      (lệch ≤ max(1đ, 0,5%)), tổng tiền hàng, VAT, tổng thanh toán → mỗi chỗ lệch thành 1 `warnings`.
      Dòng không có đơn giá/thành tiền → `is_free = true`.
   5. **Nhà cung cấp**: `GET http://inventory-service:8002/api/v1/inventory/meta/suppliers`; khớp theo
      mã số thuế đã chuẩn hóa (bỏ khoảng trắng; thử nguyên mã rồi phần trước dấu `-`), không khớp thì
      `supplier.matched=false` + tối đa 3 `candidates` theo tên.
   6. **Trùng hóa đơn**: `GET http://inventory-service:8002/api/v1/inventory/import-receipts/by-invoice?serial=&number=`
      → nếu có phiếu thì trả `duplicate_receipts`.
   7. **Ghép thuốc**:
      - Trước tiên tra bảng ghi nhớ `ai_service.invoice_name_mappings` theo
        (supplier_id, `normalized_name`, `normalized_unit`) → `source = "memory"`, confidence 1.
      - Các dòng còn lại đưa cho **agent** (model `DEEPSEEK_AGENT_MODEL`, mặc định `deepseek-flash`,
        thinking tắt, function calling), tối đa 6 vòng, tối đa 30 lần gọi tool. Tool:
        - `search_products(query, limit≤20)` → `GET http://catalog-service:8006/api/v1/catalog/products/search?q=&limit=`
          (chỉ trả về cho model: id, code, name, active_ingredient, registration_number, manufacturer_name,
          units[{id, unit_name, conversion_rate, is_base_unit}]). Tìm kiếm là ILIKE chuỗi con, không bỏ dấu,
          nên model nên thử nhiều truy vấn ngắn (tên thương mại, từ khóa chính, hoạt chất).
        - `search_reference_drugs(query)` → `GET http://catalog-service:8006/api/v1/catalog/reference/drugs/search?q=&limit=10`
          (danh mục Bộ Y tế, để hiểu thuốc là gì/hoạt chất nào; KHÔNG dùng làm kết quả ghép).
        - `submit_matches(matches)`: kết thúc; mỗi phần tử
          `{line_index, product_id|null, unit_id|null, confidence 0..1, reason}`.
          Không chắc chắn → `product_id = null`. Không được bịa id: service bỏ mọi id không nằm trong
          kết quả tool đã trả về.
   8. **Đơn vị & giá** cho từng dòng đã ghép:
      - Phiếu nhập Inventory tính `quantity` và `import_price` theo **đơn vị nhập = đơn vị có
        `conversion_rate` lớn nhất** của sản phẩm.
      - Nếu đơn vị trên hóa đơn khớp đơn vị lớn nhất → giữ nguyên.
      - Nếu khớp đơn vị nhỏ hơn và số lượng quy đổi ra đơn vị nhập là số nguyên → quy đổi số lượng và giá,
        thêm `notes`. Nếu không nguyên → giữ số liệu hóa đơn, thêm cảnh báo cho người dùng tự xử lý.
      - `import_price` = đơn giá (theo đơn vị nhập) × (1 + vat_rate) nếu setting
        `purchase.ai_price_includes_vat` (Store, mặc định `true`), ngược lại = đơn giá trước VAT;
        làm tròn đến đồng. Đọc setting: `GET http://store-service:8005/api/v1/store/settings/purchase.ai_price_includes_vat`
        (public); lỗi → coi như `true`.
      - Dòng `is_free` → `import_price = 0`, không tự gộp thành khuyến mãi (người dùng tự xử lý).
   9. Ghi `ai_service.usage_log` cho mỗi request DeepSeek và trả kết quả.

## Response `200` của `/extract`

```json
{
  "extraction_id": "uuid",
  "files": [
    {"file_id": "uuid", "kind": "image", "content_type": "image/avif", "page": 1, "size": 123456},
    {"file_id": "uuid", "kind": "pdf", "content_type": "application/pdf", "page": null, "page_count": 2, "size": 234567}
  ],
  "invoice": {
    "supplier_name": "CHI NHÁNH CÔNG TY CP DƯỢC PHẨM QUỐC TẾ ABIPHA",
    "supplier_tax_code": "0105659294-002",
    "serial": "1C25TAB",
    "number": "00014320",
    "date": "2025-09-19",
    "lookup_code": "EZ00000000001035061",
    "subtotal": 768572,
    "vat_rate": 0.05,
    "vat_amount": 38428,
    "total": 807000
  },
  "supplier": {"matched": true, "supplier_id": "uuid", "name": "...", "reason": "tax_code", "candidates": []},
  "duplicate_receipts": [{"id": "rcp-12", "code": "PN0012", "receipt_date": "2025-09-19"}],
  "price_includes_vat": true,
  "lines": [
    {
      "index": 0,
      "raw_name": "THUỐC HO BỔ PHỔI ABIPHA (Hộp 1 lọ x 100ml)",
      "raw_unit": "Hộp",
      "quantity": 9,
      "unit_price": 57142.857,
      "amount": 514286,
      "vat_rate": 0.05,
      "is_free": false,
      "match": {
        "product_id": "uuid", "product_code": "T0123", "product_name": "...",
        "unit_id": "uuid", "unit_name": "Hộp", "conversion": 1,
        "confidence": 0.92, "source": "memory|agent|fuzzy", "reason": "..."
      },
      "draft": {"quantity": 9, "import_price": 60000},
      "notes": []
    }
  ],
  "warnings": ["Dòng 2: hàng tặng, chưa có giá"],
  "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0012}
}
```

`match` là `null` khi không ghép được. `draft.quantity`/`draft.import_price` là số đã quy đổi theo đơn vị
nhập để frontend điền thẳng vào form.

## Các endpoint khác

- `POST /api/v1/ai/purchase-invoices/mappings` — gọi sau khi lưu phiếu thành công, chỉ với các dòng người dùng
  đã chọn thuốc:
  `{"supplier_id": "uuid", "items": [{"raw_name": "...", "raw_unit": "Hộp", "product_id": "uuid", "unit_id": "uuid|null"}]}`
  → upsert, tăng `times_confirmed`. Trả `204`.
- `GET /api/v1/ai/usage/today` → `{"date": "YYYY-MM-DD", "cost_usd": 0.03, "budget_usd": 1.0, "requests": 4}`.
- `GET /health`.

## Lưu trữ (Postgres, database `pharmar_store`, schema `ai_service`, tự tạo lúc khởi động)

- `invoice_name_mappings(supplier_id text, normalized_name text, normalized_unit text, raw_name text,
  raw_unit text, product_id text, unit_id text null, times_confirmed int, updated_at timestamptz,
  primary key (supplier_id, normalized_name, normalized_unit))`.
  `normalized_*` = chữ thường, bỏ dấu tiếng Việt (đ→d), gộp khoảng trắng.
- `usage_log(id bigserial, created_at timestamptz, kind text, model text, input_tokens int,
  cached_input_tokens int, output_tokens int, cost_usd numeric(12,6), user_id text)`.

## Cấu hình (env)

| Biến | Mặc định |
|---|---|
| `APP_PORT` | 8011 |
| `DATABASE_URL` | (bắt buộc) |
| `JWT_SECRET_KEY`, `JWT_ALGORITHM` | dùng chung |
| `DEEPSEEK_API_KEY` | rỗng → mọi endpoint AI trả `503` "Chưa cấu hình AI" |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_AGENT_MODEL` | `deepseek-flash` |
| `DEEPSEEK_PRICE_INPUT_MISS`, `DEEPSEEK_PRICE_INPUT_HIT`, `DEEPSEEK_PRICE_OUTPUT` | USD/1M token, theo giá cao điểm: `0.3`, `0.006`, `1.2` |
| `AI_DAILY_BUDGET_USD` | `1.0` |
| `AI_KEEP_PDF_MAX_BYTES` | `1048576` |
| `AI_REQUEST_TIMEOUT_SECONDS` | `90` |
| `FILE_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `CATALOG_SERVICE_URL`, `STORE_SERVICE_URL` | URL nội bộ docker |

## Inventory: trường hóa đơn trên phiếu nhập

`ImportReceiptCreateRequest` (và update) nhận thêm, đều tùy chọn:
`invoice_serial` (≤ 32), `invoice_number` (≤ 32), `invoice_date` (date), `invoice_file_ids` (list id File Service,
≤ 20). Lưu vào receipt và trả ra trong view chi tiết + list. Thêm
`GET /api/v1/inventory/import-receipts/by-invoice?serial=&number=` → danh sách
`{id, code, receipt_date, supplier_id, status}` của các phiếu khớp (so sánh không phân biệt hoa thường,
bỏ số 0 đầu ở `number`).

## Xem lại hóa đơn gốc (frontend)

Phiếu nhập có `invoice_file_ids` → trong phần chi tiết phiếu ở trang Nhập hàng hiện mục "Hóa đơn gốc":
lấy metadata bằng `GET /api/v1/file/{id}` và URL tạm bằng `GET /api/v1/file/presign/download/{id}`.
Ảnh (`image/*`, gồm AVIF): lưới ảnh thu nhỏ, bấm mở xem lớn (phóng to/kéo, chuyển trang trước/sau).
PDF: mở trong khung xem PDF của trình duyệt (iframe trong modal) + nút "Mở tab mới" và "Tải về".
URL presign hết hạn thì lấy lại khi mở.

## Store: setting mới

`purchase.ai_price_includes_vat` — bool, mặc định `true`, group `purchase`, public.

## Ghi chú triển khai (code)

- Cấu trúc: `cmd/ai-service`, `internal/{config,auth,httpapi,app,deepseek,agent,prompts,invoice,imgstore,textutil}`.
  Logic thuần (kiểm tra số, ghép NCC, quy đổi đơn vị, kế hoạch lưu trữ, lọc id của agent) nằm trong `invoice`,
  `imgstore`, `agent` và có unit test; chạy `go test -tags nodynamic ./...` (thiếu tag này thì trên Linux thư viện AVIF thử nạp libavif động qua purego và segfault lúc khởi động).
- Go 1.23 (không phải 1.22 như File Service) vì `github.com/gen2brain/avif` kéo theo `wazero` yêu cầu 1.23. Build `CGO_ENABLED=0`:
  libavif chạy dưới dạng WASM trong wazero. Đo trong container Linux với hóa đơn thật 1132x1600: ~1 giây mỗi trang,
  JPEG 272 KB → AVIF 120 KB (quality 60, chữ nhỏ vẫn đọc rõ), RAM tiến trình ~210–260 MB khi mã hóa. Service chỉ mã hóa
  1 trang một lúc; nếu đặt giới hạn bộ nhớ container thì nên ≥ 512 MB.
- Việc lưu trữ (AVIF/PDF lên File Service) chạy song song với bước đọc AI. Lưu lỗi chỉ thành `warnings` (kèm `files` thiếu), không làm hỏng kết quả.
- Không có `DEEPSEEK_API_KEY`: `/extract` trả `503 "Chưa cấu hình AI"`; `/mappings`, `/usage/today`, `/health` vẫn chạy.
- `AI_DAILY_BUDGET_USD <= 0` nghĩa là không giới hạn. Ngày tính theo giờ Việt Nam (UTC+7). Hạn mức kiểm tra đầu mỗi request nên có thể vượt tối đa một request.
- Hàng tặng: `unit_price`/`amount` = null, `draft.import_price` = 0. `match.unit_id`/`unit_name` = null nếu không xác định được đơn vị (kèm `notes`).
- Ghép thuốc xác định trước agent (`invoice/candidates.go`, `app.retrieveCandidates`): với mỗi dòng chưa có trong bộ nhớ, bỏ phần ngoặc đóng gói, bỏ từ chung (thuốc, viên, hộp, lọ, chai, gói, ống, vỉ, siro, dung dịch, kem, gel, mg, ml, g, x, và), tạo tối đa 4 truy vấn (tên đầy đủ, từ thương hiệu trùng tên NCC, rồi các từ ≥ 3 chữ dài nhất trước), gộp truy vấn trùng giữa các dòng, gọi `SearchProducts(q, 20)`. Điểm = Dice trên token đã bỏ dấu (+0,1 nếu trùng token thương hiệu, tối đa 1); giữ top 5/dòng và đưa vào user message của agent (id của chúng được coi là đã thấy).
- `match.source = "fuzzy"`: nếu agent lỗi hoặc trả null mà ứng viên đầu có điểm ≥ 0,6 và hơn ứng viên thứ hai ≥ 0,15 thì nhận ứng viên đó, `confidence = min(0.8, 0.5 + 0.3×điểm)`, `reason = "Khớp gần đúng theo tên (bỏ dấu)"`, không có `unit_id` từ AI (đơn vị suy ra theo `raw_unit`).
- Ứng viên NCC theo tên bỏ các từ chung (chi nhánh, công ty, cổ phần, cp, tnhh, mtv, dược phẩm, dược, thương mại, tm, dịch vụ, dv, xuất nhập khẩu, xnk, quốc tế, việt nam, tập đoàn) và cần điểm ≥ 0,5 trên token còn lại.
