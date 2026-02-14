# Catalog Service Documentation

## 1) Tong quan

Catalog Service quan ly danh muc du lieu cho he thong nha thuoc:

- Drug Groups
- Manufacturers
- Suppliers + debt history
- Products
- Product Units
- Import/Export Excel

Service duoc viet bang FastAPI, su dung PostgreSQL (schema `catalog`), va expose qua API Gateway.

## 2) Base URL va Authentication

- Qua Gateway: `http://localhost:8000/api/v1/catalog`
- Direct service (noi bo): `http://localhost:8006/api/v1/catalog`

Tat ca endpoint trong `/api/v1/catalog/*` deu yeu cau Bearer token.

Lay token tu Users service:

- `POST /api/v1/auth/login`

Header su dung:

```http
Authorization: Bearer <access_token>
```

## 3) Phan quyen

- `All`: owner, manager, staff
- `Manager+`: owner, manager
- `Owner`: chi owner

Role duoc doc tu JWT claim `role`.

## 4) Quy uoc chung

### 4.1 Pagination

Nhieu endpoint list tra ve dang:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "size": 20,
  "pages": 0
}
```

Mac dinh:

- `page=1`
- `size=20`
- `size` toi da `200`

### 4.2 Soft delete

`DELETE` trong Catalog la soft delete:

- Dat `is_active=false`
- Khong xoa vat ly record (tru quan he `product_units` co `ON DELETE CASCADE` khi xoa cung, nhung endpoint hien tai dang soft delete)

### 4.3 Ma code tu dong

Neu khong truyen `code`, service tu sinh:

- Drug Group: prefix `DG` (vd `DG0001`)
- Manufacturer: prefix `MFG` (vd `MFG0001`)
- Supplier: prefix `SUP` (vd `SUP0001`)
- Product: prefix `T` (vd `T0001`)

### 4.4 Loi thuong gap

- `401`: token khong hop le/thieu token
- `403`: khong du quyen
- `404`: khong tim thay resource
- `409`: conflict business rule (trung code, dang duoc su dung, ...)
- `422`: body/query sai schema

## 5) API Endpoints tong hop

### 5.1 System

- `GET /` - health root
- `GET /health` - health check

### 5.2 Drug Groups

- `GET /drug-groups` (All)
- `GET /drug-groups/{group_id}` (All)
- `POST /drug-groups` (Manager+)
- `PUT /drug-groups/{group_id}` (Manager+)
- `DELETE /drug-groups/{group_id}` (Owner)

### 5.3 Manufacturers

- `GET /manufacturers` (All)
- `GET /manufacturers/{manufacturer_id}` (All)
- `POST /manufacturers` (Manager+)
- `PUT /manufacturers/{manufacturer_id}` (Manager+)
- `DELETE /manufacturers/{manufacturer_id}` (Owner)

### 5.4 Suppliers

- `GET /suppliers` (All)
- `GET /suppliers/{supplier_id}` (All)
- `POST /suppliers` (Manager+)
- `PUT /suppliers/{supplier_id}` (Manager+)
- `DELETE /suppliers/{supplier_id}` (Owner)
- `GET /suppliers/{supplier_id}/debt` (Manager+)
- `POST /suppliers/{supplier_id}/debt/payment` (Manager+)

### 5.5 Products

- `GET /products` (All)
- `GET /products/search?q=` (All)
- `GET /products/barcode/{barcode}` (All)
- `POST /products` (Manager+)
- `PUT /products/{product_id}` (Manager+)
- `DELETE /products/{product_id}` (Owner)
- `GET /products/{product_id}` (All)

### 5.6 Product Units

- `GET /products/{product_id}/units` (All)
- `POST /products/{product_id}/units` (Manager+)
- `PUT /products/{product_id}/units/{unit_id}` (Manager+)
- `DELETE /products/{product_id}/units/{unit_id}` (Manager+)
- `GET /units/barcode/{barcode}` (All)

### 5.7 Excel

- `POST /products/import` (Manager+)
- `GET /products/export` (Manager+)

## 6) Chi tiet API: Drug Groups

## `GET /drug-groups`

Permission: `All`

Query params:

- `search` (optional): tim theo `code`, `name`
- `is_active` (optional): `true/false`
- `page` (default `1`)
- `size` (default `20`, max `200`)

Response `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "DG0001",
      "name": "Giam dau",
      "description": "Nhom thuoc giam dau",
      "is_active": true,
      "created_at": "2026-02-14T10:00:00Z",
      "updated_at": "2026-02-14T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20,
  "pages": 1
}
```

Logic:

- Sort theo `created_at desc`
- Filter search va `is_active`

## `GET /drug-groups/{group_id}`

Permission: `All`

Response `200`: `DrugGroupResponse`

Response `404`: `Drug group not found`

## `POST /drug-groups`

Permission: `Manager+`

Request:

```json
{
  "code": "GIAMDAU",
  "name": "Giam dau",
  "description": "Nhom giam dau",
  "is_active": true
}
```

`code` la optional. Neu bo qua -> auto generate `DGxxxx`.

Response `201`: `DrugGroupResponse`

Logic:

- Chuan hoa `code` (trim + uppercase)
- Validate unique code

## `PUT /drug-groups/{group_id}`

Permission: `Manager+`

Request: partial update (chi field truyen len moi update).

Response `200`: `DrugGroupResponse`

Logic:

- Neu update `code` -> check unique (exclude ban ghi hien tai)

## `DELETE /drug-groups/{group_id}`

Permission: `Owner`

Response `200`:

```json
{
  "message": "Drug group deleted (soft delete)"
}
```

Logic:

- Khong cho xoa neu con product active dang dung group (`409`)
- Neu hop le -> `is_active=false`

## 7) Chi tiet API: Manufacturers

## `GET /manufacturers`

Permission: `All`

Query params:

- `search` (code/name)
- `is_active`
- `page`, `size`

Response: page object tuong tu Drug Groups.

## `GET /manufacturers/{manufacturer_id}`

Permission: `All`

Response `200`: `ManufacturerResponse`

## `POST /manufacturers`

Permission: `Manager+`

Request:

```json
{
  "code": "GSK",
  "name": "GlaxoSmithKline",
  "country": "UK",
  "address": "London",
  "phone": "0123456789",
  "is_active": true
}
```

`code` optional, neu bo qua auto `MFGxxxx`.

Response `201`: `ManufacturerResponse`

## `PUT /manufacturers/{manufacturer_id}`

Permission: `Manager+`

Request: partial update.

Response `200`: `ManufacturerResponse`

## `DELETE /manufacturers/{manufacturer_id}`

Permission: `Owner`

Response `200`:

```json
{
  "message": "Manufacturer deleted (soft delete)"
}
```

Logic:

- Khong cho xoa neu con product active dang dung manufacturer (`409`)
- Soft delete `is_active=false`

## 8) Chi tiet API: Suppliers

## `GET /suppliers`

Permission: `All`

Query params:

- `search` (code/name/phone)
- `is_active`
- `page`, `size`

Response: page object cua `SupplierResponse`.

## `GET /suppliers/{supplier_id}`

Permission: `All`

Response `200`: `SupplierResponse`

## `POST /suppliers`

Permission: `Manager+`

Request:

```json
{
  "code": "SUP001",
  "name": "NPP ABC",
  "address": "HCM",
  "phone": "0900000000",
  "email": "abc@npp.vn",
  "tax_code": "123456",
  "contact_person": "Nguyen Van A",
  "current_debt": 1000000,
  "is_active": true,
  "note": "Nha phan phoi chinh"
}
```

`code` optional, neu bo qua auto `SUPxxxx`.

Response `201`: `SupplierResponse`

## `PUT /suppliers/{supplier_id}`

Permission: `Manager+`

Request: partial update.

Response `200`: `SupplierResponse`

## `DELETE /suppliers/{supplier_id}`

Permission: `Owner`

Response `200`:

```json
{
  "message": "Supplier deleted (soft delete)"
}
```

Logic:

- Khong cho xoa neu co debt history `type=import` (`409`)
- Neu khong co -> soft delete

## `GET /suppliers/{supplier_id}/debt`

Permission: `Manager+`

Query params:

- `page` (default `1`)
- `size` (default `20`)

Response `200`:

```json
{
  "supplier_id": "uuid",
  "supplier_code": "SUP001",
  "supplier_name": "NPP ABC",
  "current_debt": 900000,
  "history": {
    "items": [
      {
        "id": "uuid",
        "supplier_id": "uuid",
        "type": "payment",
        "amount": 100000,
        "balance_after": 900000,
        "reference_type": "payment",
        "reference_id": null,
        "note": "Thanh toan dot 1",
        "created_by": "1",
        "created_at": "2026-02-14T10:00:00Z"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20,
    "pages": 1
  }
}
```

## `POST /suppliers/{supplier_id}/debt/payment`

Permission: `Manager+`

Request:

```json
{
  "amount": 100000,
  "note": "Thanh toan dot 1",
  "reference_id": null
}
```

Response `200`:

```json
{
  "message": "Supplier debt payment recorded",
  "supplier_id": "uuid",
  "current_debt": 900000,
  "entry": {
    "id": "uuid",
    "supplier_id": "uuid",
    "type": "payment",
    "amount": 100000,
    "balance_after": 900000,
    "reference_type": "payment",
    "reference_id": null,
    "note": "Thanh toan dot 1",
    "created_by": "1",
    "created_at": "2026-02-14T10:00:00Z"
  }
}
```

Logic:

- `amount > 0`
- Khong duoc thanh toan vuot `current_debt` (`400`)
- Tru no va ghi 1 dong history type `payment`

## 9) Chi tiet API: Products

## `GET /products`

Permission: `All`

Query params:

- `search` (code/name/barcode/registration_number)
- `group_id` (UUID)
- `manufacturer_id` (UUID)
- `is_active` (bool)
- `page`, `size`

Response `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "T0001",
      "barcode": "8934567890123",
      "name": "Panadol Extra",
      "registration_number": "VD-12345-20",
      "group_name": "Giam dau",
      "manufacturer_name": "GlaxoSmithKline",
      "base_unit": "Vien",
      "base_price": 2500,
      "is_active": true,
      "created_at": "2026-02-14T10:00:00Z",
      "updated_at": "2026-02-14T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20,
  "pages": 1
}
```

## `GET /products/search`

Permission: `All`

Query params:

- `q` (required, min length = 1)
- `limit` (default `20`, max `100`)

Response `200`: `ProductListItemResponse[]`

Logic:

- Chi lay product active
- Sort `updated_at desc`

## `GET /products/barcode/{barcode}`

Permission: `All`

Response `200`:

```json
{
  "product": {
    "id": "uuid",
    "code": "T0001",
    "barcode": "8934567890123",
    "name": "Panadol Extra",
    "registration_number": "VD-12345-20",
    "group_name": "Giam dau",
    "manufacturer_name": "GlaxoSmithKline",
    "base_unit": "Vien",
    "base_price": 2500,
    "is_active": true,
    "created_at": "2026-02-14T10:00:00Z",
    "updated_at": "2026-02-14T10:00:00Z"
  },
  "unit": {
    "id": "uuid",
    "product_id": "uuid",
    "unit_name": "Vien",
    "conversion_rate": 1,
    "barcode": "8934567890123",
    "selling_price": 2500,
    "is_base_unit": true,
    "is_active": true,
    "created_at": "2026-02-14T10:00:00Z",
    "updated_at": "2026-02-14T10:00:00Z"
  }
}
```

Logic:

- Uu tien tim theo `product_units.barcode`
- Neu khong co thi tim theo `products.barcode`
- Neu tim theo product barcode se lay base unit active (hoac unit active dau tien)

## `POST /products`

Permission: `Manager+`

Request:

```json
{
  "code": "T0001",
  "barcode": "8934567890123",
  "name": "Panadol Extra",
  "registration_number": "VD-12345-20",
  "group_id": "uuid",
  "manufacturer_id": "uuid",
  "instructions": "Uong 1 vien",
  "note": "",
  "is_active": true,
  "base_unit": {
    "unit_name": "Vien",
    "selling_price": 2500
  }
}
```

`code` optional, neu bo qua auto `Txxxx`.

Response `201`: `ProductDetailResponse` (kem `units`).

Logic:

- Validate group/manufacturer ton tai neu co truyen
- Luon tao 1 base unit voi `conversion_rate=1`, `is_base_unit=true`
- Neu khong truyen `base_unit` thi tao mac dinh

## `PUT /products/{product_id}`

Permission: `Manager+`

Request: partial update.

Response `200`: `ProductDetailResponse`

Logic:

- Co validate unique `code`
- Co validate group/manufacturer khi cap nhat id

## `DELETE /products/{product_id}`

Permission: `Owner`

Response `200`:

```json
{
  "message": "Product deleted (soft delete)"
}
```

Logic:

- Goi Inventory service de kiem tra batch (`/api/v1/inventory/batches?product_id=...&size=1`)
- Neu co batch -> `409`
- Neu khong -> `product.is_active=false` va tat ca unit `is_active=false`

## `GET /products/{product_id}`

Permission: `All`

Response `200`: `ProductDetailResponse`

## 10) Chi tiet API: Product Units

## `GET /products/{product_id}/units`

Permission: `All`

Query params:

- `include_inactive` (default `false`)

Response `200`: `ProductUnitResponse[]`

Logic:

- Sort theo base unit truoc, sau do theo `conversion_rate`, `unit_name`

## `POST /products/{product_id}/units`

Permission: `Manager+`

Request:

```json
{
  "unit_name": "Hop",
  "conversion_rate": 100,
  "barcode": "8934567890999",
  "selling_price": 230000,
  "is_base_unit": false,
  "is_active": true
}
```

Response `201`: `ProductUnitResponse`

Logic:

- `conversion_rate > 0`
- Neu `is_base_unit=true` -> `conversion_rate` phai bang `1`
- Khong cho trung `unit_name` trong cung product (`409`)
- Khong cho co hon 1 active base unit (`409`)

## `PUT /products/{product_id}/units/{unit_id}`

Permission: `Manager+`

Request: partial update.

Response `200`: `ProductUnitResponse`

Logic:

- Base unit phai co `conversion_rate=1`
- Khong cho bo `is_base_unit` cua base unit hien tai (`400`)
- Khong cho deactivate base unit (`400`)
- Khong cho trung `unit_name` (`409`)

## `DELETE /products/{product_id}/units/{unit_id}`

Permission: `Manager+`

Response `200`:

```json
{
  "message": "Product unit deleted (soft delete)"
}
```

Logic:

- Khong cho xoa base unit (`400`)
- Unit thuong thi soft delete (`is_active=false`)

## `GET /units/barcode/{barcode}`

Permission: `All`

Response `200`: giong endpoint barcode lookup (`product` + `unit`)

## 11) Excel APIs

## `POST /products/import`

Permission: `Manager+`

Content-Type: `multipart/form-data`

Field:

- `file`: `.xlsx`

Header bat buoc trong file:

- `name`
- `base_unit_name`
- `base_unit_price`

Cac cot ho tro them:

- `code`
- `barcode`
- `registration_number`
- `group_code`
- `manufacturer_code`
- `instructions`
- `note`
- `unit_barcode`

Response `200`:

```json
{
  "imported": 10,
  "failed": 2,
  "errors": [
    "Row 5: product code 'T0003' already exists",
    "Row 8: base_unit_name is required"
  ]
}
```

Logic:

- Bo qua dong rong/khong co `name`
- Neu khong co `code` thi tu sinh `Txxxx`
- Neu `group_code`/`manufacturer_code` khong map duoc thi de `null`
- Moi dong insert product + 1 base unit
- Dong loi thi rollback dong do, tiep tuc dong sau

## `GET /products/export`

Permission: `Manager+`

Response `200`:

- Content-Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- File name: `catalog_products.xlsx`

Columns export:

- `code`
- `barcode`
- `name`
- `registration_number`
- `group_code`
- `group_name`
- `manufacturer_code`
- `manufacturer_name`
- `instructions`
- `note`
- `base_unit_name`
- `base_unit_price`
- `is_active`

## 12) Data model tom tat

Bang chinh:

- `catalog.drug_groups`
- `catalog.manufacturers`
- `catalog.suppliers`
- `catalog.supplier_debt_history`
- `catalog.products`
- `catalog.product_units`

Constraints/Index quan trong:

- Unique code cho `drug_groups`, `manufacturers`, `suppliers`, `products`
- Unique `(product_id, unit_name)` cho `product_units`
- GIN full-text index tren `products.name`
- FK:
  - `products.group_id -> drug_groups.id`
  - `products.manufacturer_id -> manufacturers.id`
  - `product_units.product_id -> products.id`
  - `supplier_debt_history.supplier_id -> suppliers.id`

## 13) Luong nghiep vu de xuat

1. Tao master data:
   - Drug group
   - Manufacturer
   - Supplier
2. Tao product + base unit
3. Them cac don vi quy doi (Hop, Vi, ...)
4. Dung endpoint barcode de scan nhanh khi ban hang
5. Dung import/export de dong bo danh muc lon

## 14) Ghi chu implementation

- Service tao schema/table khi startup (`CREATE SCHEMA IF NOT EXISTS` + `metadata.create_all`).
- Endpoint detail product/unit dung path type `:uuid` de tranh xung dot voi `/products/import` va `/products/export`.
- Kiem tra batch truoc khi xoa product la best-effort:
  - Neu Inventory service khong san sang, logic fallback la xem nhu khong co batch.

