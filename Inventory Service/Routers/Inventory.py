import asyncio
import json
import re
from enum import Enum
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from redis.asyncio import Redis
from types import SimpleNamespace

from Source.core.config import settings
from Source.domain import (
    BatchStatus,
    MovementType,
    PaymentMethod,
    PaymentStatus,
    PromoType,
    ReceiptStatus,
)
from Source.schemas.inventory import (
    BatchCostLookupRequest,
    BatchStatusUpdateRequest,
    ImportReceiptCreateRequest,
    ImportReceiptUpdateRequest,
    ReserveRequest,
    StockAdjustmentRequest,
)

router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])
runtime_state = SimpleNamespace()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")
optional_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

DEFAULT_INVENTORY_SETTINGS: dict[str, Any] = {
    "inventory.low_stock_threshold": 10,
    "inventory.expiry_warning_days": 30,
    "inventory.near_date_days": 90,
    "inventory.enable_fefo": True,
    "inventory.fefo_threshold_days": settings.FEFO_THRESHOLD_DAYS,
}

LEGACY_DEMO_DRUG_IDS = {"d1", "d2", "d3", "d4", "d5"}
LEGACY_DEMO_SUPPLIER_IDS = {"s1", "s2", "s3", "s4"}


def _to_non_negative_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed < 0:
        return default
    return parsed


