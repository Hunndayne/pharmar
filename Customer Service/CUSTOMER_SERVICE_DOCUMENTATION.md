# Customer Service Documentation

## 1) Overview

Customer Service quan ly:

- Customers
- Points transactions (earn/redeem/adjust/expire/rollback)
- Tier configs
- Promotions + promotion usages
- Internal APIs cho Sale Service

Service viet bang FastAPI, su dung PostgreSQL schema `customer`.

## 2) Base URL and Auth

- Through gateway: `http://localhost:8000/api/v1/customer`
- Direct service: `http://localhost:8007/api/v1/customer`

Public business endpoints yeu cau Bearer token.
Internal endpoints yeu cau header:

```http
X-Internal-API-Key: <CUSTOMER_INTERNAL_API_KEY>
```

## 3) Permissions

- `All`: owner, manager, staff
- `Manager+`: owner, manager
- `Owner`: owner only
- `Internal`: internal key only

## 4) Core business logic

### 4.1 Customer code

- Auto generate `KH0001`, `KH0002`, ...

### 4.2 Points

- `points_earned = floor(order_amount / customer.points_per_amount) * tier_multiplier`
- `discount_from_points = points_used * customer.point_value`
- Points expiry date duoc cap nhat theo `customer.points_expiry_months` (Store Service setting).
- Background job co the bat (`ENABLE_POINTS_EXPIRY_JOB=true`) de expire points theo ngay.

### 4.3 Tier update

- Tier duoc xac dinh theo `total_points_earned` va bang `tier_configs`.
- Sau moi lan earn/adjust tang diem, service kiem tra auto upgrade.

### 4.4 Promotion validation

Kiem tra theo thu tu:
1. `is_active = true`
2. Date range (`start_date <= today <= end_date`)
3. `usage_limit`
4. `usage_per_customer`
5. `applicable_tiers`
6. `min_order_amount`
7. `applicable_products` / `applicable_groups`

Discount:
- `percent`: `order_amount * discount_value / 100`, co `max_discount` neu co
- `fixed`: `discount_value`

## 5) Endpoint summary

### System

- `GET /health`

### Customers

- `GET /customers` (All)
- `GET /customers/{id}` (All)
- `GET /customers/phone/{phone}` (All)
- `POST /customers` (All)
- `PUT /customers/{id}` (All)
- `DELETE /customers/{id}` (Manager+)
- `GET /customers/{id}/points` (All)
- `POST /customers/{id}/points/adjust` (Manager+)
- `GET /customers/{id}/stats` (All)

### Tiers

- `GET /tiers` (All)
- `GET /tiers/{name}` (All)
- `PUT /tiers/{name}` (Owner)

### Promotions

- `GET /promotions` (All)
- `GET /promotions/active` (All)
- `GET /promotions/{id}` (All)
- `GET /promotions/code/{code}` (All)
- `POST /promotions` (Manager+)
- `PUT /promotions/{id}` (Manager+)
- `DELETE /promotions/{id}` (Owner)
- `GET /promotions/{id}/usages` (Manager+)

### Internal APIs

- `POST /internal/customers/lookup`
- `POST /internal/points/calculate`
- `POST /internal/points/earn`
- `POST /internal/points/redeem`
- `POST /internal/points/rollback`
- `POST /internal/promotions/validate`
- `POST /internal/promotions/apply`
- `POST /internal/promotions/rollback`
- `GET /internal/promotions/suggest`
- `POST /internal/stats/update`

## 6) Request/Response samples

### 6.1 Create customer

`POST /customers`

Request:
```json
{
  "name": "Nguyen Van A",
  "phone": "0901234567",
  "email": "a@example.com",
  "gender": "male",
  "address": "HCM"
}
```

Response 201:
```json
{
  "id": "uuid",
  "code": "KH0001",
  "name": "Nguyen Van A",
  "phone": "0901234567",
  "email": "a@example.com",
  "current_points": 0,
  "tier": "bronze",
  "total_orders": 0,
  "total_spent": 0,
  "is_active": true,
  "created_at": "2026-02-14T12:00:00Z",
  "updated_at": "2026-02-14T12:00:00Z"
}
```

### 6.2 List customers

`GET /customers?search=0901&tier=gold&page=1&size=20`

Response 200:
```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "size": 20,
  "pages": 0
}
```

### 6.3 Adjust points

`POST /customers/{id}/points/adjust`

Request:
```json
{
  "points": 100,
  "note": "Manual bonus"
}
```

Response 200:
```json
{
  "message": "Points adjusted",
  "customer_id": "uuid",
  "adjusted_points": 100,
  "new_balance": 250,
  "tier_changed": false,
  "new_tier": "silver"
}
```

