# Sale Service Documentation

## 1) Overview

Sale Service quản lý:

- Invoices (hóa đơn bán hàng)
- Invoice Items (chi tiết hóa đơn)
- Held Orders (đơn tạm giữ - chuyển đổi giữa nhiều khách)
- Returns (trả hàng)
- Shifts (ca làm việc)
- Payment Methods (phương thức thanh toán)
- Cashier Stats (thống kê theo nhân viên)

Service được viết bằng FastAPI, sử dụng PostgreSQL schema `sale`.

## 2) Base URL và Authentication

- Through gateway: `http://localhost:8000/api/v1/sale`
- Direct service: `http://localhost:8008/api/v1/sale`

Tất cả endpoints yêu cầu Bearer token:

```http
Authorization: Bearer <access_token>
```

## 3) Permissions

- `All`: owner, manager, staff
- `Manager+`: owner, manager
- `Owner`: owner only

## 4) Service Integrations

Sale Service gọi đến 5 services khác:

| Service | Mục đích |
|---------|----------|
| **Auth Service** | Verify token, get user info |
| **Store Service** | Get settings (auto_print, allow_negative_stock) |
| **Catalog Service** | Get product info, prices, barcode lookup |
| **Inventory Service** | Reserve, confirm, release, return stock |
| **Customer Service** | Lookup customer, points, promotions |

