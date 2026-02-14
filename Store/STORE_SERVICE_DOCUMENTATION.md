# Store Service API Documentation

## 1) Overview

Store Service quan ly:
- Thong tin cua hang (`store.info`)
- Cac cai dat he thong (`store.settings`)

Service nay duoc viet bang Go, luu du lieu tren PostgreSQL, va expose API theo prefix:
- Direct service: `http://localhost:8005`
- Through gateway: `http://localhost:8000/api/v1/store`

## 2) Auth and permission

- Read endpoints: public.
- Write endpoints: yeu cau `Authorization: Bearer <access_token>`.
- Role duoc phep write: `owner`.
- Token phai la access token (claim `type` la `access` hoac rong de tuong thich).

Neu token sai/het han:
```json
{ "detail": "Invalid token" }
```

Neu dung token hop le nhung khong phai owner:
```json
{ "detail": "Only owner is allowed" }
```

## 3) Runtime logic

- Luc startup service:
1. Tao schema `store` neu chua co.
2. Tao bang `store.info` va `store.settings` neu chua co.
3. Seed 1 dong `store.info` mac dinh neu bang rong.
4. Seed toan bo default settings neu key chua ton tai.

- Logo upload:
1. Nhan file multipart (`file`) toi da 10MB.
2. Luu vao thu muc upload (config `LOGO_UPLOAD_DIR`).
3. Luu `logo_url` theo dang `/api/v1/store/uploads/{filename}`.
4. Neu da co logo cu thi xoa file cu tren disk.

- Settings update:
1. Validate type theo `data_type` (`boolean|number|string|json`).
2. Reject neu type request khong khop.
3. Ghi `updated_at`, `updated_by`.

- Settings bulk update:
1. Chay trong transaction.
2. Neu mot key loi thi rollback toan bo.

## 4) Data model

### 4.1 Store info

| Field | Type |
|---|---|
| id | UUID |
| name | string |
| address | string/null |
| phone | string/null |
| email | string/null |
| tax_code | string/null |
| license_number | string/null |
| owner_name | string/null |
| logo_url | string/null |
| bank_account | string/null |
| bank_name | string/null |
| bank_branch | string/null |
| created_at | timestamp |
| updated_at | timestamp |

### 4.2 Setting item

| Field | Type |
|---|---|
| key | string |
| value | JSON |
| group_name | string |
| data_type | string |
| description | string |
| is_public | boolean |
| updated_at | timestamp |
| updated_by | uuid/null |

## 5) Default settings

### Sale
- `sale.auto_print = true`
- `sale.allow_negative_stock = false`
- `sale.allow_edit_price = false`
- `sale.default_payment_method = "cash"`
- `sale.invoice_prefix = "HD"`

### Inventory
- `inventory.low_stock_threshold = 10`
- `inventory.expiry_warning_days = 30`
- `inventory.near_date_days = 90`
- `inventory.enable_fefo = true`
- `inventory.fefo_threshold_days = 180`
- `inventory.receipt_prefix = "PN"`

### Customer
- `customer.enable_points = true`
- `customer.points_per_amount = 1000`
- `customer.point_value = 1000`
- `customer.points_expiry_months = 12`
- `customer.tier_bronze = 0`
- `customer.tier_silver = 1000`
- `customer.tier_gold = 5000`
- `customer.tier_diamond = 20000`

### Promotion
- `promotion.auto_hide_expired = true`
- `promotion.auto_delete_days = 30`

### System
- `system.timezone = "Asia/Ho_Chi_Minh"`
- `system.currency = "VND"`
- `system.date_format = "DD/MM/YYYY"`

