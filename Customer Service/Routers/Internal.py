from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, select

from Source.customer import (
    apply_points_change,
    calculate_points,
    fetch_customer_settings,
    get_customer_or_404,
    now_utc,
    promotion_summary,
    resolve_points_rollback,
    rollback_promotion_usage,
    setting_decimal,
    validate_promotion_business_rules,
    validate_promotion_by_code,
)
from Source.db.models import Customer, Promotion, PromotionUsage, TierConfig
from Source.dependencies import DbSession, require_internal_api_key
from Source.schemas.customer import (
    CustomerLookupRequest,
    CustomerLookupResponse,
    PointsCalculateRequest,
    PointsCalculateResponse,
    PointsEarnRequest,
    PointsEarnResponse,
    PointsRedeemRequest,
    PointsRedeemResponse,
    PointsRollbackRequest,
    PointsRollbackResponse,
    PromotionApplyRequest,
    PromotionApplyResponse,
    PromotionRollbackRequest,
    PromotionRollbackResponse,
    PromotionSuggestResponse,
    PromotionSuggestionItem,
    PromotionValidateRequest,
    PromotionValidateResponse,
    StatsUpdateRequest,
    StatsUpdateResponse,
)


router = APIRouter(
    prefix="/customer/internal",
    tags=["customer-internal"],
    dependencies=[Depends(require_internal_api_key)],
)


@router.post("/customers/lookup", response_model=CustomerLookupResponse)
async def customer_lookup(payload: CustomerLookupRequest, db: DbSession) -> CustomerLookupResponse:
    customer = await db.scalar(select(Customer).where(Customer.phone == payload.phone.strip()))
    if customer is None:
        return CustomerLookupResponse(found=False, customer=None)

    tier_discount_percent = Decimal("0")
    tier = await db.get(TierConfig, customer.tier)
    if tier is not None:
        tier_discount_percent = Decimal(tier.discount_percent)

    return CustomerLookupResponse(
        found=True,
        customer={
            "id": str(customer.id),
            "code": customer.code,
            "name": customer.name,
            "phone": customer.phone,
            "tier": customer.tier,
            "current_points": customer.current_points,
            "tier_discount_percent": tier_discount_percent,
        },
    )


@router.post("/points/calculate", response_model=PointsCalculateResponse)
async def calculate_customer_points(payload: PointsCalculateRequest, db: DbSession) -> PointsCalculateResponse:
    customer = await get_customer_or_404(payload.customer_id, db)
    base_points, multiplier, points_earned = await calculate_points(db, customer, payload.order_amount)
    return PointsCalculateResponse(
        base_points=base_points,
        tier_multiplier=multiplier,
        points_earned=points_earned,
    )


@router.post("/points/earn", response_model=PointsEarnResponse)
async def earn_points(payload: PointsEarnRequest, db: DbSession) -> PointsEarnResponse:
    customer = await get_customer_or_404(payload.customer_id, db)
    new_balance, tier_changed, new_tier = await apply_points_change(
        db=db,
        customer=customer,
        points_delta=payload.points,
        transaction_type="earn",
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        reference_code=payload.reference_code,
        note=payload.note,
        created_by="internal",
        increase_total_earned=True,
        increase_total_used=False,
    )
    await db.commit()
    return PointsEarnResponse(
        success=True,
        points_earned=payload.points,
        new_balance=new_balance,
        tier_changed=tier_changed,
        new_tier=new_tier,
    )


@router.post("/points/redeem", response_model=PointsRedeemResponse)
async def redeem_points(payload: PointsRedeemRequest, db: DbSession) -> PointsRedeemResponse:
    customer = await get_customer_or_404(payload.customer_id, db)
    if payload.points > customer.current_points:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Insufficient points")

    settings_map = await fetch_customer_settings()
    point_value = setting_decimal(settings_map, "customer.point_value", Decimal("1000"))
    discount_amount = (Decimal(payload.points) * point_value).quantize(Decimal("0.01"))

    new_balance, _, _ = await apply_points_change(
        db=db,
        customer=customer,
        points_delta=-payload.points,
        transaction_type="redeem",
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        reference_code=payload.reference_code,
        note=payload.note,
        created_by="internal",
        increase_total_earned=False,
        increase_total_used=True,
    )
    await db.commit()

    return PointsRedeemResponse(
        success=True,
        points_used=payload.points,
        discount_amount=discount_amount,
        new_balance=new_balance,
    )


@router.post("/points/rollback", response_model=PointsRollbackResponse)
async def rollback_points(payload: PointsRollbackRequest, db: DbSession) -> PointsRollbackResponse:
    customer = await get_customer_or_404(payload.customer_id, db)
    mode, requested_points, _, _ = await resolve_points_rollback(
        db=db,
        customer_id=payload.customer_id,
        points=payload.points,
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        reference_code=payload.reference_code,
        note=payload.note,
    )

    if mode == "reverse_earn":
        points_delta = -requested_points
        total_earned_delta = -requested_points
        total_used_delta = 0
    else:
        points_delta = requested_points
        total_earned_delta = 0
        total_used_delta = -requested_points

    new_balance, _, _ = await apply_points_change(
        db=db,
        customer=customer,
        points_delta=points_delta,
        transaction_type="rollback",
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        reference_code=payload.reference_code,
        note=payload.note,
        created_by="internal",
        total_earned_delta=total_earned_delta,
        total_used_delta=total_used_delta,
    )
    await db.commit()

    return PointsRollbackResponse(
        success=True,
        rollback_mode=mode,
        points_rolled_back=requested_points,
        new_balance=new_balance,
    )


