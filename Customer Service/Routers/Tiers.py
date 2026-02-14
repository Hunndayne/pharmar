from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select

from Source.customer import get_tier_or_404, list_tiers, normalize_optional_string
from Source.dependencies import (
    DbSession,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.customer import TierConfigResponse, TierConfigUpdateRequest


router = APIRouter(prefix="/customer", tags=["customer-tiers"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
OwnerOnly = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER))]


@router.get("/tiers", response_model=list[TierConfigResponse])
async def get_tiers(_: AnyUser, db: DbSession) -> list[TierConfigResponse]:
    rows = await list_tiers(db)
    return [TierConfigResponse.model_validate(item) for item in rows]


@router.get("/tiers/{tier_name}", response_model=TierConfigResponse)
async def get_tier(tier_name: str, _: AnyUser, db: DbSession) -> TierConfigResponse:
    item = await get_tier_or_404(tier_name, db)
    return TierConfigResponse.model_validate(item)


@router.put("/tiers/{tier_name}", response_model=TierConfigResponse)
async def update_tier(
    tier_name: str,
    payload: TierConfigUpdateRequest,
    _: OwnerOnly,
    db: DbSession,
) -> TierConfigResponse:
    tier = await get_tier_or_404(tier_name, db)
    updates = payload.model_dump(exclude_unset=True)

    if "min_points" in updates and payload.min_points is not None:
        tier.min_points = payload.min_points
    if "point_multiplier" in updates and payload.point_multiplier is not None:
        tier.point_multiplier = payload.point_multiplier
    if "discount_percent" in updates and payload.discount_percent is not None:
        tier.discount_percent = payload.discount_percent
    if "benefits" in updates:
        tier.benefits = normalize_optional_string(payload.benefits)
    if "display_order" in updates and payload.display_order is not None:
        tier.display_order = payload.display_order

    await db.commit()
    await db.refresh(tier)
    return TierConfigResponse.model_validate(tier)
