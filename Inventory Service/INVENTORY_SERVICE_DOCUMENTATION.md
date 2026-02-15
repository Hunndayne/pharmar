# Inventory Service Documentation

## Scope

Inventory Service now supports:

- Import receipts management
- Batch management
- Stock summary/detail and stock adjustments
- Alerts for low stock and expiry windows
- FEFO + FIFO issue suggestion
- Sale reservation compatibility for `Sale Service`

## Module Structure

Code was split for easier debugging:

- `Inventory Service/main.py`: only app entrypoint.
- `Inventory Service/inventory_service/app.py`: FastAPI routes and lifecycle.
- `Inventory Service/inventory_service/config.py`: settings.
- `Inventory Service/inventory_service/domain.py`: enums and domain constants.
- `Inventory Service/inventory_service/schemas.py`: request models and validation.

Base path: `/api/v1/inventory`

## Key Rules

- FEFO/FIFO rule:
  - Expiry `< 180 days` => FEFO (nearest expiry first)
  - Expiry `>= 180 days` => FIFO (oldest receipt first)
- Import receipt update is allowed only when all its batches are untouched (`qty_remaining == qty_in` and no non-import movements).
- Cancelling a receipt rolls back stock and marks all its batches as cancelled.

## Main Endpoints

### Health and metadata

- `GET /health`
- `GET /api/v1/inventory/meta/drugs`
- `GET /api/v1/inventory/meta/suppliers`
- `GET /api/v1/inventory/events` (consumed `sale.created` events)

### Import receipts

- `GET /api/v1/inventory/import-receipts?date_from=&date_to=&supplier_id=&status=`
- `GET /api/v1/inventory/import-receipts/{receipt_id}`
- `POST /api/v1/inventory/import-receipts`
- `PUT /api/v1/inventory/import-receipts/{receipt_id}`
- `POST /api/v1/inventory/import-receipts/{receipt_id}/cancel`

### Batches

- `GET /api/v1/inventory/batches?search=&drug=&supplier_id=&status=&exp_from=&exp_to=`
- `GET /api/v1/inventory/batches/{batch_id}`
- `GET /api/v1/inventory/batches/qr/{qr_value}`
- `GET /api/v1/inventory/batches/suggest-issue?drug_id=&drug_code=&quantity=&as_of=`
- `PATCH /api/v1/inventory/batches/{batch_id}/status`

### Stock

- `GET /api/v1/inventory/stock` (legacy map for service compatibility)
- `GET /api/v1/inventory/stock/summary`
- `GET /api/v1/inventory/stock/drugs/{drug_id}`
- `POST /api/v1/inventory/stock/adjustments`

### Alerts and reports

- `GET /api/v1/inventory/alerts?low_stock_threshold=&as_of=`
- `GET /api/v1/inventory/reports/movement?date_from=&date_to=&drug=`

### Reservation for sale flow

- `POST /api/v1/inventory/reserve`

Request:

```json
{
  "sale_id": "S0001",
  "items": [
    { "sku": "PANADOL", "quantity": 2 }
  ]
}
```

## API Logic (How Endpoints Work)

### 0) Auth, state and consistency

- Read endpoints are public in current implementation.
- Write endpoints require `Bearer` token:
  - `POST/PUT` receipts, `POST cancel`, `PATCH batch status`, `POST stock adjustments`, `POST reserve`.
- Token is decoded from JWT and accepts token type `access` (or missing type for backward compatibility). Invalid/expired token returns `401`.
- Service keeps runtime state (`runtime_state`) with `asyncio.Lock` for write safety, and persists it to PostgreSQL (`inventory_runtime_state`) after write operations.

### 1) Health + metadata

- `GET /health`: liveness check.
- `GET /meta/drugs`, `GET /meta/suppliers`: return metadata from runtime state; drugs are auto-synced from Catalog service when token is provided.
- `GET /events`: returns latest consumed `sale.created` events from Redis (keeps last 200).