## 6) API summary

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/health` | Public |
| GET | `/api/v1/store/health` | Public |
| GET | `/api/v1/store/info` | Public |
| PUT | `/api/v1/store/info` | Owner |
| POST | `/api/v1/store/info/logo` | Owner |
| DELETE | `/api/v1/store/info/logo` | Owner |
| GET | `/api/v1/store/settings` | Public |
| GET | `/api/v1/store/settings/{key}` | Public |
| GET | `/api/v1/store/settings/group/{group}` | Public |
| PUT | `/api/v1/store/settings/{key}` | Owner |
| PUT | `/api/v1/store/settings` | Owner |
| POST | `/api/v1/store/settings/reset` | Owner |
| POST | `/api/v1/store/settings/reset/{key}` | Owner |
| GET | `/api/v1/store/drug-categories?include_inactive=&search=` | Public |
| POST | `/api/v1/store/drug-categories` | Owner |
| PUT | `/api/v1/store/drug-categories/{categoryID}` | Owner |
| DELETE | `/api/v1/store/drug-categories/{categoryID}` | Owner |
| POST | `/api/v1/store/drug-groups` | Owner |
| PUT | `/api/v1/store/drug-groups/{groupID}` | Owner |
| DELETE | `/api/v1/store/drug-groups/{groupID}` | Owner |
| GET | `/api/v1/store/uploads/{filename}` | Public |

## 7) API details (logic + request + response)

### 7.1 Health

#### GET `/health`
Logic:
- Kiem tra service process con chay.

Request:
```bash
curl http://localhost:8005/health
```

Response 200:
```json
{
  "service": "store",
  "status": "ok"
}
```

#### GET `/api/v1/store/health`
Logic:
- Health endpoint qua namespace store, dung de test qua gateway.

Request:
```bash
curl http://localhost:8000/api/v1/store/health
```

Response 200:
```json
{
  "service": "store",
  "status": "ok"
}
```

### 7.2 Store info

#### GET `/api/v1/store/info`
Logic:
- Lay dong info dau tien (order theo `created_at`).
- Neu khong co dong nao thi tra 404.

Request:
```bash
curl http://localhost:8000/api/v1/store/info
```

Response 200:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Nha thuoc Pharmar",
  "address": null,
  "phone": null,
  "email": null,
  "tax_code": null,
  "license_number": null,
  "owner_name": null,
  "logo_url": null,
  "bank_account": null,
  "bank_name": null,
  "bank_branch": null,
  "created_at": "2026-02-14T09:00:00Z",
  "updated_at": "2026-02-14T09:00:00Z"
}
```

Response 404 (sample):
```json
{ "detail": "not found: store info not found" }
```

#### PUT `/api/v1/store/info`
Logic:
- Chi owner duoc cap nhat.
- Chi cap nhat field duoc gui len.
- Neu `name` duoc gui nhung rong thi reject 400.
- String rong o cac field optional se duoc set `null`.

Request:
```bash
curl -X PUT http://localhost:8000/api/v1/store/info \
  -H "Authorization: Bearer <owner_access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Nha thuoc An Khang",
    "address": "123 Nguyen Van Linh, Q7, HCM",
    "phone": "02812345678",
    "email": "ankhang@pharmacy.vn",
    "tax_code": "0123456789",
    "license_number": "GPP-12345",
    "owner_name": "Nguyen Van A",
    "bank_account": "1234567890",
    "bank_name": "Vietcombank",
    "bank_branch": "Q7"
  }'
```

Response 200:
```json
{
  "message": "Store info updated",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Nha thuoc An Khang",
    "address": "123 Nguyen Van Linh, Q7, HCM",
    "phone": "02812345678",
    "email": "ankhang@pharmacy.vn",
    "tax_code": "0123456789",
    "license_number": "GPP-12345",
    "owner_name": "Nguyen Van A",
    "logo_url": null,
    "bank_account": "1234567890",
    "bank_name": "Vietcombank",
    "bank_branch": "Q7",
    "created_at": "2026-02-14T09:00:00Z",
    "updated_at": "2026-02-14T09:10:00Z"
  }
}
```

Response 400 (sample):
```json
{ "detail": "bad request: name cannot be empty" }
```

#### POST `/api/v1/store/info/logo`
Logic:
- Chi owner duoc upload.
- Nhan multipart field `file`, gioi han 10MB.
- Tao ten file moi bang UUID + extension.
- Cap nhat `logo_url` trong DB.

Request:
```bash
curl -X POST http://localhost:8000/api/v1/store/info/logo \
  -H "Authorization: Bearer <owner_access_token>" \
  -F "file=@./logo.png"
```

Response 200:
```json
{
  "message": "Logo uploaded",
  "logo_url": "/api/v1/store/uploads/7b15fcb1-9b8a-4a95-a2f6-9ddbe4b5c21a.png",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Nha thuoc An Khang",
    "logo_url": "/api/v1/store/uploads/7b15fcb1-9b8a-4a95-a2f6-9ddbe4b5c21a.png",
    "updated_at": "2026-02-14T09:15:00Z"
  }
}
```

Response 400 (sample):
```json
{ "detail": "Missing logo file in form field 'file'" }
```

#### DELETE `/api/v1/store/info/logo`
Logic:
- Chi owner duoc xoa logo.
- Set `logo_url = null` trong DB.
- Neu file logo cu ton tai tren disk thi xoa file.

Request:
```bash
curl -X DELETE http://localhost:8000/api/v1/store/info/logo \
  -H "Authorization: Bearer <owner_access_token>"
```

Response 200:
```json
{
  "message": "Logo removed",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "logo_url": null,
    "updated_at": "2026-02-14T09:20:00Z"
  }
}
```

### 7.3 Settings

#### GET `/api/v1/store/settings`
Logic:
- Tra map tat ca setting duoi dang `key -> value`.

Request:
```bash
curl http://localhost:8000/api/v1/store/settings
```