```
┌─────────────────────────────────────────────────────────────────┐
│                    SERVICE INTEGRATIONS                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                      ┌──────────────┐                          │
│                      │ Sale Service │                          │
│                      └──────┬───────┘                          │
│                             │                                   │
│         ┌───────────────────┼───────────────────┐              │
│         │                   │                   │              │
│         ▼                   ▼                   ▼              │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐         │
│  │   Store    │     │  Catalog   │     │ Inventory  │         │
│  │  Service   │     │  Service   │     │  Service   │         │
│  └────────────┘     └────────────┘     └────────────┘         │
│        │                   │                   │               │
│        ▼                   ▼                   ▼               │
│  • Settings          • Product info     • Reserve stock       │
│  • auto_print        • Unit prices      • Confirm stock       │
│  • allow_negative    • Barcode lookup   • Release stock       │
│                                         • Return stock        │
│                                                                 │
│         ┌───────────────────┼───────────────────┐              │
│         │                   │                   │              │
│         ▼                   ▼                   ▼              │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐         │
│  │  Customer  │     │    Auth    │     │   Report   │         │
│  │  Service   │     │  Service   │     │  Service   │         │
│  └────────────┘     └────────────┘     └────────────┘         │
│        │                   │                   │               │
│        ▼                   ▼                   ▼               │
│  • Lookup customer   • Verify token     • Push sale data      │
│  • Earn/redeem pts   • Get user info                          │
│  • Apply promotion   • Cashier name                           │
│  • Update stats                                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 5) Data Models

### 5.1 Payment Methods (Master Data)

| Field | Type | Mô tả |
|-------|------|-------|
| code | string | Primary key (cash, card, transfer...) |
| name | string | Tên hiển thị |
| is_active | boolean | Đang hoạt động |
| display_order | int | Thứ tự hiển thị |
| requires_reference | boolean | Cần nhập mã giao dịch |
| created_at | timestamp | |

**Default payment methods:**

| Code | Name | Requires Reference |
|------|------|-------------------|
| cash | Tiền mặt | false |
| card | Thẻ | true |
| transfer | Chuyển khoản | true |
| momo | MoMo | true |
| zalopay | ZaloPay | true |
| vnpay | VNPay | true |

### 5.2 Invoices (Hóa đơn)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| code | string | Mã hóa đơn (HD20260214001) |
| **Customer (snapshot)** |
| customer_id | UUID | FK → Customer (nullable) |
| customer_code | string | Mã KH |
| customer_name | string | Tên KH |
| customer_phone | string | SĐT |
| customer_tier | string | Hạng KH |
| **Amounts** |
| subtotal | decimal | Tổng tiền hàng |
| discount_amount | decimal | Tổng giảm giá |
| tier_discount | decimal | Giảm theo hạng KH |
| promotion_discount | decimal | Giảm KM |
| points_discount | decimal | Giảm từ điểm |
| total_amount | decimal | Thành tiền |
| **Points** |
| points_used | int | Điểm đã dùng |
| points_earned | int | Điểm tích được |
| **Promotion** |
| promotion_id | UUID | FK → Promotion |
| promotion_code | string | Mã KM |
| **Payment** |
| payment_method | enum | cash/card/transfer/momo/zalopay/vnpay/mixed |
| amount_paid | decimal | Số tiền KH đưa |
| change_amount | decimal | Tiền thừa |
| **Status** |
| status | enum | pending/completed/cancelled/returned |
| cancelled_at | timestamp | |
| cancelled_by | UUID | |
| cancel_reason | string | |
| **Cashier (audit)** |
| created_by | UUID | Cashier ID |
| created_by_name | string | Tên cashier |
| cashier_code | string | Mã nhân viên |
| commission_rate | decimal | % hoa hồng |
| commission_amount | decimal | Tiền hoa hồng |
| shift_id | UUID | Ca làm việc |
| **Timestamps** |
| note | string | |
| created_at | timestamp | |
| updated_at | timestamp | |

### 5.3 Invoice Items (Chi tiết hóa đơn)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| invoice_id | UUID | FK → Invoices |
| **Product (snapshot)** |
| product_id | UUID | FK → Product |
| product_code | string | Mã thuốc |
| product_name | string | Tên thuốc |
| **Unit (snapshot)** |
| unit_id | UUID | FK → Product Unit |
| unit_name | string | Đơn vị |
| conversion_rate | int | Quy đổi |
| **Batch (snapshot)** |
| batch_id | UUID | FK → Batch |
| lot_number | string | Số lô |
| expiry_date | date | Hạn sử dụng |
| **Pricing** |
| unit_price | decimal | Giá bán |
| quantity | int | Số lượng |
| discount_amount | decimal | Giảm giá dòng |
| line_total | decimal | Thành tiền |
| **Return tracking** |
| returned_quantity | int | SL đã trả |
| created_at | timestamp | |

### 5.4 Invoice Payments (Chi tiết thanh toán - mixed payment)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| invoice_id | UUID | FK → Invoices |
| payment_method | string | Phương thức |
| amount | decimal | Số tiền |
| reference_code | string | Mã giao dịch |
| card_type | string | Loại thẻ (visa, master, atm) |
| card_last_4 | string | 4 số cuối thẻ |
| note | string | |
| created_at | timestamp | |

### 5.5 Held Orders (Đơn tạm giữ)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| code | string | Mã đơn giữ (HOLD001) |
| **Customer** |
| customer_id | UUID | |
| customer_name | string | |
| customer_phone | string | |
| customer_tier | string | |
| **Cart** |
| items | JSONB | Danh sách sản phẩm |
| subtotal | decimal | |
| **Promotion/Points** |
| promotion_code | string | KM đã chọn |
| points_to_use | int | Điểm định dùng |
| **Status** |
| status | enum | active/resumed/expired/cancelled |
| expires_at | timestamp | Hết hạn giữ |
| priority | int | Thứ tự ưu tiên |
| note | string | |
| **Audit** |
| created_by | UUID | |
| created_by_name | string | |
| created_at | timestamp | |
| resumed_at | timestamp | |
| resumed_invoice_id | UUID | |

### 5.6 Returns (Trả hàng)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| code | string | Mã trả hàng (TH20260214001) |
| invoice_id | UUID | FK → Invoice gốc |
| invoice_code | string | |
| **Customer** |
| customer_id | UUID | |
| customer_name | string | |
| **Amounts** |
| total_return_amount | decimal | Tổng tiền trả |
| points_returned | int | Điểm hoàn lại |
| **Refund** |
| refund_method | enum | cash/card/points |
| refund_amount | decimal | Tiền hoàn |
| **Status** |
| status | enum | pending/completed/rejected |
| reason | string | Lý do trả |
| **Audit** |
| created_by | UUID | |
| created_by_name | string | |
| approved_by | UUID | Manager duyệt |
| approved_at | timestamp | |
| created_at | timestamp | |

### 5.7 Return Items (Chi tiết trả hàng)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| return_id | UUID | FK → Returns |
| invoice_item_id | UUID | FK → Invoice Item |
| product_id | UUID | |
| product_name | string | |
| unit_name | string | |
| batch_id | UUID | |
| quantity | int | SL trả |
| unit_price | decimal | Giá lúc mua |
| return_amount | decimal | Tiền trả |
| reason | string | |
| condition | enum | good/damaged/expired |
| created_at | timestamp | |

### 5.8 Shifts (Ca làm việc)

| Field | Type | Mô tả |
|-------|------|-------|
| id | UUID | Primary key |
| code | string | Mã ca (CA20260214001) |
| **Cashier** |
| cashier_id | UUID | |
| cashier_name | string | |
| cashier_code | string | |
| **Time** |
| started_at | timestamp | Mở ca |
| ended_at | timestamp | Đóng ca |
| **Money** |
| opening_amount | decimal | Tiền đầu ca |
| closing_amount | decimal | Tiền cuối ca |
| expected_amount | decimal | Tiền dự kiến |
| difference | decimal | Chênh lệch |
| **Stats** |
| total_invoices | int | Số hóa đơn |
| total_sales | decimal | Tổng doanh số |
| total_returns | decimal | Tổng trả hàng |
| total_cancelled | decimal | Tổng hủy |
| cash_sales | decimal | Doanh số tiền mặt |
| card_sales | decimal | Doanh số thẻ |
| transfer_sales | decimal | Doanh số CK |
| **Status** |
| status | enum | open/closed |
| note | string | |
| created_at | timestamp | |
| updated_at | timestamp | |

## 6) API Endpoints

### 6.1 Health

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/health` | Health check | Public |

### 6.2 Payment Methods

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/payment-methods` | Danh sách PTTT | All |
| POST | `/payment-methods` | Thêm PTTT | Owner |
| PUT | `/payment-methods/{code}` | Cập nhật PTTT | Owner |
| DELETE | `/payment-methods/{code}` | Xóa PTTT | Owner |

### 6.3 Invoices

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/invoices` | Danh sách hóa đơn | All |
| GET | `/invoices/{id}` | Chi tiết hóa đơn | All |
| GET | `/invoices/code/{code}` | Tìm theo mã | All |
| POST | `/invoices` | Tạo hóa đơn (checkout) | All |
| POST | `/invoices/{id}/cancel` | Hủy hóa đơn | Manager+ |
| GET | `/invoices/{id}/print` | Lấy data in | All |
| POST | `/invoices/{id}/reprint` | In lại | All |