### 2) Import receipts

- `GET /import-receipts`:
  - Filter by `date_from`, `date_to`, `supplier_id`, `status`.
  - Sort desc by `(receipt_date, created_at)`.
  - Each row includes computed `can_edit`.
- `GET /import-receipts/{receipt_id}`:
  - Returns full receipt with lines and per-line `batch_status`.
  - `404` if receipt not found.
- `POST /import-receipts`:
  - Validates supplier and each line (`drug_id`/`drug_code`, `qty > 0`, `exp_date > mfg_date`).
  - Auto-generates `receipt_code` and `batch_code` when missing.
  - Enforces unique `batch_code` globally (`409` if duplicated).
  - `lines[].quantity` được hiểu là **số lượng theo đơn vị nhập** (đơn vị lớn nhất của thuốc trong dòng đó).
  - Tồn kho (`qty_in`, `qty_remaining`) được lưu theo **đơn vị bán lẻ**:
    - `stock_qty = quantity * max(unit_prices.conversion)`.
    - Ví dụ: `quantity=222` hộp, `conversion=100` viên/hộp => tồn kho tăng `22,200` viên.
  - Creates receipt + batches, sets `qty_remaining = qty_in`.
  - Logs `import_receipt` movement for each line.
- `PUT /import-receipts/{receipt_id}`:
  - Allowed only when receipt is still editable:
    - status must be `confirmed`
    - all related batches untouched (`qty_remaining == qty_in`)
    - no non-import movement exists on those batches.
  - Rebuilds lines/batches from new payload and rewrites import movements for this receipt.
  - `409` if any batch was sold/adjusted or receipt is not editable.
- `POST /import-receipts/{receipt_id}/cancel`:
  - Idempotent: if already cancelled, returns current receipt immediately.
  - Also requires receipt still editable (same rule as update).
  - For each batch: subtract remaining qty via `receipt_cancel` movement, then mark batch `cancelled` and `qty_remaining = 0`.
  - Marks receipt status as `cancelled`.

### 3) Batches

- `GET /batches`:
  - Supports filter by keyword (`batch_code`, `lot_number`, drug code/name), drug, supplier, expiry range, status.
  - Status is computed dynamically:
    - `cancelled` if cancelled flag true
    - `depleted` if `qty_remaining <= 0`
    - `expired` if forced expired or `exp_date < today`
    - otherwise `active`
  - Sorted by `(exp_date, received_date, batch_code)`.
- `GET /batches/{batch_id}`:
  - Returns batch info + movement history (latest first).
- `GET /batches/qr/{qr_value}`:
  - Matches by `batch_code` or `lot_number` (case-insensitive normalization).
  - Returns same structure as batch detail.
- `GET /batches/suggest-issue`:
  - Requires `drug_id` or `drug_code` (`400` if both missing).
  - Candidate set: only `active` batches with remaining stock.
  - Allocation rule:
    - If `days_to_expiry < FEFO_THRESHOLD_DAYS` => FEFO (nearest expiry first)
    - Else FIFO (oldest received first)
  - Returns allocations, shortage, and applied rule metadata.
- `PATCH /batches/{batch_id}/status`:
  - `cancelled`: zeroes stock, marks cancelled; writes negative adjustment movement if stock existed.
  - `depleted`: zeroes stock (cannot apply to cancelled batch).
  - `expired`: sets `force_expired = true` (cannot apply to cancelled batch).
  - `active`: only if not cancelled, qty > 0, and not already past expiry date.
  - Invalid transitions return `409`.

### 4) Stock

- `GET /stock`:
  - Legacy compatibility map `{drug_code_or_alias: total_qty}` for service integrations.
- `GET /stock/summary`:
  - Per-drug aggregate:
    - `total_qty`
    - nearest expiry from non-cancelled, in-stock batches
    - status (`out_of_stock`, `expired`, `expiring_soon`, `near_date`, `low_stock`, `normal`)
  - Sorted by drug code.