### 6.4 Internal calculate points

`POST /internal/points/calculate`

Request:
```json
{
  "customer_id": "uuid",
  "order_amount": 150000
}
```

Response 200:
```json
{
  "base_points": 150,
  "tier_multiplier": 1.5,
  "points_earned": 225
}
```

### 6.5 Internal redeem points

`POST /internal/points/redeem`

Request:
```json
{
  "customer_id": "uuid",
  "points": 100,
  "reference_type": "invoice",
  "reference_id": "invoice-uuid",
  "reference_code": "HD20260214001"
}
```

Response 200:
```json
{
  "success": true,
  "points_used": 100,
  "discount_amount": 100000,
  "new_balance": 900
}
```

### 6.6 Create promotion

`POST /promotions`

Request:
```json
{
  "code": "SALE20",
  "name": "Sale 20%",
  "discount_type": "percent",
  "discount_value": 20,
  "max_discount": 50000,
  "min_order_amount": 100000,
  "start_date": "2026-02-14",
  "end_date": "2026-03-31",
  "applicable_tiers": ["silver", "gold", "diamond"],
  "usage_limit": 1000,
  "usage_per_customer": 5,
  "is_active": true,
  "auto_apply": true
}
```

Response 201:
```json
{
  "id": "uuid",
  "code": "SALE20",
  "name": "Sale 20%",
  "discount_type": "percent",
  "discount_value": 20,
  "current_usage": 0,
  "is_active": true,
  "auto_apply": true,
  "created_at": "2026-02-14T12:10:00Z",
  "updated_at": "2026-02-14T12:10:00Z"
}
```

### 6.7 Internal validate promotion

`POST /internal/promotions/validate`

Request:
```json
{
  "promotion_code": "SALE20",
  "customer_id": "uuid",
  "order_amount": 200000,
  "product_ids": ["uuid1", "uuid2"]
}
```

Response 200 (valid):
```json
{
  "valid": true,
  "promotion": {
    "id": "uuid",
    "code": "SALE20",
    "name": "Sale 20%",
    "discount_type": "percent",
    "discount_value": "20.00",
    "max_discount": "50000.00"
  },
  "calculated_discount": 40000
}
```

Response 200 (invalid):
```json
{
  "valid": false,
  "reason": "Promotion expired"
}
```

### 6.8 Internal suggest promotion

`GET /internal/promotions/suggest?customer_id=<uuid>&order_amount=200000`

Response 200:
```json
{
  "suggestions": [
    {
      "promotion": {
        "id": "uuid",
        "code": "SALE20",
        "name": "Sale 20%",
        "discount_type": "percent",
        "discount_value": "20.00",
        "max_discount": "50000.00"
      },
      "discount_amount": 40000,
      "auto_apply": true
    }
  ],
  "best_auto_apply": {
    "promotion_id": "uuid",
    "discount_amount": 40000
  }
}
```

### 6.9 Internal points rollback

`POST /internal/points/rollback`

Request:
```json
{
  "customer_id": "uuid",
  "points": 225,
  "reference_type": "invoice_cancel",
  "reference_id": "invoice-uuid",
  "reference_code": "HD20260214001",
  "note": "Huy don hang"
}
```

Response 200:
```json
{
  "success": true,
  "rollback_mode": "reverse_earn",
  "points_rolled_back": 225,
  "new_balance": 1725
}
```

Logic:
- Service tim transaction theo `reference_id/reference_code`.
- Neu rollback earn: tru diem va giam `total_points_earned`.
- Neu rollback redeem: cong diem va giam `total_points_used`.
- Tao transaction moi voi `type=rollback`.

### 6.10 Internal promotion rollback

`POST /internal/promotions/rollback`

Request:
```json
{
  "promotion_id": "uuid",
  "usage_id": "uuid",
  "reason": "Invoice cancelled"
}
```

Response 200:
```json
{
  "success": true,
  "promotion_id": "uuid",
  "new_usage_count": 99
}
```

Logic:
- Mark usage `is_cancelled=true`, set `cancelled_reason`, `cancelled_at`.
- Giam `promotion.current_usage` (khong am).
- Neu usage da cancel truoc do, endpoint idempotent va khong giam tiep.

## 7) Database objects

Main tables:

- `customer.tier_configs`
- `customer.customers`
- `customer.point_transactions`
- `customer.promotions`
- `customer.promotion_usages`

SQL script: `Customer Service/Database/customer.sql`

## 8) Error format

Validation/business errors:

```json
{ "detail": "..." }
```

Common codes:

- `400`: invalid payload or business rule
- `401`: token/internal key invalid
- `403`: permission denied
- `404`: resource not found
- `409`: duplicate code/phone conflict