### 6.4 Held Orders

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/held-orders` | Danh sách đơn giữ | All |
| GET | `/held-orders/my` | Đơn giữ của tôi | All |
| GET | `/held-orders/count` | Số đơn đang giữ | All |
| GET | `/held-orders/{id}` | Chi tiết | All |
| POST | `/held-orders` | Tạo đơn giữ | All |
| PUT | `/held-orders/{id}` | Cập nhật | All |
| POST | `/held-orders/{id}/resume` | Resume → tạo invoice | All |
| DELETE | `/held-orders/{id}` | Hủy đơn giữ | All |

### 6.5 Returns

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/returns` | Danh sách trả hàng | All |
| GET | `/returns/{id}` | Chi tiết | All |
| POST | `/returns` | Tạo phiếu trả | All |
| POST | `/returns/{id}/approve` | Duyệt trả hàng | Manager+ |
| POST | `/returns/{id}/reject` | Từ chối | Manager+ |

### 6.6 Shifts

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/shifts` | Danh sách ca | Manager+ |
| GET | `/shifts/current` | Ca hiện tại của user | All |
| GET | `/shifts/{id}` | Chi tiết ca | All |
| POST | `/shifts/open` | Mở ca mới | All |
| POST | `/shifts/close` | Đóng ca | All |
| GET | `/shifts/{id}/report` | Báo cáo ca | All |

### 6.7 Statistics

| Method | Endpoint | Mô tả | Quyền |
|--------|----------|-------|-------|
| GET | `/stats/today` | Thống kê hôm nay | All |
| GET | `/stats/shift/{shift_id}` | Thống kê theo ca | All |
| GET | `/stats/by-cashier` | Doanh số theo NV | Manager+ |
| GET | `/stats/by-cashier/{user_id}` | Chi tiết 1 NV | Manager+ |
| GET | `/stats/commission` | Báo cáo hoa hồng | Manager+ |

## 7) Business Flows

### 7.1 POS Checkout Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      POS CHECKOUT FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. SCAN/ADD ITEMS                                             │
│     │                                                           │
│     ├─→ GET /catalog/products/barcode/{barcode}                │
│     │   → Get product + unit info                              │
│     │                                                           │
│     ├─→ GET /inventory/batches/suggest-issue                   │
│     │   → Get batch suggestion (FEFO/FIFO)                     │
│     │                                                           │
│     └─→ Build cart items locally                               │
│                                                                 │
│  2. ADD CUSTOMER (optional)                                    │
│     │                                                           │
│     ├─→ GET /customer/customers/phone/{phone}                  │
│     │   → Get customer info, tier, points                      │
│     │                                                           │
│     └─→ Apply tier discount if any                             │
│                                                                 │
│  3. APPLY PROMOTION (optional)                                 │
│     │                                                           │
│     ├─→ GET /customer/internal/promotions/suggest              │
│     │   → Get suggested promotions                             │
│     │                                                           │
│     ├─→ POST /customer/internal/promotions/validate            │
│     │   → Validate selected promotion                          │
│     │                                                           │
│     └─→ Calculate promotion discount                           │
│                                                                 │
│  4. USE POINTS (optional)                                      │
│     │                                                           │
│     └─→ Calculate points discount                              │
│         points_discount = points_used * point_value            │
│                                                                 │
│  5. CHECKOUT                                                   │
│     │                                                           │
│     ├─→ POST /inventory/reserve                                │
│     │   → Reserve stock (all-or-nothing)                       │
│     │   → If fail (409) → Show "hết hàng" error               │
│     │                                                           │
│     ├─→ POST /sale/invoices                                    │
│     │   │                                                       │
│     │   ├─→ Create invoice + items                             │
│     │   │                                                       │
│     │   ├─→ POST /inventory/reserve/{id}/confirm               │
│     │   │   → Confirm stock deduction                          │
│     │   │                                                       │
│     │   ├─→ POST /customer/internal/points/redeem              │
│     │   │   → Deduct points (if used)                          │
│     │   │                                                       │
│     │   ├─→ POST /customer/internal/promotions/apply           │
│     │   │   → Record promotion usage                           │
│     │   │                                                       │
│     │   ├─→ POST /customer/internal/points/earn                │
│     │   │   → Add points earned                                │
│     │   │                                                       │
│     │   └─→ POST /customer/internal/stats/update               │
│     │       → Update customer stats                            │
│     │                                                           │
│     └─→ Return invoice with print data                         │
│                                                                 │
│  6. PRINT RECEIPT                                              │
│     │                                                           │
│     └─→ GET /sale/invoices/{id}/print                          │
│         → Get formatted receipt data                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Cancel Invoice Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CANCEL INVOICE FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  POST /sale/invoices/{id}/cancel                               │
│     │                                                           │
│     ├─→ Validate invoice status == 'completed'                 │
│     │                                                           │
│     ├─→ POST /inventory/stock/return                           │
│     │   → Return stock to batches                              │
│     │                                                           │
│     ├─→ POST /customer/internal/points/rollback                │
│     │   → Rollback earned points                               │
│     │   → Rollback used points (return to customer)            │
│     │                                                           │
│     ├─→ POST /customer/internal/promotions/rollback            │
│     │   → Decrease promotion usage                             │
│     │                                                           │
│     ├─→ Update invoice status = 'cancelled'                    │
│     │                                                           │
│     └─→ Update shift stats                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Return Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       RETURN FLOW                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. CREATE RETURN REQUEST                                      │
│     │                                                           │
│     └─→ POST /sale/returns                                     │
│         → Staff tạo phiếu trả                                  │
│         → Status = 'pending'                                   │
│                                                                 │
│  2. APPROVE RETURN (Manager+)                                  │
│     │                                                           │
│     └─→ POST /sale/returns/{id}/approve                        │
│         │                                                       │
│         ├─→ POST /inventory/stock/return                       │
│         │   → Return good items to batches                     │
│         │                                                       │
│         ├─→ POST /customer/internal/points/rollback            │
│         │   → Adjust points proportionally                     │
│         │                                                       │
│         ├─→ Update invoice_items.returned_quantity             │
│         │                                                       │
│         ├─→ Update invoice status if fully returned            │
│         │                                                       │
│         └─→ Process refund (cash/card/points)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.4 Held Orders Flow (Multi-order handling)

```
┌─────────────────────────────────────────────────────────────────┐
│                    HELD ORDERS FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Tình huống: Đang bán cho KH A, KH B đến cần thanh toán gấp    │
│                                                                 │
│  ┌─────────────────┐                                           │
│  │  Đơn KH A       │  ← Đang nhập hàng                         │
│  │  - Panadol x2   │                                           │
│  │  - Vitamin C x1 │                                           │
│  └────────┬────────┘                                           │
│           │                                                     │
│           │ [Hold] - POST /held-orders                         │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │  HELD ORDERS    │                                           │
│  │  ─────────────  │                                           │
│  │  • Đơn KH A ⏸️   │  ← Lưu tạm, có thể quay lại               │
│  │  • Đơn KH C ⏸️   │  ← Có thể hold nhiều đơn                  │
│  └─────────────────┘                                           │
│           │                                                     │
│           │ Bán cho KH B (đơn mới)                             │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │  Đơn KH B       │  ← POST /invoices                         │
│  │  - Thuốc ho x1  │                                           │
│  │  [Thanh toán ✓] │                                           │
│  └────────┬────────┘                                           │
│           │                                                     │
│           │ [Resume] - POST /held-orders/{id}/resume           │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │  Đơn KH A       │  ← Tiếp tục bán                           │
│  │  - Panadol x2   │                                           │
│  │  - Vitamin C x1 │                                           │
│  │  + Thêm hàng... │                                           │
│  │  [Thanh toán]   │                                           │
│  └─────────────────┘                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.5 Shift Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       SHIFT FLOW                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. MỞ CA                                                      │
│     │                                                           │
│     └─→ POST /shifts/open                                      │
│         {                                                       │
│           "opening_amount": 500000,                            │
│           "note": "Ca sáng"                                    │
│         }                                                       │
│         → Tạo shift mới, status = 'open'                       │
│                                                                 │
│  2. BÁN HÀNG                                                   │
│     │                                                           │
│     └─→ Các invoice được gắn shift_id                          │
│         → Stats tự động cập nhật                               │
│                                                                 │
│  3. ĐÓNG CA                                                    │
│     │                                                           │
│     └─→ POST /shifts/close                                     │
│         {                                                       │
│           "closing_amount": 1500000,                           │
│           "note": "Đã kiểm tiền"                               │
│         }                                                       │
│         → Tính expected_amount từ các giao dịch                │
│         → Tính difference = closing - expected                 │
│         → Status = 'closed'                                    │
│                                                                 │
│  4. BÁO CÁO CA                                                 │
│     │                                                           │
│     └─→ GET /shifts/{id}/report                                │
│         → Chi tiết doanh số theo payment method                │
│         → Danh sách invoices trong ca                          │
│         → Thống kê tổng hợp                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 8) Request/Response Samples

