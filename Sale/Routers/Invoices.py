from __future__ import annotations

from datetime import date
from decimal import Decimal
import re
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from Source.core.config import get_settings
from Source.db.models import Invoice, InvoiceItem, InvoicePayment, Shift
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
    extract_item_sku,
    fetch_customer_by_id,
    fetch_customer_tier_discount_percent,
    fetch_store_info,
    fetch_store_settings_group,
    generate_next_daily_code,
    get_invoice_by_code_or_404,
    get_invoice_or_404,
    inventory_reserve,
    inventory_return_stock,
    invoice_search_filter,
    invoice_status_filter,
    list_active_payment_methods_map,
    now_utc,
    paginate_scalars,
    proportion_points,
    quantize_money,
    safe_decimal,
    safe_uuid,
    customer_internal_post,
)
from Source.schemas.sale import (
    InvoiceCancelRequest,
    InvoiceCollectPaymentRequest,
    InvoiceCreateRequest,
    InvoiceListItemResponse,
    InvoicePrintResponse,
    ProfitSourceInvoiceResponse,
    PublicInvoiceListItemResponse,
    PublicInvoiceResponse,
    InvoiceResponse,
    PageResponse,
)


settings = get_settings()
MIN_DEBT_AMOUNT_AFTER_ROUNDING = Decimal("500.00")