- `GET /stock/drugs/{drug_id}`:
  - Drug-level summary + all related batches sorted by `(exp_date, received_date, batch_code)`.
- `POST /stock/adjustments`:
  - Request must provide exactly one of `quantity_delta` or `new_quantity`.
  - Rejects cancelled batch.
  - Rejects if adjustment makes stock negative (`409`).
  - Applies quantity update and writes `stock_adjustment` movement.

### 5) Alerts and movement report

- `GET /alerts`:
  - Low-stock threshold per drug:
    - use query `low_stock_threshold` if provided
    - otherwise use drug `reorder_level`
  - Expiry buckets (ignores cancelled/empty batches):
    - `expired`: `days_to_expiry < 0`
    - `expiring_soon`: `< 30`
    - `near_date`: `30-89`
  - Returns totals and detailed lists.
- `GET /reports/movement`:
  - Requires `date_from`, `date_to` and validates `date_to >= date_from` (`400` otherwise).
  - Optional `drug` filter (id/code/alias resolve).
  - Per drug:
    - opening stock = sum of movements before `date_from`
    - in-period split: imported, exported, adjusted in/out
    - closing stock = opening + net in-period movement

### 6) Reserve flow for Sale service

- `POST /reserve` is all-or-nothing:
  - Phase 1: compute allocations for every item using the same FEFO/FIFO suggestion logic.
  - If any item has shortage -> return `409` and do not mutate stock.
  - Phase 2: when all items pass, deduct from each allocated batch and log `sale_reserve` movements.
  - Writes a reservation record (keeps last 500 records and persists state to PostgreSQL).

## API Reference (Request/Response Samples)

### Conventions

- Direct service base URL: `http://localhost:8002`
- Gateway base URL: `http://localhost:8000/api/v1`
- Inventory prefix: `/api/v1/inventory`
- Write APIs require header: `Authorization: Bearer <access_token>`

### 1) Health and metadata

#### `GET /health`

Request:

```bash
curl http://localhost:8002/health
```

Response `200`:

```json
{
  "service": "inventory",
  "status": "ok"
}
```

#### `GET /api/v1/inventory/meta/drugs`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/meta/drugs
```

Response `200` (rút gọn):

```json
[
  {
    "id": "d1",
    "code": "T0001",
    "name": "Panadol Extra",
    "group": "Giam dau",
    "base_unit": "Vien",
    "reorder_level": 200,
    "sku_aliases": ["PANADOL"]
  }
]
```

#### `GET /api/v1/inventory/meta/suppliers`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/meta/suppliers
```

Response `200`:

```json
[
  {
    "id": "s1",
    "name": "Phuong Dong",
    "contact_name": "Nguyen Minh Ha",
    "phone": "028 3838 8899",
    "address": "Q1, HCMC"
  }
]
```

#### `GET /api/v1/inventory/events`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/events
```

Response `200`:

```json
[
  {
    "sale_id": "S0009",
    "created_at": "2026-02-13T09:20:00Z"
  }
]
```

### 2) Import receipts

#### `GET /api/v1/inventory/import-receipts`

Request:

```bash
curl "http://localhost:8002/api/v1/inventory/import-receipts?date_from=2026-01-01&date_to=2026-12-31&supplier_id=s1&status=confirmed"
```

Response `200` (rút gọn):

```json
[
  {
    "id": "rcp-10",
    "code": "PN20260213001",
    "receipt_date": "2026-02-13",
    "supplier_id": "s1",
    "supplier_name": "Phuong Dong",
    "status": "confirmed",
    "total_value": 1470000.0,
    "line_count": 2,
    "can_edit": true
  }
]
```

#### `GET /api/v1/inventory/import-receipts/{receipt_id}`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/import-receipts/rcp-10
```

Response `200` (rút gọn):

