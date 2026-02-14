from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from math import ceil
from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .core.config import get_settings
from .db.models import Customer, PointTransaction, Promotion, PromotionUsage, TierConfig


settings = get_settings()

DEFAULT_CUSTOMER_SETTINGS: dict[str, Any] = {
    "customer.points_per_amount": 1000,
    "customer.point_value": 1000,
    "customer.points_expiry_months": 12,
}

DEFAULT_TIERS: list[dict[str, Any]] = [
    {
        "tier_name": "bronze",
        "min_points": 0,
        "point_multiplier": Decimal("1.00"),
        "discount_percent": Decimal("0.00"),
        "benefits": "Basic tier",
        "display_order": 1,
    },
    {
        "tier_name": "silver",
        "min_points": 1000,
        "point_multiplier": Decimal("1.20"),
        "discount_percent": Decimal("2.00"),
        "benefits": "Point x1.2 and 2% discount",
        "display_order": 2,
    },
    {
        "tier_name": "gold",
        "min_points": 5000,
        "point_multiplier": Decimal("1.50"),
        "discount_percent": Decimal("5.00"),
        "benefits": "Point x1.5 and 5% discount",
        "display_order": 3,
    },
    {
        "tier_name": "diamond",
        "min_points": 20000,
        "point_multiplier": Decimal("2.00"),
        "discount_percent": Decimal("10.00"),
        "benefits": "Point x2 and 10% discount",
        "display_order": 4,
    },
]


def normalize_optional_string(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def normalize_phone(value: str) -> str:
    return value.strip()


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
) -> tuple[list[Any], int, int, int, int]:
    safe_page, safe_size = normalize_page_size(page, size)
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int((await db.scalar(count_stmt)) or 0)

    offset = (safe_page - 1) * safe_size
    rows = list((await db.scalars(stmt.offset(offset).limit(safe_size))).all())
    _, _, pages = build_pagination(total, safe_page, safe_size)
    return rows, total, safe_page, safe_size, pages


def search_filter(statement: Select[Any], query_text: str | None, *columns: Any) -> Select[Any]:
    if query_text is None or not query_text.strip():
        return statement
    pattern = f"%{query_text.strip()}%"
    return statement.where(or_(*[column.ilike(pattern) for column in columns]))


async def generate_next_code(
    db: AsyncSession,
    model: Any,
    prefix: str,
    width: int = 4,
) -> str:
    prefix_normalized = prefix.strip().upper()
    code_column = getattr(model, "code")
    codes = await db.scalars(select(code_column).where(code_column.like(f"{prefix_normalized}%")))

    max_value = 0
    for code in codes:
        if code is None:
            continue
        suffix = str(code)[len(prefix_normalized) :]
        if suffix.isdigit():
            max_value = max(max_value, int(suffix))

    return f"{prefix_normalized}{max_value + 1:0{width}d}"


async def get_customer_or_404(customer_id: UUID, db: AsyncSession) -> Customer:
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return customer


async def get_tier_or_404(tier_name: str, db: AsyncSession) -> TierConfig:
    tier = await db.get(TierConfig, tier_name.strip().lower())
    if tier is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tier not found")
    return tier


async def get_promotion_or_404(promotion_id: UUID, db: AsyncSession) -> Promotion:
    promotion = await db.get(Promotion, promotion_id)
    if promotion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promotion not found")
    return promotion


async def get_promotion_by_code_or_404(code: str, db: AsyncSession) -> Promotion:
    promotion = await db.scalar(
        select(Promotion).where(func.upper(Promotion.code) == code.strip().upper())
    )
    if promotion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promotion not found")
    return promotion


async def ensure_unique_customer_phone(
    db: AsyncSession,
    phone: str,
    exclude_id: UUID | None = None,
) -> None:
    normalized_phone = normalize_phone(phone)
    stmt = select(Customer.id).where(Customer.phone == normalized_phone)
    if exclude_id is not None:
        stmt = stmt.where(Customer.id != exclude_id)
    exists = await db.scalar(stmt)
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Phone already exists")


