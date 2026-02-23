from datetime import datetime
from decimal import Decimal
from typing import Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


T = TypeVar("T")


class PageResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int


class DrugGroupCreateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class DrugGroupUpdateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    is_active: bool | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class DrugGroupResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str
    description: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ManufacturerCreateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str = Field(min_length=1, max_length=200)
    country: str | None = Field(default=None, max_length=50)
    address: str | None = None
    phone: str | None = Field(default=None, max_length=20)
    is_active: bool = True

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class ManufacturerUpdateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    country: str | None = Field(default=None, max_length=50)
    address: str | None = None
    phone: str | None = Field(default=None, max_length=20)
    is_active: bool | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class ManufacturerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str
    country: str | None
    address: str | None
    phone: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class SupplierCreateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str = Field(min_length=1, max_length=200)
    address: str | None = None
    phone: str = Field(min_length=1, max_length=20)
    email: EmailStr | None = None
    tax_code: str | None = Field(default=None, max_length=20)
    contact_person: str | None = Field(default=None, max_length=100)
    current_debt: Decimal = Field(default=Decimal("0.00"), ge=0)
    is_active: bool = True
    note: str | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class SupplierUpdateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    address: str | None = None
    phone: str | None = Field(default=None, min_length=1, max_length=20)
    email: EmailStr | None = None
    tax_code: str | None = Field(default=None, max_length=20)
    contact_person: str | None = Field(default=None, max_length=100)
    is_active: bool | None = None
    note: str | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class SupplierResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str
    address: str | None
    phone: str
    email: str | None
    tax_code: str | None
    contact_person: str | None
    current_debt: Decimal
    is_active: bool
    note: str | None
    created_at: datetime
    updated_at: datetime


class SupplierDebtHistoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    supplier_id: UUID
    type: str
    amount: Decimal
    balance_after: Decimal
    reference_type: str | None
    reference_id: UUID | None
    note: str | None
    created_by: str | None
    created_at: datetime


class SupplierDebtPaymentRequest(BaseModel):
    amount: Decimal = Field(gt=0)
    note: str | None = None
    reference_id: UUID | None = None


class SupplierDebtResponse(BaseModel):
    supplier_id: UUID
    supplier_code: str
    supplier_name: str
    current_debt: Decimal
    history: PageResponse[SupplierDebtHistoryResponse]


class ProductBaseUnitRequest(BaseModel):
    unit_name: str = Field(min_length=1, max_length=30)
    selling_price: Decimal = Field(ge=0)


class ProductCreateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    barcode: str | None = Field(default=None, max_length=50)
    name: str = Field(min_length=1, max_length=300)
    active_ingredient: str | None = Field(default=None, max_length=300)
    registration_number: str | None = Field(default=None, max_length=50)
    group_id: UUID | None = None
    manufacturer_id: UUID | None = None
    instructions: str | None = None
    note: str | None = None
    vat_rate: Decimal = Field(default=Decimal("0.00"), ge=0, le=100)
    other_tax_rate: Decimal = Field(default=Decimal("0.00"), ge=0, le=100)
    is_active: bool = True
    base_unit: ProductBaseUnitRequest | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class ProductUpdateRequest(BaseModel):
    code: str | None = Field(default=None, max_length=20)
    barcode: str | None = Field(default=None, max_length=50)
    name: str | None = Field(default=None, min_length=1, max_length=300)
    active_ingredient: str | None = Field(default=None, max_length=300)
    registration_number: str | None = Field(default=None, max_length=50)
    group_id: UUID | None = None
    manufacturer_id: UUID | None = None
    instructions: str | None = None
    note: str | None = None
    vat_rate: Decimal | None = Field(default=None, ge=0, le=100)
    other_tax_rate: Decimal | None = Field(default=None, ge=0, le=100)
    is_active: bool | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = value.strip().upper()
        return normalized or None


class ProductGroupRef(BaseModel):
    id: UUID
    code: str
    name: str


class ProductManufacturerRef(BaseModel):
    id: UUID
    code: str
    name: str


class ProductUnitResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    product_id: UUID
    unit_name: str
    conversion_rate: int
    barcode: str | None
    selling_price: Decimal
    is_base_unit: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ProductListItemResponse(BaseModel):
    id: UUID
    code: str
    barcode: str | None
    name: str
    active_ingredient: str | None
    registration_number: str | None
    group_name: str | None
    manufacturer_name: str | None
    base_unit: str | None
    base_price: Decimal | None
    vat_rate: Decimal
    other_tax_rate: Decimal
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ProductDetailResponse(BaseModel):
    id: UUID
    code: str
    barcode: str | None
    name: str
    active_ingredient: str | None
    registration_number: str | None
    group: ProductGroupRef | None
    manufacturer: ProductManufacturerRef | None
    instructions: str | None
    note: str | None
    vat_rate: Decimal
    other_tax_rate: Decimal
    is_active: bool
    units: list[ProductUnitResponse]
    created_at: datetime
    updated_at: datetime


class ProductUnitCreateRequest(BaseModel):
    unit_name: str = Field(min_length=1, max_length=30)
    conversion_rate: int = Field(gt=0)
    barcode: str | None = Field(default=None, max_length=50)
    selling_price: Decimal = Field(ge=0)
    is_base_unit: bool = False
    is_active: bool = True


class ProductUnitUpdateRequest(BaseModel):
    unit_name: str | None = Field(default=None, min_length=1, max_length=30)
    conversion_rate: int | None = Field(default=None, gt=0)
    barcode: str | None = Field(default=None, max_length=50)
    selling_price: Decimal | None = Field(default=None, ge=0)
    is_base_unit: bool | None = None
    is_active: bool | None = None


class BarcodeLookupResponse(BaseModel):
    product: ProductListItemResponse
    unit: ProductUnitResponse


class ProductImportResult(BaseModel):
    imported: int
    failed: int
    errors: list[str]