```json
{
  "id": "rcp-10",
  "code": "PN20260213001",
  "receipt_date": "2026-02-13",
  "supplier_id": "s1",
  "status": "confirmed",
  "lines": [
    {
      "id": "rline-23",
      "batch_id": "bt-18",
      "drug_id": "d1",
      "drug_code": "T0001",
      "lot_number": "PA-0226",
      "batch_code": "LO20260213001",
      "quantity": 300,
      "mfg_date": "2026-01-10",
      "exp_date": "2027-12-10",
      "import_price": 245000.0,
      "line_total": 73500000.0,
      "batch_status": "active"
    }
  ]
}
```

#### `POST /api/v1/inventory/import-receipts`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Request body:

```json
{
  "receipt_date": "2026-02-13",
  "supplier_id": "s1",
  "note": "Nhap hang thang 2",
  "lines": [
    {
      "drug_code": "T0001",
      "lot_number": "PA-0226",
      "quantity": 300,
      "mfg_date": "2026-01-10",
      "exp_date": "2027-12-10",
      "import_price": 245000,
      "promo_note": "Tang 5 hop"
    },
    {
      "drug_id": "d2",
      "batch_code": "LO-CUSTOM-001",
      "lot_number": "VC-0226",
      "quantity": 120,
      "mfg_date": "2026-01-01",
      "exp_date": "2027-10-01",
      "import_price": 178000
    }
  ]
}
```

Response `201` (rút gọn):

```json
{
  "id": "rcp-11",
  "code": "PN20260213002",
  "status": "confirmed",
  "created_by": "1",
  "total_value": 94860000.0,
  "lines": [
    {
      "batch_id": "bt-19",
      "batch_code": "LO20260213002",
      "drug_code": "T0001",
      "quantity": 300
    },
    {
      "batch_id": "bt-20",
      "batch_code": "LO-CUSTOM-001",
      "drug_code": "T0034",
      "quantity": 120
    }
  ]
}
```

#### `PUT /api/v1/inventory/import-receipts/{receipt_id}`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Request body (cùng schema với tạo mới):

```json
{
  "receipt_date": "2026-02-14",
  "supplier_id": "s1",
  "note": "Cap nhat phieu nhap",
  "lines": [
    {
      "drug_id": "d1",
      "lot_number": "PA-0226-REV1",
      "quantity": 280,
      "mfg_date": "2026-01-10",
      "exp_date": "2027-12-10",
      "import_price": 245000
    }
  ]
}
```

Response `200`:

```json
{
  "id": "rcp-11",
  "receipt_date": "2026-02-14",
  "note": "Cap nhat phieu nhap",
  "status": "confirmed",
  "can_edit": true
}
```

#### `POST /api/v1/inventory/import-receipts/{receipt_id}/cancel`

Headers:

```http
Authorization: Bearer <access_token>
```

Request:

```bash
curl -X POST \
  -H "Authorization: Bearer <access_token>" \
  http://localhost:8002/api/v1/inventory/import-receipts/rcp-11/cancel
```

Response `200`:

```json
{
  "message": "Import receipt cancelled and stock rolled back",
  "receipt": {
    "id": "rcp-11",
    "status": "cancelled"
  }
}
```

### 3) Batches

#### `GET /api/v1/inventory/batches`

Request:

```bash
curl "http://localhost:8002/api/v1/inventory/batches?search=panadol&drug=d1&status=active&exp_from=2026-01-01&exp_to=2027-12-31"
```

Response `200` (rút gọn):

```json
[
  {
    "id": "bt-18",
    "batch_code": "LO20260213001",
    "lot_number": "PA-0226",
    "drug_id": "d1",
    "drug_code": "T0001",
    "supplier_id": "s1",
    "received_date": "2026-02-13",
    "exp_date": "2027-12-10",
    "qty_in": 300,
    "qty_remaining": 280,
    "status": "active"
  }
]
```