async def ensure_unique_promotion_code(
    db: AsyncSession,
    code: str,
    exclude_id: UUID | None = None,
) -> None:
    stmt = select(Promotion.id).where(func.upper(Promotion.code) == code.strip().upper())
    if exclude_id is not None:
        stmt = stmt.where(Promotion.id != exclude_id)
    exists = await db.scalar(stmt)
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Promotion code '{code}' already exists")


def parse_decimal(value: Any, default: Decimal) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return default
    return default


def decimal_to_int_floor(value: Decimal) -> int:
    if value <= 0:
        return 0
    return int(value.quantize(Decimal("1"), rounding=ROUND_DOWN))


def add_months(input_date: date, months: int) -> date:
    if months <= 0:
        return input_date
    month = input_date.month - 1 + months
    year = input_date.year + month // 12
    month = month % 12 + 1
    day = min(input_date.day, monthrange(year, month)[1])
    return date(year, month, day)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def fetch_customer_settings() -> dict[str, Any]:
    base_url = settings.STORE_SERVICE_URL.strip()
    if not base_url:
        return dict(DEFAULT_CUSTOMER_SETTINGS)

    target_url = f"{base_url.rstrip('/')}/api/v1/store/settings/group/customer"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(target_url)
        if response.status_code >= 400:
            return dict(DEFAULT_CUSTOMER_SETTINGS)
        payload = response.json()
        if not isinstance(payload, dict):
            return dict(DEFAULT_CUSTOMER_SETTINGS)
    except (httpx.RequestError, ValueError):
        return dict(DEFAULT_CUSTOMER_SETTINGS)

    merged = dict(DEFAULT_CUSTOMER_SETTINGS)
    merged.update(payload)
    return merged


def setting_int(settings_map: dict[str, Any], key: str, default: int) -> int:
    value = settings_map.get(key, default)
    parsed = parse_decimal(value, Decimal(default))
    if parsed < 0:
        return default
    return int(parsed)


def setting_decimal(settings_map: dict[str, Any], key: str, default: Decimal) -> Decimal:
    value = settings_map.get(key, default)
    parsed = parse_decimal(value, default)
    if parsed < 0:
        return default
    return parsed


async def list_tiers(db: AsyncSession) -> list[TierConfig]:
    rows = await db.scalars(
        select(TierConfig).order_by(TierConfig.display_order.asc(), TierConfig.min_points.asc())
    )
    return list(rows.all())


async def find_tier_for_points(total_points_earned: int, db: AsyncSession) -> TierConfig:
    rows = await db.scalars(select(TierConfig).order_by(TierConfig.min_points.desc()))
    tiers = list(rows.all())
    if not tiers:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Tier configuration missing")

    for tier in tiers:
        if total_points_earned >= tier.min_points:
            return tier
    return tiers[-1]


async def maybe_update_customer_tier(customer: Customer, db: AsyncSession) -> tuple[bool, str]:
    tier = await find_tier_for_points(customer.total_points_earned, db)
    target_tier_name = tier.tier_name.strip().lower()
    current_tier_name = customer.tier.strip().lower()
    if current_tier_name == target_tier_name:
        return False, current_tier_name

    customer.tier = target_tier_name
    customer.tier_updated_at = now_utc()
    return True, target_tier_name


async def get_tier_multiplier(tier_name: str, db: AsyncSession) -> Decimal:
    tier = await db.get(TierConfig, tier_name.strip().lower())
    if tier is None:
        return Decimal("1.00")
    return parse_decimal(tier.point_multiplier, Decimal("1.00"))


async def get_tier_discount_percent(tier_name: str, db: AsyncSession) -> Decimal:
    tier = await db.get(TierConfig, tier_name.strip().lower())
    if tier is None:
        return Decimal("0.00")
    return parse_decimal(tier.discount_percent, Decimal("0.00"))


