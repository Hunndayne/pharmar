from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from math import ceil
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .core.config import get_settings
from .db.models import HeldOrder, Invoice, InvoiceItem, PaymentMethod, Return, Shift


settings = get_settings()


DECIMAL_ZERO = Decimal("0")
DEFAULT_STORE_TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")


@dataclass(slots=True)
class PaginationMeta:
    total: int
    page: int
    size: int
    pages: int


DEFAULT_PAYMENT_METHODS: list[dict[str, Any]] = [
    {"code": "cash", "name": "Tien mat", "display_order": 1, "requires_reference": False},
    {"code": "card", "name": "The", "display_order": 2, "requires_reference": True},
    {"code": "bank", "name": "Ngan hang", "display_order": 3, "requires_reference": True},
    {"code": "transfer", "name": "Chuyen khoan", "display_order": 4, "requires_reference": True},
    {"code": "momo", "name": "MoMo", "display_order": 5, "requires_reference": True},
    {"code": "zalopay", "name": "ZaloPay", "display_order": 6, "requires_reference": True},
    {"code": "vnpay", "name": "VNPay", "display_order": 7, "requires_reference": True},
]


def normalize_optional_string(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def resolve_store_timezone(value: str | None) -> ZoneInfo:
    raw = str(value or "").strip()
    if not raw:
        return DEFAULT_STORE_TIMEZONE
    try:
        return ZoneInfo(raw)
    except Exception:
        return DEFAULT_STORE_TIMEZONE


async def get_store_timezone(token: str | None = None) -> ZoneInfo:
    settings_map = await fetch_store_settings_group("system", token)
    return resolve_store_timezone(settings_map.get("system.timezone") if isinstance(settings_map, dict) else None)


def build_utc_range_for_local_dates(
    date_from: date | None,
    date_to: date | None,
    time_zone: ZoneInfo,
) -> tuple[datetime | None, datetime | None]:
    start_at: datetime | None = None
    end_at: datetime | None = None

    if date_from is not None:
        start_at = datetime.combine(date_from, datetime.min.time(), tzinfo=time_zone).astimezone(timezone.utc)
    if date_to is not None:
        next_day = date_to + timedelta(days=1)
        end_at = datetime.combine(next_day, datetime.min.time(), tzinfo=time_zone).astimezone(timezone.utc)

    return start_at, end_at


def quantize_money(value: Decimal | int | float | str) -> Decimal:
    if isinstance(value, Decimal):
        parsed = value
    else:
        try:
            parsed = Decimal(str(value))
        except (InvalidOperation, ValueError):
            parsed = DECIMAL_ZERO
    return parsed.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def safe_decimal(value: Any, default: Decimal = DECIMAL_ZERO) -> Decimal:
    try:
        return quantize_money(value)
    except Exception:
        return default


def normalize_page_size(page: int, size: int, max_size: int = 200) -> tuple[int, int]:
    safe_page = max(page, 1)
    safe_size = min(max(size, 1), max_size)
    return safe_page, safe_size


async def paginate_scalars(
    db: AsyncSession,
    stmt: Select[Any],
    page: int,
    size: int,
) -> tuple[list[Any], PaginationMeta]:
    safe_page, safe_size = normalize_page_size(page, size)
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int((await db.scalar(count_stmt)) or 0)

    offset = (safe_page - 1) * safe_size
    rows = list((await db.scalars(stmt.offset(offset).limit(safe_size))).all())
    pages = ceil(total / safe_size) if total > 0 else 0
    return rows, PaginationMeta(total=total, page=safe_page, size=safe_size, pages=pages)


async def generate_next_daily_code(
    db: AsyncSession,
    model: Any,
    code_column: Any,
    prefix: str,
    target_date: date | None = None,
    width: int = 3,
) -> str:
    day = target_date or date.today()
    prefix_day = f"{prefix}{day.strftime('%Y%m%d')}"
    rows = await db.scalars(select(code_column).where(code_column.like(f"{prefix_day}%")))

    max_value = 0
    for value in rows:
        if value is None:
            continue
        code = str(value)
        suffix = code[len(prefix_day) :]
        if suffix.isdigit():
            max_value = max(max_value, int(suffix))

    return f"{prefix_day}{max_value + 1:0{width}d}"


async def generate_next_sequence_code(
    db: AsyncSession,
    code_column: Any,
    prefix: str,
    width: int = 3,
) -> str:
    rows = await db.scalars(select(code_column).where(code_column.like(f"{prefix}%")))
    max_value = 0
    for value in rows:
        if value is None:
            continue
        code = str(value)
        suffix = code[len(prefix) :]
        if suffix.isdigit():
            max_value = max(max_value, int(suffix))
    return f"{prefix}{max_value + 1:0{width}d}"


async def get_invoice_or_404(invoice_id: UUID, db: AsyncSession) -> Invoice:
    invoice = await db.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    return invoice


async def get_invoice_by_code_or_404(code: str, db: AsyncSession) -> Invoice:
    invoice = await db.scalar(select(Invoice).where(func.upper(Invoice.code) == code.strip().upper()))
    if invoice is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    return invoice


async def get_held_order_or_404(order_id: UUID, db: AsyncSession) -> HeldOrder:
    held_order = await db.get(HeldOrder, order_id)
    if held_order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Held order not found")
    return held_order


async def get_return_or_404(return_id: UUID, db: AsyncSession) -> Return:
    return_doc = await db.get(Return, return_id)
    if return_doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Return not found")
    return return_doc


async def get_shift_or_404(shift_id: UUID, db: AsyncSession) -> Shift:
    shift = await db.get(Shift, shift_id)
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shift not found")
    return shift


async def get_open_shift_for_user(user_id: str, db: AsyncSession) -> Shift | None:
    return await db.scalar(
        select(Shift).where(
            Shift.cashier_id == user_id,
            Shift.status == "open",
        )
    )


async def ensure_payment_method_exists(method_code: str, db: AsyncSession) -> PaymentMethod:
    method = await db.get(PaymentMethod, method_code.lower())
    if method is None or not method.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Payment method '{method_code}' is not available",
        )
    return method


