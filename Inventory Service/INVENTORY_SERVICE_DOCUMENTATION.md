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

- Service currently uses in-memory state (seeded demo data on startup).
- Existing `Sale Service` integration remains compatible through `/inventory/reserve`.