### 8.1 Create Invoice (Checkout)

`POST /invoices`

**Request - Single payment:**

```json
{
  "customer_id": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "product_id": "uuid",
      "unit_id": "uuid",
      "batch_id": "uuid",
      "quantity": 2,
      "unit_price": 25000,
      "discount_amount": 0
    },
    {
      "product_id": "uuid",
      "unit_id": "uuid",
      "batch_id": "uuid",
      "quantity": 1,
      "unit_price": 150000,
      "discount_amount": 10000
    }
  ],
  "promotion_code": "SALE20",
  "points_used": 100,
  "payment_method": "cash",
  "amount_paid": 200000,
  "note": "Khách quen"
}
```

**Request - Mixed payment:**

```json
{
  "customer_id": "uuid",
  "items": [...],
  "promotion_code": "SALE20",
  "points_used": 100,
  "payments": [
    {
      "method": "cash",
      "amount": 100000
    },
    {
      "method": "card",
      "amount": 80000,
      "card_type": "visa",
      "card_last_4": "1234",
      "reference_code": "TXN123456"
    },
    {
      "method": "momo",
      "amount": 20000,
      "reference_code": "MOMO789"
    }
  ],
  "note": "Thanh toán kết hợp"
}
```

**Response 201:**

```json
{
  "id": "uuid",
  "code": "HD20260214001",
  "customer": {
    "id": "uuid",
    "code": "KH0001",
    "name": "Nguyen Van A",
    "phone": "0901234567",
    "tier": "gold"
  },
  "items": [
    {
      "id": "uuid",
      "product_code": "T0001",
      "product_name": "Panadol Extra",
      "unit_name": "Vỉ",
      "lot_number": "PA-0226",
      "expiry_date": "2027-12-10",
      "quantity": 2,
      "unit_price": 25000,
      "discount_amount": 0,
      "line_total": 50000
    }
  ],
  "subtotal": 200000,
  "discount_amount": 50000,
  "tier_discount": 10000,
  "promotion_discount": 30000,
  "points_discount": 10000,
  "total_amount": 150000,
  "points_used": 100,
  "points_earned": 150,
  "promotion_code": "SALE20",
  "payment_method": "mixed",
  "payments": [
    {
      "method": "cash",
      "method_name": "Tiền mặt",
      "amount": 100000
    },
    {
      "method": "card",
      "method_name": "Thẻ",
      "amount": 80000,
      "card_type": "visa",
      "card_last_4": "1234"
    },
    {
      "method": "momo",
      "method_name": "MoMo",
      "amount": 20000,
      "reference_code": "MOMO789"
    }
  ],
  "amount_paid": 200000,
  "change_amount": 50000,
  "cashier": {
    "id": "uuid",
    "code": "NV001",
    "name": "Nguyen Van A"
  },
  "shift_id": "uuid",
  "status": "completed",
  "created_at": "2026-02-14T14:30:00Z"
}
```