async def list_active_payment_methods_map(db: AsyncSession) -> dict[str, PaymentMethod]:
    rows = await db.scalars(select(PaymentMethod).where(PaymentMethod.is_active.is_(True)))
    return {item.code: item for item in rows.all()}


def extract_item_sku(item: Any) -> str:
    # Prefer product_id when available so inventory reserve can validate exact drug ownership.
    product_id = getattr(item, "product_id", None)
    if isinstance(product_id, str) and product_id.strip():
        return product_id.strip()

    sku = getattr(item, "sku", None)
    if isinstance(sku, str) and sku.strip():
        return sku.strip()

    for attr in ("product_code",):
        value = getattr(item, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()

    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot resolve sku for an invoice item")


def update_shift_sales_by_method(shift: Shift, method: str, amount: Decimal) -> None:
    amount = quantize_money(amount)
    if method == "cash":
        shift.cash_sales = quantize_money(shift.cash_sales + amount)
    elif method == "card":
        shift.card_sales = quantize_money(shift.card_sales + amount)
    elif method in {"transfer", "bank"}:
        shift.transfer_sales = quantize_money(shift.transfer_sales + amount)
    elif method == "momo":
        shift.momo_sales = quantize_money(shift.momo_sales + amount)
    elif method == "zalopay":
        shift.zalopay_sales = quantize_money(shift.zalopay_sales + amount)
    elif method == "vnpay":
        shift.vnpay_sales = quantize_money(shift.vnpay_sales + amount)


async def call_json_api(
    method: str,
    url: str,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 8.0,
) -> tuple[int, Any]:
    request_headers = dict(headers or {})
    if token:
        request_headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(method=method, url=url, json=payload, headers=request_headers)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Upstream unavailable: {exc}") from exc

    data: Any
    try:
        data = response.json()
    except ValueError:
        data = response.text

    return response.status_code, data


async def inventory_reserve(sale_id: str, items: list[dict[str, Any]], token: str) -> dict[str, Any]:
    url = f"{settings.INVENTORY_SERVICE_URL.rstrip('/')}/api/v1/inventory/reserve"
    payload = {"sale_id": sale_id, "items": items}
    status_code, data = await call_json_api("POST", url, token=token, payload=payload, timeout=15.0)
    if status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise HTTPException(status_code=status_code, detail=detail or "Inventory reservation failed")
    return data if isinstance(data, dict) else {"data": data}


async def inventory_return_stock(batch_id: str, quantity: int, token: str) -> bool:
    url = f"{settings.INVENTORY_SERVICE_URL.rstrip('/')}/api/v1/inventory/stock/adjustments"
    payload = {
        "batch_id": batch_id,
        "reason": "sale_return",
        "note": "Stock returned from Sale Service",
        "quantity_delta": quantity,
    }
    status_code, _ = await call_json_api("POST", url, token=token, payload=payload, timeout=8.0)
    return status_code < 400


async def fetch_store_info(token: str | None = None) -> dict[str, Any]:
    url = f"{settings.STORE_SERVICE_URL.rstrip('/')}/api/v1/store/info"
    status_code, data = await call_json_api("GET", url, token=token, timeout=5.0)
    if status_code >= 400 or not isinstance(data, dict):
        return {}
    return data


async def fetch_store_settings_group(group: str, token: str | None = None) -> dict[str, Any]:
    url = f"{settings.STORE_SERVICE_URL.rstrip('/')}/api/v1/store/settings/group/{group.strip()}"
    status_code, data = await call_json_api("GET", url, token=token, timeout=5.0)
    if status_code >= 400 or not isinstance(data, dict):
        return {}
    return data


async def fetch_customer_by_id(customer_id: UUID, token: str) -> dict[str, Any] | None:
    url = f"{settings.CUSTOMER_SERVICE_URL.rstrip('/')}/api/v1/customer/customers/{customer_id}"
    status_code, data = await call_json_api("GET", url, token=token, timeout=8.0)
    if status_code == 404:
        return None
    if status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise HTTPException(status_code=status_code, detail=detail or "Cannot load customer")
    if not isinstance(data, dict):
        return None
    return data


async def fetch_customer_tier_discount_percent(customer_id: UUID, token: str) -> Decimal:
    url = f"{settings.CUSTOMER_SERVICE_URL.rstrip('/')}/api/v1/customer/customers/{customer_id}/stats"
    status_code, data = await call_json_api("GET", url, token=token, timeout=8.0)
    if status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise HTTPException(status_code=status_code, detail=detail or "Cannot load customer tier discount")
    if not isinstance(data, dict):
        return DECIMAL_ZERO

    discount = safe_decimal(data.get("tier_discount_percent"), DECIMAL_ZERO)
    if discount < DECIMAL_ZERO:
        return DECIMAL_ZERO
    return min(discount, Decimal("100.00"))


async def customer_internal_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = f"{settings.CUSTOMER_SERVICE_URL.rstrip('/')}/api/v1/customer/internal/{path.lstrip('/')}"
    status_code, data = await call_json_api(
        "POST",
        url,
        payload=payload,
        headers={"X-Internal-API-Key": settings.CUSTOMER_INTERNAL_API_KEY},
        timeout=12.0,
    )
    if status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise HTTPException(status_code=status_code, detail=detail or "Customer internal request failed")
    if isinstance(data, dict):
        return data
    return {"data": data}


async def customer_internal_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{settings.CUSTOMER_SERVICE_URL.rstrip('/')}/api/v1/customer/internal/{path.lstrip('/')}"
    headers = {"X-Internal-API-Key": settings.CUSTOMER_INTERNAL_API_KEY}
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(url, params=params, headers=headers)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Customer service unavailable: {exc}") from exc

    try:
        data = response.json()
    except ValueError:
        data = response.text

    if response.status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise HTTPException(status_code=response.status_code, detail=detail or "Customer internal request failed")
    if isinstance(data, dict):
        return data
    return {"data": data}


async def cleanup_expired_held_orders(db: AsyncSession) -> int:
    now = now_utc()
    rows = await db.scalars(
        select(HeldOrder).where(
            and_(
                HeldOrder.status == "active",
                HeldOrder.expires_at <= now,
            )
        )
    )
    items = list(rows.all())
    if not items:
        return 0

    for held_order in items:
        held_order.status = "expired"
    await db.commit()
    return len(items)


def invoice_status_filter(stmt: Select[Any], status_value: str | None) -> Select[Any]:
    if status_value is None or not status_value.strip():
        return stmt
    return stmt.where(Invoice.status == status_value.strip().lower())


def invoice_search_filter(stmt: Select[Any], search: str | None) -> Select[Any]:
    if search is None or not search.strip():
        return stmt
    pattern = f"%{search.strip()}%"
    return stmt.where(
        or_(
            Invoice.code.ilike(pattern),
            Invoice.customer_name.ilike(pattern),
            Invoice.customer_phone.ilike(pattern),
        )
    )


def clamp_return_quantity(requested: int, purchased: int, already_returned: int) -> int:
    available = max(0, purchased - already_returned)
    if requested > available:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Return quantity ({requested}) exceeds purchased quantity ({available})",
        )
    return requested


def proportion_points(points: int, amount_part: Decimal, amount_total: Decimal) -> int:
    if points <= 0:
        return 0
    if amount_total <= DECIMAL_ZERO:
        return 0
    ratio = (amount_part / amount_total) if amount_total > DECIMAL_ZERO else Decimal("0")
    value = Decimal(points) * ratio
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def build_print_datetime(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%d/%m/%Y %H:%M")


def safe_uuid(value: Any) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except ValueError:
        return None


def future_time(minutes: int) -> datetime:
    return now_utc() + timedelta(minutes=max(minutes, 1))