def build_point_transaction(
    customer_id: UUID,
    transaction_type: str,
    points: int,
    balance_after: int,
    reference_type: str | None = None,
    reference_id: UUID | None = None,
    reference_code: str | None = None,
    note: str | None = None,
    created_by: str | None = None,
) -> PointTransaction:
    return PointTransaction(
        customer_id=customer_id,
        transaction_type=transaction_type,
        points=points,
        balance_after=balance_after,
        reference_type=normalize_optional_string(reference_type),
        reference_id=reference_id,
        reference_code=normalize_optional_string(reference_code),
        note=normalize_optional_string(note),
        created_by=normalize_optional_string(created_by),
    )


async def apply_points_change(
    db: AsyncSession,
    customer: Customer,
    points_delta: int,
    transaction_type: str,
    reference_type: str | None = None,
    reference_id: UUID | None = None,
    reference_code: str | None = None,
    note: str | None = None,
    created_by: str | None = None,
    increase_total_earned: bool = False,
    increase_total_used: bool = False,
) -> tuple[int, bool, str]:
    if points_delta == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="points_delta cannot be zero")

    next_balance = customer.current_points + points_delta
    if next_balance < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Insufficient points")

    customer.current_points = next_balance

    if increase_total_earned and points_delta > 0:
        customer.total_points_earned += points_delta
    if increase_total_used and points_delta < 0:
        customer.total_points_used += abs(points_delta)

    settings_map = await fetch_customer_settings()
    expiry_months = setting_int(settings_map, "customer.points_expiry_months", 12)
    if points_delta > 0 and expiry_months > 0:
        customer.points_expire_at = add_months(date.today(), expiry_months)
    if customer.current_points <= 0:
        customer.points_expire_at = None

    tier_changed, new_tier = await maybe_update_customer_tier(customer, db)

    transaction = build_point_transaction(
        customer_id=customer.id,
        transaction_type=transaction_type,
        points=points_delta,
        balance_after=customer.current_points,
        reference_type=reference_type,
        reference_id=reference_id,
        reference_code=reference_code,
        note=note,
        created_by=created_by,
    )
    db.add(transaction)

    return customer.current_points, tier_changed, new_tier


async def calculate_points(
    db: AsyncSession,
    customer: Customer,
    order_amount: Decimal,
) -> tuple[int, Decimal, int]:
    settings_map = await fetch_customer_settings()
    points_per_amount = setting_decimal(settings_map, "customer.points_per_amount", Decimal("1000"))
    if points_per_amount <= 0:
        points_per_amount = Decimal("1000")

    base_points_decimal = (order_amount / points_per_amount).quantize(Decimal("1"), rounding=ROUND_DOWN)
    base_points = int(base_points_decimal) if base_points_decimal > 0 else 0
    multiplier = await get_tier_multiplier(customer.tier, db)
    earned_points = decimal_to_int_floor(Decimal(base_points) * multiplier)
    return base_points, multiplier, earned_points


def promotion_summary(promotion: Promotion) -> dict[str, Any]:
    return {
        "id": str(promotion.id),
        "code": promotion.code,
        "name": promotion.name,
        "discount_type": promotion.discount_type,
        "discount_value": str(promotion.discount_value),
        "max_discount": str(promotion.max_discount) if promotion.max_discount is not None else None,
    }


def calculate_promotion_discount(promotion: Promotion, order_amount: Decimal) -> Decimal:
    order_amount = max(order_amount, Decimal("0"))
    if promotion.discount_type == "percent":
        discount = (order_amount * Decimal(promotion.discount_value) / Decimal("100")).quantize(
            Decimal("0.01"),
            rounding=ROUND_DOWN,
        )
        if promotion.max_discount is not None:
            discount = min(discount, Decimal(promotion.max_discount))
    else:
        discount = Decimal(promotion.discount_value)
    if discount < 0:
        return Decimal("0.00")
    return min(discount, order_amount).quantize(Decimal("0.01"), rounding=ROUND_DOWN)