@router.post("/promotions/validate", response_model=PromotionValidateResponse)
async def validate_promotion(payload: PromotionValidateRequest, db: DbSession) -> PromotionValidateResponse:
    valid, reason, promotion, discount = await validate_promotion_by_code(
        db=db,
        promotion_code=payload.promotion_code,
        customer_id=payload.customer_id,
        order_amount=payload.order_amount,
        product_ids=payload.product_ids,
        group_ids=payload.group_ids,
    )
    if not valid or promotion is None:
        return PromotionValidateResponse(valid=False, reason=reason)

    return PromotionValidateResponse(
        valid=True,
        promotion=promotion_summary(promotion),
        calculated_discount=discount,
        reason=None,
    )


@router.post("/promotions/apply", response_model=PromotionApplyResponse)
async def apply_promotion(payload: PromotionApplyRequest, db: DbSession) -> PromotionApplyResponse:
    valid, reason, promotion, discount = await validate_promotion_by_code(
        db=db,
        promotion_code=payload.promotion_code,
        customer_id=payload.customer_id,
        order_amount=payload.order_amount,
        product_ids=payload.product_ids,
        group_ids=payload.group_ids,
    )
    if not valid or promotion is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=reason or "Promotion is invalid")

    usage = PromotionUsage(
        promotion_id=promotion.id,
        customer_id=payload.customer_id,
        invoice_id=payload.invoice_id,
        invoice_code=payload.invoice_code,
        discount_amount=discount,
    )
    db.add(usage)
    promotion.current_usage += 1
    await db.commit()
    await db.refresh(promotion)

    return PromotionApplyResponse(
        success=True,
        usage_id=usage.id,
        promotion_id=promotion.id,
        promotion_code=promotion.code,
        discount_amount=discount,
        current_usage=promotion.current_usage,
    )


@router.post("/promotions/rollback", response_model=PromotionRollbackResponse)
async def rollback_promotion(payload: PromotionRollbackRequest, db: DbSession) -> PromotionRollbackResponse:
    new_usage_count = await rollback_promotion_usage(
        db=db,
        promotion_id=payload.promotion_id,
        usage_id=payload.usage_id,
        reason=payload.reason,
    )
    await db.commit()
    return PromotionRollbackResponse(
        success=True,
        promotion_id=payload.promotion_id,
        new_usage_count=new_usage_count,
    )


@router.get("/promotions/suggest", response_model=PromotionSuggestResponse)
async def suggest_promotions(
    db: DbSession,
    customer_id: UUID | None = Query(default=None),
    order_amount: Decimal = Query(default=Decimal("0"), ge=0),
    product_ids: list[UUID] | None = Query(default=None),
    group_ids: list[UUID] | None = Query(default=None),
) -> PromotionSuggestResponse:
    today = date.today()
    rows = await db.scalars(
        select(Promotion).where(
            and_(
                Promotion.is_active.is_(True),
                Promotion.start_date <= today,
                Promotion.end_date >= today,
            )
        )
    )
    promotions = list(rows.all())

    suggestions: list[PromotionSuggestionItem] = []
    for promotion in promotions:
        valid, _, discount = await validate_promotion_business_rules(
            db=db,
            promotion=promotion,
            customer_id=customer_id,
            order_amount=order_amount,
            product_ids=product_ids,
            group_ids=group_ids,
        )
        if not valid:
            continue
        suggestions.append(
            PromotionSuggestionItem(
                promotion=promotion_summary(promotion),
                discount_amount=discount,
                auto_apply=promotion.auto_apply,
            )
        )

    suggestions.sort(key=lambda item: item.discount_amount, reverse=True)

    best_auto_apply = None
    for item in suggestions:
        if item.auto_apply:
            best_auto_apply = {
                "promotion_id": item.promotion["id"],
                "discount_amount": item.discount_amount,
            }
            break

    return PromotionSuggestResponse(
        suggestions=suggestions,
        best_auto_apply=best_auto_apply,
    )


@router.post("/stats/update", response_model=StatsUpdateResponse)
async def update_customer_stats(payload: StatsUpdateRequest, db: DbSession) -> StatsUpdateResponse:
    customer = await get_customer_or_404(payload.customer_id, db)
    customer.total_orders += 1
    customer.total_spent = Decimal(customer.total_spent) + payload.order_amount
    customer.last_purchase_at = payload.purchased_at or now_utc()
    await db.commit()
    await db.refresh(customer)

    return StatsUpdateResponse(
        success=True,
        total_orders=customer.total_orders,
        total_spent=customer.total_spent,
        last_purchase_at=customer.last_purchase_at,
    )
