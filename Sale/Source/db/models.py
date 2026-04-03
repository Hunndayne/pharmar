from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


SCHEMA_NAME = "sale"


class PaymentMethod(Base):
    __tablename__ = "payment_methods"
    __table_args__ = (
        Index("idx_payment_methods_active", "is_active"),
        {"schema": SCHEMA_NAME},
    )

    code: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requires_reference: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (
        Index("idx_invoices_code", "code"),
        Index("idx_invoices_customer", "customer_id"),
        Index("idx_invoices_status", "status"),
        Index("idx_invoices_created", "created_at"),
        Index("idx_invoices_shift", "shift_id"),
        Index("idx_invoices_cashier", "created_by", "created_at"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)

    customer_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    customer_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    customer_tier: Mapped[str | None] = mapped_column(String(20), nullable=True)

    subtotal: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    tier_discount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    promotion_discount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    points_discount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    total_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    rounding_adjustment_amount: Mapped[Decimal] = mapped_column(
        Numeric(15, 2),
        nullable=False,
        default=Decimal("0.00"),
    )

    points_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    points_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    promotion_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    promotion_usage_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    promotion_code: Mapped[str | None] = mapped_column(String(30), nullable=True)

    payment_method: Mapped[str] = mapped_column(String(20), nullable=False)
    service_fee_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    service_fee_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="split")
    amount_paid: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    change_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="completed")
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    cashier_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    commission_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=Decimal("0.00"))
    commission_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    shift_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)

    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    items: Mapped[list["InvoiceItem"]] = relationship(back_populates="invoice", cascade="all, delete-orphan")
    payments: Mapped[list["InvoicePayment"]] = relationship(back_populates="invoice", cascade="all, delete-orphan")


class InvoiceItem(Base):
    __tablename__ = "invoice_items"
    __table_args__ = (
        Index("idx_invoice_items_invoice", "invoice_id"),
        Index("idx_invoice_items_product", "product_id"),
        Index("idx_invoice_items_batch", "batch_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    invoice_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.invoices.id", ondelete="CASCADE"),
        nullable=False,
    )

    product_id: Mapped[str] = mapped_column(String(64), nullable=False)
    product_code: Mapped[str] = mapped_column(String(50), nullable=False)
    product_name: Mapped[str] = mapped_column(String(300), nullable=False)

    unit_id: Mapped[str] = mapped_column(String(64), nullable=False)
    unit_name: Mapped[str] = mapped_column(String(30), nullable=False)
    conversion_rate: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    batch_id: Mapped[str] = mapped_column(String(64), nullable=False)
    lot_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0.00"))
    line_total: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)

    returned_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    invoice: Mapped[Invoice] = relationship(back_populates="items")


class InvoicePayment(Base):
    __tablename__ = "invoice_payments"
    __table_args__ = (
        Index("idx_invoice_payments_invoice", "invoice_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    invoice_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.invoices.id", ondelete="CASCADE"),
        nullable=False,
    )
    payment_method: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    reference_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    card_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    card_last_4: Mapped[str | None] = mapped_column(String(4), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    invoice: Mapped[Invoice] = relationship(back_populates="payments")


class HeldOrder(Base):
    __tablename__ = "held_orders"
    __table_args__ = (
        Index("idx_held_orders_status", "status"),
        Index("idx_held_orders_created_by", "created_by"),
        Index("idx_held_orders_expires", "expires_at"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)

    customer_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    customer_tier: Mapped[str | None] = mapped_column(String(20), nullable=True)

    items: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))

    promotion_code: Mapped[str | None] = mapped_column(String(30), nullable=True)
    points_to_use: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    resumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resumed_invoice_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)


class Return(Base):
    __tablename__ = "returns"
    __table_args__ = (
        Index("idx_returns_invoice", "invoice_id"),
        Index("idx_returns_status", "status"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)

    invoice_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.invoices.id"),
        nullable=False,
    )
    invoice_code: Mapped[str] = mapped_column(String(30), nullable=False)

    customer_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    total_return_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    points_returned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    refund_method: Mapped[str | None] = mapped_column(String(20), nullable=True)
    refund_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    items: Mapped[list["ReturnItem"]] = relationship(back_populates="return_doc", cascade="all, delete-orphan")


class ReturnItem(Base):
    __tablename__ = "return_items"
    __table_args__ = (
        Index("idx_return_items_return", "return_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    return_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.returns.id", ondelete="CASCADE"),
        nullable=False,
    )
    invoice_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.invoice_items.id"),
        nullable=False,
    )

    product_id: Mapped[str] = mapped_column(String(64), nullable=False)
    product_name: Mapped[str] = mapped_column(String(300), nullable=False)
    unit_name: Mapped[str] = mapped_column(String(30), nullable=False)
    batch_id: Mapped[str] = mapped_column(String(64), nullable=False)

    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    return_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)

    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    condition: Mapped[str] = mapped_column(String(20), nullable=False, default="good")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    return_doc: Mapped[Return] = relationship(back_populates="items")


class Shift(Base):
    __tablename__ = "shifts"
    __table_args__ = (
        Index("idx_shifts_cashier", "cashier_id"),
        Index("idx_shifts_status", "status"),
        Index("idx_shifts_dates", "started_at", "ended_at"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)

    cashier_id: Mapped[str] = mapped_column(String(64), nullable=False)
    cashier_name: Mapped[str] = mapped_column(String(100), nullable=False)
    cashier_code: Mapped[str | None] = mapped_column(String(20), nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    opening_amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    closing_amount: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    expected_amount: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    difference: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)

    total_invoices: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    total_returns: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    total_cancelled: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    cash_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    card_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    transfer_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    momo_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    zalopay_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    vnpay_sales: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
