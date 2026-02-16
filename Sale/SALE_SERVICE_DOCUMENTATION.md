# Sale Service API Documentation

## 1. Overview

Sale Service quan ly:

- Payment methods
- Invoices (checkout, list, detail, cancel, print)
- Held orders (don tam giu)
- Returns (tra hang)
- Shifts (mo/doi ca)
- Statistics (today, shift, cashier, commission)

Service su dung FastAPI + PostgreSQL (`sale` schema).

## 2. Base URL va Authentication

- Qua gateway: `http://localhost:8000/api/v1/sale`
- Goi truc tiep service: `http://localhost:8003/api/v1/sale`

Tat ca endpoint trong `/api/v1/sale/*` yeu cau Bearer access token:

```http
Authorization: Bearer <access_token>
```

## 3. Permissions

Role hop le tu JWT: `owner`, `manager`, `staff`.

- `All`: owner, manager, staff
- `Manager+`: owner, manager
- `Owner`: owner

## 4. Startup va Runtime Logic

Khi service start:

1. Tao schema `sale` neu chua co.
2. Tao toan bo table theo SQLAlchemy models.
3. Seed default payment methods neu chua ton tai:
   - `cash`, `card`, `transfer`, `momo`, `zalopay`, `vnpay`
4. Neu bat `ENABLE_HELD_ORDER_CLEANUP_JOB=true`:
   - Chay background job cleanup held orders qua han.

## 5. Integrations

Sale Service goi cac service khac:

- Inventory Service
  - `POST /api/v1/inventory/reserve` de giu ton kho luc checkout
  - `POST /api/v1/inventory/adjustment` de cong lai kho khi cancel/return
- Customer Service
  - `GET /api/v1/customer/customers/{id}` lay snapshot khach
  - Internal APIs (`X-Internal-API-Key`) cho points/promotion/stats
- Store Service
  - `GET /api/v1/store/info` de lay du lieu in hoa don

Luu y:

- Hien tai khong co reserve-confirm/release reservation API rieng trong Inventory.
- Neu checkout fail sau reserve, Sale Service goi adjustment de cong lai kho (best effort).

## 6. API Summary

### 6.1 Health

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/health` | Public |

### 6.2 Payment Methods

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/payment-methods` | All |
| POST | `/payment-methods` | Owner |
| PUT | `/payment-methods/{code}` | Owner |
| DELETE | `/payment-methods/{code}` | Owner |

### 6.3 Invoices

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/invoices` | All |
| GET | `/invoices/{id}` | All |
| GET | `/invoices/code/{code}` | All |
| POST | `/invoices` | All |
| POST | `/invoices/{id}/cancel` | Manager+ |
| GET | `/invoices/{id}/print` | All |
| POST | `/invoices/{id}/reprint` | All |

### 6.4 Held Orders

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/held-orders` | All |
| GET | `/held-orders/my` | All |
| GET | `/held-orders/count` | All |
| GET | `/held-orders/{id}` | All |
| POST | `/held-orders` | All |
| PUT | `/held-orders/{id}` | All |
| POST | `/held-orders/{id}/resume` | All |
| DELETE | `/held-orders/{id}` | All |

### 6.5 Returns

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/returns` | All |
| GET | `/returns/{id}` | All |
| POST | `/returns` | All |
| POST | `/returns/{id}/approve` | Manager+ |
| POST | `/returns/{id}/reject` | Manager+ |

### 6.6 Shifts

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/shifts` | Manager+ |
| GET | `/shifts/current` | All |
| GET | `/shifts/{id}` | All |
| POST | `/shifts/open` | All |
| POST | `/shifts/close` | All |
| GET | `/shifts/{id}/report` | All |

