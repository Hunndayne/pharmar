from decimal import Decimal, ROUND_HALF_UP
import json
import logging
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
    ProductUnitRole,
    ProductUnitResponse,
    SupplierDebtHistoryResponse,
    UnitConfigStatus,
)


settings = get_settings()
logger = logging.getLogger(__name__)
UNIT_ROLE_ORDER: dict[str, int] = {
    "import": 0,
    "intermediate": 1,
    "retail": 2,
}
KNOWN_UNIT_ROLES = tuple(UNIT_ROLE_ORDER.keys())


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


def normalize_unit_role(value: str | None) -> ProductUnitRole | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in UNIT_ROLE_ORDER:
        return normalized  # type: ignore[return-value]
    return None


def _sort_product_units(units: list[ProductUnit]) -> list[ProductUnit]:
    def sort_key(unit: ProductUnit) -> tuple[int, int, int, str]:
        role = normalize_unit_role(unit.unit_role)
        role_group = 0 if role is not None else 1
        role_order = UNIT_ROLE_ORDER.get(role or "", 99)
        return (
            0 if unit.is_active else 1,
            role_group,
            role_order if role is not None else int(unit.conversion_rate),
            unit.unit_name.casefold(),
        )

    return sorted(units, key=sort_key)


def _active_units(units: list[ProductUnit]) -> list[ProductUnit]:
    return [unit for unit in units if unit.is_active]


def _find_role_unit(units: list[ProductUnit], role: ProductUnitRole) -> ProductUnit | None:
    for unit in units:
        if unit.is_active and normalize_unit_role(unit.unit_role) == role:
            return unit
    return None


def get_primary_product_unit(product: Product) -> ProductUnit | None:
    retail_unit = _find_role_unit(product.units, "retail")
    if retail_unit is not None:
        return retail_unit
    for unit in product.units:
        if unit.is_active and unit.is_base_unit:
            return unit
    active_units = _active_units(product.units)
    if not active_units:
        return None
    return sorted(active_units, key=lambda item: (item.conversion_rate, item.unit_name.casefold()))[0]


def _validate_role_based_units(units: list[ProductUnit]) -> tuple[bool, str | None]:
    active_units = _active_units(units)
    if not active_units:
        return True, None

    seen_roles: dict[ProductUnitRole, ProductUnit] = {}
    for unit in active_units:
        role = normalize_unit_role(unit.unit_role)
        if role is None:
            return False, "missing unit_role on active unit"
        if role in seen_roles:
            return False, f"duplicate active role '{role}'"
        seen_roles[role] = unit

    retail_unit = seen_roles.get("retail")
    if retail_unit is None:
        return False, "missing active retail unit"
    if retail_unit.conversion_rate != 1:
        return False, "retail unit must have conversion_rate = 1"

    intermediate_unit = seen_roles.get("intermediate")
    import_unit = seen_roles.get("import")
    if intermediate_unit is not None and import_unit is None:
        return False, "intermediate unit requires an import unit"
    if intermediate_unit is not None and import_unit is not None:
        if import_unit.conversion_rate < intermediate_unit.conversion_rate:
            return False, "import conversion_rate must be >= intermediate conversion_rate"
        if import_unit.conversion_rate % intermediate_unit.conversion_rate != 0:
            return False, "import conversion_rate must be divisible by intermediate conversion_rate"

    return True, None


def _infer_legacy_unit_roles(units: list[ProductUnit]) -> tuple[dict[UUID, ProductUnitRole] | None, str | None]:
    active_units = _active_units(units)
    if not active_units:
        return {}, None

    if any(normalize_unit_role(unit.unit_role) is not None for unit in units):
        return None, "mixed legacy and role-based unit data"
    if len(active_units) > 3:
        return None, "more than 3 active units"

    base_units = [unit for unit in active_units if unit.conversion_rate == 1]
    if len(base_units) != 1:
        return None, "legacy units must have exactly one active conversion_rate = 1"

    sorted_active = sorted(active_units, key=lambda item: (item.conversion_rate, item.unit_name.casefold()))
    conversion_values = [unit.conversion_rate for unit in sorted_active]
    if conversion_values != sorted(conversion_values):
        return None, "legacy conversion_rate order is invalid"
    if len(set(conversion_values)) != len(conversion_values):
        return None, "legacy conversion_rate values are ambiguous"

    mapping: dict[UUID, ProductUnitRole] = {}
    if len(sorted_active) == 1:
        mapping[sorted_active[0].id] = "retail"
        return mapping, None
    if len(sorted_active) == 2:
        mapping[sorted_active[0].id] = "retail"
        mapping[sorted_active[1].id] = "import"
        return mapping, None

    mapping[sorted_active[0].id] = "retail"
    mapping[sorted_active[1].id] = "intermediate"
    mapping[sorted_active[2].id] = "import"
    return mapping, None