### 8.2 List Invoices

`GET /invoices?status=completed&date_from=2026-02-14&date_to=2026-02-14&cashier_id=uuid&page=1&size=20`

**Response 200:**

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "HD20260214001",
      "customer_name": "Nguyen Van A",
      "customer_phone": "0901234567",
      "total_amount": 150000,
      "payment_method": "cash",
      "status": "completed",
      "cashier_name": "Staff01",
      "created_at": "2026-02-14T14:30:00Z"
    }
  ],
  "total": 50,
  "page": 1,
  "size": 20,
  "pages": 3
}
```

### 8.3 Cancel Invoice

`POST /invoices/{id}/cancel`

**Request:**

```json
{
  "reason": "Khách đổi ý không mua"
}
```

**Response 200:**

```json
{
  "message": "Invoice cancelled",
  "invoice": {
    "id": "uuid",
    "code": "HD20260214001",
    "status": "cancelled",
    "cancelled_at": "2026-02-14T15:00:00Z",
    "cancelled_by": "uuid",
    "cancel_reason": "Khách đổi ý không mua"
  },
  "rollback": {
    "stock_returned": true,
    "points_refunded": 100,
    "points_earned_revoked": 150,
    "promotion_usage_revoked": true
  }
}
```

### 8.4 Create Held Order

`POST /held-orders`

**Request:**

```json
{
  "customer_id": "uuid",
  "customer_name": "Nguyen Van A",
  "customer_phone": "0901234567",
  "customer_tier": "gold",
  "items": [
    {
      "product_id": "uuid",
      "product_code": "T0001",
      "product_name": "Panadol Extra",
      "unit_id": "uuid",
      "unit_name": "Vỉ",
      "batch_id": "uuid",
      "quantity": 2,
      "unit_price": 25000,
      "line_total": 50000
    }
  ],
  "subtotal": 50000,
  "promotion_code": "SALE20",
  "points_to_use": 50,
  "note": "Khách chờ lấy thêm thuốc"
}
```

**Response 201:**

```json
{
  "id": "uuid",
  "code": "HOLD001",
  "customer_name": "Nguyen Van A",
  "items": [...],
  "subtotal": 50000,
  "status": "active",
  "expires_at": "2026-02-14T15:30:00Z",
  "created_by_name": "Staff01",
  "created_at": "2026-02-14T15:00:00Z"
}
```

### 8.5 Resume Held Order

`POST /held-orders/{id}/resume`

**Request:**

```json
{
  "additional_items": [
    {
      "product_id": "uuid",
      "unit_id": "uuid",
      "batch_id": "uuid",
      "quantity": 1,
      "unit_price": 30000
    }
  ],
  "payment_method": "cash",
  "amount_paid": 100000
}
```

**Response 200:**

```json
{
  "message": "Held order resumed",
  "held_order": {
    "id": "uuid",
    "code": "HOLD001",
    "status": "resumed",
    "resumed_at": "2026-02-14T15:20:00Z",
    "resumed_invoice_id": "uuid"
  },
  "invoice": {
    "id": "uuid",
    "code": "HD20260214002",
    "total_amount": 80000,
    "status": "completed"
  }
}
```

### 8.6 Create Return

`POST /returns`

**Request:**

```json
{
  "invoice_id": "uuid",
  "items": [
    {
      "invoice_item_id": "uuid",
      "quantity": 1,
      "reason": "Khách đổi ý",
      "condition": "good"
    }
  ],
  "refund_method": "cash",
  "reason": "Khách trả hàng"
}
```

**Response 201:**

```json
{
  "id": "uuid",
  "code": "TH20260214001",
  "invoice_code": "HD20260214001",
  "customer_name": "Nguyen Van A",
  "items": [
    {
      "id": "uuid",
      "product_name": "Panadol Extra",
      "unit_name": "Vỉ",
      "quantity": 1,
      "unit_price": 25000,
      "return_amount": 25000,
      "condition": "good"
    }
  ],
  "total_return_amount": 25000,
  "refund_method": "cash",
  "refund_amount": 25000,
  "status": "pending",
  "created_by_name": "Staff01",
  "created_at": "2026-02-14T16:00:00Z"
}
```

### 8.7 Approve Return

`POST /returns/{id}/approve`

**Response 200:**

```json
{
  "message": "Return approved",
  "return": {
    "id": "uuid",
    "code": "TH20260214001",
    "status": "completed",
    "approved_by": "uuid",
    "approved_at": "2026-02-14T16:10:00Z"
  },
  "actions": {
    "stock_returned": true,
    "points_adjusted": -25,
    "refund_amount": 25000
  }
}
```

### 8.8 Open Shift

`POST /shifts/open`

**Request:**

```json
{
  "opening_amount": 500000,
  "note": "Ca sáng"
}
```

**Response 201:**

```json
{
  "id": "uuid",
  "code": "CA20260214001",
  "cashier_id": "uuid",
  "cashier_name": "Staff01",
  "cashier_code": "NV001",
  "started_at": "2026-02-14T08:00:00Z",
  "opening_amount": 500000,
  "status": "open"
}
```

### 8.9 Close Shift

`POST /shifts/close`

**Request:**

```json
{
  "closing_amount": 1850000,
  "note": "Đã kiểm tiền"
}
```

**Response 200:**

```json
{
  "id": "uuid",
  "code": "CA20260214001",
  "cashier_name": "Staff01",
  "started_at": "2026-02-14T08:00:00Z",
  "ended_at": "2026-02-14T16:00:00Z",
  "opening_amount": 500000,
  "closing_amount": 1850000,
  "expected_amount": 1820000,
  "difference": 30000,
  "total_invoices": 45,
  "total_sales": 1500000,
  "total_returns": 50000,
  "total_cancelled": 130000,
  "cash_sales": 1000000,
  "card_sales": 300000,
  "transfer_sales": 200000,
  "status": "closed"
}
```

### 8.10 Shift Report

`GET /shifts/{id}/report`

**Response 200:**

```json
{
  "shift": {
    "id": "uuid",
    "code": "CA20260214001",
    "cashier_name": "Staff01",
    "started_at": "2026-02-14T08:00:00Z",
    "ended_at": "2026-02-14T16:00:00Z",
    "status": "closed"
  },
  "summary": {
    "total_invoices": 45,
    "total_sales": 1500000,
    "total_returns": 50000,
    "total_cancelled": 130000,
    "net_sales": 1320000
  },
  "payment_breakdown": {
    "cash": 1000000,
    "card": 300000,
    "transfer": 200000,
    "momo": 0,
    "zalopay": 0,
    "vnpay": 0
  },
  "cash_flow": {
    "opening_amount": 500000,
    "cash_in": 1000000,
    "cash_out": 50000,
    "expected_amount": 1450000,
    "closing_amount": 1850000,
    "difference": 400000
  },
  "invoices": [
    {
      "id": "uuid",
      "code": "HD20260214001",
      "total_amount": 150000,
      "payment_method": "cash",
      "status": "completed",
      "created_at": "2026-02-14T09:30:00Z"
    }
  ]
}
```

### 8.11 Cashier Stats

`GET /stats/by-cashier?date_from=2026-02-01&date_to=2026-02-14`

**Response 200:**

```json
{
  "period": {
    "from": "2026-02-01",
    "to": "2026-02-14"
  },
  "cashiers": [
    {
      "user_id": "uuid",
      "user_code": "NV001",
      "user_name": "Nguyen Van A",
      "total_invoices": 150,
      "total_sales": 45000000,
      "total_returns": 500000,
      "net_sales": 44500000,
      "commission_rate": 1.5,
      "commission_amount": 667500,
      "avg_invoice_value": 296667
    },
    {
      "user_id": "uuid",
      "user_code": "NV002",
      "user_name": "Tran Thi B",
      "total_invoices": 120,
      "total_sales": 38000000,
      "total_returns": 200000,
      "net_sales": 37800000,
      "commission_rate": 1.5,
      "commission_amount": 567000,
      "avg_invoice_value": 315000
    }
  ],
  "totals": {
    "total_invoices": 270,
    "total_sales": 83000000,
    "total_returns": 700000,
    "net_sales": 82300000,
    "total_commission": 1234500
  }
}
```

### 8.12 Print Invoice Data

`GET /invoices/{id}/print`

**Response 200:**

```json
{
  "store": {
    "name": "Nhà thuốc An Khang",
    "address": "123 Nguyen Van Linh, Q7, HCM",
    "phone": "028 1234 5678",
    "tax_code": "0123456789",
    "license_number": "GPP-12345"
  },
  "invoice": {
    "code": "HD20260214001",
    "date": "14/02/2026 14:30",
    "cashier": "Staff01"
  },
  "customer": {
    "name": "Nguyen Van A",
    "phone": "0901234567",
    "tier": "Gold",
    "points_before": 1600,
    "points_after": 1650
  },
  "items": [
    {
      "name": "Panadol Extra",
      "unit": "Vỉ",
      "qty": 2,
      "price": 25000,
      "amount": 50000
    }
  ],
  "summary": {
    "subtotal": 200000,
    "tier_discount": 10000,
    "promotion": {
      "code": "SALE20",
      "amount": 30000
    },
    "points_discount": 10000,
    "total": 150000
  },
  "payment": {
    "method": "Tiền mặt",
    "amount_paid": 200000,
    "change": 50000
  },
  "points": {
    "used": 100,
    "earned": 150
  },
  "footer": {
    "message": "Cảm ơn quý khách!",
    "return_policy": "Đổi trả trong 7 ngày với hóa đơn"
  }
}
```

## 9) Database Schema

```sql
-- Schema: sale