router = APIRouter(prefix="/sale", tags=["sale-invoices"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]
AccessToken = Annotated[str, Depends(oauth2_scheme)]


def _normalize_decimal(value: Decimal) -> Decimal:
    return quantize_money(value)


def _decimal_to_float(value: Decimal | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _apply_minimum_debt_threshold(
    total_amount: Decimal,
    amount_paid: Decimal,
    rounding_adjustment_amount: Decimal,
) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    debt_amount = _normalize_decimal(max(total_amount - amount_paid, Decimal("0.00")))
    if Decimal("0.00") < debt_amount <= MIN_DEBT_AMOUNT_AFTER_ROUNDING:
        # Absorb tiny residual balances into the rounding adjustment to avoid meaningless debt.
        rounding_adjustment_amount = _normalize_decimal(rounding_adjustment_amount - debt_amount)
        total_amount = _normalize_decimal(total_amount - debt_amount)
        debt_amount = Decimal("0.00")

    change_amount = _normalize_decimal(max(amount_paid - total_amount, Decimal("0.00")))
    return total_amount, rounding_adjustment_amount, debt_amount, change_amount


def _invoice_event_payload(invoice: Invoice) -> dict[str, Any]:
    return {
        "invoice_id": str(invoice.id),
        "invoice_code": invoice.code,
        "customer_id": str(invoice.customer_id) if invoice.customer_id else None,
        "customer_name": invoice.customer_name,
        "customer_phone": invoice.customer_phone,
        "total_amount": _decimal_to_float(invoice.total_amount),
        "rounding_adjustment_amount": _decimal_to_float(invoice.rounding_adjustment_amount),
        "amount_paid": _decimal_to_float(invoice.amount_paid),
        "change_amount": _decimal_to_float(invoice.change_amount),
        "service_fee_amount": _decimal_to_float(invoice.service_fee_amount),
        "service_fee_mode": invoice.service_fee_mode,
        "payment_method": invoice.payment_method,
        "status": invoice.status,
        "created_by": invoice.created_by,
        "created_by_name": invoice.created_by_name,
        "created_at": invoice.created_at.isoformat() if invoice.created_at else None,
        "updated_at": invoice.updated_at.isoformat() if invoice.updated_at else None,
    }


async def _get_invoice_with_details(invoice_id: UUID, db: AsyncSession) -> Invoice:
    stmt = (
        select(Invoice)
        .options(selectinload(Invoice.items), selectinload(Invoice.payments))
        .where(Invoice.id == invoice_id)
    )
    item = await db.scalar(stmt)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    return item


def _normalize_phone_lookup(phone: str) -> str:
    normalized = re.sub(r"\D+", "", phone or "")
    if len(normalized) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Phone number is invalid")
    return normalized


async def _prepare_invoice_creation(
    payload: InvoiceCreateRequest,
    current_user: TokenUser,
    token: str,
    db: AsyncSession,
) -> tuple[Invoice, list[InvoiceItem], list[InvoicePayment], dict[str, Any]]:
    # Shift open/close feature is temporarily disabled.
    open_shift: Shift | None = None

    invoice_code = await generate_next_daily_code(
        db=db,
        model=Invoice,
        code_column=Invoice.code,
        prefix=settings.INVOICE_PREFIX,
    )
    invoice_id = uuid4()

    reserve_items: list[dict[str, Any]] = []
    for item in payload.items:
        conversion_rate = max(int(item.conversion_rate or 1), 1)
        reserve_item: dict[str, Any] = {
            "sku": extract_item_sku(item),
            "quantity": item.quantity * conversion_rate,
        }
        if item.batch_id:
            reserve_item["batch_id"] = item.batch_id
        reserve_items.append(reserve_item)
    await inventory_reserve(invoice_code, reserve_items, token)

    customer_snapshot: dict[str, Any] | None = None
    if payload.customer_id is not None:
        customer_snapshot = await fetch_customer_by_id(payload.customer_id, token)
        if customer_snapshot is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")

    line_subtotal = Decimal("0.00")
    line_discount_total = Decimal("0.00")
    invoice_items: list[InvoiceItem] = []

    for item in payload.items:
        unit_price = _normalize_decimal(item.unit_price)
        line_before_discount = _normalize_decimal(unit_price * item.quantity)
        line_discount = _normalize_decimal(item.discount_amount)
        line_total = _normalize_decimal(line_before_discount - line_discount)
        if line_total < Decimal("0.00"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Line total cannot be negative")

        line_subtotal += line_before_discount
        line_discount_total += line_discount

        invoice_items.append(
            InvoiceItem(
                invoice_id=invoice_id,
                product_id=item.product_id,
                product_code=item.product_code or item.product_id,
                product_name=item.product_name or item.product_code or item.product_id,
                unit_id=item.unit_id,
                unit_name=item.unit_name or "unit",
                conversion_rate=item.conversion_rate,
                batch_id=item.batch_id,
                lot_number=item.lot_number,
                expiry_date=item.expiry_date,
                unit_price=unit_price,
                quantity=item.quantity,
                discount_amount=line_discount,
                line_total=line_total,
            )
        )

    subtotal = _normalize_decimal(line_subtotal)
    tier_discount = Decimal("0.00")
    subtotal_after_line_discount = _normalize_decimal(subtotal - line_discount_total)
    if subtotal_after_line_discount < Decimal("0.00"):
        subtotal_after_line_discount = Decimal("0.00")

    if payload.customer_id is not None and subtotal_after_line_discount > Decimal("0.00"):
        tier_discount_percent = await fetch_customer_tier_discount_percent(payload.customer_id, token)
        tier_discount = _normalize_decimal(subtotal_after_line_discount * tier_discount_percent / Decimal("100"))
        if tier_discount > subtotal_after_line_discount:
            tier_discount = subtotal_after_line_discount

    promotion_base_amount = _normalize_decimal(subtotal_after_line_discount - tier_discount)
    if promotion_base_amount < Decimal("0.00"):
        promotion_base_amount = Decimal("0.00")

    promotion_discount = Decimal("0.00")
    promotion_validated = False
    if payload.promotion_code:
        validate_payload = {
            "promotion_code": payload.promotion_code,
            "customer_id": str(payload.customer_id) if payload.customer_id else None,
            "order_amount": float(promotion_base_amount),
            "product_ids": [item.product_id for item in payload.items if safe_uuid(item.product_id) is not None],
            "group_ids": [],
        }
        validate_result = await customer_internal_post("promotions/validate", validate_payload)
        if validate_result.get("valid"):
            promotion_discount = safe_decimal(validate_result.get("calculated_discount"))
            promotion_validated = True
        else:
            reason = validate_result.get("reason") or "Promotion is invalid"
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=reason)

    points_discount_base_amount = _normalize_decimal(promotion_base_amount - promotion_discount)
    if points_discount_base_amount < Decimal("0.00"):
        points_discount_base_amount = Decimal("0.00")

    points_discount = Decimal("0.00")
    points_used_applied = 0
    if payload.points_used > 0:
        if payload.customer_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="customer_id is required when using points")
        if points_discount_base_amount > Decimal("0.00"):
            redeem_payload = {
                "customer_id": str(payload.customer_id),
                "points": payload.points_used,
                "max_discount_amount": points_discount_base_amount,
                "reference_type": "invoice",
                "reference_id": str(invoice_id),
                "reference_code": invoice_code,
                "note": "Invoice checkout",
            }
            redeem_result = await customer_internal_post("points/redeem", redeem_payload)
            points_discount = _normalize_decimal(safe_decimal(redeem_result.get("discount_amount")))
            if points_discount > points_discount_base_amount:
                points_discount = points_discount_base_amount
            points_used_applied = int(redeem_result.get("points_used", payload.points_used) or 0)

    total_discount = _normalize_decimal(line_discount_total + tier_discount + promotion_discount + points_discount)
    total_amount = _normalize_decimal(subtotal - total_discount)
    if total_amount < Decimal("0.00"):
        total_amount = Decimal("0.00")

    service_fee_amount = _normalize_decimal(payload.service_fee_amount or Decimal("0.00"))
    service_fee_mode = payload.service_fee_mode or "split"
    if service_fee_mode == "separate" and service_fee_amount > Decimal("0.00"):
        total_amount = _normalize_decimal(total_amount + service_fee_amount)

    rounding_adjustment_amount = _normalize_decimal(payload.rounding_adjustment_amount or Decimal("0.00"))
    if total_amount + rounding_adjustment_amount < Decimal("0.00"):
        rounding_adjustment_amount = _normalize_decimal(-total_amount)
    total_amount = _normalize_decimal(total_amount + rounding_adjustment_amount)

    payment_methods = await list_active_payment_methods_map(db)

    invoice_payments: list[InvoicePayment] = []
    amount_paid = Decimal("0.00")
    payment_method = payload.payment_method or "cash"

    if payload.payments:
        payment_method = "mixed"
        for payment in payload.payments:
            method = payment.method
            payment_method_item = payment_methods.get(method)
            if payment_method_item is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Payment method '{method}' is not available")
            if payment_method_item.requires_reference and not payment.reference_code:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Payment method '{method}' requires reference_code",
                )
            payment_amount = _normalize_decimal(payment.amount)
            amount_paid += payment_amount
            invoice_payments.append(
                InvoicePayment(
                    invoice_id=invoice_id,
                    payment_method=method,
                    amount=payment_amount,
                    reference_code=payment.reference_code,
                    card_type=payment.card_type,
                    card_last_4=payment.card_last_4,
                    note=payment.note,
                )
            )
    else:
        single_method = (payment_method or "cash").lower()
        payment_method_item = payment_methods.get(single_method)
        if payment_method_item is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Payment method '{single_method}' is not available")
        amount_paid = _normalize_decimal(payload.amount_paid or Decimal("0.00"))
        invoice_payments.append(
            InvoicePayment(
                invoice_id=invoice_id,
                payment_method=single_method,
                amount=amount_paid,
            )
        )
        payment_method = single_method

    total_amount, rounding_adjustment_amount, debt_amount, change_amount = _apply_minimum_debt_threshold(
        total_amount,
        amount_paid,
        rounding_adjustment_amount,
    )
    effective_payment_method = "debt" if debt_amount > Decimal("0.00") else payment_method

    points_earned = 0
    if payload.customer_id is not None and total_amount > Decimal("0.00"):
        calculate_result = await customer_internal_post(
            "points/calculate",
            {
                "customer_id": str(payload.customer_id),
                "order_amount": float(total_amount),
            },
        )
        points_earned = int(calculate_result.get("points_earned", 0) or 0)

    commission_rate = Decimal(str(settings.DEFAULT_COMMISSION_RATE))
    commission_amount = _normalize_decimal(total_amount * commission_rate / Decimal("100"))

    invoice = Invoice(
        id=invoice_id,
        code=invoice_code,
        customer_id=payload.customer_id,
        customer_code=customer_snapshot.get("code") if customer_snapshot else None,
        customer_name=customer_snapshot.get("name") if customer_snapshot else None,
        customer_phone=customer_snapshot.get("phone") if customer_snapshot else None,
        customer_tier=customer_snapshot.get("tier") if customer_snapshot else None,
        subtotal=_normalize_decimal(subtotal),
        discount_amount=_normalize_decimal(total_discount),
        tier_discount=_normalize_decimal(tier_discount),
        promotion_discount=_normalize_decimal(promotion_discount),
        points_discount=_normalize_decimal(points_discount),
        total_amount=_normalize_decimal(total_amount),
        points_used=points_used_applied,
        points_earned=points_earned,
        promotion_code=payload.promotion_code,
        payment_method=effective_payment_method,
        service_fee_amount=service_fee_amount,
        service_fee_mode=service_fee_mode,
        rounding_adjustment_amount=rounding_adjustment_amount,
        amount_paid=_normalize_decimal(amount_paid),
        change_amount=_normalize_decimal(change_amount),
        status="completed",
        created_by=current_user.sub,
        created_by_name=current_user.username,
        cashier_code=current_user.sub,
        commission_rate=_normalize_decimal(commission_rate),
        commission_amount=_normalize_decimal(commission_amount),
        shift_id=open_shift.id if open_shift else None,
        note=payload.note,
    )

    context = {
        "invoice_id": invoice_id,
        "invoice_code": invoice_code,
        "promotion_validated": promotion_validated,
        "promotion_order_amount": promotion_base_amount,
        "points_used_applied": points_used_applied,
        "points_earned": points_earned,
    }

    return invoice, invoice_items, invoice_payments, context