def get_unit_config_status(product: Product) -> UnitConfigStatus:
    active_units = _active_units(product.units)
    if not active_units:
        return "ok"

    active_roles = [normalize_unit_role(unit.unit_role) for unit in active_units]
    if any(role is not None for role in active_roles):
        is_valid, _ = _validate_role_based_units(product.units)
        return "ok" if is_valid else "conflict"

    mapping, reason = _infer_legacy_unit_roles(product.units)
    return "ok" if mapping is not None and reason is None else "conflict"


def apply_unit_role_invariants(unit: ProductUnit) -> None:
    role = normalize_unit_role(unit.unit_role)
    if role == "retail":
        unit.conversion_rate = 1
        unit.is_base_unit = True
    elif role in {"import", "intermediate"}:
        unit.is_base_unit = False


async def backfill_product_unit_roles(db: AsyncSession) -> None:
    stmt = select(Product).options(selectinload(Product.units))
    products = list((await db.scalars(stmt)).all())
    has_changes = False

    for product in products:
        active_units = _active_units(product.units)
        if not active_units:
            continue

        active_roles = [normalize_unit_role(unit.unit_role) for unit in active_units]
        if any(role is not None for role in active_roles):
            is_valid, reason = _validate_role_based_units(product.units)
            if is_valid:
                for unit in product.units:
                    apply_unit_role_invariants(unit)
                has_changes = True
            else:
                logger.warning(
                    "Unit role conflict on product %s (%s): %s",
                    product.id,
                    product.code,
                    reason or "unknown role validation error",
                )
            continue

        mapping, reason = _infer_legacy_unit_roles(product.units)
        if mapping is None:
            logger.warning(
                "Legacy unit mapping conflict on product %s (%s, %s): %s",
                product.id,
                product.code,
                product.name,
                reason or "unknown mapping error",
            )
            continue

        for unit in product.units:
            role = mapping.get(unit.id)
            if role is None:
                continue
            unit.unit_role = role
            apply_unit_role_invariants(unit)
            has_changes = True

    if has_changes:
        await db.commit()


def to_product_unit_response(unit: ProductUnit) -> ProductUnitResponse:
    return ProductUnitResponse(
        id=unit.id,
        product_id=unit.product_id,
        unit_name=unit.unit_name,
        conversion_rate=unit.conversion_rate,
        unit_role=normalize_unit_role(unit.unit_role),
        barcode=unit.barcode,
        selling_price=unit.selling_price,
        is_base_unit=unit.is_base_unit,
        is_active=unit.is_active,
        created_at=unit.created_at,
        updated_at=unit.updated_at,
    )


def to_product_list_item(product: Product) -> ProductListItemResponse:
    base_unit = get_primary_product_unit(product)
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
    units = _sort_product_units(product.units)
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
        unit_config_status=get_unit_config_status(product),
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


async def product_has_inventory_history(product_id: UUID) -> bool:
    base_url = settings.INVENTORY_SERVICE_URL.strip()
    if not base_url:
        return True

    target_url = f"{base_url.rstrip('/')}/api/v1/inventory/batches"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(target_url, params={"drug": str(product_id)})
    except httpx.RequestError:
        return True

    if response.status_code == status.HTTP_404_NOT_FOUND:
        return False
    if response.status_code >= 400:
        return True

    data: Any = response.json()
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return any(isinstance(item, dict) for item in items)
        total = data.get("total")
        if isinstance(total, int):
            return total > 0
        return False

    if isinstance(data, list):
        return any(isinstance(item, dict) for item in data)

    return False


async def product_has_sale_history(product_id: UUID, token: str) -> bool:
    base_url = settings.SALE_SERVICE_URL.strip()
    auth_token = token.strip()
    if not base_url or not auth_token:
        return True

    target_url = f"{base_url.rstrip('/')}/api/v1/sale/internal/products/{product_id}/usage"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(
                target_url,
                headers={"Authorization": f"Bearer {auth_token}"},
            )
    except httpx.RequestError:
        return True

    if response.status_code >= 400:
        return True

    try:
        data: Any = response.json()
    except json.JSONDecodeError:
        return True

    if not isinstance(data, dict):
        return True

    return bool(data.get("used"))


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
