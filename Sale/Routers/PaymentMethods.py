from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from Source.db.models import PaymentMethod
from Source.dependencies import ROLE_OWNER, DbSession, TokenUser, get_current_user, require_roles
from Source.schemas.sale import PaymentMethodCreateRequest, PaymentMethodResponse, PaymentMethodUpdateRequest


router = APIRouter(prefix="/sale", tags=["sale-payment-methods"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
OwnerOnly = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER))]


@router.get("/payment-methods", response_model=list[PaymentMethodResponse])
async def list_payment_methods(_: AnyUser, db: DbSession) -> list[PaymentMethodResponse]:
    rows = await db.scalars(select(PaymentMethod).order_by(PaymentMethod.display_order.asc(), PaymentMethod.code.asc()))
    return [PaymentMethodResponse.model_validate(item) for item in rows.all()]


@router.post("/payment-methods", response_model=PaymentMethodResponse, status_code=status.HTTP_201_CREATED)
async def create_payment_method(payload: PaymentMethodCreateRequest, _: OwnerOnly, db: DbSession) -> PaymentMethodResponse:
    code = payload.code.strip().lower()
    exists = await db.get(PaymentMethod, code)
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Payment method '{code}' already exists")

    item = PaymentMethod(
        code=code,
        name=payload.name.strip(),
        is_active=payload.is_active,
        display_order=payload.display_order,
        requires_reference=payload.requires_reference,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return PaymentMethodResponse.model_validate(item)


@router.put("/payment-methods/{code}", response_model=PaymentMethodResponse)
async def update_payment_method(
    code: str,
    payload: PaymentMethodUpdateRequest,
    _: OwnerOnly,
    db: DbSession,
) -> PaymentMethodResponse:
    item = await db.get(PaymentMethod, code.strip().lower())
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment method not found")

    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and payload.name is not None:
        item.name = payload.name.strip()
    if "is_active" in updates and payload.is_active is not None:
        item.is_active = payload.is_active
    if "display_order" in updates and payload.display_order is not None:
        item.display_order = payload.display_order
    if "requires_reference" in updates and payload.requires_reference is not None:
        item.requires_reference = payload.requires_reference

    await db.commit()
    await db.refresh(item)
    return PaymentMethodResponse.model_validate(item)


@router.delete("/payment-methods/{code}")
async def delete_payment_method(code: str, _: OwnerOnly, db: DbSession):
    item = await db.get(PaymentMethod, code.strip().lower())
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment method not found")

    await db.delete(item)
    await db.commit()
    return {"message": "Payment method deleted"}
