from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


SCHEMA_NAME = "customer"


class TierConfig(Base):
    __tablename__ = "tier_configs"
    __table_args__ = {"schema": SCHEMA_NAME}

    tier_name: Mapped[str] = mapped_column(String(20), primary_key=True)
    min_points: Mapped[int] = mapped_column(Integer, nullable=False)
    point_multiplier: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False, default=Decimal("1.00"))
    discount_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=Decimal("0.00"))
    benefits: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (
        Index("idx_customers_phone", "phone"),
        Index("idx_customers_code", "code"),
        Index("idx_customers_tier", "tier"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    email: Mapped[str | None] = mapped_column(String(100), nullable=True)
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(10), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    current_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_points_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_points_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    points_expire_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    tier: Mapped[str] = mapped_column(
        String(20),
        ForeignKey(f"{SCHEMA_NAME}.tier_configs.tier_name"),
        nullable=False,
        default="bronze",
    )
    tier_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    total_orders: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_spent: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    last_purchase_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    point_transactions: Mapped[list["PointTransaction"]] = relationship(back_populates="customer")


class PointTransaction(Base):
    __tablename__ = "point_transactions"
    __table_args__ = (
        Index("idx_point_transactions_customer", "customer_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    customer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.customers.id", ondelete="CASCADE"),
        nullable=False,
    )
    transaction_type: Mapped[str] = mapped_column("type", String(20), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reference_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    reference_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    reference_code: Mapped[str | None] = mapped_column(String(30), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    customer: Mapped[Customer] = relationship(back_populates="point_transactions")


class Promotion(Base):
    __tablename__ = "promotions"
    __table_args__ = (
        Index("idx_promotions_code", "code"),
        Index("idx_promotions_dates", "start_date", "end_date"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    discount_type: Mapped[str] = mapped_column(String(20), nullable=False)
    discount_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    max_discount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    min_order_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)

    applicable_tiers: Mapped[list[str] | None] = mapped_column(ARRAY(String(20)), nullable=True)
    applicable_products: Mapped[list[UUID] | None] = mapped_column(ARRAY(PG_UUID(as_uuid=True)), nullable=True)
    applicable_groups: Mapped[list[UUID] | None] = mapped_column(ARRAY(PG_UUID(as_uuid=True)), nullable=True)

    usage_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    usage_per_customer: Mapped[int | None] = mapped_column(Integer, nullable=True)
    current_usage: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    auto_apply: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    usages: Mapped[list["PromotionUsage"]] = relationship(back_populates="promotion")


class PromotionUsage(Base):
    __tablename__ = "promotion_usages"
    __table_args__ = (
        Index("idx_promotion_usages_promotion", "promotion_id"),
        Index("idx_promotion_usages_customer", "customer_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    promotion_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.promotions.id", ondelete="CASCADE"),
        nullable=False,
    )
    customer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.customers.id", ondelete="SET NULL"),
        nullable=True,
    )
    invoice_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    invoice_code: Mapped[str | None] = mapped_column(String(30), nullable=True)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    is_cancelled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cancelled_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    promotion: Mapped[Promotion] = relationship(back_populates="usages")
