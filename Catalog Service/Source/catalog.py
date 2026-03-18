from decimal import Decimal, ROUND_HALF_UP
from math import ceil
from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .core.config import get_settings
from .db.models import (
    DrugGroup,
    Manufacturer,
    Product,
    ProductUnit,
    Supplier,
    SupplierDebtHistory,
)
from .schemas.catalog import (
    PageResponse,
    ProductDetailResponse,
    ProductGroupRef,
    ProductListItemResponse,
    ProductManufacturerRef,
    ProductUnitResponse,
    SupplierDebtHistoryResponse,
)


settings = get_settings()


def normalize_optional_string(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def normalize_code(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().upper()
    return normalized or None


def normalize_page_size(page: int, size: int, max_size: int = 200) -> tuple[int, int]:
    safe_page = max(page, 1)
    safe_size = min(max(size, 1), max_size)
    return safe_page, safe_size


def build_pagination(total: int, page: int, size: int) -> tuple[int, int, int]:
    safe_page, safe_size = normalize_page_size(page, size)
    pages = ceil(total / safe_size) if total > 0 else 0
    return safe_page, safe_size, pages


async def paginate_scalars(
    db: AsyncSession,
    stmt: Select[Any],
    page: int,
    size: int,
) -> tuple[list[Any], PageResponse[Any]]:
    safe_page, safe_size = normalize_page_size(page, size)
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int((await db.scalar(count_stmt)) or 0)

    offset = (safe_page - 1) * safe_size
    rows = list((await db.scalars(stmt.offset(offset).limit(safe_size))).all())
    _, _, pages = build_pagination(total, safe_page, safe_size)
    meta = PageResponse[Any](
        items=[],
        total=total,
        page=safe_page,
        size=safe_size,
        pages=pages,
    )
    return rows, meta


async def generate_next_code(
    db: AsyncSession,
    model: Any,
    prefix: str,
    width: int = 4,
) -> str:
    prefix_normalized = prefix.strip().upper()
    code_column = getattr(model, "code")

    codes = await db.scalars(
        select(code_column).where(code_column.like(f"{prefix_normalized}%"))
    )
    max_value = 0
    for code in codes:
        if code is None:
            continue
        suffix = str(code)[len(prefix_normalized) :]
        if suffix.isdigit():
            max_value = max(max_value, int(suffix))

    return f"{prefix_normalized}{max_value + 1:0{width}d}"


async def ensure_unique_code(
    db: AsyncSession,
    model: Any,
    code: str,
    exclude_id: UUID | None = None,
) -> None:
    code_column = getattr(model, "code")
    id_column = getattr(model, "id")
    stmt = select(id_column).where(func.upper(code_column) == code.upper())
    if exclude_id is not None:
        stmt = stmt.where(id_column != exclude_id)
    exists = await db.scalar(stmt)
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Code '{code}' already exists",
        )


async def get_drug_group_or_404(group_id: UUID, db: AsyncSession) -> DrugGroup:
    item = await db.get(DrugGroup, group_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Drug group not found")
    return item


async def get_manufacturer_or_404(manufacturer_id: UUID, db: AsyncSession) -> Manufacturer:
    item = await db.get(Manufacturer, manufacturer_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Manufacturer not found")
    return item


async def get_supplier_or_404(supplier_id: UUID, db: AsyncSession) -> Supplier:
    item = await db.get(Supplier, supplier_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found")
    return item


async def get_product_or_404(product_id: UUID, db: AsyncSession) -> Product:
    stmt = (
        select(Product)
        .where(Product.id == product_id)
        .options(
            selectinload(Product.group),
            selectinload(Product.manufacturer),
            selectinload(Product.units),
        )
    )
    item = await db.scalar(stmt)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")
    return item


async def get_product_unit_or_404(product_id: UUID, unit_id: UUID, db: AsyncSession) -> ProductUnit:
    stmt = select(ProductUnit).where(
        ProductUnit.id == unit_id,
        ProductUnit.product_id == product_id,
    )
    item = await db.scalar(stmt)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product unit not found")
    return item


def to_product_unit_response(unit: ProductUnit) -> ProductUnitResponse:
    return ProductUnitResponse.model_validate(unit)


def _active_base_unit(product: Product) -> ProductUnit | None:
    for unit in product.units:
        if unit.is_active and unit.is_base_unit:
            return unit
    for unit in product.units:
        if unit.is_active:
            return unit
    return None


def to_product_list_item(product: Product) -> ProductListItemResponse:
    base_unit = _active_base_unit(product)
    return ProductListItemResponse(
        id=product.id,
        code=product.code,
        barcode=product.barcode,
        name=product.name,
        active_ingredient=product.active_ingredient,
        registration_number=product.registration_number,
        group_name=product.group.name if product.group else None,
        manufacturer_name=product.manufacturer.name if product.manufacturer else None,
        base_unit=base_unit.unit_name if base_unit else None,
        base_price=base_unit.selling_price if base_unit else None,
        vat_rate=product.vat_rate,
        other_tax_rate=product.other_tax_rate,
        is_active=product.is_active,
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


def to_product_detail(product: Product) -> ProductDetailResponse:
    units = sorted(product.units, key=lambda item: (not item.is_base_unit, item.conversion_rate, item.unit_name))
    return ProductDetailResponse(
        id=product.id,
        code=product.code,
        barcode=product.barcode,
        name=product.name,
        active_ingredient=product.active_ingredient,
        registration_number=product.registration_number,
        group=(
            ProductGroupRef(
                id=product.group.id,
                code=product.group.code,
                name=product.group.name,
            )
            if product.group
            else None
        ),
        manufacturer=(
            ProductManufacturerRef(
                id=product.manufacturer.id,
                code=product.manufacturer.code,
                name=product.manufacturer.name,
            )
            if product.manufacturer
            else None
        ),
        instructions=product.instructions,
        note=product.note,
        vat_rate=product.vat_rate,
        other_tax_rate=product.other_tax_rate,
        is_active=product.is_active,
        units=[to_product_unit_response(unit) for unit in units],
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


def to_supplier_debt_history(entry: SupplierDebtHistory) -> SupplierDebtHistoryResponse:
    return SupplierDebtHistoryResponse(
        id=entry.id,
        supplier_id=entry.supplier_id,
        type=entry.entry_type,
        amount=entry.amount,
        balance_after=entry.balance_after,
        reference_type=entry.reference_type,
        reference_id=entry.reference_id,
        note=entry.note,
        created_by=entry.created_by,
        created_at=entry.created_at,
    )


async def product_has_inventory_batches(product_id: UUID) -> bool:
    base_url = settings.INVENTORY_SERVICE_URL.strip()
    if not base_url:
        return False

    target_url = f"{base_url.rstrip('/')}/api/v1/inventory/batches"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(
                target_url,
                params={
                    "drug": str(product_id),
                },
            )
    except httpx.RequestError:
        return False

    if response.status_code >= 400:
        return False

    data: Any = response.json()
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return any(parse_decimal(item.get("qty_remaining"), Decimal("0")) > 0 for item in items if isinstance(item, dict))
        total = data.get("total")
        if isinstance(total, int):
            return total > 0
        return False

    if isinstance(data, list):
        return any(parse_decimal(item.get("qty_remaining"), Decimal("0")) > 0 for item in data if isinstance(item, dict))

    return False


def parse_decimal(value: Any, default: Decimal = Decimal("0.00")) -> Decimal:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except Exception:
            return default
    return default


def round_money_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    amount = parse_decimal(value, default)
    return amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def search_filter(statement: Select[Any], query_text: str | None, *columns: Any) -> Select[Any]:
    if query_text is None or not query_text.strip():
        return statement
    pattern = f"%{query_text.strip()}%"
    conditions = [column.ilike(pattern) for column in columns]
    return statement.where(or_(*conditions))