-- Phương thức thanh toán (master data)
CREATE TABLE sale.payment_methods (
    code VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    display_order INT DEFAULT 0,
    requires_reference BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Default payment methods
INSERT INTO sale.payment_methods (code, name, display_order, requires_reference) VALUES
('cash', 'Tiền mặt', 1, false),
('card', 'Thẻ', 2, true),
('transfer', 'Chuyển khoản', 3, true),
('momo', 'MoMo', 4, true),
('zalopay', 'ZaloPay', 5, true),
('vnpay', 'VNPay', 6, true);

-- Hóa đơn
CREATE TABLE sale.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) UNIQUE NOT NULL,
    
    -- Customer (snapshot)
    customer_id UUID,
    customer_code VARCHAR(20),
    customer_name VARCHAR(100),
    customer_phone VARCHAR(20),
    customer_tier VARCHAR(20),
    
    -- Amounts
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    tier_discount DECIMAL(15,2) DEFAULT 0,
    promotion_discount DECIMAL(15,2) DEFAULT 0,
    points_discount DECIMAL(15,2) DEFAULT 0,
    total_amount DECIMAL(15,2) NOT NULL,
    
    -- Points
    points_used INT DEFAULT 0,
    points_earned INT DEFAULT 0,
    
    -- Promotion
    promotion_id UUID,
    promotion_code VARCHAR(30),
    
    -- Payment
    payment_method VARCHAR(20) NOT NULL,
    amount_paid DECIMAL(15,2) NOT NULL,
    change_amount DECIMAL(15,2) DEFAULT 0,
    
    -- Status
    status VARCHAR(20) DEFAULT 'completed',
    cancelled_at TIMESTAMP,
    cancelled_by UUID,
    cancel_reason TEXT,
    
    -- Cashier (audit)
    created_by UUID NOT NULL,
    created_by_name VARCHAR(100),
    cashier_code VARCHAR(20),
    commission_rate DECIMAL(5,2) DEFAULT 0,
    commission_amount DECIMAL(12,2) DEFAULT 0,
    shift_id UUID,
    
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Chi tiết hóa đơn
CREATE TABLE sale.invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id) ON DELETE CASCADE,
    
    -- Product (snapshot)
    product_id UUID NOT NULL,
    product_code VARCHAR(20) NOT NULL,
    product_name VARCHAR(300) NOT NULL,
    
    -- Unit (snapshot)
    unit_id UUID NOT NULL,
    unit_name VARCHAR(30) NOT NULL,
    conversion_rate INT NOT NULL,
    
    -- Batch (snapshot)
    batch_id UUID NOT NULL,
    lot_number VARCHAR(50),
    expiry_date DATE,
    
    -- Pricing
    unit_price DECIMAL(12,2) NOT NULL,
    quantity INT NOT NULL,
    discount_amount DECIMAL(12,2) DEFAULT 0,
    line_total DECIMAL(15,2) NOT NULL,
    
    -- Return tracking
    returned_quantity INT DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Chi tiết thanh toán (mixed payment)
