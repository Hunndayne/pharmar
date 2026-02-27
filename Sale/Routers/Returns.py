from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from Source.core.config import get_settings
from Source.db.models import Invoice, InvoiceItem, Return, ReturnItem, Shift
from Source.dependencies import (
    ROLE_MANAGER,
    ROLE_OWNER,
    DbSession,
    TokenUser,
    get_current_user,
    oauth2_scheme,
    require_roles,
)
from Source.events import publish_sale_event
from Source.sale import (
    clamp_return_quantity,
    customer_internal_post,
    generate_next_daily_code,
    get_return_or_404,
    inventory_return_stock,
    now_utc,
    paginate_scalars,
    proportion_points,
    quantize_money,
)
from Source.schemas.sale import (
    PageResponse,
    ReturnCreateRequest,
    ReturnRejectRequest,
    ReturnResponse,
)


settings = get_settings()

router = APIRouter(prefix="/sale", tags=["sale-returns"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]
AccessToken = Annotated[str, Depends(oauth2_scheme)]


async def _get_return_with_details(return_id: UUID, db: DbSession) -> Return:
    stmt = (
        select(Return)
        .options(selectinload(Return.items))
        .where(Return.id == return_id)
    )
    result = await db.scalar(stmt)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Return not found")
    return result


@router.get("/returns", response_model=PageResponse[ReturnResponse])
async def list_returns(
    _: AnyUser,
    db: DbSession,
    status_value: str | None = Query(default=None, alias="status"),
    invoice_id: UUID | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[ReturnResponse]:
    stmt = select(Return).order_by(Return.created_at.desc())
    if status_value and status_value.strip():
        stmt = stmt.where(Return.status == status_value.strip().lower())
    if invoice_id is not None:
        stmt = stmt.where(Return.invoice_id == invoice_id)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[ReturnResponse](
        items=[ReturnResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/returns/{return_id}", response_model=ReturnResponse)
async def get_return(return_id: UUID, _: AnyUser, db: DbSession) -> ReturnResponse:
    item = await _get_return_with_details(return_id, db)
    return ReturnResponse.model_validate(item)


@router.post("/returns", response_model=ReturnResponse, status_code=status.HTTP_201_CREATED)
async def create_return(payload: ReturnCreateRequest, current_user: AnyUser, db: DbSession) -> ReturnResponse:
    invoice = await db.scalar(
        select(Invoice)
        .options(selectinload(Invoice.items))
        .where(Invoice.id == payload.invoice_id)
    )
    if invoice is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    if invoice.status not in {"completed", "returned"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Invoice is not eligible for return")

    code = await generate_next_daily_code(
        db=db,
        model=Return,
        code_column=Return.code,
        prefix=settings.RETURN_PREFIX,
    )

    invoice_item_map = {item.id: item for item in invoice.items}
    return_items: list[ReturnItem] = []
    total_return_amount = Decimal("0.00")

    for req_item in payload.items:
        invoice_item = invoice_item_map.get(req_item.invoice_item_id)
        if invoice_item is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invoice_item_id does not belong to invoice")

        qty = clamp_return_quantity(req_item.quantity, invoice_item.quantity, invoice_item.returned_quantity)
        amount = quantize_money(invoice_item.unit_price * qty)
        total_return_amount += amount

        return_items.append(
            ReturnItem(
                invoice_item_id=invoice_item.id,
                product_id=invoice_item.product_id,
                product_name=invoice_item.product_name,
                unit_name=invoice_item.unit_name,
                batch_id=invoice_item.batch_id,
                quantity=qty,
                unit_price=invoice_item.unit_price,
                return_amount=amount,
                reason=req_item.reason,
                condition=req_item.condition,
            )
        )

    return_doc = Return(
        code=code,
        invoice_id=invoice.id,
        invoice_code=invoice.code,
        customer_id=invoice.customer_id,
        customer_name=invoice.customer_name,
        total_return_amount=quantize_money(total_return_amount),
        points_returned=0,
        refund_method=payload.refund_method,
        refund_amount=quantize_money(total_return_amount),
        status="pending",
        reason=payload.reason,
        created_by=current_user.sub,
        created_by_name=current_user.username,
    )
    db.add(return_doc)
    await db.flush()

    for item in return_items:
        item.return_id = return_doc.id
        db.add(item)

    await db.commit()

    created = await _get_return_with_details(return_doc.id, db)
    return ReturnResponse.model_validate(created)


@router.post("/returns/{return_id}/approve")
async def approve_return(
    return_id: UUID,
    current_user: ManagerOrOwner,
    token: AccessToken,
    db: DbSession,
):
    return_doc = await _get_return_with_details(return_id, db)
    if return_doc.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only pending return can be approved")

    invoice = await db.scalar(
        select(Invoice)
        .options(selectinload(Invoice.items))
        .where(Invoice.id == return_doc.invoice_id)
    )
    if invoice is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Original invoice not found")

    stock_returned = True
    for item in return_doc.items:
        invoice_item = next((row for row in invoice.items if row.id == item.invoice_item_id), None)
        if invoice_item is None:
            continue

        invoice_item.returned_quantity += item.quantity
        if item.condition == "good":
            conversion_rate = max(int(invoice_item.conversion_rate or 1), 1)
            ok = await inventory_return_stock(item.batch_id, item.quantity * conversion_rate, token)
            stock_returned = stock_returned and ok

    fully_returned = all(row.returned_quantity >= row.quantity for row in invoice.items)
    if fully_returned:
        invoice.status = "returned"

    points_adjusted = 0
    if invoice.customer_id:
        rollback_earned = proportion_points(invoice.points_earned, return_doc.total_return_amount, invoice.total_amount)
        rollback_redeem = proportion_points(invoice.points_used, return_doc.total_return_amount, invoice.total_amount)

        if rollback_earned > 0:
            try:
                result = await customer_internal_post(
                    "points/rollback",
                    {
                        "customer_id": str(invoice.customer_id),
                        "points": rollback_earned,
                        "reference_type": "invoice_return_earn",
                        "reference_id": str(invoice.id),
                        "reference_code": invoice.code,
                        "note": "Return goods rollback earn points",
                    },
                )
                points_adjusted -= int(result.get("points_rolled_back", rollback_earned) or 0)
            except Exception:
                pass

        if rollback_redeem > 0:
            try:
                result = await customer_internal_post(
                    "points/rollback",
                    {
                        "customer_id": str(invoice.customer_id),
                        "points": rollback_redeem,
                        "reference_type": "invoice_return_redeem",
                        "reference_id": str(invoice.id),
                        "reference_code": invoice.code,
                        "note": "Return goods rollback redeem points",
                    },
                )
                points_adjusted += int(result.get("points_rolled_back", rollback_redeem) or 0)
                return_doc.points_returned = int(result.get("points_rolled_back", rollback_redeem) or rollback_redeem)
            except Exception:
                pass

    if fully_returned and invoice.promotion_id and invoice.promotion_usage_id:
        try:
            await customer_internal_post(
                "promotions/rollback",
                {
                    "promotion_id": str(invoice.promotion_id),
                    "usage_id": str(invoice.promotion_usage_id),
                    "reason": "Invoice fully returned",
                },
            )
        except Exception:
            pass

    if invoice.shift_id:
        shift = await db.get(Shift, invoice.shift_id)
        if shift is not None:
            shift.total_returns = quantize_money(shift.total_returns + return_doc.total_return_amount)

    return_doc.status = "completed"
    return_doc.approved_by = current_user.sub
    return_doc.approved_at = now_utc()

    await db.commit()

    await publish_sale_event(
        event_type="sale.return.approved",
        routing_key="sale.return.approved",
        payload={
            "return_id": str(return_doc.id),
            "return_code": return_doc.code,
            "invoice_id": str(invoice.id),
            "invoice_code": invoice.code,
            "customer_id": str(invoice.customer_id) if invoice.customer_id else None,
            "customer_name": invoice.customer_name,
            "status": return_doc.status,
            "total_return_amount": float(return_doc.total_return_amount),
            "refund_amount": float(return_doc.refund_amount),
            "approved_at": return_doc.approved_at.isoformat() if return_doc.approved_at else None,
            "approved_by": return_doc.approved_by,
        },
    )

    return {
        "message": "Return approved",
        "return": {
            "id": str(return_doc.id),
            "code": return_doc.code,
            "status": return_doc.status,
            "approved_by": return_doc.approved_by,
            "approved_at": return_doc.approved_at,
        },
        "actions": {
            "stock_returned": stock_returned,
            "points_adjusted": points_adjusted,
            "refund_amount": return_doc.refund_amount,
        },
    }


@router.post("/returns/{return_id}/reject")
async def reject_return(return_id: UUID, payload: ReturnRejectRequest, _: ManagerOrOwner, db: DbSession):
    return_doc = await get_return_or_404(return_id, db)
    if return_doc.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only pending return can be rejected")

    return_doc.status = "rejected"
    reason_text = payload.reason.strip()
    return_doc.reason = f"{return_doc.reason or ''}\nRejected: {reason_text}".strip()

    await db.commit()

    return {
        "message": "Return rejected",
        "return": {
            "id": str(return_doc.id),
            "code": return_doc.code,
            "status": return_doc.status,
            "reason": reason_text,
        },
    }