Response 200 (sample):
```json
{
  "sale.auto_print": true,
  "sale.allow_negative_stock": false,
  "inventory.low_stock_threshold": 10,
  "inventory.enable_fefo": true,
  "system.currency": "VND"
}
```

#### GET `/api/v1/store/settings/{key}`
Logic:
- Tra day du metadata cua mot setting.
- 404 neu key khong ton tai.

Request:
```bash
curl http://localhost:8000/api/v1/store/settings/sale.auto_print
```

Response 200:
```json
{
  "key": "sale.auto_print",
  "value": true,
  "group_name": "sale",
  "data_type": "boolean",
  "description": "Tu dong in hoa don",
  "is_public": true,
  "updated_at": "2026-02-14T09:00:00Z",
  "updated_by": null
}
```

Response 404 (sample):
```json
{ "detail": "not found: setting 'sale.unknown' not found" }
```

#### GET `/api/v1/store/settings/group/{group}`
Logic:
- Filter settings theo `group_name` va tra map `key -> value`.
- Neu group rong thi 400.

Request:
```bash
curl http://localhost:8000/api/v1/store/settings/group/inventory
```

Response 200:
```json
{
  "inventory.enable_fefo": true,
  "inventory.expiry_warning_days": 30,
  "inventory.fefo_threshold_days": 180,
  "inventory.low_stock_threshold": 10,
  "inventory.near_date_days": 90,
  "inventory.receipt_prefix": "PN"
}
```

#### PUT `/api/v1/store/settings/{key}`
Logic:
- Chi owner.
- Validate type cua `value` theo `data_type` da khai bao trong DB.
- Cap nhat setting va audit fields (`updated_at`, `updated_by`).

Request:
```bash
curl -X PUT http://localhost:8000/api/v1/store/settings/sale.auto_print \
  -H "Authorization: Bearer <owner_access_token>" \
  -H "Content-Type: application/json" \
  -d '{ "value": false }'
```

Response 200:
```json
{
  "message": "Setting updated",
  "key": "sale.auto_print",
  "value": false
}
```

Response 400 (sample type mismatch):
```json
{ "detail": "bad request: value type does not match data_type 'boolean'" }
```

#### PUT `/api/v1/store/settings` (bulk)
Logic:
- Chi owner.
- Payload bat buoc co `settings` va khong rong.
- Chay transaction: mot key fail -> rollback toan bo.
- Validate type tung key truoc khi update.

Request:
```bash
curl -X PUT http://localhost:8000/api/v1/store/settings \
  -H "Authorization: Bearer <owner_access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "sale.auto_print": false,
      "inventory.low_stock_threshold": 20,
      "system.currency": "VND"
    }
  }'
```

Response 200:
```json
{
  "message": "Settings updated",
  "updated": 3
}
```

Response 400 (sample payload rong):
```json
{ "detail": "bad request: settings payload is empty" }
```

#### POST `/api/v1/store/settings/reset`
Logic:
- Chi owner.
- Reset tat ca keys ve default value trong code.
- Upsert theo key (neu chua co thi tao moi).

Request:
```bash
curl -X POST http://localhost:8000/api/v1/store/settings/reset \
  -H "Authorization: Bearer <owner_access_token>"
```

Response 200:
```json
{
  "message": "Settings reset to default",
  "updated": 24
}
```

#### POST `/api/v1/store/settings/reset/{key}`
Logic:
- Chi owner.
- Reset duy nhat 1 key ve default.
- 404 neu key khong nam trong default map cua service.

Request:
```bash
curl -X POST http://localhost:8000/api/v1/store/settings/reset/sale.auto_print \
  -H "Authorization: Bearer <owner_access_token>"
```

Response 200:
```json
{
  "message": "Setting reset",
  "key": "sale.auto_print",
  "value": true
}
```

Response 404 (sample):
```json
{ "detail": "not found: default setting for key 'custom.key' not found" }
```

### 7.4 Static logo file

#### GET `/api/v1/store/uploads/{filename}`
Logic:
- Serve file logo da upload tu `LOGO_UPLOAD_DIR`.
- Public endpoint.

Request:
```bash
curl http://localhost:8000/api/v1/store/uploads/7b15fcb1-9b8a-4a95-a2f6-9ddbe4b5c21a.png
```

Response 200:
- Binary image data.

## 8) Common error formats

`400` sample:
```json
{ "detail": "bad request: value type does not match data_type 'number'" }
```

`401` sample:
```json
{ "detail": "Invalid token" }
```

`403` sample:
```json
{ "detail": "Only owner is allowed" }
```

`404` sample:
```json
{ "detail": "not found: setting 'abc' not found" }
```

`500` sample:
```json
{ "detail": "Internal server error" }
```