CREATE TABLE sale.invoice_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id) ON DELETE CASCADE,
    payment_method VARCHAR(20) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    reference_code VARCHAR(50),
    card_type VARCHAR(20),
    card_last_4 VARCHAR(4),
    note TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Đơn tạm giữ
CREATE TABLE sale.held_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) UNIQUE NOT NULL,
    
    customer_id UUID,
    customer_name VARCHAR(100),
    customer_phone VARCHAR(20),
    customer_tier VARCHAR(20),
    
    items JSONB NOT NULL,
    subtotal DECIMAL(15,2) DEFAULT 0,
    
    promotion_code VARCHAR(30),
    points_to_use INT DEFAULT 0,
    
    status VARCHAR(20) DEFAULT 'active',
    expires_at TIMESTAMP NOT NULL,
    priority INT DEFAULT 0,
    note TEXT,
    
    created_by UUID NOT NULL,
    created_by_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    
    resumed_at TIMESTAMP,
    resumed_invoice_id UUID
);

-- Trả hàng
CREATE TABLE sale.returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) UNIQUE NOT NULL,
    
    invoice_id UUID NOT NULL REFERENCES sale.invoices(id),
    invoice_code VARCHAR(30) NOT NULL,
    
    customer_id UUID,
    customer_name VARCHAR(100),
    
    total_return_amount DECIMAL(15,2) NOT NULL,
    points_returned INT DEFAULT 0,
    
    refund_method VARCHAR(20),
    refund_amount DECIMAL(15,2) DEFAULT 0,
    
    status VARCHAR(20) DEFAULT 'pending',
    reason TEXT,
    
    created_by UUID NOT NULL,
    created_by_name VARCHAR(100),
    approved_by UUID,
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Chi tiết trả hàng
CREATE TABLE sale.return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id UUID NOT NULL REFERENCES sale.returns(id) ON DELETE CASCADE,
    invoice_item_id UUID NOT NULL REFERENCES sale.invoice_items(id),
    
    product_id UUID NOT NULL,
    product_name VARCHAR(300) NOT NULL,
    unit_name VARCHAR(30) NOT NULL,
    batch_id UUID NOT NULL,
    
    quantity INT NOT NULL,
    unit_price DECIMAL(12,2) NOT NULL,
    return_amount DECIMAL(15,2) NOT NULL,
    
    reason TEXT,
    condition VARCHAR(20) DEFAULT 'good',
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Ca làm việc
CREATE TABLE sale.shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) UNIQUE NOT NULL,
    
    cashier_id UUID NOT NULL,
    cashier_name VARCHAR(100) NOT NULL,
    cashier_code VARCHAR(20),
    
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMP,
    
    opening_amount DECIMAL(15,2) DEFAULT 0,
    closing_amount DECIMAL(15,2),
    expected_amount DECIMAL(15,2),
    difference DECIMAL(15,2),
    
    total_invoices INT DEFAULT 0,
    total_sales DECIMAL(15,2) DEFAULT 0,
    total_returns DECIMAL(15,2) DEFAULT 0,
    total_cancelled DECIMAL(15,2) DEFAULT 0,
    cash_sales DECIMAL(15,2) DEFAULT 0,
    card_sales DECIMAL(15,2) DEFAULT 0,
    transfer_sales DECIMAL(15,2) DEFAULT 0,
    
    status VARCHAR(20) DEFAULT 'open',
    note TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_invoices_code ON sale.invoices(code);