### 6.7 Stats

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/stats/today` | All |
| GET | `/stats/shift/{shift_id}` | All |
| GET | `/stats/by-cashier` | Manager+ |
| GET | `/stats/by-cashier/{user_id}` | Manager+ |
| GET | `/stats/commission` | Manager+ |

## 7. API Details

## 7.1 Health

### GET `/health`

Response 200:

```json
{
  "service": "sale",
  "status": "ok"
}
```

Logic:

- Health check service.

## 7.2 Payment Methods

### GET `/payment-methods`

Response 200:

```json
[
  {
    "code": "cash",
    "name": "Tien mat",
    "is_active": true,
    "display_order": 1,
    "requires_reference": false,
    "created_at": "2026-02-15T10:00:00Z"
  }
]
```

Logic:

- Tra danh sach payment methods sap xep theo `display_order`, `code`.

### POST `/payment-methods` (Owner)

Request:

```json
{
  "code": "qr",
  "name": "QR",
  "is_active": true,
  "display_order": 7,
  "requires_reference": true
}
```

Response 201:

```json
{
  "code": "qr",
  "name": "QR",
  "is_active": true,
  "display_order": 7,
  "requires_reference": true,
  "created_at": "2026-02-15T10:05:00Z"
}
```

Logic:

1. Normalize `code` ve lowercase.
2. Check trung code -> 409 neu da ton tai.
3. Tao record moi.

### PUT `/payment-methods/{code}` (Owner)

Request:

```json
{
  "name": "The ngan hang",
  "requires_reference": true,
  "display_order": 2
}
```

Response 200: tra object payment method sau update.

Logic:

- Tim theo `{code}`.
- Khong tim thay -> 404.
- Update cac truong duoc truyen.

### DELETE `/payment-methods/{code}` (Owner)

Response 200:

```json
{
  "message": "Payment method deleted"
}
```

Logic:

- Hard delete payment method.

## 7.3 Invoices

### POST `/invoices` (Checkout)

Request (single payment):

```json
{
  "customer_id": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "sku": "T0001",
      "product_id": "product-uuid-1",
      "product_code": "T0001",
      "product_name": "Panadol Extra",
      "unit_id": "unit-uuid-1",
      "unit_name": "Vien",
      "conversion_rate": 1,
      "batch_id": "batch-uuid-1",
      "lot_number": "LO2401",
      "expiry_date": "2027-12-31",
      "quantity": 2,
      "unit_price": 25000,
      "discount_amount": 0
    }
  ],
  "promotion_code": "SALE20",
  "points_used": 100,
  "payment_method": "cash",
  "amount_paid": 100000,
  "note": "Khach quen"
}
```

Request (mixed payment):

```json
{
  "customer_id": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "sku": "T0001",
      "product_id": "product-uuid-1",
      "unit_id": "unit-uuid-1",
      "batch_id": "batch-uuid-1",
      "quantity": 2,
      "unit_price": 25000,
      "discount_amount": 0
    }
  ],
  "payments": [
    { "method": "cash", "amount": 50000 },
    { "method": "card", "amount": 30000, "reference_code": "TXN123" }
  ],
  "note": "Mixed payment"
}
```

Response 201 (rut gon):

```json
{
  "id": "invoice-uuid",
  "code": "HD20260215001",
  "customer_id": "550e8400-e29b-41d4-a716-446655440000",
  "subtotal": 50000,
  "discount_amount": 12000,
  "tier_discount": 2000,
  "promotion_discount": 5000,
  "points_discount": 5000,
  "total_amount": 38000,
  "points_used": 100,
  "points_earned": 40,
  "payment_method": "mixed",
  "amount_paid": 80000,
  "change_amount": 42000,
  "status": "completed",
  "items": [
    {
      "id": "item-uuid",
      "product_code": "T0001",
      "quantity": 2,
      "line_total": 50000
    }
  ],
  "payments": [
    { "payment_method": "cash", "amount": 50000 },
    { "payment_method": "card", "amount": 30000, "reference_code": "TXN123" }
  ]
}
```

Logic:

1. Check shift dang mo neu `REQUIRE_SHIFT_FOR_SALE=true`.
2. Tao code hoa don theo ngay (`HDYYYYMMDDxxx`).
3. Goi Inventory reserve theo SKU va quantity.
4. Neu co `customer_id` -> lay customer snapshot.
5. Tinh `subtotal`, `line discount`, validate line total >= 0.
6. Lay `tier_discount_percent` tu Customer Service (`GET /api/v1/customer/customers/{id}/stats`) va tinh `tier_discount`.
7. Neu co promotion_code -> goi Customer internal validate.
8. Neu co points_used -> goi Customer internal redeem.
9. Tinh `total_amount`, validate `amount_paid >= total_amount`.
10. Neu co customer -> goi Customer internal calculate points earn.
11. Luu invoice + items + payments.
12. Update shift stats (total_invoices, total_sales, sales theo payment method).
13. Sau commit:
    - Ghi earn points (best effort).
    - Update customer stats (best effort).
    - Apply promotion usage (best effort).
14. Neu fail trong qua trinh tao:
    - Rollback DB.
    - Co gang cong lai kho qua Inventory adjustment (best effort).
    - Rollback points da redeem (best effort).

### GET `/invoices`

Query params:

- `status`: completed/cancelled/returned/...
- `date_from`, `date_to` (YYYY-MM-DD)
- `cashier_id`
- `search` (code, customer_name, customer_phone)
- `page`, `size`

Response 200:

```json
{
  "items": [
    {
      "id": "invoice-uuid",
      "code": "HD20260215001",
      "customer_name": "Nguyen Van A",
      "customer_phone": "0901234567",
      "total_amount": 150000,
      "payment_method": "cash",
      "status": "completed",
      "cashier_name": "staff01",
      "created_at": "2026-02-15T08:30:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20,
  "pages": 1
}
```

Logic:

- Filter + pagination tren `sale.invoices`.

### GET `/invoices/{id}`

- Tra chi tiet invoice kem items + payments.

### GET `/invoices/code/{code}`

- Tim invoice theo ma hoa don.

### POST `/invoices/{id}/cancel` (Manager+)

Request:

```json
{
  "reason": "Khach doi y"
}
```

Response 200:

```json
{
  "message": "Invoice cancelled",
  "invoice": {
    "id": "invoice-uuid",
    "code": "HD20260215001",
    "status": "cancelled",
    "cancelled_at": "2026-02-15T09:00:00Z",
    "cancelled_by": "user-id",
    "cancel_reason": "Khach doi y"
  },
  "rollback": {
    "stock_returned": true,
    "points_refunded": 100,
    "points_earned_revoked": 40,
    "promotion_usage_revoked": true
  }
}
```

Logic:

1. Chi cancel duoc invoice `completed`.
2. Tra lai kho tung item qua Inventory adjustment.
3. Rollback points da dung va points da earn (Customer internal).
4. Rollback promotion usage neu co `promotion_id` + `promotion_usage_id`.
5. Update status invoice = `cancelled`.
6. Tang `shift.total_cancelled` neu invoice thuoc shift.

### GET `/invoices/{id}/print`

Response 200 (rut gon):

```json
{
  "store": {
    "name": "Store",
    "address": "...",
    "phone": "..."
  },
  "invoice": {
    "code": "HD20260215001",
    "date": "15/02/2026 08:30",
    "cashier": "staff01"
  },
  "customer": {
    "name": "Nguyen Van A",
    "phone": "0901234567",
    "tier": "gold"
  },
  "items": [
    { "name": "Panadol", "unit": "Vien", "qty": 2, "price": 25000, "amount": 50000 }
  ],
  "summary": {
    "subtotal": 50000,
    "tier_discount": 2000,
    "promotion": { "code": "SALE20", "amount": 5000 },
    "points_discount": 5000,
    "total": 38000
  },
  "payment": {
    "method": "cash",
    "amount_paid": 50000,
    "change": 10000
  },
  "points": {
    "used": 100,
    "earned": 40
  },
  "footer": {
    "message": "Cam on quy khach!",
    "return_policy": "Doi tra trong 7 ngay voi hoa don"
  }
}
```

Logic:

- Lay invoice + goi Store Service de lay thong tin cua hang, sau do format payload in.

### POST `/invoices/{id}/reprint`

Response 200:

```json
{
  "message": "Invoice marked for reprint",
  "invoice_id": "invoice-uuid",
  "invoice_code": "HD20260215001"
}
```

Logic:

- Xac nhan invoice ton tai, tra payload de client reprint.

## 7.4 Held Orders

### POST `/held-orders`

Request:

```json
{
  "customer_id": "550e8400-e29b-41d4-a716-446655440000",
  "customer_name": "Nguyen Van A",
  "customer_phone": "0901234567",
  "customer_tier": "gold",
  "items": [
    {
      "product_id": "product-uuid-1",
      "product_code": "T0001",
      "product_name": "Panadol",
      "unit_id": "unit-uuid-1",
      "unit_name": "Vien",
      "batch_id": "batch-uuid-1",
      "quantity": 2,
      "unit_price": 25000
    }
  ],
  "subtotal": 50000,
  "promotion_code": "SALE20",
  "points_to_use": 50,
  "priority": 1,
  "note": "Khach dang cho"
}
```

Response 201: tra `HeldOrderResponse`.

Logic:

1. Sinh ma `HOLDxxx`.
2. Tinh subtotal neu payload subtotal <= 0.
3. Luu cart vao JSONB (`items`).
4. Set `expires_at = now + HELD_ORDER_EXPIRE_MINUTES`.

### GET `/held-orders`, `/held-orders/my`, `/held-orders/count`

Logic:

- Truoc khi query, service auto cleanup held order het han (`active -> expired`).

### PUT `/held-orders/{id}`

Logic:

- Chi update duoc khi status `active`.
- Chi user tao don moi duoc sua.
- Moi lan update se gia han `expires_at`.

### POST `/held-orders/{id}/resume`

Request:

```json
{
  "additional_items": [],
  "payment_method": "cash",
  "amount_paid": 100000,
  "note": "Resume va thanh toan"
}
```

Response 200:

```json
{
  "message": "Held order resumed",
  "held_order": {
    "id": "held-order-uuid",
    "code": "HOLD001",
    "status": "resumed",
    "resumed_at": "2026-02-15T10:10:00Z",
    "resumed_invoice_id": "invoice-uuid"
  },
  "invoice": {
    "id": "invoice-uuid",
    "code": "HD20260215002",
    "total_amount": 80000,
    "status": "completed"
  }
}
```

Logic:

1. Check held order phai `active` va chua het han.
2. Chuyen held items + additional_items thanh `InvoiceCreateRequest`.
3. Goi lai luong checkout.
4. Cap nhat held order -> `resumed` + link `resumed_invoice_id`.

### DELETE `/held-orders/{id}`

Logic:

- Cho phep huy khi status `active` hoac `expired`.
- Set status `cancelled`.

## 7.5 Returns

### POST `/returns`

Request:

```json
{
  "invoice_id": "invoice-uuid",
  "items": [
    {
      "invoice_item_id": "invoice-item-uuid",
      "quantity": 1,
      "reason": "Khach doi y",
      "condition": "good"
    }
  ],
  "refund_method": "cash",
  "reason": "Tra hang mot phan"
}
```

Response 201: tra `ReturnResponse` voi status `pending`.

Logic:

1. Invoice phai ton tai va status nam trong `completed/returned`.
2. Validate item tra thuoc invoice goc.
3. Validate `quantity` khong vuot qua so luong chua tra.
4. Tao return doc + return items.

### POST `/returns/{id}/approve` (Manager+)

Response 200:

```json
{
  "message": "Return approved",
  "return": {
    "id": "return-uuid",
    "code": "TH20260215001",
    "status": "completed",
    "approved_by": "manager-id",
    "approved_at": "2026-02-15T11:00:00Z"
  },
  "actions": {
    "stock_returned": true,
    "points_adjusted": -25,
    "refund_amount": 25000
  }
}
```

Logic:

1. Chi approve duoc return `pending`.
2. Tang `invoice_items.returned_quantity`.
3. Neu condition `good` -> cong lai kho qua Inventory adjustment.
4. Tinh rollback points theo ti le gia tri tra tren tong hoa don:
   - rollback earn points
   - rollback redeem points
5. Neu invoice tra het va co promotion usage -> rollback promotion usage.
6. Neu invoice co shift -> cong `shift.total_returns`.
7. Set return status `completed` + approved info.

### POST `/returns/{id}/reject` (Manager+)

Request:

```json
{
  "reason": "Khong du dieu kien tra"
}
```

Response 200:

```json
{
  "message": "Return rejected",
  "return": {
    "id": "return-uuid",
    "code": "TH20260215001",
    "status": "rejected",
    "reason": "Khong du dieu kien tra"
  }
}
```

Logic:

- Chi reject duoc return `pending`.
- Set status `rejected`, append ly do reject vao `reason`.

## 7.6 Shifts

### POST `/shifts/open`

Request:

```json
{
  "opening_amount": 500000,
  "note": "Ca sang"
}
```

Response 201: `ShiftResponse`.

Logic:

1. Moi user chi duoc 1 shift `open` tai mot thoi diem.
2. Sinh ma `CAYYYYMMDDxxx`.
3. Tao shift status `open`.

### POST `/shifts/close`

Request:

```json
{
  "closing_amount": 1850000,
  "note": "Da kiem tien"
}
```

Response 200: `ShiftResponse` sau khi dong ca.

Logic:

1. Tim shift `open` cua current user.
2. Tinh:
   - `expected_amount = opening_amount + cash_sales - total_returns`
   - `difference = closing_amount - expected_amount`
3. Cap nhat `ended_at`, `status=closed`.

### GET `/shifts/{id}/report`

Response 200:

- `shift`: thong tin ca
- `summary`: tong hop doanh so/tra/huy/net
- `payment_breakdown`: cash/card/transfer/momo/zalopay/vnpay
- `cash_flow`: opening/cash_in/cash_out/expected/closing/difference
- `invoices`: list invoice trong shift

## 7.7 Stats

### GET `/stats/today`

Response 200:

```json
{
  "date": "2026-02-15",
  "total_invoices": 45,
  "total_sales": 1500000,
  "total_returns": 50000,
  "total_cancelled": 130000,
  "net_sales": 1320000
}
```

Logic:

- Tong hop theo ngay hien tai dua tren `sale.invoices`.
- `total_returns` duoc tinh tu bang `sale.returns` voi dieu kien `status = completed`.

### GET `/stats/shift/{shift_id}`

Response 200:

```json
{
  "shift_id": "shift-uuid",
  "code": "CA20260215001",
  "cashier_id": "user-id",
  "cashier_name": "staff01",
  "status": "closed",
  "total_invoices": 45,
  "total_sales": 1500000,
  "total_returns": 50000,
  "total_cancelled": 130000,
  "net_sales": 1320000
}
```

### GET `/stats/by-cashier` (Manager+)

Query:

- `date_from` (required)
- `date_to` (required)

Response 200:

```json
{
  "period": {
    "from": "2026-02-01",
    "to": "2026-02-15"
  },
  "cashiers": [
    {
      "user_id": "staff-id",
      "user_code": "staff-id",
      "user_name": "staff01",
      "total_invoices": 120,
      "total_sales": 38000000,
      "total_returns": 200000,
      "net_sales": 37800000,
      "commission_rate": 1.5,
      "commission_amount": 567000,
      "avg_invoice_value": 316667
    }
  ],
  "totals": {
    "total_invoices": 120,
    "total_sales": 38000000,
    "total_returns": 200000,
    "net_sales": 37800000,
    "total_commission": 567000
  }
}
```

### GET `/stats/by-cashier/{user_id}` (Manager+)

- Tra thong ke cho 1 user trong khoang ngay.

### GET `/stats/commission` (Manager+)

- Tra tong hop hoa hong theo nhan vien trong khoang ngay.

## 8. Business Flow (Implementation)

## 8.1 Checkout Flow

1. Validate shift dang mo (neu bat setting).
2. Reserve ton kho qua Inventory.
3. Validate customer (neu co).
4. Lay `tier_discount_percent` tu Customer Service va tinh `tier_discount`.
5. Validate promotion (neu co).
6. Redeem points (neu co).
7. Validate payment amount.
8. Tao invoice + invoice items + invoice payments.
9. Update shift sales.
10. Sau commit:
   - Earn points
   - Update customer stats
   - Apply promotion usage
11. Neu fail:
   - Rollback DB
   - Cong lai kho (best effort)
   - Rollback points da redeem (best effort)

## 8.2 Cancel Invoice Flow

1. Chi cho phep invoice `completed`.
2. Cong lai kho theo items.
3. Rollback redeem points + earn points.
4. Rollback promotion usage.
5. Cap nhat invoice `cancelled`.
6. Cong `shift.total_cancelled`.

## 8.3 Return Approve Flow

1. Return phai `pending`.
2. Cap nhat returned quantity tren invoice item.
3. Item `good` -> cong lai kho.
4. Dieu chinh points theo ti le gia tri tra.
5. Tra het invoice -> set invoice `returned`, rollback promotion usage.
6. Update shift total returns.
7. Set return status `completed`.

## 8.4 Held Order Flow

1. Tao held order: luu cart JSONB + expires_at.
2. Job cleanup doi `active -> expired` khi qua han.
3. Resume held order: convert thanh checkout, tao invoice, mark `resumed`.

## 9. Error Format

Response loi chung:

```json
{
  "detail": "Error message"
}
```

Mot so case:

- 400: payload khong hop le, thieu payment, line total am, khong co shift
- 401: token sai/het han
- 403: khong du quyen
- 404: resource khong ton tai
- 409: conflict business rule (invoice da cancel, held order het han, ...)
- 422: validation error cua FastAPI/Pydantic
- 502: goi upstream service loi

## 10. Environment Variables

```env
APP_NAME=Sale Service
APP_PORT=8003
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/pharmar_sale

JWT_SECRET_KEY=change-this-secret
JWT_ALGORITHM=HS256

STORE_SERVICE_URL=http://store-service:8005
CATALOG_SERVICE_URL=http://catalog-service:8006
INVENTORY_SERVICE_URL=http://inventory-service:8002
CUSTOMER_SERVICE_URL=http://customer-service:8007
CUSTOMER_INTERNAL_API_KEY=change-this-internal-key

HELD_ORDER_EXPIRE_MINUTES=30
ENABLE_HELD_ORDER_CLEANUP_JOB=true
HELD_ORDER_CLEANUP_INTERVAL_MINUTES=5

REQUIRE_SHIFT_FOR_SALE=true
DEFAULT_COMMISSION_RATE=1.5

INVOICE_PREFIX=HD
RETURN_PREFIX=TH
SHIFT_PREFIX=CA
HELD_ORDER_PREFIX=HOLD
```

## 11. Ghi Chu Hanh Vi Hien Tai

- `tier_discount` duoc tinh tu `tier_discount_percent` cua Customer Service (`GET /api/v1/customer/customers/{id}/stats`).
- `stats/today.total_returns` duoc tinh tu bang `sale.returns` voi dieu kien `status = completed`.
- Payment method default seed dang dung ten ASCII (`Tien mat`, `The`, ...).
- Tich hop voi Inventory hien la best effort cho rollback khi loi giua luong bang `POST /api/v1/inventory/adjustment`.
- Goi y optional: neu Inventory bo sung confirm/release reservation API, nen chuyen rollback reserve sang release de clean hon.
