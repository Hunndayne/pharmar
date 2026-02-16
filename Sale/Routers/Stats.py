from datetime import date
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, select

from Source.db.models import Invoice, Return, Shift
from Source.dependencies import ROLE_MANAGER, ROLE_OWNER, DbSession, TokenUser, get_current_user, require_roles
from Source.sale import get_shift_or_404, quantize_money
from Source.schemas.sale import CashierStatsItemResponse, CashierStatsResponse, StatsTodayResponse


router = APIRouter(prefix="/sale", tags=["sale-stats"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


def _period_filter(date_from: date | None, date_to: date | None):
    conditions = []
    if date_from is not None:
        conditions.append(Invoice.created_at >= date_from)
    if date_to is not None:
        conditions.append(Invoice.created_at <= date_to)
    return conditions


def _collect_cashier_stats(invoices: list[Invoice]) -> list[dict]:
    grouped: dict[str, dict] = {}
    for invoice in invoices:
        key = invoice.created_by
        item = grouped.get(key)
        if item is None:
            item = {
                "user_id": invoice.created_by,
                "user_code": invoice.cashier_code,
                "user_name": invoice.created_by_name,
                "total_invoices": 0,
                "total_sales": Decimal("0.00"),
                "total_returns": Decimal("0.00"),
                "commission_rate": invoice.commission_rate,
                "commission_amount": Decimal("0.00"),
            }
            grouped[key] = item

        if invoice.status in {"completed", "returned"}:
            item["total_invoices"] += 1
            item["total_sales"] = quantize_money(item["total_sales"] + invoice.total_amount)
            item["commission_amount"] = quantize_money(item["commission_amount"] + invoice.commission_amount)
        elif invoice.status == "cancelled":
            item["total_returns"] = quantize_money(item["total_returns"] + invoice.total_amount)

    for item in grouped.values():
        item["net_sales"] = quantize_money(item["total_sales"] - item["total_returns"])
        item["avg_invoice_value"] = quantize_money(
            item["total_sales"] / item["total_invoices"] if item["total_invoices"] > 0 else Decimal("0.00")
        )

    return sorted(grouped.values(), key=lambda x: x["net_sales"], reverse=True)


@router.get("/stats/today", response_model=StatsTodayResponse)
async def stats_today(_: AnyUser, db: DbSession) -> StatsTodayResponse:
    today = date.today()
    rows = await db.scalars(
        select(Invoice).where(func.date(Invoice.created_at) == today)
    )
    invoices = list(rows.all())

    total_invoices = len([item for item in invoices if item.status in {"completed", "returned"}])
    total_sales = quantize_money(sum((item.total_amount for item in invoices if item.status in {"completed", "returned"}), Decimal("0.00")))
    total_cancelled = quantize_money(sum((item.total_amount for item in invoices if item.status == "cancelled"), Decimal("0.00")))
    total_returns_raw = await db.scalar(
        select(func.coalesce(func.sum(Return.total_return_amount), 0)).where(
            and_(
                func.date(Return.created_at) == today,
                Return.status == "completed",
            )
        )
    )
    total_returns = quantize_money(total_returns_raw or Decimal("0.00"))
    net_sales = quantize_money(total_sales - total_returns - total_cancelled)

    return StatsTodayResponse(
        date=today,
        total_invoices=total_invoices,
        total_sales=total_sales,
        total_returns=total_returns,
        total_cancelled=total_cancelled,
        net_sales=net_sales,
    )


@router.get("/stats/shift/{shift_id}")
async def stats_by_shift(shift_id: UUID, _: AnyUser, db: DbSession):
    shift = await get_shift_or_404(shift_id, db)
    return {
        "shift_id": str(shift.id),
        "code": shift.code,
        "cashier_id": shift.cashier_id,
        "cashier_name": shift.cashier_name,
        "status": shift.status,
        "total_invoices": shift.total_invoices,
        "total_sales": shift.total_sales,
        "total_returns": shift.total_returns,
        "total_cancelled": shift.total_cancelled,
        "net_sales": quantize_money(shift.total_sales - shift.total_returns - shift.total_cancelled),
    }


@router.get("/stats/by-cashier", response_model=CashierStatsResponse)
async def stats_by_cashier(
    _: ManagerOrOwner,
    db: DbSession,
    date_from: date,
    date_to: date,
) -> CashierStatsResponse:
    rows = await db.scalars(
        select(Invoice).where(
            and_(
                func.date(Invoice.created_at) >= date_from,
                func.date(Invoice.created_at) <= date_to,
            )
        )
    )
    invoices = list(rows.all())

    aggregated = _collect_cashier_stats(invoices)
    cashier_items = [CashierStatsItemResponse(**item) for item in aggregated]

    totals = {
        "total_invoices": sum(item.total_invoices for item in cashier_items),
        "total_sales": quantize_money(sum((item.total_sales for item in cashier_items), Decimal("0.00"))),
        "total_returns": quantize_money(sum((item.total_returns for item in cashier_items), Decimal("0.00"))),
        "net_sales": quantize_money(sum((item.net_sales for item in cashier_items), Decimal("0.00"))),
        "total_commission": quantize_money(sum((item.commission_amount for item in cashier_items), Decimal("0.00"))),
    }

    return CashierStatsResponse(
        period={"from": date_from, "to": date_to},
        cashiers=cashier_items,
        totals=totals,
    )


@router.get("/stats/by-cashier/{user_id}")
async def stats_by_single_cashier(
    user_id: str,
    _: ManagerOrOwner,
    db: DbSession,
    date_from: date,
    date_to: date,
):
    rows = await db.scalars(
        select(Invoice).where(
            and_(
                Invoice.created_by == user_id,
                func.date(Invoice.created_at) >= date_from,
                func.date(Invoice.created_at) <= date_to,
            )
        )
    )
    invoices = list(rows.all())
    aggregated = _collect_cashier_stats(invoices)
    item = aggregated[0] if aggregated else {
        "user_id": user_id,
        "user_code": None,
        "user_name": None,
        "total_invoices": 0,
        "total_sales": Decimal("0.00"),
        "total_returns": Decimal("0.00"),
        "net_sales": Decimal("0.00"),
        "commission_rate": Decimal("0.00"),
        "commission_amount": Decimal("0.00"),
        "avg_invoice_value": Decimal("0.00"),
    }
    return {
        "period": {"from": date_from, "to": date_to},
        "cashier": item,
    }


@router.get("/stats/commission")
async def stats_commission(
    _: ManagerOrOwner,
    db: DbSession,
    date_from: date,
    date_to: date,
):
    rows = await db.scalars(
        select(Invoice).where(
            and_(
                func.date(Invoice.created_at) >= date_from,
                func.date(Invoice.created_at) <= date_to,
                Invoice.status.in_(["completed", "returned"]),
            )
        )
    )
    invoices = list(rows.all())

    by_cashier = _collect_cashier_stats(invoices)

    return {
        "period": {"from": date_from, "to": date_to},
        "cashiers": [
            {
                "user_id": item["user_id"],
                "user_name": item["user_name"],
                "commission_rate": item["commission_rate"],
                "commission_amount": item["commission_amount"],
                "total_sales": item["total_sales"],
            }
            for item in by_cashier
        ],
        "total_commission": quantize_money(sum((item["commission_amount"] for item in by_cashier), Decimal("0.00"))),
    }