#### `GET /api/v1/inventory/batches/{batch_id}`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/batches/bt-18
```

Response `200` (rút gọn):

```json
{
  "batch": {
    "id": "bt-18",
    "batch_code": "LO20260213001",
    "status": "active"
  },
  "history": [
    {
      "id": "mv-101",
      "event_type": "import_receipt",
      "quantity_delta": 300,
      "reference_type": "import_receipt",
      "reference_id": "rcp-11"
    }
  ]
}
```

#### `GET /api/v1/inventory/batches/qr/{qr_value}`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/batches/qr/LO20260213001
```

Response `200`: cùng format với `GET /batches/{batch_id}`.

#### `GET /api/v1/inventory/batches/suggest-issue`

Request:

```bash
curl "http://localhost:8002/api/v1/inventory/batches/suggest-issue?drug_code=T0001&quantity=150&as_of=2026-02-13"
```

Response `200`:

```json
{
  "drug_id": "d1",
  "drug_code": "T0001",
  "drug_name": "Panadol Extra",
  "requested": 150,
  "allocated": 150,
  "shortage": 0,
  "rule": {
    "fefo_threshold_days": 180,
    "description": "expiry < threshold => FEFO, otherwise FIFO"
  },
  "allocations": [
    {
      "batch_id": "bt-2",
      "batch_code": "LO20250808001",
      "available": 80,
      "allocated": 80,
      "strategy": "fefo"
    },
    {
      "batch_id": "bt-1",
      "batch_code": "LO20251215001",
      "available": 240,
      "allocated": 70,
      "strategy": "fifo"
    }
  ]
}
```

#### `PATCH /api/v1/inventory/batches/{batch_id}/status`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Request body:

```json
{
  "status": "expired"
}
```

Response `200`:

```json
{
  "id": "bt-18",
  "batch_code": "LO20260213001",
  "status": "expired",
  "qty_remaining": 280
}
```

Accepted `status` values:
- `active`
- `depleted`
- `expired`
- `cancelled`

### 4) Stock

#### `GET /api/v1/inventory/stock`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/stock
```

Response `200`:

```json
{
  "T0001": 320,
  "PANADOL": 320,
  "T0034": 345,
  "VITC1000": 345
}
```

#### `GET /api/v1/inventory/stock/summary`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/stock/summary
```

Response `200` (rút gọn):

```json
[
  {
    "drug_id": "d1",
    "drug_code": "T0001",
    "drug_name": "Panadol Extra",
    "reorder_level": 200,
    "total_qty": 320,
    "nearest_expiry": "2026-04-15",
    "days_to_nearest_expiry": 62,
    "status": "near_date"
  }
]
```

#### `GET /api/v1/inventory/stock/drugs/{drug_id}`

Request:

```bash
curl http://localhost:8002/api/v1/inventory/stock/drugs/d1
```

Response `200` (rút gọn):

```json
{
  "drug": {
    "id": "d1",
    "code": "T0001",
    "name": "Panadol Extra"
  },
  "summary": {
    "total_qty": 320,
    "status": "near_date",
    "reorder_level": 200
  },
  "batches": [
    {
      "id": "bt-2",
      "batch_code": "LO20250808001",
      "qty_remaining": 80,
      "status": "active"
    }
  ]
}
```

#### `POST /api/v1/inventory/stock/adjustments`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Request body (dùng `quantity_delta`):

```json
{
  "batch_id": "bt-18",
  "reason": "inventory_count",
  "note": "Dieu chinh sau kiem ke",
  "quantity_delta": -5
}
```

Hoặc request body (dùng `new_quantity`):

```json
{
  "batch_id": "bt-18",
  "reason": "inventory_count",
  "new_quantity": 260
}
```

Response `200`:

```json
{
  "message": "Stock adjusted",
  "batch": {
    "id": "bt-18",
    "qty_remaining": 275
  },
  "adjustment": {
    "id": "mv-130",
    "event_type": "stock_adjustment",
    "quantity_delta": -5
  }
}
```

