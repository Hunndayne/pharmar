from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


SCHEMA_NAME = "catalog"


class DrugGroup(Base):
    __tablename__ = "drug_groups"
    __table_args__ = (
        Index("idx_drug_groups_code", "code"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    products: Mapped[list["Product"]] = relationship(back_populates="group")


class Manufacturer(Base):
    __tablename__ = "manufacturers"
    __table_args__ = (
        Index("idx_manufacturers_code", "code"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    country: Mapped[str | None] = mapped_column(String(50), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    products: Mapped[list["Product"]] = relationship(back_populates="manufacturer")


class Supplier(Base):
    __tablename__ = "suppliers"
    __table_args__ = (
        Index("idx_suppliers_code", "code"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone: Mapped[str] = mapped_column(String(20), nullable=False)
    email: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tax_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    contact_person: Mapped[str | None] = mapped_column(String(100), nullable=True)
    current_debt: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=Decimal("0.00"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    debt_history: Mapped[list["SupplierDebtHistory"]] = relationship(back_populates="supplier")


class SupplierDebtHistory(Base):
    __tablename__ = "supplier_debt_history"
    __table_args__ = {"schema": SCHEMA_NAME}

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    supplier_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.suppliers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entry_type: Mapped[str] = mapped_column("type", String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    balance_after: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False)
    reference_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    reference_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    supplier: Mapped[Supplier] = relationship(back_populates="debt_history")


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (
        Index("idx_products_code", "code"),
        Index("idx_products_barcode", "barcode"),
        Index("idx_products_group", "group_id"),
        Index("idx_products_manufacturer", "manufacturer_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    barcode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    registration_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    group_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.drug_groups.id"),
        nullable=True,
    )
    manufacturer_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.manufacturers.id"),
        nullable=True,
    )
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    group: Mapped[DrugGroup | None] = relationship(back_populates="products")
    manufacturer: Mapped[Manufacturer | None] = relationship(back_populates="products")
    units: Mapped[list["ProductUnit"]] = relationship(
        back_populates="product",
        cascade="all, delete-orphan",
    )


class ProductUnit(Base):
    __tablename__ = "product_units"
    __table_args__ = (
        UniqueConstraint("product_id", "unit_name", name="uq_product_units_product_unit_name"),
        Index("idx_product_units_barcode", "barcode"),
        Index("idx_product_units_product", "product_id"),
        {"schema": SCHEMA_NAME},
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    product_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.products.id", ondelete="CASCADE"),
        nullable=False,
    )
    unit_name: Mapped[str] = mapped_column(String(30), nullable=False)
    conversion_rate: Mapped[int] = mapped_column(nullable=False, default=1)
    barcode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    selling_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    is_base_unit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    product: Mapped[Product] = relationship(back_populates="units")