def round_money_value(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default
    return int(parsed.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _to_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "y", "on"}:
            return True
        if lowered in {"0", "false", "no", "n", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def normalize_inventory_settings(raw: dict[str, Any]) -> dict[str, Any]:
    low_stock_threshold = _to_non_negative_int(
        raw.get("inventory.low_stock_threshold"),
        _to_non_negative_int(DEFAULT_INVENTORY_SETTINGS["inventory.low_stock_threshold"], 10),
    )
    expiry_warning_days = _to_non_negative_int(
        raw.get("inventory.expiry_warning_days"),
        _to_non_negative_int(DEFAULT_INVENTORY_SETTINGS["inventory.expiry_warning_days"], 30),
    )
    near_date_days = _to_non_negative_int(
        raw.get("inventory.near_date_days"),
        _to_non_negative_int(DEFAULT_INVENTORY_SETTINGS["inventory.near_date_days"], 90),
    )
    if near_date_days < expiry_warning_days:
        near_date_days = expiry_warning_days

    enable_fefo = _to_bool(
        raw.get("inventory.enable_fefo"),
        bool(DEFAULT_INVENTORY_SETTINGS["inventory.enable_fefo"]),
    )
    fefo_threshold_days = _to_positive_int(
        raw.get("inventory.fefo_threshold_days"),
        default=_to_positive_int(DEFAULT_INVENTORY_SETTINGS["inventory.fefo_threshold_days"], settings.FEFO_THRESHOLD_DAYS),
    )

    return {
        "inventory.low_stock_threshold": low_stock_threshold,
        "inventory.expiry_warning_days": expiry_warning_days,
        "inventory.near_date_days": near_date_days,
        "inventory.enable_fefo": enable_fefo,
        "inventory.fefo_threshold_days": fefo_threshold_days,
    }


async def fetch_inventory_settings(force: bool = False) -> dict[str, Any]:
    now = utc_now()
    cached = getattr(runtime_state, "inventory_settings", None)
    ttl_seconds = max(0, int(settings.STORE_SETTINGS_TTL_SECONDS))

    if (
        not force
        and isinstance(cached, dict)
        and isinstance(cached.get("data"), dict)
        and isinstance(cached.get("fetched_at"), datetime)
        and ttl_seconds > 0
        and (now - cached["fetched_at"]).total_seconds() <= ttl_seconds
    ):
        return cached["data"]

    merged = dict(DEFAULT_INVENTORY_SETTINGS)
    base_url = settings.STORE_SERVICE_URL.strip()
    if base_url:
        target_url = f"{base_url.rstrip('/')}/api/v1/store/settings/group/inventory"
        try:
            timeout = httpx.Timeout(settings.STORE_SETTINGS_TIMEOUT_SECONDS)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(target_url)
            if response.status_code < 400:
                payload = response.json()
                if isinstance(payload, dict):
                    merged.update(payload)
        except (httpx.HTTPError, ValueError):
            pass

    normalized = normalize_inventory_settings(merged)
    runtime_state.inventory_settings = {
        "data": normalized,
        "fetched_at": now,
    }
    return normalized


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc_datetime(day: date, hour: int = 9, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour=hour, minute=minute), tzinfo=timezone.utc)


def normalize_key(value: str) -> str:
    return value.strip().lower()


def normalize_code(value: str) -> str:
    return value.strip().upper()


def highest_unit_for_drug(drug: dict[str, Any]) -> dict[str, Any] | None:
    units = drug.get("units", [])
    if not units:
        return None
    return max(units, key=lambda item: item.get("conversion", 0))


def default_line_unit_prices(drug: dict[str, Any]) -> list[dict[str, Any]]:
    unit_map = {unit["id"]: unit for unit in drug.get("units", [])}
    result: list[dict[str, Any]] = []
    for unit_price in drug.get("unit_prices", []):
        unit_meta = unit_map.get(unit_price["unit_id"])
        if unit_meta is None:
            continue
        result.append(
            {
                "unit_id": unit_price["unit_id"],
                "unit_name": unit_meta["name"],
                "conversion": unit_meta["conversion"],
                "price": round_money_value(unit_price["price"]),
            }
        )
    return result


def resolve_line_unit_prices(line: Any, drug: dict[str, Any]) -> list[dict[str, Any]]:
    if getattr(line, "unit_prices", None):
        return [
            {
                "unit_id": item.unit_id,
                "unit_name": item.unit_name,
                "conversion": item.conversion,
                "price": round_money_value(item.price),
            }
            for item in line.unit_prices
        ]
    return default_line_unit_prices(drug)


def import_unit_conversion(unit_prices: list[dict[str, Any]]) -> int:
    if not unit_prices:
        return 1
    return max(1, max(int(item.get("conversion", 1)) for item in unit_prices))


def to_effective_import_quantity(
    import_quantity: int,
    promo_type: PromoType = PromoType.NONE,
    promo_buy_qty: int | None = None,
    promo_get_qty: int | None = None,
) -> int:
    base_quantity = max(1, int(import_quantity))
    if promo_type == PromoType.BUY_X_GET_Y and promo_buy_qty and promo_get_qty and promo_buy_qty > 0:
        bonus_quantity = (base_quantity // int(promo_buy_qty)) * int(promo_get_qty)
        return base_quantity + max(0, bonus_quantity)
    return base_quantity


def to_stock_quantity(
    import_quantity: int,
    unit_prices: list[dict[str, Any]],
    promo_type: PromoType = PromoType.NONE,
    promo_buy_qty: int | None = None,
    promo_get_qty: int | None = None,
) -> int:
    # quantity sent from receipt line is nhập theo đơn vị nhập (đơn vị lớn nhất).
    # tồn kho luôn lưu theo đơn vị bán lẻ (conversion nhỏ nhất).
    effective_import_quantity = to_effective_import_quantity(
        import_quantity,
        promo_type=promo_type,
        promo_buy_qty=promo_buy_qty,
        promo_get_qty=promo_get_qty,
    )
    return effective_import_quantity * import_unit_conversion(unit_prices)


def paid_import_quantity_for_batch(batch: dict[str, Any]) -> int:
    stock_quantity = max(0, int(batch.get("qty_in", 0) or 0))
    if stock_quantity <= 0:
        return 0

    conversion = import_unit_conversion(batch.get("unit_prices", []))
    effective_import_quantity = max(1, stock_quantity // max(1, conversion))
    promo_type = batch.get("promo_type", PromoType.NONE)
    promo_buy_qty = batch.get("promo_buy_qty")
    promo_get_qty = batch.get("promo_get_qty")

    if promo_type == PromoType.BUY_X_GET_Y and promo_buy_qty and promo_get_qty and promo_buy_qty > 0:
        for paid_quantity in range(1, effective_import_quantity + 1):
            if to_effective_import_quantity(
                paid_quantity,
                promo_type=promo_type,
                promo_buy_qty=promo_buy_qty,
                promo_get_qty=promo_get_qty,
            ) == effective_import_quantity:
                return paid_quantity

    return effective_import_quantity


def batch_cost_snapshot(batch: dict[str, Any]) -> dict[str, Any]:
    qty_in = max(0, int(batch.get("qty_in", 0) or 0))
    import_price = round_money_value(batch.get("import_price", 0))
    promo_type = batch.get("promo_type", PromoType.NONE)
    promo_discount_percent = batch.get("promo_discount_percent")
    discount_percent = round(float(promo_discount_percent or 0), 4) if promo_discount_percent is not None else None
    effective_import_price = import_price
    if promo_type == PromoType.DISCOUNT_PERCENT and discount_percent and discount_percent > 0:
        effective_import_price = round_money_value(import_price * max(0.0, 1 - (discount_percent / 100)))
    paid_import_quantity = paid_import_quantity_for_batch(batch)
    total_cost_amount = round_money_value(paid_import_quantity * effective_import_price)
    cost_per_base_unit = round(total_cost_amount / qty_in, 6) if qty_in > 0 else 0.0

    return {
        "batch_id": batch["id"],
        "qty_in": qty_in,
        "import_price": import_price,
        "effective_import_price": effective_import_price,
        "promo_type": promo_type,
        "promo_buy_qty": batch.get("promo_buy_qty"),
        "promo_get_qty": batch.get("promo_get_qty"),
        "promo_discount_percent": discount_percent,
        "import_unit_conversion": import_unit_conversion(batch.get("unit_prices", [])),
        "paid_import_quantity": paid_import_quantity,
        "total_cost_amount": total_cost_amount,
        "cost_per_base_unit": cost_per_base_unit,
    }


def resolve_line_promo_note(line: Any) -> str | None:
    if line.promo_note:
        return line.promo_note
    if line.promo_type == PromoType.BUY_X_GET_Y:
        return f"Mua {line.promo_buy_qty} tặng {line.promo_get_qty}"
    if line.promo_type == PromoType.DISCOUNT_PERCENT:
        return f"Giảm {line.promo_discount_percent}%"
    return None


def resolve_line_barcode(line: Any, drug: dict[str, Any]) -> str:
    if line.barcode:
        return line.barcode.strip()
    highest_unit = highest_unit_for_drug(drug)
    return highest_unit["barcode"] if highest_unit else ""


def get_current_actor(token: str) -> tuple[str, str, str]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    token_type = payload.get("type")
    if token_type not in {None, "access"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
            headers={"WWW-Authenticate": "Bearer"},
        )

    subject = payload.get("sub")
    if subject is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
            headers={"WWW-Authenticate": "Bearer"},
        )
    role = str(payload.get("role") or "").strip().lower()
    username = str(payload.get("username") or "").strip().lower()
    return str(subject), role, username


def get_current_subject(token: str) -> str:
    subject, _, _ = get_current_actor(token)
    return subject


def can_override_receipt_lock(role: str, username: str) -> bool:
    return role in {"owner", "admin"} or username == "admin"


def next_id(counter_name: str, prefix: str) -> str:
    runtime_state.counters[counter_name] += 1
    return f"{prefix}-{runtime_state.counters[counter_name]}"


def receipt_code_for_date(receipt_date: date) -> str:
    same_day = sum(1 for r in runtime_state.receipts.values() if r["receipt_date"] == receipt_date)
    return f"PN{receipt_date.strftime('%Y%m%d')}{same_day + 1:03d}"


def next_available_batch_code(
    receipt_date: date,
    reserved_codes: set[str],
    ignore_ids: set[str] | None = None,
) -> str:
    sequence = 1
    prefix = f"LO{receipt_date.strftime('%Y%m%d')}"
    while True:
        candidate = normalize_code(f"{prefix}{sequence:03d}")
        if candidate in reserved_codes:
            sequence += 1
            continue
        if not is_batch_code_used(candidate, ignore_ids=ignore_ids):
            return candidate
        sequence += 1


def get_supplier_or_404(supplier_id: str) -> dict[str, Any]:
    supplier = runtime_state.suppliers.get(supplier_id)
    if supplier is None:
        raise HTTPException(status_code=404, detail=f"Supplier '{supplier_id}' not found")
    return supplier


def build_supplier_contact(contact_name: str | None, phone: str | None) -> str:
    left = (contact_name or "").strip()
    right = (phone or "").strip()
    if left and right:
        return f"{left} - {right}"
    return left or right


def resolve_drug(drug_id: str | None = None, drug_code_or_sku: str | None = None) -> dict[str, Any]:
    if drug_id:
        by_id = runtime_state.drugs.get(drug_id)
        if by_id:
            return by_id
    if drug_code_or_sku:
        needle = normalize_key(drug_code_or_sku)
        for drug in runtime_state.drugs.values():
            candidates = {normalize_key(drug["id"]), normalize_key(drug["code"])}
            candidates.update(normalize_key(alias) for alias in drug.get("sku_aliases", []))
            if needle in candidates:
                return drug
    raise HTTPException(status_code=404, detail=f"Drug not found for '{drug_id or drug_code_or_sku}'")


def _to_positive_int(value: Any, default: int = 1) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = round_money_value(value, int(default))
    except Exception:
        return default
    return float(parsed)


async def fetch_catalog_json(
    path: str,
    token: str | None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    url = f"{settings.CATALOG_SERVICE_URL.rstrip('/')}{path}"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    timeout = httpx.Timeout(settings.CATALOG_SYNC_TIMEOUT_SECONDS)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError:
        return None

    if response.status_code == 404:
        return None
    if response.status_code in {401, 403}:
        if not token:
            return None
        raise HTTPException(status_code=response.status_code, detail="Unauthorized to sync catalog metadata")
    if response.status_code >= 400:
        return None
    payload = response.json()
    return payload if isinstance(payload, dict) else None


def upsert_drug_from_catalog_product(
    product: dict[str, Any],
    target: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    target_map = target if target is not None else runtime_state.drugs
    product_id = str(product.get("id") or "").strip()
    product_code = normalize_code(str(product.get("code") or ""))
    product_name = str(product.get("name") or "").strip()
    if not product_id or not product_code or not product_name:
        return None

    raw_units = product.get("units") or []
    units: list[dict[str, Any]] = []
    unit_prices: list[dict[str, Any]] = []
    for index, unit in enumerate(raw_units):
        if not isinstance(unit, dict):
            continue
        unit_id = str(unit.get("id") or "").strip() or f"{product_code}-U{index + 1}"
        unit_name = str(unit.get("unit_name") or "").strip() or f"Don vi {index + 1}"
        conversion = _to_positive_int(unit.get("conversion_rate"), default=1)
        barcode = str(unit.get("barcode") or "").strip()
        units.append(
            {
                "id": unit_id,
                "name": unit_name,
                "conversion": conversion,
                "barcode": barcode,
            }
        )
        unit_prices.append(
            {
                "unit_id": unit_id,
                "price": round_money_value(unit.get("selling_price"), default=0),
            }
        )

    if not units:
        fallback_unit_id = f"{product_code}-U1"
        units = [{"id": fallback_unit_id, "name": "Don vi", "conversion": 1, "barcode": ""}]
        unit_prices = [{"unit_id": fallback_unit_id, "price": 0}]

    units.sort(key=lambda item: item["conversion"])
    highest_unit = max(units, key=lambda item: item["conversion"])
    group = product.get("group") if isinstance(product.get("group"), dict) else None
    group_name = str(group.get("name") or "Khac") if isinstance(group, dict) else "Khac"

    existing = target_map.get(product_id) or runtime_state.drugs.get(product_id)
    existing_aliases = list(existing.get("sku_aliases", [])) if isinstance(existing, dict) else []
    aliases = [product_code]
    normalized_aliases = {normalize_key(product_code)}
    for alias in existing_aliases:
        alias_text = str(alias).strip()
        normalized_alias = normalize_key(alias_text)
        if alias_text and normalized_alias not in normalized_aliases:
            aliases.append(alias_text)
            normalized_aliases.add(normalized_alias)

    drug = {
        "id": product_id,
        "code": product_code,
        "name": product_name,
        "group": group_name,
        "instructions": str(product.get("instructions") or "").strip(),
        "base_unit": highest_unit["name"],
        "reorder_level": _to_positive_int((existing or {}).get("reorder_level"), default=0),
        "units": units,
        "unit_prices": unit_prices,
        "sku_aliases": aliases,
    }
    target_map[product_id] = drug
    return drug


async def sync_drug_from_catalog(
    token: str,
    drug_id: str | None = None,
    drug_code: str | None = None,
) -> dict[str, Any] | None:
    normalized_code = normalize_code(drug_code or "")
    product: dict[str, Any] | None = None

    if drug_id:
        product = await fetch_catalog_json(f"/api/v1/catalog/products/{drug_id}", token)

    if product is None and normalized_code:
        listing = await fetch_catalog_json(
            "/api/v1/catalog/products",
            token,
            {
                "search": normalized_code,
                "page": 1,
                "size": 200,
            },
        )
        items = listing.get("items", []) if isinstance(listing, dict) else []
        match = next(
            (
                item
                for item in items
                if isinstance(item, dict)
                and normalize_code(str(item.get("code") or "")) == normalized_code
            ),
            None,
        )
        if isinstance(match, dict) and match.get("id"):
            product = await fetch_catalog_json(f"/api/v1/catalog/products/{match['id']}", token)

    if product is None:
        return None
    return upsert_drug_from_catalog_product(product)


async def sync_all_drugs_from_catalog(token: str | None) -> int:
    page = 1
    pages = 1
    upserted = 0
    synced_drugs: dict[str, dict[str, Any]] = {}
    has_page = False

    while page <= pages:
        listing = await fetch_catalog_json(
            "/api/v1/catalog/products",
            token,
            {
                "page": page,
                "size": settings.CATALOG_SYNC_PAGE_SIZE,
            },
        )
        if listing is None:
            break
        has_page = True

        items = listing.get("items", [])
        if not isinstance(items, list):
            break

        for item in items:
            if not isinstance(item, dict):
                continue
            product_id = item.get("id")
            if not product_id:
                continue
            detail = await fetch_catalog_json(f"/api/v1/catalog/products/{product_id}", token)
            if detail is None:
                continue
            if upsert_drug_from_catalog_product(detail, target=synced_drugs) is not None:
                upserted += 1

        pages = _to_positive_int(listing.get("pages"), default=1)
        page += 1

    if has_page:
        preserve_drug_ids = {
            str(batch.get("drug_id"))
            for batch in runtime_state.batches.values()
            if isinstance(batch, dict) and batch.get("drug_id")
        }
        preserve_drug_ids.update(
            str(line.get("drug_id"))
            for receipt in runtime_state.receipts.values()
            if isinstance(receipt, dict)
            for line in receipt.get("lines", [])
            if isinstance(line, dict) and line.get("drug_id")
        )

        for drug_id in preserve_drug_ids:
            if drug_id in synced_drugs:
                continue
            legacy = runtime_state.drugs.get(drug_id)
            if legacy:
                synced_drugs[drug_id] = legacy

        runtime_state.drugs = synced_drugs

    runtime_state.catalog_drugs_last_sync_at = utc_now()
    await save_runtime_state_safe()
    return upserted


def upsert_supplier_from_catalog_item(
    item: dict[str, Any],
    target: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    target_map = target if target is not None else runtime_state.suppliers
    supplier_id = str(item.get("id") or "").strip()
    supplier_name = str(item.get("name") or "").strip()
    if not supplier_id or not supplier_name:
        return None

    existing = target_map.get(supplier_id) or runtime_state.suppliers.get(supplier_id, {})
    supplier = {
        "id": supplier_id,
        "code": str(item.get("code") or existing.get("code") or "").strip(),
        "name": supplier_name,
        "contact_name": str(item.get("contact_person") or existing.get("contact_name") or "").strip(),
        "phone": str(item.get("phone") or existing.get("phone") or "").strip(),
        "address": str(item.get("address") or existing.get("address") or "").strip(),
        "email": str(item.get("email") or existing.get("email") or "").strip() or None,
        "tax_code": str(item.get("tax_code") or existing.get("tax_code") or "").strip() or None,
        "note": str(item.get("note") or existing.get("note") or "").strip() or None,
        "is_active": bool(item.get("is_active", existing.get("is_active", True))),
    }
    target_map[supplier_id] = supplier
    return supplier


async def sync_supplier_from_catalog(token: str, supplier_id: str) -> dict[str, Any] | None:
    payload = await fetch_catalog_json(f"/api/v1/catalog/suppliers/{supplier_id}", token)
    if payload is None:
        return None
    return upsert_supplier_from_catalog_item(payload)


async def sync_all_suppliers_from_catalog(token: str | None) -> int:
    page = 1
    pages = 1
    upserted = 0
    synced_suppliers: dict[str, dict[str, Any]] = {}
    has_page = False

    while page <= pages:
        listing = await fetch_catalog_json(
            "/api/v1/catalog/suppliers",
            token,
            {
                "page": page,
                "size": settings.CATALOG_SYNC_PAGE_SIZE,
            },
        )
        if listing is None:
            break
        has_page = True

        items = listing.get("items", [])
        if not isinstance(items, list):
            break

        for item in items:
            if not isinstance(item, dict):
                continue
            if upsert_supplier_from_catalog_item(item, target=synced_suppliers) is not None:
                upserted += 1

        pages = _to_positive_int(listing.get("pages"), default=1)
        page += 1

    if has_page:
        preserve_supplier_ids = {
            str(receipt.get("supplier_id"))
            for receipt in runtime_state.receipts.values()
            if isinstance(receipt, dict) and receipt.get("supplier_id")
        }
        preserve_supplier_ids.update(
            str(batch.get("supplier_id"))
            for batch in runtime_state.batches.values()
            if isinstance(batch, dict) and batch.get("supplier_id")
        )
        for supplier_id in preserve_supplier_ids:
            if supplier_id in synced_suppliers:
                continue
            legacy = runtime_state.suppliers.get(supplier_id)
            if legacy:
                synced_suppliers[supplier_id] = legacy

        runtime_state.suppliers = synced_suppliers

    runtime_state.catalog_suppliers_last_sync_at = utc_now()
    await save_runtime_state_safe()
    return upserted


async def maybe_sync_catalog_suppliers(token: str | None, force: bool = False) -> int:
    last_sync_at = getattr(
        runtime_state,
        "catalog_suppliers_last_sync_at",
        datetime.fromtimestamp(0, tz=timezone.utc),
    )
    elapsed_seconds = (utc_now() - last_sync_at).total_seconds()
    has_legacy_seed = any(supplier_id in runtime_state.suppliers for supplier_id in LEGACY_DEMO_SUPPLIER_IDS)
    if not force and elapsed_seconds < settings.CATALOG_SYNC_TTL_SECONDS and not has_legacy_seed:
        return 0
    return await sync_all_suppliers_from_catalog(token)


async def maybe_sync_catalog_drugs(token: str | None, force: bool = False) -> int:
    last_sync_at = getattr(
        runtime_state,
        "catalog_drugs_last_sync_at",
        datetime.fromtimestamp(0, tz=timezone.utc),
    )
    elapsed_seconds = (utc_now() - last_sync_at).total_seconds()
    has_legacy_seed = any(drug_id in runtime_state.drugs for drug_id in LEGACY_DEMO_DRUG_IDS)
    if not force and elapsed_seconds < settings.CATALOG_SYNC_TTL_SECONDS and not has_legacy_seed:
        return 0
    return await sync_all_drugs_from_catalog(token)


def state_file_path() -> Path:
    return Path(settings.STATE_FILE_PATH)


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _parse_iso_date(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value[:10])
    raise ValueError("Invalid date value")


def _parse_iso_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    raise ValueError("Invalid datetime value")


def _to_enum(enum_cls: type[Enum], value: Any, default: Enum) -> Enum:
    if isinstance(value, enum_cls):
        return value
    try:
        return enum_cls(value)
    except Exception:
        return default


def save_runtime_state() -> None:
    path = state_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "counters": runtime_state.counters,
        "suppliers": runtime_state.suppliers,
        "drugs": runtime_state.drugs,
        "receipts": runtime_state.receipts,
        "batches": runtime_state.batches,
        "movements": runtime_state.movements,
        "reservations": runtime_state.reservations,
        "sale_events": runtime_state.sale_events,
        "catalog_last_sync_at": runtime_state.catalog_drugs_last_sync_at,
        "catalog_drugs_last_sync_at": runtime_state.catalog_drugs_last_sync_at,
        "catalog_suppliers_last_sync_at": runtime_state.catalog_suppliers_last_sync_at,
    }
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, default=_json_default),
        encoding="utf-8",
    )
    tmp_path.replace(path)


async def save_runtime_state_safe() -> None:
    try:
        if settings.STATE_PERSISTENCE.lower() == "postgres":
            await init_state_store()
            payload = {
                "counters": runtime_state.counters,
                "suppliers": runtime_state.suppliers,
                "drugs": runtime_state.drugs,
                "receipts": runtime_state.receipts,
                "batches": runtime_state.batches,
                "movements": runtime_state.movements,
                "reservations": runtime_state.reservations,
                "sale_events": runtime_state.sale_events,
                "catalog_last_sync_at": runtime_state.catalog_drugs_last_sync_at,
                "catalog_drugs_last_sync_at": runtime_state.catalog_drugs_last_sync_at,
                "catalog_suppliers_last_sync_at": runtime_state.catalog_suppliers_last_sync_at,
            }
            async with runtime_state.pg_pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO inventory_runtime_state(id, payload, updated_at)
                    VALUES (1, $1::jsonb, NOW())
                    ON CONFLICT (id)
                    DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
                    """,
                    json.dumps(payload, ensure_ascii=False, default=_json_default),
                )
        else:
            save_runtime_state()
    except Exception:
        # Tránh chặn luồng nghiệp vụ nếu storage tạm thời gặp lỗi.
        pass


def load_runtime_state() -> bool:
    path = state_file_path()
    if not path.exists():
        return False

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False

    return load_runtime_state_from_payload(payload)


async def init_state_store() -> None:
    if settings.STATE_PERSISTENCE.lower() != "postgres":
        return
    if getattr(runtime_state, "pg_pool", None) is None:
        runtime_state.pg_pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=1,
            max_size=5,
        )
    async with runtime_state.pg_pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS inventory_runtime_state (
              id SMALLINT PRIMARY KEY CHECK (id = 1),
              payload JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )


async def load_runtime_state_safe() -> bool:
    try:
        if settings.STATE_PERSISTENCE.lower() == "postgres":
            await init_state_store()
            async with runtime_state.pg_pool.acquire() as conn:
                row = await conn.fetchrow("SELECT payload FROM inventory_runtime_state WHERE id = 1")
            if row and row.get("payload") is not None:
                payload = row["payload"]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                if isinstance(payload, dict):
                    return load_runtime_state_from_payload(payload)

            # fallback: migrate file snapshot cũ vào postgres nếu có
            loaded_from_file = load_runtime_state()
            if loaded_from_file:
                await save_runtime_state_safe()
                return True
            return False
        return load_runtime_state()
    except Exception:
        return False


def load_runtime_state_from_payload(payload: dict[str, Any]) -> bool:
    try:
        if not isinstance(payload, dict):
            return False

        runtime_state.counters = dict(payload.get("counters") or {})
        for key in ("receipt", "receipt_line", "batch", "movement", "reservation"):
            runtime_state.counters.setdefault(key, 0)
        runtime_state.suppliers = dict(payload.get("suppliers") or {})
        runtime_state.drugs = dict(payload.get("drugs") or {})
        runtime_state.receipts = dict(payload.get("receipts") or {})
        runtime_state.batches = dict(payload.get("batches") or {})
        runtime_state.movements = list(payload.get("movements") or [])
        runtime_state.reservations = list(payload.get("reservations") or [])
        runtime_state.sale_events = list(payload.get("sale_events") or [])
        legacy_catalog_sync = payload.get("catalog_last_sync_at")
        runtime_state.catalog_drugs_last_sync_at = _parse_iso_datetime(
            payload.get("catalog_drugs_last_sync_at")
            or legacy_catalog_sync
            or datetime.fromtimestamp(0, tz=timezone.utc).isoformat()
        )
        runtime_state.catalog_suppliers_last_sync_at = _parse_iso_datetime(
            payload.get("catalog_suppliers_last_sync_at")
            or legacy_catalog_sync
            or datetime.fromtimestamp(0, tz=timezone.utc).isoformat()
        )

        for receipt in runtime_state.receipts.values():
            if not isinstance(receipt, dict):
                continue
            try:
                receipt["receipt_date"] = _parse_iso_date(receipt.get("receipt_date"))
                receipt["created_at"] = _parse_iso_datetime(receipt.get("created_at"))
                receipt["updated_at"] = _parse_iso_datetime(receipt.get("updated_at"))
            except Exception:
                continue
            receipt["status"] = _to_enum(ReceiptStatus, receipt.get("status"), ReceiptStatus.CONFIRMED)
            receipt["payment_status"] = _to_enum(PaymentStatus, receipt.get("payment_status"), PaymentStatus.PAID)
            receipt["payment_method"] = _to_enum(PaymentMethod, receipt.get("payment_method"), PaymentMethod.BANK)

            for line in receipt.get("lines", []):
                if not isinstance(line, dict):
                    continue
                if line.get("mfg_date") is not None:
                    line["mfg_date"] = _parse_iso_date(line["mfg_date"])
                if line.get("exp_date") is not None:
                    line["exp_date"] = _parse_iso_date(line["exp_date"])
                line["promo_type"] = _to_enum(PromoType, line.get("promo_type"), PromoType.NONE)

        for batch in runtime_state.batches.values():
            if not isinstance(batch, dict):
                continue
            try:
                batch["received_date"] = _parse_iso_date(batch.get("received_date"))
                batch["mfg_date"] = _parse_iso_date(batch.get("mfg_date"))
                batch["exp_date"] = _parse_iso_date(batch.get("exp_date"))
                batch["created_at"] = _parse_iso_datetime(batch.get("created_at"))
                batch["updated_at"] = _parse_iso_datetime(batch.get("updated_at"))
            except Exception:
                continue
            batch["promo_type"] = _to_enum(PromoType, batch.get("promo_type"), PromoType.NONE)

        for movement in runtime_state.movements:
            if not isinstance(movement, dict):
                continue
            if movement.get("occurred_at") is not None:
                movement["occurred_at"] = _parse_iso_datetime(movement["occurred_at"])
            movement["event_type"] = _to_enum(MovementType, movement.get("event_type"), MovementType.STOCK_ADJUSTMENT)

        for reservation in runtime_state.reservations:
            if not isinstance(reservation, dict):
                continue
            if reservation.get("reserved_at") is not None:
                reservation["reserved_at"] = _parse_iso_datetime(reservation["reserved_at"])
        return True
    except Exception:
        return False


def register_provisional_drug_from_line(line: Any) -> dict[str, Any]:
    raw_code = normalize_code((line.drug_code or line.drug_id or "").strip())
    if not raw_code:
        raise HTTPException(status_code=404, detail="Drug code is required to register new drug")

    preferred_id = (line.drug_id or "").strip()
    drug_id = preferred_id if preferred_id and preferred_id not in runtime_state.drugs else raw_code
    if drug_id in runtime_state.drugs:
        return runtime_state.drugs[drug_id]

    units: list[dict[str, Any]] = []
    unit_prices: list[dict[str, Any]] = []
    used_unit_ids: set[str] = set()

    for index, unit_price in enumerate(getattr(line, "unit_prices", []) or []):
        candidate_unit_id = normalize_code(unit_price.unit_id or "") or f"{raw_code}-U{index + 1}"
        while candidate_unit_id in used_unit_ids:
            candidate_unit_id = f"{candidate_unit_id}-{index + 1}"
        used_unit_ids.add(candidate_unit_id)

        conversion = max(1, int(unit_price.conversion))
        units.append(
            {
                "id": candidate_unit_id,
                "name": unit_price.unit_name.strip() or f"Don vi {index + 1}",
                "conversion": conversion,
                "barcode": "",
            }
        )
        unit_prices.append(
            {
                "unit_id": candidate_unit_id,
                "price": round_money_value(unit_price.price),
            }
        )

    if not units:
        fallback_unit_id = f"{raw_code}-U1"
        units = [{"id": fallback_unit_id, "name": "Don vi", "conversion": 1, "barcode": ""}]
        unit_prices = [{"unit_id": fallback_unit_id, "price": round_money_value(line.import_price)}]

    if line.barcode:
        units[0]["barcode"] = line.barcode.strip()

    highest_unit = max(units, key=lambda item: item["conversion"])
    sku_aliases = [raw_code]
    if preferred_id and normalize_key(preferred_id) != normalize_key(raw_code):
        sku_aliases.append(preferred_id)

    drug = {
        "id": drug_id,
        "code": raw_code,
        "name": raw_code,
        "group": "Khac",
        "base_unit": highest_unit["name"],
        "reorder_level": 0,
        "units": units,
        "unit_prices": unit_prices,
        "sku_aliases": sku_aliases,
    }
    runtime_state.drugs[drug_id] = drug
    return drug


async def resolve_or_register_drug(line: Any, token: str | None = None) -> dict[str, Any]:
    try:
        return resolve_drug(drug_id=line.drug_id, drug_code_or_sku=line.drug_code)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        if token:
            synced = await sync_drug_from_catalog(token, drug_id=line.drug_id, drug_code=line.drug_code)
            if synced is not None:
                return synced
        if not line.drug_code:
            raise
        return register_provisional_drug_from_line(line)


async def resolve_supplier_or_404(supplier_id: str, token: str | None = None) -> dict[str, Any]:
    supplier = runtime_state.suppliers.get(supplier_id)
    if supplier is not None:
        return supplier

    if token:
        synced = await sync_supplier_from_catalog(token, supplier_id)
        if synced is not None:
            return synced
        await maybe_sync_catalog_suppliers(token, force=True)
        supplier = runtime_state.suppliers.get(supplier_id)
        if supplier is not None:
            return supplier

    raise HTTPException(status_code=404, detail=f"Supplier '{supplier_id}' not found")


def get_batch_or_404(batch_id: str) -> dict[str, Any]:
    batch = runtime_state.batches.get(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"Batch '{batch_id}' not found")
    return batch


def get_receipt_or_404(receipt_id: str) -> dict[str, Any]:
    receipt = runtime_state.receipts.get(receipt_id)
    if receipt is None:
        raise HTTPException(status_code=404, detail=f"Import receipt '{receipt_id}' not found")
    return receipt


def batch_status(batch: dict[str, Any], as_of: date | None = None) -> BatchStatus:
    day = as_of or date.today()
    if batch["cancelled"]:
        return BatchStatus.CANCELLED
    if batch["qty_remaining"] <= 0:
        return BatchStatus.DEPLETED
    if batch["force_expired"] or batch["exp_date"] < day:
        return BatchStatus.EXPIRED
    return BatchStatus.ACTIVE


def is_batch_code_used(batch_code: str, ignore_ids: set[str] | None = None) -> bool:
    needle = normalize_code(batch_code)
    ignored = ignore_ids or set()
    for batch in runtime_state.batches.values():
        if batch["id"] in ignored:
            continue
        if normalize_code(batch["batch_code"]) == needle:
            return True
    return False


def add_movement(
    event_type: MovementType,
    drug_id: str,
    batch_id: str,
    quantity_delta: int,
    reference_type: str,
    reference_id: str,
    actor: str | None,
    note: str | None = None,
    occurred_at: datetime | None = None,
) -> dict[str, Any]:
    movement = {
        "id": next_id("movement", "mv"),
        "event_type": event_type,
        "drug_id": drug_id,
        "batch_id": batch_id,
        "quantity_delta": quantity_delta,
        "reference_type": reference_type,
        "reference_id": reference_id,
        "actor": actor,
        "note": note,
        "occurred_at": occurred_at or utc_now(),
    }
    runtime_state.movements.append(movement)
    return movement

def stock_total_for_drug(drug_id: str) -> int:
    return sum(
        batch["qty_remaining"]
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug_id and not batch["cancelled"]
    )


def stock_status_for_drug(
    drug_id: str,
    as_of: date | None = None,
    *,
    low_stock_threshold: int = 0,
    expiry_warning_days: int = 30,
    near_date_days: int = 90,
) -> str:
    day = as_of or date.today()
    drug = runtime_state.drugs[drug_id]
    batches = [
        batch
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug_id and not batch["cancelled"] and batch["qty_remaining"] > 0
    ]
    total = sum(batch["qty_remaining"] for batch in batches)

    if total <= 0:
        return "out_of_stock"
    if any(batch_status(batch, day) == BatchStatus.EXPIRED for batch in batches):
        return "expired"

    nearest_expiry = min(batch["exp_date"] for batch in batches)
    days_to_expiry = (nearest_expiry - day).days

    if days_to_expiry < expiry_warning_days:
        return "expiring_soon"
    if days_to_expiry < near_date_days:
        return "near_date"
    threshold = drug["reorder_level"] if drug["reorder_level"] > 0 else low_stock_threshold
    if total < threshold:
        return "low_stock"
    return "normal"


def movement_to_view(movement: dict[str, Any]) -> dict[str, Any]:
    batch = runtime_state.batches.get(movement["batch_id"])
    drug = runtime_state.drugs.get(movement["drug_id"])
    return {
        "id": movement["id"],
        "event_type": movement["event_type"],
        "drug_id": movement["drug_id"],
        "drug_code": drug["code"] if drug else None,
        "drug_name": drug["name"] if drug else None,
        "batch_id": movement["batch_id"],
        "batch_code": batch["batch_code"] if batch else None,
        "lot_number": batch["lot_number"] if batch else None,
        "quantity_delta": movement["quantity_delta"],
        "reference_type": movement["reference_type"],
        "reference_id": movement["reference_id"],
        "actor": movement["actor"],
        "note": movement["note"],
        "occurred_at": movement["occurred_at"],
    }


def batch_to_view(batch: dict[str, Any], as_of: date | None = None) -> dict[str, Any]:
    day = as_of or date.today()
    drug = runtime_state.drugs.get(batch["drug_id"])
    supplier = runtime_state.suppliers.get(batch["supplier_id"])
    supplier_name = supplier["name"] if supplier else batch.get("supplier_name", "")
    supplier_contact_name = supplier["contact_name"] if supplier else batch.get("supplier_contact_name", "")
    supplier_phone = supplier["phone"] if supplier else batch.get("supplier_phone", "")
    return {
        "id": batch["id"],
        "batch_code": batch["batch_code"],
        "lot_number": batch["lot_number"],
        "receipt_id": batch["receipt_id"],
        "drug_id": batch["drug_id"],
        "drug_code": (drug or {}).get("code") or batch.get("drug_code") or "",
        "drug_name": (drug or {}).get("name") or batch.get("drug_name") or "",
        "drug_group": (drug or {}).get("group") or batch.get("drug_group") or "",
        "supplier_id": batch["supplier_id"],
        "supplier_name": supplier_name,
        "supplier_contact": build_supplier_contact(supplier_contact_name, supplier_phone),
        "received_date": batch["received_date"],
        "mfg_date": batch["mfg_date"],
        "exp_date": batch["exp_date"],
        "days_to_expiry": (batch["exp_date"] - day).days,
        "qty_in": batch["qty_in"],
        "qty_remaining": batch["qty_remaining"],
        "import_price": round_money_value(batch["import_price"]),
        "barcode": batch.get("barcode", ""),
        "promo_type": batch.get("promo_type", PromoType.NONE),
        "promo_buy_qty": batch.get("promo_buy_qty"),
        "promo_get_qty": batch.get("promo_get_qty"),
        "promo_discount_percent": batch.get("promo_discount_percent"),
        "unit_prices": [
            {
                **unit_price,
                "price": round_money_value(unit_price.get("price")),
            }
            for unit_price in batch.get("unit_prices", [])
        ],
        "promo_note": batch["promo_note"],
        "status": batch_status(batch, day),
        "created_at": batch["created_at"],
        "updated_at": batch["updated_at"],
    }


def receipt_is_editable(
    receipt: dict[str, Any],
    raise_if_not: bool = True,
    allow_privileged: bool = False,
) -> bool:
    if receipt["status"] != ReceiptStatus.CONFIRMED:
        if raise_if_not:
            raise HTTPException(status_code=409, detail="Only confirmed receipts can be updated")
        return False

    if allow_privileged:
        return True

    for line in receipt["lines"]:
        batch = runtime_state.batches.get(line["batch_id"])
        if batch is None:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt has missing batch")
            return False
        if batch["qty_remaining"] != batch["qty_in"]:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt cannot be modified because batch has sales/adjustments")
            return False
        irreversible_movement = any(
            m["batch_id"] == batch["id"]
            and (
                m["event_type"] == MovementType.RECEIPT_CANCEL
                or (
                    m["event_type"] == MovementType.STOCK_ADJUSTMENT
                    and not str(m.get("note") or "").startswith("sale_return:")
                )
            )
            for m in runtime_state.movements
        )
        if irreversible_movement:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt cannot be modified because batch has sales/adjustments")
            return False

    return True


def receipt_to_view(receipt: dict[str, Any]) -> dict[str, Any]:
    supplier = runtime_state.suppliers.get(receipt["supplier_id"])
    supplier_name = supplier["name"] if supplier else receipt.get("supplier_name", "")
    supplier_contact_name = (
        supplier["contact_name"] if supplier else receipt.get("supplier_contact_name", "")
    )
    supplier_phone = supplier["phone"] if supplier else receipt.get("supplier_phone", "")
    lines = []
    for line in receipt["lines"]:
        batch = runtime_state.batches.get(line["batch_id"])
        lines.append(
            {
                **line,
                "import_price": round_money_value(line["import_price"]),
                "unit_prices": [
                    {
                        **unit_price,
                        "price": round_money_value(unit_price.get("price")),
                    }
                    for unit_price in line.get("unit_prices", [])
                ],
                "line_total": round_money_value(line["quantity"] * line["import_price"]),
                "batch_status": batch_status(batch) if batch else BatchStatus.CANCELLED,
            }
        )

    return {
        "id": receipt["id"],
        "code": receipt["code"],
        "receipt_date": receipt["receipt_date"],
        "supplier_id": receipt["supplier_id"],
        "supplier_name": supplier_name,
        "supplier_contact": build_supplier_contact(supplier_contact_name, supplier_phone),
        "shipping_carrier": receipt.get("shipping_carrier"),
        "payment_status": receipt.get("payment_status", PaymentStatus.PAID),
        "payment_method": receipt.get("payment_method", PaymentMethod.BANK),
        "note": receipt["note"],
        "status": receipt["status"],
        "created_by": receipt["created_by"],
        "created_at": receipt["created_at"],
        "updated_at": receipt["updated_at"],
        "total_value": round_money_value(receipt["total_value"]),
        "line_count": len(lines),
        "lines": lines,
        "can_edit": receipt_is_editable(receipt, raise_if_not=False),
    }


def receipt_list_item_to_view(receipt: dict[str, Any]) -> dict[str, Any]:
    supplier = runtime_state.suppliers.get(receipt["supplier_id"])
    supplier_name = supplier["name"] if supplier else receipt.get("supplier_name", "")
    supplier_contact_name = (
        supplier["contact_name"] if supplier else receipt.get("supplier_contact_name", "")
    )
    supplier_phone = supplier["phone"] if supplier else receipt.get("supplier_phone", "")
    return {
        "id": receipt["id"],
        "code": receipt["code"],
        "receipt_date": receipt["receipt_date"],
        "supplier_id": receipt["supplier_id"],
        "supplier_name": supplier_name,
        "supplier_contact": build_supplier_contact(supplier_contact_name, supplier_phone),
        "shipping_carrier": receipt.get("shipping_carrier"),
        "payment_status": receipt.get("payment_status", PaymentStatus.PAID),
        "payment_method": receipt.get("payment_method", PaymentMethod.BANK),
        "status": receipt["status"],
        "total_value": round_money_value(receipt["total_value"]),
        "line_count": len(receipt.get("lines", [])),
        "created_at": receipt["created_at"],
        "updated_at": receipt["updated_at"],
        "can_edit": receipt_is_editable(receipt, raise_if_not=False),
    }


def filter_import_receipts(
    receipts: list[dict[str, Any]],
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    supplier_id: str | None = None,
    status_filter: ReceiptStatus | None = None,
    payment_status: PaymentStatus | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    filtered = receipts
    if date_from is not None:
        filtered = [receipt for receipt in filtered if receipt["receipt_date"] >= date_from]
    if date_to is not None:
        filtered = [receipt for receipt in filtered if receipt["receipt_date"] <= date_to]
    if supplier_id is not None:
        filtered = [receipt for receipt in filtered if receipt["supplier_id"] == supplier_id]
    if status_filter is not None:
        filtered = [receipt for receipt in filtered if receipt["status"] == status_filter]
    if payment_status is not None:
        filtered = [
            receipt
            for receipt in filtered
            if receipt.get("payment_status", PaymentStatus.PAID) == payment_status
        ]
    if search:
        keyword = normalize_key(search)
        filtered = [
            receipt
            for receipt in filtered
            if keyword in normalize_key(str(receipt.get("code", "")))
            or keyword in normalize_key(str(receipt.get("note", "")))
            or keyword in normalize_key(str(receipt.get("supplier_name", "")))
            or keyword
            in normalize_key(
                runtime_state.suppliers.get(receipt["supplier_id"], {}).get("name", ""),
            )
        ]
    filtered.sort(key=lambda receipt: (receipt["receipt_date"], receipt["created_at"]), reverse=True)
    filtered.sort(
        key=lambda receipt: 1 if receipt.get("status") == ReceiptStatus.CANCELLED else 0
    )
    return filtered


def filter_batches(
    records: list[dict[str, Any]],
    *,
    day: date,
    search: str | None = None,
    drug: str | None = None,
    supplier_id: str | None = None,
    status_filter: BatchStatus | None = None,
    exp_from: date | None = None,
    exp_to: date | None = None,
    hide_zero: bool = False,
) -> list[dict[str, Any]]:
    filtered = records
    if drug:
        resolved = resolve_drug(drug_id=drug, drug_code_or_sku=drug)
        filtered = [batch for batch in filtered if batch["drug_id"] == resolved["id"]]
    if supplier_id:
        filtered = [batch for batch in filtered if batch["supplier_id"] == supplier_id]
    if exp_from:
        filtered = [batch for batch in filtered if batch["exp_date"] >= exp_from]
    if exp_to:
        filtered = [batch for batch in filtered if batch["exp_date"] <= exp_to]
    if search:
        keyword = normalize_key(search)
        filtered = [
            batch
            for batch in filtered
            if keyword in normalize_key(batch["batch_code"])
            or keyword in normalize_key(batch["lot_number"])
            or keyword in normalize_key(runtime_state.drugs[batch["drug_id"]]["name"])
            or keyword in normalize_key(runtime_state.drugs[batch["drug_id"]]["code"])
            or keyword in normalize_key(batch.get("supplier_name", ""))
        ]
    if hide_zero:
        filtered = [batch for batch in filtered if int(batch.get("qty_remaining", 0)) > 0]
    if status_filter:
        filtered = [batch for batch in filtered if batch_status(batch, day) == status_filter]

    filtered.sort(key=lambda batch: (batch["exp_date"], batch["received_date"], batch["batch_code"]))
    return filtered


def summarize_batches_by_drug(
    records: list[dict[str, Any]],
    *,
    day: date,
    near_date_days: int,
) -> dict[str, int]:
    by_drug: dict[str, dict[str, Any]] = {}
    for batch in records:
        if batch.get("cancelled"):
            continue
        drug_id = str(batch.get("drug_id") or "")
        if not drug_id:
            continue
        current = by_drug.get(drug_id, {"total_qty": 0, "near": False, "expired": False})
        qty_remaining = max(0, int(batch.get("qty_remaining", 0)))
        current["total_qty"] += qty_remaining
        if qty_remaining > 0:
            days_to_expiry = (batch["exp_date"] - day).days
            if days_to_expiry < 0:
                current["expired"] = True
            elif days_to_expiry <= near_date_days:
                current["near"] = True
        by_drug[drug_id] = current

    total_drugs = len(by_drug)
    out_of_stock = sum(1 for item in by_drug.values() if item["total_qty"] <= 0)
    near_date = sum(1 for item in by_drug.values() if item["near"])
    expired = sum(1 for item in by_drug.values() if item["expired"])
    return {
        "total_drugs": total_drugs,
        "out_of_stock": out_of_stock,
        "near_date": near_date,
        "expired": expired,
    }


def issue_sort_key(
    batch: dict[str, Any],
    as_of: date,
    *,
    enable_fefo: bool,
    fefo_threshold_days: int,
) -> tuple[int, date, date, datetime]:
    days_to_expiry = (batch["exp_date"] - as_of).days
    if enable_fefo and days_to_expiry < fefo_threshold_days:
        return (0, batch["exp_date"], batch["received_date"], batch["created_at"])
    return (1, batch["received_date"], batch["exp_date"], batch["created_at"])


def issue_strategy(
    batch: dict[str, Any],
    as_of: date,
    *,
    enable_fefo: bool,
    fefo_threshold_days: int,
) -> str:
    days_to_expiry = (batch["exp_date"] - as_of).days
    return "fefo" if enable_fefo and days_to_expiry < fefo_threshold_days else "fifo"


def suggest_issue_plan(
    drug: dict[str, Any],
    quantity: int,
    as_of: date | None = None,
    *,
    enable_fefo: bool,
    fefo_threshold_days: int,
) -> tuple[list[dict[str, Any]], int]:
    day = as_of or date.today()
    candidates = [
        batch
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug["id"]
        and batch_status(batch, day) == BatchStatus.ACTIVE
        and batch["qty_remaining"] > 0
    ]
    candidates.sort(
        key=lambda batch: issue_sort_key(
            batch,
            day,
            enable_fefo=enable_fefo,
            fefo_threshold_days=fefo_threshold_days,
        )
    )

    remaining = quantity
    allocations: list[dict[str, Any]] = []

    for batch in candidates:
        if remaining <= 0:
            break
        allocated = min(remaining, batch["qty_remaining"])
        if allocated <= 0:
            continue
        allocations.append(
            {
                "batch_id": batch["id"],
                "batch_code": batch["batch_code"],
                "lot_number": batch["lot_number"],
                "drug_id": batch["drug_id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "received_date": batch["received_date"],
                "exp_date": batch["exp_date"],
                "available": batch["qty_remaining"],
                "allocated": allocated,
                "strategy": issue_strategy(
                    batch,
                    day,
                    enable_fefo=enable_fefo,
                    fefo_threshold_days=fefo_threshold_days,
                ),
            }
        )
        remaining -= allocated

    return allocations, remaining


def find_batch_by_qr(qr_value: str) -> dict[str, Any] | None:
    candidates = extract_qr_candidates(qr_value)
    if not candidates:
        return None

    for candidate in candidates:
        needle = normalize_code(candidate)
        for batch in runtime_state.batches.values():
            if (
                normalize_code(batch["batch_code"]) == needle
                or normalize_code(batch["lot_number"]) == needle
                or normalize_code(batch.get("barcode", "")) == needle
            ):
                return batch

    # Fuzzy fallback for scanner payload that wraps the real lot code.
    for candidate in candidates:
        needle = normalize_code(candidate)
        for batch in runtime_state.batches.values():
            batch_code = normalize_code(batch["batch_code"])
            lot_number = normalize_code(batch["lot_number"])
            barcode = normalize_code(batch.get("barcode", ""))
            if (
                needle in batch_code
                or needle in lot_number
                or needle in barcode
                or batch_code in needle
                or lot_number in needle
                or (barcode and barcode in needle)
            ):
                return batch

    return None


def extract_qr_candidates(raw_value: str) -> list[str]:
    values: set[str] = set()

    def add(candidate: Any) -> None:
        if not isinstance(candidate, str):
            return
        normalized = candidate.strip()
        if normalized:
            values.add(normalized)

    add(raw_value)
    if not values:
        return []

    for value in list(values):
        try:
            add(unquote(value))
        except Exception:
            pass

    for value in list(values):
        for part in re.split(r"[\s|,;]+", value):
            add(part)

        if "://" in value:
            try:
                parsed = urlparse(value)
                segments = [segment for segment in parsed.path.split("/") if segment]
                if segments:
                    add(segments[-1])
                query_params = parse_qs(parsed.query, keep_blank_values=False)
                for key in ("qr", "batch", "batch_code", "batchCode", "lot", "lot_number", "code"):
                    for item in query_params.get(key, []):
                        add(item)
            except Exception:
                pass

        if value.startswith("{") and value.endswith("}"):
            try:
                payload = json.loads(value)
                if isinstance(payload, dict):
                    for key in ("qr", "batch", "batch_code", "batchCode", "lot", "lot_number", "code"):
                        add(payload.get(key))
            except Exception:
                pass

    for value in list(values):
        if ":" in value:
            add(value.rsplit(":", 1)[-1])
        for match in re.findall(r"[A-Za-z]{1,6}[-_ ]?\d{4,}", value):
            add(match)
        add(value.upper())

    return list(values)


def seed_demo_data() -> None:
    runtime_state.counters = {"receipt": 0, "receipt_line": 0, "batch": 0, "movement": 0, "reservation": 0}
    runtime_state.suppliers = {}
    runtime_state.drugs = {}
    runtime_state.receipts = {}
    runtime_state.batches = {}
    runtime_state.movements = []
    runtime_state.reservations = []
    runtime_state.sale_events = []
    runtime_state.catalog_drugs_last_sync_at = datetime.fromtimestamp(0, tz=timezone.utc)
    runtime_state.catalog_suppliers_last_sync_at = datetime.fromtimestamp(0, tz=timezone.utc)


def cleanup_legacy_seed_data() -> bool:
    changed = False

    referenced_drug_ids = {
        str(batch.get("drug_id"))
        for batch in runtime_state.batches.values()
        if isinstance(batch, dict) and batch.get("drug_id")
    }
    referenced_drug_ids.update(
        str(line.get("drug_id"))
        for receipt in runtime_state.receipts.values()
        if isinstance(receipt, dict)
        for line in receipt.get("lines", [])
        if isinstance(line, dict) and line.get("drug_id")
    )

    for drug_id in list(runtime_state.drugs.keys()):
        if drug_id in LEGACY_DEMO_DRUG_IDS and drug_id not in referenced_drug_ids:
            runtime_state.drugs.pop(drug_id, None)
            changed = True

    referenced_supplier_ids = {
        str(batch.get("supplier_id"))
        for batch in runtime_state.batches.values()
        if isinstance(batch, dict) and batch.get("supplier_id")
    }
    referenced_supplier_ids.update(
        str(receipt.get("supplier_id"))
        for receipt in runtime_state.receipts.values()
        if isinstance(receipt, dict) and receipt.get("supplier_id")
    )

    for supplier_id in list(runtime_state.suppliers.keys()):
        if supplier_id in LEGACY_DEMO_SUPPLIER_IDS and supplier_id not in referenced_supplier_ids:
            runtime_state.suppliers.pop(supplier_id, None)
            changed = True

    return changed


async def consume_sale_events() -> None:
    while True:
        pubsub = None
        try:
            pubsub = runtime_state.redis.pubsub()
            await pubsub.subscribe("sale.created")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    payload = json.loads(message["data"])
                    runtime_state.sale_events.append(payload)
                    runtime_state.sale_events = runtime_state.sale_events[-200:]
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(1)
        finally:
            if pubsub is not None:
                await pubsub.close()


async def startup_event() -> None:
    runtime_state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    runtime_state.lock = asyncio.Lock()
    runtime_state.pg_pool = None
    runtime_state.inventory_settings = {
        "data": normalize_inventory_settings(DEFAULT_INVENTORY_SETTINGS),
        "fetched_at": datetime.fromtimestamp(0, tz=timezone.utc),
    }
    loaded = await load_runtime_state_safe()
    if loaded:
        if cleanup_legacy_seed_data():
            await save_runtime_state_safe()
    else:
        seed_demo_data()
        await save_runtime_state_safe()
    await fetch_inventory_settings(force=True)
    runtime_state.consumer_task = asyncio.create_task(consume_sale_events())


async def shutdown_event() -> None:
    await save_runtime_state_safe()
    runtime_state.consumer_task.cancel()
    await asyncio.gather(runtime_state.consumer_task, return_exceptions=True)
    await runtime_state.redis.aclose()
    if getattr(runtime_state, "pg_pool", None) is not None:
        await runtime_state.pg_pool.close()

@router.get("/events")
async def get_events() -> list[dict[str, Any]]:
    return runtime_state.sale_events


@router.get("/meta/drugs")
async def get_drugs(token: str = Depends(oauth2_scheme)) -> list[dict[str, Any]]:
    get_current_subject(token)
    await maybe_sync_catalog_drugs(token)
    return list(runtime_state.drugs.values())


@router.get("/meta/suppliers")
async def get_suppliers(token: str = Depends(oauth2_scheme)) -> list[dict[str, Any]]:
    get_current_subject(token)
    await maybe_sync_catalog_suppliers(token, force=True)
    return list(runtime_state.suppliers.values())


@router.get("/stock")
async def get_stock(token: str | None = Depends(optional_oauth2_scheme)) -> dict[str, int]:
    await maybe_sync_catalog_drugs(token)
    stock_map: dict[str, int] = {}
    for drug in runtime_state.drugs.values():
        total = stock_total_for_drug(drug["id"])
        stock_map[drug["code"]] = total
        if drug.get("sku_aliases"):
            stock_map[drug["sku_aliases"][0]] = total
    return stock_map


@router.get("/stock/summary")
async def get_stock_summary(token: str | None = Depends(optional_oauth2_scheme)) -> list[dict[str, Any]]:
    await maybe_sync_catalog_drugs(token)
    inventory_settings = await fetch_inventory_settings()
    day = date.today()
    low_stock_threshold = _to_non_negative_int(inventory_settings.get("inventory.low_stock_threshold"), 10)
    expiry_warning_days = _to_non_negative_int(inventory_settings.get("inventory.expiry_warning_days"), 30)
    near_date_days = _to_non_negative_int(inventory_settings.get("inventory.near_date_days"), 90)
    rows: list[dict[str, Any]] = []
    for drug in runtime_state.drugs.values():
        batches = [
            batch
            for batch in runtime_state.batches.values()
            if batch["drug_id"] == drug["id"] and not batch["cancelled"] and batch["qty_remaining"] > 0
        ]
        nearest = min((batch["exp_date"] for batch in batches), default=None)
        rows.append(
            {
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "drug_group": drug["group"],
                "base_unit": drug["base_unit"],
                "reorder_level": drug["reorder_level"],
                "total_qty": stock_total_for_drug(drug["id"]),
                "nearest_expiry": nearest,
                "days_to_nearest_expiry": (nearest - day).days if nearest else None,
                "status": stock_status_for_drug(
                    drug["id"],
                    day,
                    low_stock_threshold=low_stock_threshold,
                    expiry_warning_days=expiry_warning_days,
                    near_date_days=near_date_days,
                ),
            }
        )
    rows.sort(key=lambda row: row["drug_code"])
    return rows


@router.get("/stock/drugs/{drug_id}")
async def get_stock_detail(drug_id: str, token: str | None = Depends(optional_oauth2_scheme)) -> dict[str, Any]:
    await maybe_sync_catalog_drugs(token)
    inventory_settings = await fetch_inventory_settings()
    drug = resolve_drug(drug_id=drug_id)
    day = date.today()
    low_stock_threshold = _to_non_negative_int(inventory_settings.get("inventory.low_stock_threshold"), 10)
    expiry_warning_days = _to_non_negative_int(inventory_settings.get("inventory.expiry_warning_days"), 30)
    near_date_days = _to_non_negative_int(inventory_settings.get("inventory.near_date_days"), 90)
    batches = [batch for batch in runtime_state.batches.values() if batch["drug_id"] == drug["id"]]
    batches.sort(key=lambda batch: (batch["exp_date"], batch["received_date"], batch["batch_code"]))
    return {
        "drug": drug,
        "summary": {
            "total_qty": stock_total_for_drug(drug["id"]),
            "status": stock_status_for_drug(
                drug["id"],
                day,
                low_stock_threshold=low_stock_threshold,
                expiry_warning_days=expiry_warning_days,
                near_date_days=near_date_days,
            ),
            "reorder_level": drug["reorder_level"],
        },
        "batches": [batch_to_view(batch, day) for batch in batches],
    }


@router.post("/reports/batch-costs")
async def get_batch_costs(
    payload: BatchCostLookupRequest,
    token: str | None = Depends(optional_oauth2_scheme),
) -> dict[str, Any]:
    if token:
        get_current_subject(token)

    unique_batch_ids: list[str] = []
    seen: set[str] = set()
    for batch_id in payload.batch_ids:
        normalized = str(batch_id).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_batch_ids.append(normalized)

    items = [
        batch_cost_snapshot(batch)
        for batch_id in unique_batch_ids
        if (batch := runtime_state.batches.get(batch_id)) is not None
    ]
    return {"items": items}

@router.get("/import-receipts")
async def list_import_receipts(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: ReceiptStatus | None = Query(default=None, alias="status"),
) -> list[dict[str, Any]]:
    receipts = filter_import_receipts(
        list(runtime_state.receipts.values()),
        date_from=date_from,
        date_to=date_to,
        supplier_id=supplier_id,
        status_filter=status_filter,
    )
    return [receipt_to_view(receipt) for receipt in receipts]


@router.get("/import-receipts/paged")
async def list_import_receipts_paged(
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: ReceiptStatus | None = Query(default=None, alias="status"),
    payment_status: PaymentStatus | None = Query(default=None),
    search: str | None = Query(default=None),
) -> dict[str, Any]:
    receipts = filter_import_receipts(
        list(runtime_state.receipts.values()),
        date_from=date_from,
        date_to=date_to,
        supplier_id=supplier_id,
        status_filter=status_filter,
        payment_status=payment_status,
        search=search,
    )

    total = len(receipts)
    pages = max(1, (total + size - 1) // size)
    current_page = min(page, pages)
    start = (current_page - 1) * size
    end = start + size
    items = receipts[start:end]
    return {
        "items": [receipt_list_item_to_view(receipt) for receipt in items],
        "total": total,
        "page": current_page,
        "size": size,
        "pages": pages,
    }


@router.get("/import-receipts/{receipt_id}")
async def get_import_receipt(receipt_id: str) -> dict[str, Any]:
    return receipt_to_view(get_receipt_or_404(receipt_id))


@router.post("/import-receipts", status_code=status.HTTP_201_CREATED)
async def create_import_receipt(payload: ImportReceiptCreateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        supplier = await resolve_supplier_or_404(payload.supplier_id, token=token)
        receipt_id = next_id("receipt", "rcp")
        now = utc_now()
        lines: list[dict[str, Any]] = []
        staged_batches: list[dict[str, Any]] = []
        staged_movements: list[tuple[str, str, int]] = []
        reserved_batch_codes: set[str] = set()
        total = 0.0

        for line in payload.lines:
            drug = await resolve_or_register_drug(line, token=token)

            if line.batch_code:
                batch_code = normalize_code(line.batch_code)
            else:
                batch_code = next_available_batch_code(payload.receipt_date, reserved_batch_codes)

            if batch_code in reserved_batch_codes:
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' is duplicated in payload")
            if is_batch_code_used(batch_code):
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")
            reserved_batch_codes.add(batch_code)

            batch_id = next_id("batch", "bt")
            line_id = next_id("receipt_line", "rline")
            promo_note = resolve_line_promo_note(line)
            barcode = resolve_line_barcode(line, drug)
            unit_prices = resolve_line_unit_prices(line, drug)
            stock_quantity = to_stock_quantity(
                line.quantity,
                unit_prices,
                promo_type=line.promo_type,
                promo_buy_qty=line.promo_buy_qty,
                promo_get_qty=line.promo_get_qty,
            )

            batch = {
                "id": batch_id,
                "batch_code": batch_code,
                "lot_number": line.lot_number.strip(),
                "receipt_id": receipt_id,
                "drug_id": drug["id"],
                "supplier_id": supplier["id"],
                "supplier_name": supplier.get("name", ""),
                "supplier_contact_name": supplier.get("contact_name", ""),
                "supplier_phone": supplier.get("phone", ""),
                "supplier_address": supplier.get("address", ""),
                "received_date": payload.receipt_date,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "qty_in": stock_quantity,
                "qty_remaining": stock_quantity,
                "import_price": round_money_value(line.import_price),
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "force_expired": False,
                "cancelled": False,
                "created_at": now,
                "updated_at": now,
            }
            staged_batches.append(batch)

            row = {
                "id": line_id,
                "batch_id": batch_id,
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "lot_number": batch["lot_number"],
                "batch_code": batch["batch_code"],
                "quantity": line.quantity,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "import_price": round_money_value(line.import_price),
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "stock_quantity": stock_quantity,
            }
            lines.append(row)
            total += line.quantity * round_money_value(line.import_price)
            staged_movements.append((drug["id"], batch_id, stock_quantity))

        receipt = {
            "id": receipt_id,
            "code": receipt_code_for_date(payload.receipt_date),
            "receipt_date": payload.receipt_date,
            "supplier_id": supplier["id"],
            "supplier_name": supplier.get("name", ""),
            "supplier_contact_name": supplier.get("contact_name", ""),
            "supplier_phone": supplier.get("phone", ""),
            "supplier_address": supplier.get("address", ""),
            "shipping_carrier": payload.shipping_carrier,
            "payment_status": payload.payment_status,
            "payment_method": payload.payment_method,
            "note": payload.note,
            "status": ReceiptStatus.CONFIRMED,
            "created_by": actor,
            "created_at": now,
            "updated_at": now,
            "total_value": round_money_value(total),
            "lines": lines,
        }

        for batch in staged_batches:
            runtime_state.batches[batch["id"]] = batch
        runtime_state.receipts[receipt_id] = receipt
        for drug_id, batch_id, quantity in staged_movements:
            add_movement(
                MovementType.IMPORT_RECEIPT,
                drug_id,
                batch_id,
                quantity,
                "import_receipt",
                receipt_id,
                actor,
                "create import receipt",
            )
        await save_runtime_state_safe()

    return receipt_to_view(receipt)


@router.put("/import-receipts/{receipt_id}")
async def update_import_receipt(receipt_id: str, payload: ImportReceiptUpdateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor, role, username = get_current_actor(token)
    allow_privileged = can_override_receipt_lock(role, username)
    async with runtime_state.lock:
        receipt = get_receipt_or_404(receipt_id)
        supplier = await resolve_supplier_or_404(payload.supplier_id, token=token)
        editable = receipt_is_editable(receipt, raise_if_not=False)
        receipt_is_editable(receipt, raise_if_not=True, allow_privileged=allow_privileged)

        now = utc_now()

        if not editable:
            existing_by_batch_code: dict[str, dict[str, Any]] = {}
            for existing_line in receipt["lines"]:
                key = normalize_code(existing_line["batch_code"])
                if key in existing_by_batch_code:
                    raise HTTPException(status_code=409, detail="Receipt has duplicated batch code and cannot be updated safely")
                existing_by_batch_code[key] = existing_line

            existing_batch_ids = {line["batch_id"] for line in receipt["lines"]}
            incoming_batch_codes: set[str] = set()
            matched_existing_batch_codes: set[str] = set()
            lines: list[dict[str, Any]] = []
            staged_batch_updates: list[tuple[dict[str, Any], dict[str, Any]]] = []
            staged_new_batches: list[dict[str, Any]] = []
            staged_movements: list[tuple[str, str, int]] = []
            total = 0.0

            for line in payload.lines:
                payload_batch_code = normalize_code(line.batch_code or "")
                existing_line = existing_by_batch_code.get(payload_batch_code) if payload_batch_code else None

                if payload_batch_code and payload_batch_code in incoming_batch_codes:
                    raise HTTPException(status_code=409, detail=f"Batch code '{payload_batch_code}' is duplicated in payload")

                if existing_line is not None:
                    incoming_batch_codes.add(payload_batch_code)
                    matched_existing_batch_codes.add(payload_batch_code)

                    batch = runtime_state.batches.get(existing_line["batch_id"])
                    if batch is None:
                        raise HTTPException(status_code=409, detail="Receipt has missing batch")

                    drug = await resolve_or_register_drug(line, token=token)
                    if drug["id"] != existing_line["drug_id"]:
                        raise HTTPException(
                            status_code=409,
                            detail="Receipt has sales/adjustments. Owner/admin cannot change drug of existing line.",
                        )
                    if line.quantity != existing_line["quantity"]:
                        raise HTTPException(
                            status_code=409,
                            detail="Receipt has sales/adjustments. Owner/admin cannot change quantity.",
                        )

                    batch_code = normalize_code(line.batch_code)
                    if is_batch_code_used(batch_code, ignore_ids=existing_batch_ids):
                        raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")

                    promo_note = resolve_line_promo_note(line)
                    barcode = resolve_line_barcode(line, drug)
                    unit_prices = resolve_line_unit_prices(line, drug)

                    row = {
                        "id": existing_line["id"],
                        "batch_id": existing_line["batch_id"],
                        "drug_id": drug["id"],
                        "drug_code": drug["code"],
                        "drug_name": drug["name"],
                        "lot_number": line.lot_number.strip(),
                        "batch_code": batch_code,
                        "quantity": existing_line["quantity"],
                        "mfg_date": line.mfg_date,
                        "exp_date": line.exp_date,
                        "import_price": round_money_value(line.import_price),
                        "barcode": barcode,
                        "promo_type": line.promo_type,
                        "promo_buy_qty": line.promo_buy_qty,
                        "promo_get_qty": line.promo_get_qty,
                        "promo_discount_percent": line.promo_discount_percent,
                        "unit_prices": unit_prices,
                        "promo_note": promo_note,
                    }
                    lines.append(row)
                    total += row["quantity"] * row["import_price"]
                    staged_batch_updates.append(
                        (
                            batch,
                            {
                                "batch_code": row["batch_code"],
                                "lot_number": row["lot_number"],
                                "supplier_id": supplier["id"],
                                "supplier_name": supplier.get("name", ""),
                                "supplier_contact_name": supplier.get("contact_name", ""),
                                "supplier_phone": supplier.get("phone", ""),
                                "supplier_address": supplier.get("address", ""),
                                "received_date": payload.receipt_date,
                                "mfg_date": row["mfg_date"],
                                "exp_date": row["exp_date"],
                                "import_price": row["import_price"],
                                "barcode": row["barcode"],
                                "promo_type": row["promo_type"],
                                "promo_buy_qty": row["promo_buy_qty"],
                                "promo_get_qty": row["promo_get_qty"],
                                "promo_discount_percent": row["promo_discount_percent"],
                                "unit_prices": row["unit_prices"],
                                "promo_note": row["promo_note"],
                                "updated_at": now,
                            },
                        )
                    )
                    continue

                drug = await resolve_or_register_drug(line, token=token)
                batch_code = payload_batch_code or next_available_batch_code(payload.receipt_date, incoming_batch_codes)
                if batch_code in incoming_batch_codes:
                    raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' is duplicated in payload")
                if is_batch_code_used(batch_code):
                    raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")
                incoming_batch_codes.add(batch_code)

                line_id = next_id("receipt_line", "rline")
                batch_id = next_id("batch", "bt")
                promo_note = resolve_line_promo_note(line)
                barcode = resolve_line_barcode(line, drug)
                unit_prices = resolve_line_unit_prices(line, drug)
                stock_quantity = to_stock_quantity(
                    line.quantity,
                    unit_prices,
                    promo_type=line.promo_type,
                    promo_buy_qty=line.promo_buy_qty,
                    promo_get_qty=line.promo_get_qty,
                )

                batch = {
                    "id": batch_id,
                    "batch_code": batch_code,
                    "lot_number": line.lot_number.strip(),
                    "receipt_id": receipt["id"],
                    "drug_id": drug["id"],
                    "supplier_id": supplier["id"],
                    "supplier_name": supplier.get("name", ""),
                    "supplier_contact_name": supplier.get("contact_name", ""),
                    "supplier_phone": supplier.get("phone", ""),
                    "supplier_address": supplier.get("address", ""),
                    "received_date": payload.receipt_date,
                    "mfg_date": line.mfg_date,
                    "exp_date": line.exp_date,
                    "qty_in": stock_quantity,
                    "qty_remaining": stock_quantity,
                    "import_price": round_money_value(line.import_price),
                    "barcode": barcode,
                    "promo_type": line.promo_type,
                    "promo_buy_qty": line.promo_buy_qty,
                    "promo_get_qty": line.promo_get_qty,
                    "promo_discount_percent": line.promo_discount_percent,
                    "unit_prices": unit_prices,
                    "promo_note": promo_note,
                    "stock_quantity": stock_quantity,
                    "force_expired": False,
                    "cancelled": False,
                    "created_at": now,
                    "updated_at": now,
                }
                staged_new_batches.append(batch)

                row = {
                    "id": line_id,
                    "batch_id": batch_id,
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "lot_number": batch["lot_number"],
                    "batch_code": batch_code,
                    "quantity": line.quantity,
                    "mfg_date": line.mfg_date,
                    "exp_date": line.exp_date,
                    "import_price": round_money_value(line.import_price),
                    "barcode": barcode,
                    "promo_type": line.promo_type,
                    "promo_buy_qty": line.promo_buy_qty,
                    "promo_get_qty": line.promo_get_qty,
                    "promo_discount_percent": line.promo_discount_percent,
                    "unit_prices": unit_prices,
                    "promo_note": promo_note,
                    "stock_quantity": stock_quantity,
                }
                lines.append(row)
                total += row["quantity"] * row["import_price"]
                staged_movements.append((drug["id"], batch_id, stock_quantity))

            if len(matched_existing_batch_codes) != len(existing_by_batch_code):
                raise HTTPException(
                    status_code=409,
                    detail="Receipt has sales/adjustments. Owner/admin cannot remove existing lines.",
                )

            for batch, patch in staged_batch_updates:
                batch.update(patch)
            for batch in staged_new_batches:
                runtime_state.batches[batch["id"]] = batch

            receipt["receipt_date"] = payload.receipt_date
            receipt["supplier_id"] = supplier["id"]
            receipt["supplier_name"] = supplier.get("name", "")
            receipt["supplier_contact_name"] = supplier.get("contact_name", "")
            receipt["supplier_phone"] = supplier.get("phone", "")
            receipt["supplier_address"] = supplier.get("address", "")
            receipt["shipping_carrier"] = payload.shipping_carrier
            receipt["payment_status"] = payload.payment_status
            receipt["payment_method"] = payload.payment_method
            receipt["note"] = payload.note
            receipt["lines"] = lines
            receipt["total_value"] = round_money_value(total)
            receipt["updated_at"] = now
            for drug_id, batch_id, quantity in staged_movements:
                add_movement(
                    MovementType.IMPORT_RECEIPT,
                    drug_id,
                    batch_id,
                    quantity,
                    "import_receipt",
                    receipt["id"],
                    actor,
                    "append line to locked receipt",
                )
            await save_runtime_state_safe()
            return receipt_to_view(receipt)

        old_batch_ids = {line["batch_id"] for line in receipt["lines"]}
        lines: list[dict[str, Any]] = []
        staged_batches: list[dict[str, Any]] = []
        staged_movements: list[tuple[str, str, int]] = []
        reserved_batch_codes: set[str] = set()
        total = 0.0

        for line in payload.lines:
            drug = await resolve_or_register_drug(line, token=token)

            if line.batch_code:
                batch_code = normalize_code(line.batch_code)
            else:
                batch_code = next_available_batch_code(
                    payload.receipt_date,
                    reserved_batch_codes,
                    ignore_ids=old_batch_ids,
                )

            if batch_code in reserved_batch_codes:
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' is duplicated in payload")
            if is_batch_code_used(batch_code, ignore_ids=old_batch_ids):
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")
            reserved_batch_codes.add(batch_code)

            batch_id = next_id("batch", "bt")
            line_id = next_id("receipt_line", "rline")
            promo_note = resolve_line_promo_note(line)
            barcode = resolve_line_barcode(line, drug)
            unit_prices = resolve_line_unit_prices(line, drug)
            stock_quantity = to_stock_quantity(
                line.quantity,
                unit_prices,
                promo_type=line.promo_type,
                promo_buy_qty=line.promo_buy_qty,
                promo_get_qty=line.promo_get_qty,
            )

            batch = {
                "id": batch_id,
                "batch_code": batch_code,
                "lot_number": line.lot_number.strip(),
                "receipt_id": receipt["id"],
                "drug_id": drug["id"],
                "supplier_id": supplier["id"],
                "supplier_name": supplier.get("name", ""),
                "supplier_contact_name": supplier.get("contact_name", ""),
                "supplier_phone": supplier.get("phone", ""),
                "supplier_address": supplier.get("address", ""),
                "received_date": payload.receipt_date,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "qty_in": stock_quantity,
                "qty_remaining": stock_quantity,
                "import_price": round_money_value(line.import_price),
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "stock_quantity": stock_quantity,
                "force_expired": False,
                "cancelled": False,
                "created_at": now,
                "updated_at": now,
            }
            staged_batches.append(batch)

            row = {
                "id": line_id,
                "batch_id": batch_id,
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "lot_number": batch["lot_number"],
                "batch_code": batch["batch_code"],
                "quantity": line.quantity,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "import_price": round_money_value(line.import_price),
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "stock_quantity": stock_quantity,
            }
            lines.append(row)
            total += line.quantity * round_money_value(line.import_price)
            staged_movements.append((drug["id"], batch_id, stock_quantity))

        for batch_id in old_batch_ids:
            runtime_state.batches.pop(batch_id, None)

        runtime_state.movements = [
            m
            for m in runtime_state.movements
            if not (m["batch_id"] in old_batch_ids and m["event_type"] == MovementType.IMPORT_RECEIPT and m["reference_id"] == receipt["id"])
        ]

        for batch in staged_batches:
            runtime_state.batches[batch["id"]] = batch

        receipt["receipt_date"] = payload.receipt_date
        receipt["supplier_id"] = supplier["id"]
        receipt["supplier_name"] = supplier.get("name", "")
        receipt["supplier_contact_name"] = supplier.get("contact_name", "")
        receipt["supplier_phone"] = supplier.get("phone", "")
        receipt["supplier_address"] = supplier.get("address", "")
        receipt["shipping_carrier"] = payload.shipping_carrier
        receipt["payment_status"] = payload.payment_status
        receipt["payment_method"] = payload.payment_method
        receipt["note"] = payload.note
        receipt["lines"] = lines
        receipt["total_value"] = round_money_value(total)
        receipt["updated_at"] = now
        for drug_id, batch_id, quantity in staged_movements:
            add_movement(
                MovementType.IMPORT_RECEIPT,
                drug_id,
                batch_id,
                quantity,
                "import_receipt",
                receipt["id"],
                actor,
                "update import receipt",
            )
        await save_runtime_state_safe()

    return receipt_to_view(receipt)


@router.post("/import-receipts/{receipt_id}/cancel")
async def cancel_import_receipt(receipt_id: str, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        receipt = get_receipt_or_404(receipt_id)
        if receipt["status"] == ReceiptStatus.CANCELLED:
            return {"message": "Receipt already cancelled", "receipt": receipt_to_view(receipt)}

        receipt_is_editable(receipt, raise_if_not=True)
        now = utc_now()

        for line in receipt["lines"]:
            batch = runtime_state.batches.get(line["batch_id"])
            if batch is None:
                continue
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.RECEIPT_CANCEL, batch["drug_id"], batch["id"], -batch["qty_remaining"], "import_receipt", receipt["id"], actor, "cancel receipt")
            batch["qty_remaining"] = 0
            batch["cancelled"] = True
            batch["force_expired"] = False
            batch["updated_at"] = now

        receipt["status"] = ReceiptStatus.CANCELLED
        receipt["updated_at"] = now
        await save_runtime_state_safe()

    return {"message": "Import receipt cancelled and stock rolled back", "receipt": receipt_to_view(receipt)}


@router.get("/batches")
async def list_batches(
    search: str | None = Query(default=None),
    drug: str | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: BatchStatus | None = Query(default=None, alias="status"),
    exp_from: date | None = Query(default=None),
    exp_to: date | None = Query(default=None),
    hide_zero: bool = Query(default=False),
) -> list[dict[str, Any]]:
    day = date.today()
    records = filter_batches(
        list(runtime_state.batches.values()),
        day=day,
        search=search,
        drug=drug,
        supplier_id=supplier_id,
        status_filter=status_filter,
        exp_from=exp_from,
        exp_to=exp_to,
        hide_zero=hide_zero,
    )
    return [batch_to_view(batch, day) for batch in records]


@router.get("/batches/paged")
async def list_batches_paged(
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    drug: str | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: BatchStatus | None = Query(default=None, alias="status"),
    exp_from: date | None = Query(default=None),
    exp_to: date | None = Query(default=None),
    hide_zero: bool = Query(default=False),
) -> dict[str, Any]:
    day = date.today()
    base_records = filter_batches(
        list(runtime_state.batches.values()),
        day=day,
        search=search,
        drug=drug,
        supplier_id=supplier_id,
        status_filter=status_filter,
        exp_from=exp_from,
        exp_to=exp_to,
    )
    inventory_settings = await fetch_inventory_settings()
    near_date_days = _to_non_negative_int(inventory_settings.get("inventory.near_date_days"), 90)
    summary = summarize_batches_by_drug(base_records, day=day, near_date_days=near_date_days)
    records = (
        [batch for batch in base_records if int(batch.get("qty_remaining", 0)) > 0]
        if hide_zero
        else base_records
    )

    total = len(records)
    pages = max(1, (total + size - 1) // size)
    current_page = min(page, pages)
    start = (current_page - 1) * size
    end = start + size
    items = records[start:end]

    return {
        "items": [batch_to_view(batch, day) for batch in items],
        "total": total,
        "page": current_page,
        "size": size,
        "pages": pages,
        "summary": summary,
    }


@router.get("/batches/qr/{qr_value}")
async def get_batch_by_qr(qr_value: str) -> dict[str, Any]:
    batch = find_batch_by_qr(qr_value)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"Batch not found for QR '{qr_value}'")

    history = [
        movement_to_view(m)
        for m in sorted((m for m in runtime_state.movements if m["batch_id"] == batch["id"]), key=lambda item: item["occurred_at"], reverse=True)
    ]
    return {"batch": batch_to_view(batch), "history": history}


@router.get("/batches/suggest-issue")
async def suggest_batches_for_issue(
    quantity: int = Query(gt=0),
    drug_id: str | None = Query(default=None),
    drug_code: str | None = Query(default=None),
    as_of: date | None = Query(default=None),
) -> dict[str, Any]:
    if not drug_id and not drug_code:
        raise HTTPException(status_code=400, detail="Provide drug_id or drug_code")
    drug = resolve_drug(drug_id=drug_id, drug_code_or_sku=drug_code)
    day = as_of or date.today()
    inventory_settings = await fetch_inventory_settings()
    fefo_enabled = _to_bool(inventory_settings.get("inventory.enable_fefo"), True)
    fefo_threshold_days = _to_positive_int(
        inventory_settings.get("inventory.fefo_threshold_days"),
        default=settings.FEFO_THRESHOLD_DAYS,
    )
    allocations, shortage = suggest_issue_plan(
        drug,
        quantity,
        day,
        enable_fefo=fefo_enabled,
        fefo_threshold_days=fefo_threshold_days,
    )
    return {
        "drug_id": drug["id"],
        "drug_code": drug["code"],
        "drug_name": drug["name"],
        "requested": quantity,
        "allocated": quantity - shortage,
        "shortage": shortage,
        "rule": {
            "enable_fefo": fefo_enabled,
            "fefo_threshold_days": fefo_threshold_days,
            "description": "expiry < threshold => FEFO, otherwise FIFO",
        },
        "allocations": allocations,
    }


@router.get("/batches/{batch_id}")
async def get_batch_detail(batch_id: str) -> dict[str, Any]:
    batch = get_batch_or_404(batch_id)
    history = [
        movement_to_view(m)
        for m in sorted((m for m in runtime_state.movements if m["batch_id"] == batch["id"]), key=lambda item: item["occurred_at"], reverse=True)
    ]
    return {"batch": batch_to_view(batch), "history": history}

@router.patch("/batches/{batch_id}/status")
async def update_batch_status(batch_id: str, payload: BatchStatusUpdateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        batch = get_batch_or_404(batch_id)
        now = utc_now()
        today = date.today()

        if payload.status == BatchStatus.CANCELLED:
            if batch["cancelled"]:
                return batch_to_view(batch)
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], -batch["qty_remaining"], "batch_status", batch["id"], actor, "manual cancel batch")
            batch["qty_remaining"] = 0
            batch["cancelled"] = True
            batch["force_expired"] = False

        elif payload.status == BatchStatus.DEPLETED:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be marked depleted")
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], -batch["qty_remaining"], "batch_status", batch["id"], actor, "manual set depleted")
            batch["qty_remaining"] = 0
            batch["force_expired"] = False

        elif payload.status == BatchStatus.EXPIRED:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be marked expired")
            batch["force_expired"] = True

        elif payload.status == BatchStatus.ACTIVE:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be activated")
            if batch["qty_remaining"] <= 0:
                raise HTTPException(status_code=409, detail="Batch with zero quantity cannot be active")
            if batch["exp_date"] < today:
                raise HTTPException(status_code=409, detail="Expired batch cannot be activated")
            batch["force_expired"] = False

        batch["updated_at"] = now
        await save_runtime_state_safe()

    return batch_to_view(batch)


@router.post("/stock/adjustments")
async def adjust_stock(payload: StockAdjustmentRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        batch = get_batch_or_404(payload.batch_id)
        if batch["cancelled"]:
            raise HTTPException(status_code=409, detail="Cannot adjust cancelled batch")

        if payload.quantity_delta is not None:
            quantity_delta = payload.quantity_delta
        else:
            quantity_delta = payload.new_quantity - batch["qty_remaining"]

        next_qty = batch["qty_remaining"] + quantity_delta
        if next_qty < 0:
            raise HTTPException(status_code=409, detail="Adjustment would make stock negative")

        batch["qty_remaining"] = next_qty
        batch["updated_at"] = utc_now()
        movement = add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], quantity_delta, "stock_adjustment", next_id("reservation", "adj"), actor, f"{payload.reason}: {payload.note or ''}".strip())
        await save_runtime_state_safe()

    return {"message": "Stock adjusted", "batch": batch_to_view(batch), "adjustment": movement_to_view(movement)}


@router.get("/reports/movement")
async def movement_report(
    date_from: date = Query(...),
    date_to: date = Query(...),
    drug: str | None = Query(default=None),
) -> dict[str, Any]:
    if date_to < date_from:
        raise HTTPException(status_code=400, detail="date_to must be greater than or equal to date_from")

    if drug:
        target_drug = resolve_drug(drug_id=drug, drug_code_or_sku=drug)
        target_ids = {target_drug["id"]}
    else:
        target_ids = set(runtime_state.drugs.keys())

    rows: list[dict[str, Any]] = []
    for drug_id in sorted(target_ids):
        drug_record = runtime_state.drugs[drug_id]
        movements = [m for m in runtime_state.movements if m["drug_id"] == drug_id]

        opening_stock = sum(m["quantity_delta"] for m in movements if m["occurred_at"].date() < date_from)
        in_period = [m for m in movements if date_from <= m["occurred_at"].date() <= date_to]

        imported_qty = sum(m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.IMPORT_RECEIPT and m["quantity_delta"] > 0)
        exported_qty = sum(-m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.SALE_RESERVE and m["quantity_delta"] < 0)
        adjusted_in = sum(m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.STOCK_ADJUSTMENT and m["quantity_delta"] > 0)
        adjusted_out = sum(-m["quantity_delta"] for m in in_period if m["event_type"] in {MovementType.STOCK_ADJUSTMENT, MovementType.RECEIPT_CANCEL} and m["quantity_delta"] < 0)
        closing_stock = opening_stock + sum(m["quantity_delta"] for m in in_period)

        rows.append(
            {
                "drug_id": drug_record["id"],
                "drug_code": drug_record["code"],
                "drug_name": drug_record["name"],
                "opening_stock": opening_stock,
                "imported_qty": imported_qty,
                "exported_qty": exported_qty,
                "adjusted_in": adjusted_in,
                "adjusted_out": adjusted_out,
                "closing_stock": closing_stock,
            }
        )

    return {"date_from": date_from, "date_to": date_to, "rows": rows}


@router.get("/alerts")
async def inventory_alerts(
    low_stock_threshold: int | None = Query(default=None, ge=0),
    as_of: date | None = Query(default=None),
) -> dict[str, Any]:
    inventory_settings = await fetch_inventory_settings()
    day = as_of or date.today()
    configured_low_stock_threshold = _to_non_negative_int(
        inventory_settings.get("inventory.low_stock_threshold"),
        10,
    )
    expiry_warning_days = _to_non_negative_int(
        inventory_settings.get("inventory.expiry_warning_days"),
        30,
    )
    near_date_days = _to_non_negative_int(
        inventory_settings.get("inventory.near_date_days"),
        90,
    )
    low_stock: list[dict[str, Any]] = []
    expired: list[dict[str, Any]] = []
    expiring_soon: list[dict[str, Any]] = []
    near_date: list[dict[str, Any]] = []

    for drug in runtime_state.drugs.values():
        total = stock_total_for_drug(drug["id"])
        threshold = (
            low_stock_threshold
            if low_stock_threshold is not None
            else (drug["reorder_level"] if drug["reorder_level"] > 0 else configured_low_stock_threshold)
        )
        if total < threshold:
            low_stock.append(
                {
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "current_qty": total,
                    "threshold": threshold,
                }
            )

    for batch in runtime_state.batches.values():
        if batch["cancelled"] or batch["qty_remaining"] <= 0:
            continue
        days = (batch["exp_date"] - day).days
        entry = {"batch": batch_to_view(batch, day), "days_to_expiry": days}
        if days < 0:
            expired.append(entry)
        elif days < expiry_warning_days:
            expiring_soon.append(entry)
        elif days < near_date_days:
            near_date.append(entry)

    return {
        "as_of": day,
        "totals": {
            "low_stock": len(low_stock),
            "expiring_soon": len(expiring_soon),
            "near_date": len(near_date),
            "expired": len(expired),
        },
        "low_stock": low_stock,
        "expiring_soon": expiring_soon,
        "near_date": near_date,
        "expired": expired,
    }


@router.post("/reserve")
async def reserve(payload: ReserveRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    user_id = get_current_subject(token)
    inventory_settings = await fetch_inventory_settings()
    fefo_enabled = _to_bool(inventory_settings.get("inventory.enable_fefo"), True)
    fefo_threshold_days = _to_positive_int(
        inventory_settings.get("inventory.fefo_threshold_days"),
        default=settings.FEFO_THRESHOLD_DAYS,
    )
    as_of_day = date.today()
    async with runtime_state.lock:
        reservation_items: list[dict[str, Any]] = []

        for item in payload.items:
            drug = resolve_drug(drug_code_or_sku=item.sku)
            recommended_allocations, shortage = suggest_issue_plan(
                drug,
                item.quantity,
                as_of_day,
                enable_fefo=fefo_enabled,
                fefo_threshold_days=fefo_threshold_days,
            )

            allocations: list[dict[str, Any]]
            lot_policy: dict[str, Any]
            if item.batch_id:
                batch = get_batch_or_404(item.batch_id)
                if batch["drug_id"] != drug["id"]:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Batch '{item.batch_id}' does not belong to sku '{item.sku}'",
                    )
                if batch_status(batch, as_of_day) != BatchStatus.ACTIVE or batch["qty_remaining"] <= 0:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Batch '{item.batch_id}' is not available for reservation",
                    )
                if batch["qty_remaining"] < item.quantity:
                    shortage = item.quantity - batch["qty_remaining"]
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "message": f"Not enough stock in batch '{item.batch_id}' for '{item.sku}'",
                            "requested": item.quantity,
                            "available": batch["qty_remaining"],
                            "shortage": shortage,
                            "batch_id": item.batch_id,
                        },
                    )

                allocations = [
                    {
                        "batch_id": batch["id"],
                        "batch_code": batch["batch_code"],
                        "lot_number": batch["lot_number"],
                        "drug_id": batch["drug_id"],
                        "drug_code": drug["code"],
                        "drug_name": drug["name"],
                        "received_date": batch["received_date"],
                        "exp_date": batch["exp_date"],
                        "available": batch["qty_remaining"],
                        "allocated": item.quantity,
                        "strategy": issue_strategy(
                            batch,
                            as_of_day,
                            enable_fefo=fefo_enabled,
                            fefo_threshold_days=fefo_threshold_days,
                        ),
                    }
                ]
                recommended_batch_id = recommended_allocations[0]["batch_id"] if recommended_allocations else None
                lot_policy = {
                    "is_checked": True,
                    "is_recommended": bool(recommended_batch_id == batch["id"]),
                    "recommended_batch_id": recommended_batch_id,
                    "recommended_batch_code": recommended_allocations[0]["batch_code"] if recommended_allocations else None,
                }
            else:
                allocations = recommended_allocations
                lot_policy = {
                    "is_checked": False,
                    "is_recommended": True,
                    "recommended_batch_id": allocations[0]["batch_id"] if allocations else None,
                    "recommended_batch_code": allocations[0]["batch_code"] if allocations else None,
                }
                if shortage > 0:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "message": f"Not enough stock for '{item.sku}'",
                            "requested": item.quantity,
                            "available": item.quantity - shortage,
                            "shortage": shortage,
                        },
                    )

            reservation_items.append(
                {
                    "sku": item.sku,
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "requested": item.quantity,
                    "requested_batch_id": item.batch_id,
                    "lot_policy": lot_policy,
                    "allocations": allocations,
                }
            )

        for reservation_item in reservation_items:
            for allocation in reservation_item["allocations"]:
                batch = get_batch_or_404(allocation["batch_id"])
                batch["qty_remaining"] -= allocation["allocated"]
                batch["updated_at"] = utc_now()
                add_movement(MovementType.SALE_RESERVE, batch["drug_id"], batch["id"], -allocation["allocated"], "sale", payload.sale_id, user_id, f"reserve for sale {payload.sale_id}")

        reservation_record = {
            "id": next_id("reservation", "rsv"),
            "sale_id": payload.sale_id,
            "reserved_by": user_id,
            "reserved_at": utc_now(),
            "items": reservation_items,
        }
        runtime_state.reservations.append(reservation_record)
        runtime_state.reservations = runtime_state.reservations[-500:]
        await save_runtime_state_safe()

    return {"message": "Stock reserved", "reservation": reservation_record}