### 5) Alerts and reports

#### `GET /api/v1/inventory/alerts`

Request:

```bash
curl "http://localhost:8002/api/v1/inventory/alerts?low_stock_threshold=100&as_of=2026-02-13"
```

Response `200` (rút gọn):

```json
{
  "as_of": "2026-02-13",
  "totals": {
    "low_stock": 1,
    "expiring_soon": 2,
    "near_date": 1,
    "expired": 0
  },
  "low_stock": [
    {
      "drug_id": "d3",
      "drug_code": "T0088",
      "current_qty": 60,
      "threshold": 100
    }
  ],
  "expiring_soon": []
}
```

#### `GET /api/v1/inventory/reports/movement`

Request:

```bash
curl "http://localhost:8002/api/v1/inventory/reports/movement?date_from=2026-01-01&date_to=2026-12-31&drug=d1"
```

Response `200`:

```json
{
  "date_from": "2026-01-01",
  "date_to": "2026-12-31",
  "rows": [
    {
      "drug_id": "d1",
      "drug_code": "T0001",
      "drug_name": "Panadol Extra",
      "opening_stock": 320,
      "imported_qty": 300,
      "exported_qty": 50,
      "adjusted_in": 0,
      "adjusted_out": 5,
      "closing_stock": 565
    }
  ]
}
```

### 6) Reserve stock for sale

#### `POST /api/v1/inventory/reserve`

Headers:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Request body:

```json
{
  "sale_id": "S0001",
  "items": [
    { "sku": "PANADOL", "quantity": 2 },
    { "sku": "VITC1000", "quantity": 1 }
  ]
}
```

Response `200` (rút gọn):

```json
{
  "message": "Stock reserved",
  "reservation": {
    "id": "rsv-15",
    "sale_id": "S0001",
    "reserved_by": "1",
    "reserved_at": "2026-02-13T10:05:02.121Z",
    "items": [
      {
        "sku": "PANADOL",
        "requested": 2,
        "allocations": [
          {
            "batch_id": "bt-2",
            "allocated": 2,
            "strategy": "fefo"
          }
        ]
      }
    ]
  }
}
```

Response lỗi thiếu hàng `409`:

```json
{
  "detail": {
    "message": "Not enough stock for 'PANADOL'",
    "requested": 5000,
    "available": 320,
    "shortage": 4680
  }
}
```

### 7) Common error responses

`400` (business validation):

```json
{
  "detail": "Provide drug_id or drug_code"
}
```

`422` (Pydantic validation):

```json
{
  "detail": [
    {
      "type": "value_error",
      "loc": ["body", "lines", 0],
      "msg": "Value error, exp_date must be later than mfg_date"
    }
  ]
}
```

`401` (token):

```json
{
  "detail": "Invalid token"
}
```

`404`:

```json
{
  "detail": "Batch 'bt-999' not found"
}
```

`409`:

```json
{
  "detail": "Receipt cannot be modified because batch has sales/adjustments"
}
```

## Quick Gateway Test

Base gateway URL: `http://localhost:8000/api/v1`

1. Login and get token
- `POST /auth/login`

2. Stock check
- `GET /inventory/stock`
- `GET /inventory/stock/summary`

3. Create import receipt
- `POST /inventory/import-receipts`

4. Suggest issue
- `GET /inventory/batches/suggest-issue?drug_id=d1&quantity=5`

5. Reserve stock
- `POST /inventory/reserve`

6. Alerts/report
- `GET /inventory/alerts`
- `GET /inventory/reports/movement?date_from=2025-01-01&date_to=2026-12-31`

## Notes

- Service persists state to PostgreSQL and reloads it on startup.
- Ensure `DATABASE_URL` points to a persistent Postgres instance to keep receipts/batches across container recreation.
- Existing `Sale Service` integration remains compatible through `/inventory/reserve`.