async def process_checkout(
    payload: InvoiceCreateRequest,
    current_user: TokenUser,
    token: str,
    db: AsyncSession,
) -> Invoice:
    invoice: Invoice | None = None
    invoice_items: list[InvoiceItem] = []
    invoice_payments: list[InvoicePayment] = []
    context: dict[str, Any] = {}

    try:
        invoice, invoice_items, invoice_payments, context = await _prepare_invoice_creation(payload, current_user, token, db)
        db.add(invoice)
        db.add_all(invoice_items)
        db.add_all(invoice_payments)

        await db.commit()
    except Exception:
        await db.rollback()
        for item in payload.items:
            conversion_rate = max(int(item.conversion_rate or 1), 1)
            try:
                await inventory_return_stock(item.batch_id, item.quantity * conversion_rate, token)
            except Exception:
                pass
        points_to_rollback = int(context.get("points_used_applied", payload.points_used if payload.points_used > 0 else 0) or 0)
        if payload.customer_id and points_to_rollback > 0:
            try:
                await customer_internal_post(
                    "points/rollback",
                    {
                        "customer_id": str(payload.customer_id),
                        "points": points_to_rollback,
                        "reference_type": "invoice_create_failed",
                        "reference_id": str(context.get("invoice_id")),
                        "reference_code": context.get("invoice_code"),
                        "note": "Rollback redeem points because invoice creation failed",
                    },
                )
            except Exception:
                pass
        raise

    if invoice is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Cannot create invoice")

    if payload.customer_id and context.get("points_earned", 0) > 0:
        try:
            earn_result = await customer_internal_post(
                "points/earn",
                {
                    "customer_id": str(payload.customer_id),
                    "points": int(context["points_earned"]),
                    "reference_type": "invoice",
                    "reference_id": str(invoice.id),
                    "reference_code": invoice.code,
                    "note": "Invoice checkout",
                },
            )
            invoice.points_earned = int(earn_result.get("points_earned", context["points_earned"]) or 0)
        except Exception:
            pass

        try:
            await customer_internal_post(
                "stats/update",
                {
                    "customer_id": str(payload.customer_id),
                    "order_amount": float(invoice.total_amount),
                    "purchased_at": now_utc().isoformat(),
                },
            )
        except Exception:
            pass

    if payload.promotion_code and context.get("promotion_validated"):
        try:
            apply_result = await customer_internal_post(
                "promotions/apply",
                {
                    "promotion_code": payload.promotion_code,
                    "customer_id": str(payload.customer_id) if payload.customer_id else None,
                    "order_amount": float(context.get("promotion_order_amount", invoice.subtotal)),
                    "product_ids": [item.product_id for item in payload.items if safe_uuid(item.product_id) is not None],
                    "group_ids": [],
                    "invoice_id": str(invoice.id),
                    "invoice_code": invoice.code,
                },
            )
            invoice.promotion_id = safe_uuid(apply_result.get("promotion_id"))
            invoice.promotion_usage_id = safe_uuid(apply_result.get("usage_id"))
            await db.commit()
        except Exception:
            await db.rollback()

    return await _get_invoice_with_details(invoice.id, db)


