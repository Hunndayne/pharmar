from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select

from Source.core.config import get_settings
from Source.db.models import HeldOrder
from Source.dependencies import DbSession, TokenUser, get_current_user, oauth2_scheme
from Source.sale import (
    cleanup_expired_held_orders,
    future_time,
    generate_next_sequence_code,
    get_held_order_or_404,
    now_utc,
    paginate_scalars,
    quantize_money,
)
from Source.schemas.sale import (
    HeldOrderCreateRequest,
    HeldOrderResponse,
    HeldOrderResumeRequest,
    HeldOrderUpdateRequest,
    InvoiceCheckoutItemRequest,
    InvoiceCreateRequest,
    PageResponse,
)

from .Invoices import process_checkout


settings = get_settings()

router = APIRouter(prefix="/sale", tags=["sale-held-orders"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
AccessToken = Annotated[str, Depends(oauth2_scheme)]


def _held_item_to_checkout_item(raw: dict) -> InvoiceCheckoutItemRequest:
    return InvoiceCheckoutItemRequest(
        sku=raw.get("sku") or raw.get("product_code") or raw.get("product_id"),
        product_id=str(raw.get("product_id") or ""),
        product_code=raw.get("product_code"),
        product_name=raw.get("product_name"),
        unit_id=str(raw.get("unit_id") or ""),
        unit_name=raw.get("unit_name"),
        conversion_rate=int(raw.get("conversion_rate") or 1),
        batch_id=str(raw.get("batch_id") or ""),
        lot_number=raw.get("lot_number"),
        expiry_date=raw.get("expiry_date"),
        quantity=int(raw.get("quantity") or 0),
        unit_price=Decimal(str(raw.get("unit_price") or 0)),
        discount_amount=Decimal(str(raw.get("discount_amount") or 0)),
    )


@router.get("/held-orders", response_model=PageResponse[HeldOrderResponse])
async def list_held_orders(
    _: AnyUser,
    db: DbSession,
    status_value: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[HeldOrderResponse]:
    await cleanup_expired_held_orders(db)

    stmt = select(HeldOrder).order_by(HeldOrder.priority.desc(), HeldOrder.created_at.desc())
    if status_value and status_value.strip():
        stmt = stmt.where(HeldOrder.status == status_value.strip().lower())

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[HeldOrderResponse](
        items=[HeldOrderResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/held-orders/my", response_model=PageResponse[HeldOrderResponse])
async def list_my_held_orders(
    current_user: AnyUser,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[HeldOrderResponse]:
    await cleanup_expired_held_orders(db)

    stmt = (
        select(HeldOrder)
        .where(HeldOrder.created_by == current_user.sub)
        .order_by(HeldOrder.priority.desc(), HeldOrder.created_at.desc())
    )
    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[HeldOrderResponse](
        items=[HeldOrderResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/held-orders/count")
async def count_active_held_orders(_: AnyUser, db: DbSession):
    await cleanup_expired_held_orders(db)

    total = await db.scalar(select(func.count()).select_from(HeldOrder).where(HeldOrder.status == "active"))
    return {"active_count": int(total or 0)}


@router.get("/held-orders/{order_id}", response_model=HeldOrderResponse)
async def get_held_order(order_id: UUID, _: AnyUser, db: DbSession) -> HeldOrderResponse:
    held_order = await get_held_order_or_404(order_id, db)
    return HeldOrderResponse.model_validate(held_order)


@router.post("/held-orders", response_model=HeldOrderResponse, status_code=status.HTTP_201_CREATED)
async def create_held_order(
    payload: HeldOrderCreateRequest,
    current_user: AnyUser,
    db: DbSession,
) -> HeldOrderResponse:
    code = await generate_next_sequence_code(
        db=db,
        code_column=HeldOrder.code,
        prefix=settings.HELD_ORDER_PREFIX,
    )

    subtotal = quantize_money(payload.subtotal)
    if subtotal <= Decimal("0.00"):
        subtotal = quantize_money(sum((item.line_total or (item.unit_price * item.quantity)) for item in payload.items))

    items = []
    for item in payload.items:
        line_total = quantize_money(item.line_total if item.line_total is not None else (item.unit_price * item.quantity))
        items.append(
            {
                "product_id": item.product_id,
                "product_code": item.product_code,
                "product_name": item.product_name,
                "unit_id": item.unit_id,
                "unit_name": item.unit_name,
                "batch_id": item.batch_id,
                "quantity": item.quantity,
                "unit_price": float(quantize_money(item.unit_price)),
                "line_total": float(line_total),
            }
        )

    held_order = HeldOrder(
        code=code,
        customer_id=payload.customer_id,
        customer_name=payload.customer_name,
        customer_phone=payload.customer_phone,
        customer_tier=payload.customer_tier,
        items=items,
        subtotal=subtotal,
        promotion_code=payload.promotion_code,
        points_to_use=payload.points_to_use,
        status="active",
        expires_at=future_time(settings.HELD_ORDER_EXPIRE_MINUTES),
        priority=payload.priority,
        note=payload.note,
        created_by=current_user.sub,
        created_by_name=current_user.username,
    )
    db.add(held_order)
    await db.commit()
    await db.refresh(held_order)
    return HeldOrderResponse.model_validate(held_order)


@router.put("/held-orders/{order_id}", response_model=HeldOrderResponse)
async def update_held_order(
    order_id: UUID,
    payload: HeldOrderUpdateRequest,
    current_user: AnyUser,
    db: DbSession,
) -> HeldOrderResponse:
    held_order = await get_held_order_or_404(order_id, db)
    if held_order.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only active held order can be updated")
    if held_order.created_by != current_user.sub:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    updates = payload.model_dump(exclude_unset=True)
    if "customer_id" in updates:
        held_order.customer_id = payload.customer_id
    if "customer_name" in updates:
        held_order.customer_name = payload.customer_name
    if "customer_phone" in updates:
        held_order.customer_phone = payload.customer_phone
    if "customer_tier" in updates:
        held_order.customer_tier = payload.customer_tier
    if "subtotal" in updates and payload.subtotal is not None:
        held_order.subtotal = quantize_money(payload.subtotal)
    if "promotion_code" in updates:
        held_order.promotion_code = payload.promotion_code
    if "points_to_use" in updates and payload.points_to_use is not None:
        held_order.points_to_use = payload.points_to_use
    if "priority" in updates and payload.priority is not None:
        held_order.priority = payload.priority
    if "note" in updates:
        held_order.note = payload.note

    if "items" in updates and payload.items is not None:
        held_order.items = [
            {
                "product_id": item.product_id,
                "product_code": item.product_code,
                "product_name": item.product_name,
                "unit_id": item.unit_id,
                "unit_name": item.unit_name,
                "batch_id": item.batch_id,
                "quantity": item.quantity,
                "unit_price": float(quantize_money(item.unit_price)),
                "line_total": float(
                    quantize_money(item.line_total if item.line_total is not None else (item.unit_price * item.quantity))
                ),
            }
            for item in payload.items
        ]

    held_order.expires_at = future_time(settings.HELD_ORDER_EXPIRE_MINUTES)

    await db.commit()
    await db.refresh(held_order)
    return HeldOrderResponse.model_validate(held_order)


@router.post("/held-orders/{order_id}/resume")
async def resume_held_order(
    order_id: UUID,
    payload: HeldOrderResumeRequest,
    current_user: AnyUser,
    token: AccessToken,
    db: DbSession,
):
    held_order = await get_held_order_or_404(order_id, db)
    if held_order.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only active held order can be resumed")

    if held_order.expires_at <= now_utc():
        held_order.status = "expired"
        await db.commit()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Held order already expired")

    base_items = [_held_item_to_checkout_item(item) for item in held_order.items]
    all_items = list(base_items)
    all_items.extend(payload.additional_items)

    invoice_payload = InvoiceCreateRequest(
        customer_id=held_order.customer_id,
        items=all_items,
        promotion_code=held_order.promotion_code,
        points_used=held_order.points_to_use,
        payment_method=payload.payment_method,
        amount_paid=payload.amount_paid,
        payments=payload.payments,
        note=payload.note,
    )

    invoice = await process_checkout(invoice_payload, current_user, token, db)

    held_order.status = "resumed"
    held_order.resumed_at = now_utc()
    held_order.resumed_invoice_id = invoice.id
    await db.commit()

    return {
        "message": "Held order resumed",
        "held_order": {
            "id": str(held_order.id),
            "code": held_order.code,
            "status": held_order.status,
            "resumed_at": held_order.resumed_at,
            "resumed_invoice_id": str(held_order.resumed_invoice_id),
        },
        "invoice": {
            "id": str(invoice.id),
            "code": invoice.code,
            "total_amount": invoice.total_amount,
            "status": invoice.status,
        },
    }


@router.delete("/held-orders/{order_id}")
async def cancel_held_order(order_id: UUID, _: AnyUser, db: DbSession):
    held_order = await get_held_order_or_404(order_id, db)
    if held_order.status not in {"active", "expired"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Held order cannot be cancelled")

    held_order.status = "cancelled"
    await db.commit()
    return {"message": "Held order cancelled", "held_order_id": str(held_order.id)}