CREATE INDEX idx_invoices_customer ON sale.invoices(customer_id);
CREATE INDEX idx_invoices_status ON sale.invoices(status);
CREATE INDEX idx_invoices_created ON sale.invoices(created_at);
CREATE INDEX idx_invoices_shift ON sale.invoices(shift_id);
CREATE INDEX idx_invoices_cashier ON sale.invoices(created_by, created_at);

CREATE INDEX idx_invoice_items_invoice ON sale.invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_product ON sale.invoice_items(product_id);
CREATE INDEX idx_invoice_items_batch ON sale.invoice_items(batch_id);

CREATE INDEX idx_invoice_payments_invoice ON sale.invoice_payments(invoice_id);

CREATE INDEX idx_held_orders_status ON sale.held_orders(status);
CREATE INDEX idx_held_orders_created_by ON sale.held_orders(created_by);
CREATE INDEX idx_held_orders_expires ON sale.held_orders(expires_at);

CREATE INDEX idx_returns_invoice ON sale.returns(invoice_id);
CREATE INDEX idx_returns_status ON sale.returns(status);

CREATE INDEX idx_shifts_cashier ON sale.shifts(cashier_id);
CREATE INDEX idx_shifts_status ON sale.shifts(status);
CREATE INDEX idx_shifts_dates ON sale.shifts(started_at, ended_at);
```

## 10) Error Responses

### Common Error Format

```json
{
  "detail": "Error message here"
}
```

### Error Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request - invalid payload hoặc business rule |
| 401 | Unauthorized - token invalid/expired |
| 403 | Forbidden - không đủ quyền |
| 404 | Not Found - resource không tồn tại |
| 409 | Conflict - vi phạm business rule (hết hàng, đã hủy...) |
| 422 | Validation Error - schema không đúng |
| 500 | Internal Server Error |

### Sample Errors

**409 - Out of stock:**

```json
{
  "detail": {
    "message": "Not enough stock for 'Panadol Extra'",
    "product_code": "T0001",
    "requested": 10,
    "available": 5,
    "shortage": 5
  }
}
```

**409 - Invoice already cancelled:**

```json
{
  "detail": "Invoice already cancelled"
}
```

**400 - Invalid return quantity:**

```json
{
  "detail": "Return quantity (5) exceeds purchased quantity (2)"
}
```

**400 - Shift already open:**

```json
{
  "detail": "You already have an open shift. Please close it first."
}
```

## 11) Configuration

### Environment Variables

```env
# Service
SERVICE_NAME=sale-service
SERVICE_PORT=8008

# Database
DATABASE_URL=postgresql+asyncpg://sale_svc:sale_pass@localhost:5432/pharmacy_db

# Auth
JWT_SECRET=your-super-secret-key
JWT_ALGORITHM=HS256

# Service URLs
AUTH_SERVICE_URL=http://localhost:8001
STORE_SERVICE_URL=http://localhost:8005
CATALOG_SERVICE_URL=http://localhost:8006
INVENTORY_SERVICE_URL=http://localhost:8002
CUSTOMER_SERVICE_URL=http://localhost:8007

# Held Orders
HELD_ORDER_EXPIRE_MINUTES=30
ENABLE_HELD_ORDER_CLEANUP_JOB=true

# Shift
REQUIRE_SHIFT_FOR_SALE=true

# Commission
DEFAULT_COMMISSION_RATE=1.5

# Invoice Code
INVOICE_PREFIX=HD
RETURN_PREFIX=TH
SHIFT_PREFIX=CA
HELD_ORDER_PREFIX=HOLD
```

## 12) Summary

| Component | Count |
|-----------|-------|
| **Tables** | 7 (payment_methods, invoices, invoice_items, invoice_payments, held_orders, returns, return_items, shifts) |
| **Endpoints** | ~30 |
| **Integrations** | 5 services |
| **Complexity** | ⭐⭐⭐⭐ High |
| **Framework** | Python (FastAPI) |
