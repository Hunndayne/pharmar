from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from Source.core.config import get_settings
from Source.db.models import Invoice, Shift
from Source.dependencies import (
    ROLE_MANAGER,
    ROLE_OWNER,
    DbSession,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.sale import (
    generate_next_daily_code,
    get_open_shift_for_user,
    get_shift_or_404,
    now_utc,
    paginate_scalars,
    quantize_money,
)
from Source.schemas.sale import PageResponse, ShiftCloseRequest, ShiftOpenRequest, ShiftReportResponse, ShiftResponse


settings = get_settings()

router = APIRouter(prefix="/sale", tags=["sale-shifts"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


@router.get("/shifts", response_model=PageResponse[ShiftResponse])
async def list_shifts(
    _: ManagerOrOwner,
    db: DbSession,
    cashier_id: str | None = Query(default=None),
    status_value: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[ShiftResponse]:
    stmt = select(Shift).order_by(Shift.started_at.desc())
    if cashier_id and cashier_id.strip():
        stmt = stmt.where(Shift.cashier_id == cashier_id.strip())
    if status_value and status_value.strip():
        stmt = stmt.where(Shift.status == status_value.strip().lower())

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[ShiftResponse](
        items=[ShiftResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/shifts/current", response_model=ShiftResponse)
async def get_current_shift(current_user: AnyUser, db: DbSession) -> ShiftResponse:
    shift = await get_open_shift_for_user(current_user.sub, db)
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No open shift")
    return ShiftResponse.model_validate(shift)


@router.get("/shifts/{shift_id}", response_model=ShiftResponse)
async def get_shift(shift_id: UUID, _: AnyUser, db: DbSession) -> ShiftResponse:
    shift = await get_shift_or_404(shift_id, db)
    return ShiftResponse.model_validate(shift)


@router.post("/shifts/open", response_model=ShiftResponse, status_code=status.HTTP_201_CREATED)
async def open_shift(payload: ShiftOpenRequest, current_user: AnyUser, db: DbSession) -> ShiftResponse:
    existing = await get_open_shift_for_user(current_user.sub, db)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You already have an open shift. Please close it first.",
        )

    code = await generate_next_daily_code(
        db=db,
        model=Shift,
        code_column=Shift.code,
        prefix=settings.SHIFT_PREFIX,
    )

    shift = Shift(
        code=code,
        cashier_id=current_user.sub,
        cashier_name=current_user.username or current_user.sub,
        cashier_code=current_user.sub,
        opening_amount=quantize_money(payload.opening_amount),
        status="open",
        note=payload.note,
    )
    db.add(shift)
    await db.commit()
    await db.refresh(shift)
    return ShiftResponse.model_validate(shift)


@router.post("/shifts/close", response_model=ShiftResponse)
async def close_shift(payload: ShiftCloseRequest, current_user: AnyUser, db: DbSession) -> ShiftResponse:
    shift = await get_open_shift_for_user(current_user.sub, db)
    if shift is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No open shift to close")

    closing_amount = quantize_money(payload.closing_amount)

    expected_amount = quantize_money(shift.opening_amount + shift.cash_sales - shift.total_returns)
    difference = quantize_money(closing_amount - expected_amount)

    shift.ended_at = now_utc()
    shift.closing_amount = closing_amount
    shift.expected_amount = expected_amount
    shift.difference = difference
    shift.status = "closed"
    if payload.note is not None:
        shift.note = payload.note

    await db.commit()
    await db.refresh(shift)
    return ShiftResponse.model_validate(shift)


@router.get("/shifts/{shift_id}/report", response_model=ShiftReportResponse)
async def shift_report(shift_id: UUID, _: AnyUser, db: DbSession) -> ShiftReportResponse:
    shift = await get_shift_or_404(shift_id, db)

    invoices_rows = await db.scalars(
        select(Invoice).where(Invoice.shift_id == shift.id).order_by(Invoice.created_at.asc())
    )
    invoices = list(invoices_rows.all())

    net_sales = quantize_money(shift.total_sales - shift.total_returns - shift.total_cancelled)

    return ShiftReportResponse(
        shift=ShiftResponse.model_validate(shift),
        summary={
            "total_invoices": shift.total_invoices,
            "total_sales": shift.total_sales,
            "total_returns": shift.total_returns,
            "total_cancelled": shift.total_cancelled,
            "net_sales": net_sales,
        },
        payment_breakdown={
            "cash": shift.cash_sales,
            "card": shift.card_sales,
            "transfer": shift.transfer_sales,
            "momo": shift.momo_sales,
            "zalopay": shift.zalopay_sales,
            "vnpay": shift.vnpay_sales,
        },
        cash_flow={
            "opening_amount": shift.opening_amount,
            "cash_in": shift.cash_sales,
            "cash_out": shift.total_returns,
            "expected_amount": quantize_money(shift.opening_amount + shift.cash_sales - shift.total_returns),
            "closing_amount": quantize_money(shift.closing_amount or Decimal("0.00")),
            "difference": quantize_money(shift.difference or Decimal("0.00")),
        },
        invoices=[
            {
                "id": str(item.id),
                "code": item.code,
                "total_amount": item.total_amount,
                "payment_method": item.payment_method,
                "status": item.status,
                "created_at": item.created_at,
            }
            for item in invoices
        ],
    )
