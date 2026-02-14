from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from Source.customer import (
    apply_points_change,
    ensure_unique_customer_phone,
    generate_next_code,
    get_customer_or_404,
    get_tier_discount_percent,
    now_utc,
    paginate_scalars,
    search_filter,
)
from Source.db.models import Customer, PointTransaction
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.customer import (
    CustomerCreateRequest,
    CustomerResponse,
    CustomerStatsResponse,
    CustomerUpdateRequest,
    PageResponse,
    PointAdjustRequest,
    PointTransactionResponse,
)


router = APIRouter(prefix="/customer", tags=["customer-customers"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


def to_point_transaction_response(item: PointTransaction) -> PointTransactionResponse:
    return PointTransactionResponse(
        id=item.id,
        customer_id=item.customer_id,
        type=item.transaction_type,
        points=item.points,
        balance_after=item.balance_after,
        reference_type=item.reference_type,
        reference_id=item.reference_id,
        reference_code=item.reference_code,
        note=item.note,
        created_by=item.created_by,
        created_at=item.created_at,
    )


@router.get("/customers", response_model=PageResponse[CustomerResponse])
async def list_customers(
    _: AnyUser,
    db: DbSession,
    search: str | None = Query(default=None),
    tier: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[CustomerResponse]:
    stmt = select(Customer).order_by(Customer.created_at.desc())
    stmt = search_filter(stmt, search, Customer.code, Customer.name, Customer.phone)

    if tier is not None and tier.strip():
        stmt = stmt.where(Customer.tier == tier.strip().lower())
    if is_active is not None:
        stmt = stmt.where(Customer.is_active == is_active)

    rows, total, current_page, current_size, pages = await paginate_scalars(db, stmt, page, size)
    return PageResponse[CustomerResponse](
        items=[CustomerResponse.model_validate(item) for item in rows],
        total=total,
        page=current_page,
        size=current_size,
        pages=pages,
    )


@router.get("/customers/phone/{phone}", response_model=CustomerResponse)
async def get_customer_by_phone(phone: str, _: AnyUser, db: DbSession) -> CustomerResponse:
    normalized_phone = phone.strip()
    item = await db.scalar(select(Customer).where(Customer.phone == normalized_phone))
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return CustomerResponse.model_validate(item)


@router.get("/customers/{customer_id}", response_model=CustomerResponse)
async def get_customer(customer_id: UUID, _: AnyUser, db: DbSession) -> CustomerResponse:
    item = await get_customer_or_404(customer_id, db)
    return CustomerResponse.model_validate(item)


@router.post("/customers", response_model=CustomerResponse, status_code=status.HTTP_201_CREATED)
async def create_customer(payload: CustomerCreateRequest, _: AnyUser, db: DbSession) -> CustomerResponse:
    await ensure_unique_customer_phone(db, payload.phone)
    code = await generate_next_code(db, Customer, "KH")

    customer = Customer(
        code=code,
        name=payload.name.strip(),
        phone=payload.phone.strip(),
        email=str(payload.email).strip().lower() if payload.email else None,
        date_of_birth=payload.date_of_birth,
        gender=payload.gender,
        address=payload.address.strip() if payload.address else None,
        tier="bronze",
        tier_updated_at=now_utc(),
        is_active=payload.is_active,
        note=payload.note.strip() if payload.note else None,
    )
    db.add(customer)
    await db.commit()
    await db.refresh(customer)
    return CustomerResponse.model_validate(customer)


@router.put("/customers/{customer_id}", response_model=CustomerResponse)
async def update_customer(
    customer_id: UUID,
    payload: CustomerUpdateRequest,
    _: AnyUser,
    db: DbSession,
) -> CustomerResponse:
    customer = await get_customer_or_404(customer_id, db)
    updates = payload.model_dump(exclude_unset=True)

    if "phone" in updates and payload.phone is not None:
        await ensure_unique_customer_phone(db, payload.phone, exclude_id=customer.id)
        customer.phone = payload.phone.strip()
    if "name" in updates and payload.name is not None:
        customer.name = payload.name.strip()
    if "email" in updates:
        customer.email = str(payload.email).strip().lower() if payload.email else None
    if "date_of_birth" in updates:
        customer.date_of_birth = payload.date_of_birth
    if "gender" in updates:
        customer.gender = payload.gender
    if "address" in updates:
        customer.address = payload.address.strip() if payload.address else None
    if "note" in updates:
        customer.note = payload.note.strip() if payload.note else None
    if "is_active" in updates and payload.is_active is not None:
        customer.is_active = payload.is_active

    await db.commit()
    await db.refresh(customer)
    return CustomerResponse.model_validate(customer)


@router.delete("/customers/{customer_id}")
async def delete_customer(customer_id: UUID, _: ManagerOrOwner, db: DbSession):
    customer = await get_customer_or_404(customer_id, db)
    customer.is_active = False
    await db.commit()
    return {"message": "Customer deleted (soft delete)"}


@router.get("/customers/{customer_id}/points", response_model=PageResponse[PointTransactionResponse])
async def list_customer_points(
    customer_id: UUID,
    _: AnyUser,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[PointTransactionResponse]:
    await get_customer_or_404(customer_id, db)
    stmt = (
        select(PointTransaction)
        .where(PointTransaction.customer_id == customer_id)
        .order_by(PointTransaction.created_at.desc())
    )
    rows, total, current_page, current_size, pages = await paginate_scalars(db, stmt, page, size)
    return PageResponse[PointTransactionResponse](
        items=[to_point_transaction_response(item) for item in rows],
        total=total,
        page=current_page,
        size=current_size,
        pages=pages,
    )


@router.post("/customers/{customer_id}/points/adjust")
async def adjust_customer_points(
    customer_id: UUID,
    payload: PointAdjustRequest,
    current_user: ManagerOrOwner,
    db: DbSession,
):
    customer = await get_customer_or_404(customer_id, db)
    new_balance, tier_changed, new_tier = await apply_points_change(
        db=db,
        customer=customer,
        points_delta=payload.points,
        transaction_type="adjust",
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        reference_code=payload.reference_code,
        note=payload.note,
        created_by=current_user.sub,
        increase_total_earned=payload.points > 0,
        increase_total_used=payload.points < 0,
    )
    await db.commit()
    await db.refresh(customer)

    return {
        "message": "Points adjusted",
        "customer_id": str(customer.id),
        "adjusted_points": payload.points,
        "new_balance": new_balance,
        "tier_changed": tier_changed,
        "new_tier": new_tier,
    }


@router.get("/customers/{customer_id}/stats", response_model=CustomerStatsResponse)
async def get_customer_stats(customer_id: UUID, _: AnyUser, db: DbSession) -> CustomerStatsResponse:
    customer = await get_customer_or_404(customer_id, db)
    tier_discount_percent = await get_tier_discount_percent(customer.tier, db)
    return CustomerStatsResponse(
        customer_id=customer.id,
        customer_code=customer.code,
        customer_name=customer.name,
        tier=customer.tier,
        tier_discount_percent=Decimal(tier_discount_percent),
        total_orders=customer.total_orders,
        total_spent=customer.total_spent,
        last_purchase_at=customer.last_purchase_at,
        current_points=customer.current_points,
        total_points_earned=customer.total_points_earned,
        total_points_used=customer.total_points_used,
        points_expire_at=customer.points_expire_at,
    )
