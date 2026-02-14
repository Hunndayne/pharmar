from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select

from Source.customer import (
    ensure_unique_promotion_code,
    get_promotion_by_code_or_404,
    get_promotion_or_404,
    normalize_optional_string,
    paginate_scalars,
    search_filter,
)
from Source.db.models import Promotion, PromotionUsage
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.customer import (
    PageResponse,
    PromotionCreateRequest,
    PromotionResponse,
    PromotionUpdateRequest,
    PromotionUsageResponse,
)


router = APIRouter(prefix="/customer", tags=["customer-promotions"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]
OwnerOnly = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER))]


def _validate_promotion_dates(start_date: date, end_date: date) -> None:
    if end_date < start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")


def _validate_discount_value(discount_type: str, discount_value: Decimal) -> None:
    if discount_type == "percent" and discount_value > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="discount_value for percent discount must be <= 100",
        )


@router.get("/promotions", response_model=PageResponse[PromotionResponse])
async def list_promotions(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    auto_apply: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[PromotionResponse]:
    stmt = select(Promotion).order_by(Promotion.created_at.desc())
    stmt = search_filter(stmt, search, Promotion.code, Promotion.name)

    if is_active is not None:
        stmt = stmt.where(Promotion.is_active == is_active)
    if auto_apply is not None:
        stmt = stmt.where(Promotion.auto_apply == auto_apply)

    rows, total, current_page, current_size, pages = await paginate_scalars(db, stmt, page, size)
    return PageResponse[PromotionResponse](
        items=[PromotionResponse.model_validate(item) for item in rows],
        total=total,
        page=current_page,
        size=current_size,
        pages=pages,
    )


@router.get("/promotions/active", response_model=list[PromotionResponse])
async def list_active_promotions(_: AnyUser, db: DbSession) -> list[PromotionResponse]:
    today = date.today()
    rows = await db.scalars(
        select(Promotion)
        .where(
            and_(
                Promotion.is_active.is_(True),
                Promotion.start_date <= today,
                Promotion.end_date >= today,
            )
        )
        .order_by(Promotion.end_date.asc(), Promotion.created_at.desc())
    )
    return [PromotionResponse.model_validate(item) for item in rows.all()]


@router.get("/promotions/code/{code}", response_model=PromotionResponse)
async def get_promotion_by_code(code: str, _: AnyUser, db: DbSession) -> PromotionResponse:
    item = await get_promotion_by_code_or_404(code, db)
    return PromotionResponse.model_validate(item)


@router.get("/promotions/{promotion_id}", response_model=PromotionResponse)
async def get_promotion(promotion_id: UUID, _: AnyUser, db: DbSession) -> PromotionResponse:
    item = await get_promotion_or_404(promotion_id, db)
    return PromotionResponse.model_validate(item)


@router.post("/promotions", response_model=PromotionResponse, status_code=status.HTTP_201_CREATED)
async def create_promotion(
    payload: PromotionCreateRequest,
    current_user: ManagerOrOwner,
    db: DbSession,
) -> PromotionResponse:
    await ensure_unique_promotion_code(db, payload.code)
    _validate_promotion_dates(payload.start_date, payload.end_date)
    _validate_discount_value(payload.discount_type, payload.discount_value)

    item = Promotion(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        description=normalize_optional_string(payload.description),
        discount_type=payload.discount_type,
        discount_value=payload.discount_value,
        max_discount=payload.max_discount,
        min_order_amount=payload.min_order_amount,
        start_date=payload.start_date,
        end_date=payload.end_date,
        applicable_tiers=payload.applicable_tiers,
        applicable_products=payload.applicable_products,
        applicable_groups=payload.applicable_groups,
        usage_limit=payload.usage_limit,
        usage_per_customer=payload.usage_per_customer,
        is_active=payload.is_active,
        auto_apply=payload.auto_apply,
        created_by=current_user.sub,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return PromotionResponse.model_validate(item)


@router.put("/promotions/{promotion_id}", response_model=PromotionResponse)
async def update_promotion(
    promotion_id: UUID,
    payload: PromotionUpdateRequest,
    _: ManagerOrOwner,
    db: DbSession,
) -> PromotionResponse:
    item = await get_promotion_or_404(promotion_id, db)
    updates = payload.model_dump(exclude_unset=True)

    target_start_date = payload.start_date if "start_date" in updates and payload.start_date else item.start_date
    target_end_date = payload.end_date if "end_date" in updates and payload.end_date else item.end_date
    _validate_promotion_dates(target_start_date, target_end_date)

    target_discount_type = (
        payload.discount_type if "discount_type" in updates and payload.discount_type else item.discount_type
    )
    target_discount_value = (
        payload.discount_value if "discount_value" in updates and payload.discount_value is not None else item.discount_value
    )
    _validate_discount_value(target_discount_type, Decimal(target_discount_value))

    if "code" in updates and payload.code is not None:
        await ensure_unique_promotion_code(db, payload.code, exclude_id=item.id)
        item.code = payload.code.strip().upper()
    if "name" in updates and payload.name is not None:
        item.name = payload.name.strip()
    if "description" in updates:
        item.description = normalize_optional_string(payload.description)
    if "discount_type" in updates and payload.discount_type is not None:
        item.discount_type = payload.discount_type
    if "discount_value" in updates and payload.discount_value is not None:
        item.discount_value = payload.discount_value
    if "max_discount" in updates:
        item.max_discount = payload.max_discount
    if "min_order_amount" in updates:
        item.min_order_amount = payload.min_order_amount
    if "start_date" in updates and payload.start_date is not None:
        item.start_date = payload.start_date
    if "end_date" in updates and payload.end_date is not None:
        item.end_date = payload.end_date
    if "applicable_tiers" in updates:
        item.applicable_tiers = payload.applicable_tiers
    if "applicable_products" in updates:
        item.applicable_products = payload.applicable_products
    if "applicable_groups" in updates:
        item.applicable_groups = payload.applicable_groups
    if "usage_limit" in updates:
        item.usage_limit = payload.usage_limit
    if "usage_per_customer" in updates:
        item.usage_per_customer = payload.usage_per_customer
    if "is_active" in updates and payload.is_active is not None:
        item.is_active = payload.is_active
    if "auto_apply" in updates and payload.auto_apply is not None:
        item.auto_apply = payload.auto_apply

    await db.commit()
    await db.refresh(item)
    return PromotionResponse.model_validate(item)


@router.delete("/promotions/{promotion_id}")
async def delete_promotion(promotion_id: UUID, _: OwnerOnly, db: DbSession):
    item = await get_promotion_or_404(promotion_id, db)
    item.is_active = False
    await db.commit()
    return {"message": "Promotion deleted (soft delete)"}


@router.get("/promotions/{promotion_id}/usages", response_model=PageResponse[PromotionUsageResponse])
async def list_promotion_usages(
    promotion_id: UUID,
    _: ManagerOrOwner,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[PromotionUsageResponse]:
    await get_promotion_or_404(promotion_id, db)
    stmt = (
        select(PromotionUsage)
        .where(PromotionUsage.promotion_id == promotion_id)
        .order_by(PromotionUsage.created_at.desc())
    )
    rows, total, current_page, current_size, pages = await paginate_scalars(db, stmt, page, size)
    return PageResponse[PromotionUsageResponse](
        items=[PromotionUsageResponse.model_validate(item) for item in rows],
        total=total,
        page=current_page,
        size=current_size,
        pages=pages,
    )