@router.get("/public/invoices/code/{code}", response_model=PublicInvoiceResponse)
async def public_get_invoice_by_code(code: str, db: DbSession) -> PublicInvoiceResponse:
    invoice = await get_invoice_by_code_or_404(code, db)
    invoice = await _get_invoice_with_details(invoice.id, db)
    return PublicInvoiceResponse.model_validate(invoice)


@router.get("/public/invoices/phone/{phone}", response_model=PageResponse[PublicInvoiceListItemResponse])
async def public_list_invoices_by_phone(
    phone: str,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=10, ge=1, le=50),
) -> PageResponse[PublicInvoiceListItemResponse]:
    normalized_phone = _normalize_phone_lookup(phone)
    stmt = (
        select(Invoice)
        .where(
            func.regexp_replace(func.coalesce(Invoice.customer_phone, ""), r"\D", "", "g") == normalized_phone
        )
        .order_by(Invoice.created_at.desc())
    )
    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse(
        items=[
            PublicInvoiceListItemResponse(
                id=item.id,
                code=item.code,
                customer_name=item.customer_name,
                customer_phone=item.customer_phone,
                total_amount=item.total_amount,
                rounding_adjustment_amount=item.rounding_adjustment_amount,
                amount_paid=item.amount_paid,
                payment_method=item.payment_method,
                service_fee_amount=item.service_fee_amount,
                service_fee_mode=item.service_fee_mode,
                status=item.status,
                created_at=item.created_at,
            )
            for item in rows
        ],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/invoices", response_model=PageResponse[InvoiceListItemResponse])
async def list_invoices(
    current_user: AnyUser,
    db: DbSession,
    status_value: str | None = Query(default=None, alias="status"),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    cashier_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> PageResponse[InvoiceListItemResponse]:
    stmt = select(Invoice).order_by(Invoice.created_at.desc())
    stmt = invoice_status_filter(stmt, status_value)
    stmt = invoice_search_filter(stmt, search)

    # Staff can only view their own invoices; managers and owners see all.
    if current_user.role not in {ROLE_OWNER, ROLE_MANAGER}:
        stmt = stmt.where(Invoice.created_by == current_user.sub)
    elif cashier_id is not None and cashier_id.strip():
        stmt = stmt.where(Invoice.created_by == cashier_id.strip())

    if date_from is not None:
        stmt = stmt.where(func.date(Invoice.created_at) >= date_from)
    if date_to is not None:
        stmt = stmt.where(func.date(Invoice.created_at) <= date_to)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[InvoiceListItemResponse](
        items=[
            InvoiceListItemResponse(
                id=item.id,
                code=item.code,
                customer_name=item.customer_name,
                customer_phone=item.customer_phone,
                total_amount=item.total_amount,
                rounding_adjustment_amount=item.rounding_adjustment_amount,
                amount_paid=item.amount_paid,
                payment_method=item.payment_method,
                service_fee_amount=item.service_fee_amount,
                service_fee_mode=item.service_fee_mode,
                status=item.status,
                cashier_name=item.created_by_name,
                created_at=item.created_at,
            )
            for item in rows
        ],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.get("/invoices/{invoice_id}", response_model=InvoiceResponse)
async def get_invoice(invoice_id: UUID, _: AnyUser, db: DbSession) -> InvoiceResponse:
    invoice = await _get_invoice_with_details(invoice_id, db)
    return InvoiceResponse.model_validate(invoice)


@router.get("/invoices/code/{code}", response_model=InvoiceResponse)
async def get_invoice_by_code(code: str, _: AnyUser, db: DbSession) -> InvoiceResponse:
    invoice = await get_invoice_by_code_or_404(code, db)
    invoice = await _get_invoice_with_details(invoice.id, db)
    return InvoiceResponse.model_validate(invoice)


@router.post("/invoices", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
async def create_invoice(
    payload: InvoiceCreateRequest,
    current_user: AnyUser,
    token: AccessToken,
    db: DbSession,
) -> InvoiceResponse:
    invoice = await process_checkout(payload, current_user, token, db)
    await publish_sale_event(
        event_type="sale.invoice.created",
        routing_key="sale.invoice.created",
        payload=_invoice_event_payload(invoice),
    )
    return InvoiceResponse.model_validate(invoice)


@router.post("/invoices/{invoice_id}/collect-payment", response_model=InvoiceResponse)
async def collect_invoice_payment(
    invoice_id: UUID,
    payload: InvoiceCollectPaymentRequest,
    current_user: AnyUser,
    db: DbSession,
) -> InvoiceResponse:
    invoice = await _get_invoice_with_details(invoice_id, db)
    if invoice.status != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only completed invoices can collect debt payments")

    outstanding_before = _normalize_decimal(max(invoice.total_amount - invoice.amount_paid, Decimal("0.00")))
    if outstanding_before <= Decimal("0.00"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Invoice does not have outstanding debt")

    payment_method = payload.payment_method.strip().lower()
    if payment_method in {"mixed", "debt"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment method is not valid for debt collection")

    payment_methods = await list_active_payment_methods_map(db)
    payment_method_item = payment_methods.get(payment_method)
    if payment_method_item is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Payment method '{payment_method}' is not available")
    if payment_method_item.requires_reference and not payload.reference_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Payment method '{payment_method}' requires reference_code",
        )

    collect_amount = _normalize_decimal(payload.amount or Decimal("0.00"))
    if outstanding_before > MIN_DEBT_AMOUNT_AFTER_ROUNDING and collect_amount <= Decimal("0.00"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Collection amount must be greater than 0")
    if collect_amount > outstanding_before:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Collection amount cannot exceed outstanding debt")

    if collect_amount > Decimal("0.00"):
        invoice.amount_paid = _normalize_decimal(invoice.amount_paid + collect_amount)
        db.add(
            InvoicePayment(
                invoice_id=invoice.id,
                payment_method=payment_method,
                amount=collect_amount,
                reference_code=payload.reference_code,
                note=payload.note,
            )
        )

    invoice.total_amount, invoice.rounding_adjustment_amount, debt_amount, invoice.change_amount = _apply_minimum_debt_threshold(
        invoice.total_amount,
        invoice.amount_paid,
        invoice.rounding_adjustment_amount,
    )
    if outstanding_before > Decimal("0.00") or invoice.payment_method == "debt":
        invoice.payment_method = "debt"
    elif debt_amount <= Decimal("0.00"):
        invoice.payment_method = payment_method

    await db.commit()

    refreshed = await _get_invoice_with_details(invoice.id, db)

    await publish_sale_event(
        event_type="sale.invoice.payment_collected",
        routing_key="sale.invoice.payment_collected",
        payload={
            **_invoice_event_payload(refreshed),
            "collected_amount": _decimal_to_float(collect_amount),
            "collected_method": payment_method,
            "collected_by": current_user.sub,
            "outstanding_before": _decimal_to_float(outstanding_before),
            "outstanding_after": _decimal_to_float(max(refreshed.total_amount - refreshed.amount_paid, Decimal("0.00"))),
            "collection_note": payload.note,
        },
    )

    return InvoiceResponse.model_validate(refreshed)


@router.get("/reports/profit-source", response_model=PageResponse[ProfitSourceInvoiceResponse])
async def list_profit_source_invoices(
    _: AnyUser,
    db: DbSession,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=100, ge=1, le=200),
) -> PageResponse[ProfitSourceInvoiceResponse]:
    stmt = (
        select(Invoice)
        .options(selectinload(Invoice.items))
        .where(Invoice.status.in_(["completed", "returned"]))
        .order_by(Invoice.created_at.desc())
    )
    if date_from is not None:
        stmt = stmt.where(func.date(Invoice.created_at) >= date_from)
    if date_to is not None:
        stmt = stmt.where(func.date(Invoice.created_at) <= date_to)

    rows, meta = await paginate_scalars(db, stmt, page, size)
    return PageResponse[ProfitSourceInvoiceResponse](
        items=[ProfitSourceInvoiceResponse.model_validate(item) for item in rows],
        total=meta.total,
        page=meta.page,
        size=meta.size,
        pages=meta.pages,
    )


@router.post("/invoices/{invoice_id}/cancel")
async def cancel_invoice(
    invoice_id: UUID,
    payload: InvoiceCancelRequest,
    current_user: ManagerOrOwner,
    token: AccessToken,
    db: DbSession,
):
    invoice = await _get_invoice_with_details(invoice_id, db)
    if invoice.status == "cancelled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Invoice already cancelled")
    if invoice.status != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only completed invoices can be cancelled")

    rollback = {
        "stock_returned": True,
        "points_refunded": 0,
        "points_earned_revoked": 0,
        "promotion_usage_revoked": False,
    }

    for item in invoice.items:
        conversion_rate = max(int(item.conversion_rate or 1), 1)
        ok = await inventory_return_stock(item.batch_id, item.quantity * conversion_rate, token)
        rollback["stock_returned"] = rollback["stock_returned"] and ok

    if invoice.customer_id and invoice.points_used > 0:
        try:
            result = await customer_internal_post(
                "points/rollback",
                {
                    "customer_id": str(invoice.customer_id),
                    "points": int(invoice.points_used),
                    "reference_type": "invoice_cancel_redeem",
                    "reference_id": str(invoice.id),
                    "reference_code": invoice.code,
                    "note": "Cancel invoice rollback redeem",
                },
            )
            rollback["points_refunded"] = int(result.get("points_rolled_back", invoice.points_used) or 0)
        except Exception:
            rollback["points_refunded"] = 0

    if invoice.customer_id and invoice.points_earned > 0:
        try:
            result = await customer_internal_post(
                "points/rollback",
                {
                    "customer_id": str(invoice.customer_id),
                    "points": int(invoice.points_earned),
                    "reference_type": "invoice_cancel_earn",
                    "reference_id": str(invoice.id),
                    "reference_code": invoice.code,
                    "note": "Cancel invoice rollback earn",
                },
            )
            rollback["points_earned_revoked"] = int(result.get("points_rolled_back", invoice.points_earned) or 0)
        except Exception:
            rollback["points_earned_revoked"] = 0

    if invoice.promotion_id and invoice.promotion_usage_id:
        try:
            await customer_internal_post(
                "promotions/rollback",
                {
                    "promotion_id": str(invoice.promotion_id),
                    "usage_id": str(invoice.promotion_usage_id),
                    "reason": "Invoice cancelled",
                },
            )
            rollback["promotion_usage_revoked"] = True
        except Exception:
            rollback["promotion_usage_revoked"] = False

    invoice.status = "cancelled"
    invoice.cancelled_at = now_utc()
    invoice.cancelled_by = current_user.sub
    invoice.cancel_reason = payload.reason

    if invoice.shift_id:
        shift = await db.get(Shift, invoice.shift_id)
        if shift is not None:
            shift.total_cancelled = quantize_money(shift.total_cancelled + invoice.total_amount)

    await db.commit()

    await publish_sale_event(
        event_type="sale.invoice.cancelled",
        routing_key="sale.invoice.cancelled",
        payload={
            **_invoice_event_payload(invoice),
            "cancel_reason": invoice.cancel_reason,
            "cancelled_at": invoice.cancelled_at.isoformat() if invoice.cancelled_at else None,
            "cancelled_by": invoice.cancelled_by,
        },
    )

    return {
        "message": "Invoice cancelled",
        "invoice": {
            "id": str(invoice.id),
            "code": invoice.code,
            "status": invoice.status,
            "cancelled_at": invoice.cancelled_at,
            "cancelled_by": invoice.cancelled_by,
            "cancel_reason": invoice.cancel_reason,
        },
        "rollback": rollback,
    }


@router.get("/invoices/{invoice_id}/print", response_model=InvoicePrintResponse)
async def print_invoice_data(invoice_id: UUID, _: AnyUser, token: AccessToken, db: DbSession) -> InvoicePrintResponse:
    invoice = await _get_invoice_with_details(invoice_id, db)
    store = await fetch_store_info(token)
    sale_settings = await fetch_store_settings_group("sale", token)

    payment_name = invoice.payment_method
    if invoice.payment_method == "mixed":
        payment_name = "Thanh toán kết hợp"

    if invoice.payment_method == "debt":
        payment_name = "Mua nợ"

    raw_window_value = sale_settings.get("sale.return_window_value", 7)
    try:
        return_window_value = int(raw_window_value)
    except (TypeError, ValueError):
        return_window_value = 7
    if return_window_value < 0:
        return_window_value = 7

    raw_window_unit = str(sale_settings.get("sale.return_window_unit", "day") or "day").strip().lower()
    return_window_unit = "hour" if raw_window_unit in {"hour", "hours", "gio", "h"} else "day"
    return_window_label = "giờ" if return_window_unit == "hour" else "ngày"

    return InvoicePrintResponse(
        store={
            "name": store.get("name", "Store"),
            "address": store.get("address"),
            "phone": store.get("phone"),
            "tax_code": store.get("tax_code"),
            "license_number": store.get("license_number"),
            "logo_url": store.get("logo_url"),
        },
        invoice={
            "code": invoice.code,
            "date": invoice.created_at.strftime("%d/%m/%Y %H:%M"),
            "cashier": invoice.created_by_name or invoice.created_by,
        },
        customer={
            "name": invoice.customer_name,
            "phone": invoice.customer_phone,
            "tier": invoice.customer_tier,
            "points_before": None,
            "points_after": None,
        },
        items=[
            {
                "name": item.product_name,
                "unit": item.unit_name,
                "qty": item.quantity,
                "price": item.unit_price,
                "amount": item.line_total,
            }
            for item in invoice.items
        ],
        summary={
            "subtotal": invoice.subtotal,
            "tier_discount": invoice.tier_discount,
            "promotion": {
                "code": invoice.promotion_code,
                "amount": invoice.promotion_discount,
            },
            "points_discount": invoice.points_discount,
            "service_fee_amount": invoice.service_fee_amount,
            "service_fee_mode": invoice.service_fee_mode,
            "rounding_adjustment_amount": invoice.rounding_adjustment_amount,
            "total": invoice.total_amount,
        },
        payment={
            "method": payment_name,
            "amount_paid": invoice.amount_paid,
            "change": invoice.change_amount,
            "debt_amount": _normalize_decimal(max(invoice.total_amount - invoice.amount_paid, Decimal("0.00"))),
        },
        points={
            "used": invoice.points_used,
            "earned": invoice.points_earned,
        },
        footer={
            "message": "Cảm ơn quý khách!",
            "return_policy": f"Đổi trả trong {return_window_value} {return_window_label} với hóa đơn",
            "return_window_value": return_window_value,
            "return_window_unit": return_window_unit,
        },
    )


@router.post("/invoices/{invoice_id}/reprint")
async def reprint_invoice(invoice_id: UUID, _: AnyUser, db: DbSession):
    invoice = await get_invoice_or_404(invoice_id, db)
    return {
        "message": "Invoice marked for reprint",
        "invoice_id": str(invoice.id),
        "invoice_code": invoice.code,
    }