async def validate_promotion_business_rules(
    db: AsyncSession,
    promotion: Promotion,
    customer_id: UUID | None,
    order_amount: Decimal,
    product_ids: list[UUID] | None,
    group_ids: list[UUID] | None,
) -> tuple[bool, str | None, Decimal]:
    today = date.today()
    if not promotion.is_active:
        return False, "Promotion is inactive", Decimal("0.00")
    if promotion.start_date > today:
        return False, "Promotion not started", Decimal("0.00")
    if promotion.end_date < today:
        return False, "Promotion expired", Decimal("0.00")
    if promotion.usage_limit is not None and promotion.current_usage >= promotion.usage_limit:
        return False, "Promotion usage limit reached", Decimal("0.00")

    customer = None
    if customer_id is not None:
        customer = await db.get(Customer, customer_id)
        if customer is None:
            return False, "Customer not found", Decimal("0.00")

    if promotion.usage_per_customer is not None and customer_id is not None:
        used_count = await db.scalar(
            select(func.count(PromotionUsage.id)).where(
                and_(
                    PromotionUsage.promotion_id == promotion.id,
                    PromotionUsage.customer_id == customer_id,
                )
            )
        )
        if int(used_count or 0) >= promotion.usage_per_customer:
            return False, "Usage limit per customer reached", Decimal("0.00")

    if promotion.applicable_tiers:
        if customer is None:
            return False, "Customer is required for this promotion", Decimal("0.00")
        tiers = {item.lower() for item in promotion.applicable_tiers if item}
        if customer.tier.lower() not in tiers:
            return False, "Customer tier is not eligible", Decimal("0.00")

    if promotion.min_order_amount is not None and order_amount < Decimal(promotion.min_order_amount):
        return False, "Order amount does not meet minimum requirement", Decimal("0.00")

    if promotion.applicable_products:
        request_product_ids = {item for item in (product_ids or [])}
        promo_product_ids = {item for item in promotion.applicable_products}
        if request_product_ids.isdisjoint(promo_product_ids):
            return False, "Promotion does not apply to selected products", Decimal("0.00")

    if promotion.applicable_groups:
        request_group_ids = {item for item in (group_ids or [])}
        promo_group_ids = {item for item in promotion.applicable_groups}
        if request_group_ids.isdisjoint(promo_group_ids):
            return False, "Promotion does not apply to selected groups", Decimal("0.00")

    discount = calculate_promotion_discount(promotion, order_amount)
    return True, None, discount


async def validate_promotion_by_code(
    db: AsyncSession,
    promotion_code: str,
    customer_id: UUID | None,
    order_amount: Decimal,
    product_ids: list[UUID] | None,
    group_ids: list[UUID] | None,
) -> tuple[bool, str | None, Promotion | None, Decimal]:
    promotion = await db.scalar(
        select(Promotion).where(func.upper(Promotion.code) == promotion_code.strip().upper())
    )
    if promotion is None:
        return False, "Promotion not found", None, Decimal("0.00")

    valid, reason, discount = await validate_promotion_business_rules(
        db,
        promotion,
        customer_id,
        order_amount,
        product_ids,
        group_ids,
    )
    return valid, reason, promotion, discount


async def expire_due_points(db: AsyncSession) -> int:
    today = date.today()
    rows = await db.scalars(
        select(Customer).where(
            and_(
                Customer.current_points > 0,
                Customer.points_expire_at.is_not(None),
                Customer.points_expire_at <= today,
            )
        )
    )
    customers = list(rows.all())
    if not customers:
        return 0

    for customer in customers:
        expired_points = customer.current_points
        customer.current_points = 0
        customer.points_expire_at = None
        db.add(
            build_point_transaction(
                customer_id=customer.id,
                transaction_type="expire",
                points=-expired_points,
                balance_after=0,
                reference_type="expiry",
                reference_id=None,
                reference_code=None,
                note="Points expired",
                created_by="system",
            )
        )

    await db.commit()
    return len(customers)


async def ensure_default_tiers(db: AsyncSession) -> None:
    for item in DEFAULT_TIERS:
        tier_name = item["tier_name"]
        existing = await db.get(TierConfig, tier_name)
        if existing is None:
            db.add(
                TierConfig(
                    tier_name=tier_name,
                    min_points=item["min_points"],
                    point_multiplier=item["point_multiplier"],
                    discount_percent=item["discount_percent"],
                    benefits=item["benefits"],
                    display_order=item["display_order"],
                )
            )
    await db.commit()
