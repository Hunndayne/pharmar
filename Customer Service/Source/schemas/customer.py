from datetime import date, datetime
from decimal import Decimal
from typing import Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


T = TypeVar("T")

GenderType = Literal["male", "female", "other"]
PromotionDiscountType = Literal["percent", "fixed"]
PointTransactionType = Literal["earn", "redeem", "expire", "adjust", "rollback"]


class PageResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int


class CustomerCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str = Field(min_length=1, max_length=20)
    email: EmailStr | None = None
    date_of_birth: date | None = None
    gender: GenderType | None = None
    address: str | None = None
    note: str | None = None
    is_active: bool = True


class CustomerUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    phone: str | None = Field(default=None, min_length=1, max_length=20)
    email: EmailStr | None = None
    date_of_birth: date | None = None
    gender: GenderType | None = None
    address: str | None = None
    note: str | None = None
    is_active: bool | None = None


class CustomerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str
    phone: str
    email: str | None
    date_of_birth: date | None
    gender: str | None
    address: str | None
    current_points: int
    total_points_earned: int
    total_points_used: int
    points_expire_at: date | None
    tier: str
    tier_updated_at: datetime | None
    total_orders: int
    total_spent: Decimal
    last_purchase_at: datetime | None
    is_active: bool
    note: str | None
    created_at: datetime
    updated_at: datetime


class CustomerStatsResponse(BaseModel):
    customer_id: UUID
    customer_code: str
    customer_name: str
    tier: str
    tier_discount_percent: Decimal
    total_orders: int
    total_spent: Decimal
    last_purchase_at: datetime | None
    current_points: int
    total_points_earned: int
    total_points_used: int
    points_expire_at: date | None


class PointTransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    customer_id: UUID
    type: str
    points: int
    balance_after: int
    reference_type: str | None
    reference_id: UUID | None
    reference_code: str | None
    note: str | None
    created_by: str | None
    created_at: datetime


class PointAdjustRequest(BaseModel):
    points: int = Field(description="Can be positive or negative, but not zero")
    note: str | None = None
    reference_type: str | None = Field(default="adjustment", max_length=20)
    reference_id: UUID | None = None
    reference_code: str | None = Field(default=None, max_length=30)

    @field_validator("points")
    @classmethod
    def points_must_not_be_zero(cls, value: int) -> int:
        if value == 0:
            raise ValueError("points must not be zero")
        return value


class TierConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    tier_name: str
    min_points: int
    point_multiplier: Decimal
    discount_percent: Decimal
    benefits: str | None
    display_order: int
    created_at: datetime
    updated_at: datetime


class TierConfigUpdateRequest(BaseModel):
    min_points: int | None = Field(default=None, ge=0)
    point_multiplier: Decimal | None = Field(default=None, ge=0)
    discount_percent: Decimal | None = Field(default=None, ge=0, le=100)
    benefits: str | None = None
    display_order: int | None = None


class PromotionBaseRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    discount_type: PromotionDiscountType | None = None
    discount_value: Decimal | None = Field(default=None, ge=0)
    max_discount: Decimal | None = Field(default=None, ge=0)
    min_order_amount: Decimal | None = Field(default=None, ge=0)
    start_date: date | None = None
    end_date: date | None = None
    applicable_tiers: list[str] | None = None
    applicable_products: list[UUID] | None = None
    applicable_groups: list[UUID] | None = None
    usage_limit: int | None = Field(default=None, ge=0)
    usage_per_customer: int | None = Field(default=None, ge=0)
    is_active: bool | None = None
    auto_apply: bool | None = None

    @field_validator("applicable_tiers")
    @classmethod
    def normalize_applicable_tiers(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized = [item.strip().lower() for item in value if item and item.strip()]
        return list(dict.fromkeys(normalized)) or None

    @model_validator(mode="after")
    def validate_dates(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be >= start_date")
        if self.discount_type == "percent" and self.discount_value is not None and self.discount_value > 100:
            raise ValueError("discount_value for percent discount must be <= 100")
        return self


class PromotionCreateRequest(PromotionBaseRequest):
    code: str = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1, max_length=200)
    discount_type: PromotionDiscountType
    discount_value: Decimal = Field(ge=0)
    start_date: date
    end_date: date
    is_active: bool = True
    auto_apply: bool = False

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class PromotionUpdateRequest(PromotionBaseRequest):
    code: str | None = Field(default=None, min_length=1, max_length=30)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip().upper()


class PromotionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    name: str
    description: str | None
    discount_type: str
    discount_value: Decimal
    max_discount: Decimal | None
    min_order_amount: Decimal | None
    start_date: date
    end_date: date
    applicable_tiers: list[str] | None
    applicable_products: list[UUID] | None
    applicable_groups: list[UUID] | None
    usage_limit: int | None
    usage_per_customer: int | None
    current_usage: int
    is_active: bool
    auto_apply: bool
    created_by: str | None
    created_at: datetime
    updated_at: datetime


class PromotionUsageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    promotion_id: UUID
    customer_id: UUID | None
    invoice_id: UUID
    invoice_code: str | None
    discount_amount: Decimal
    is_cancelled: bool
    cancelled_reason: str | None
    cancelled_at: datetime | None
    created_at: datetime


class CustomerLookupRequest(BaseModel):
    phone: str = Field(min_length=1, max_length=20)


class CustomerLookupResponse(BaseModel):
    found: bool
    customer: dict | None


class PointsCalculateRequest(BaseModel):
    customer_id: UUID
    order_amount: Decimal = Field(ge=0)


class PointsCalculateResponse(BaseModel):
    base_points: int
    tier_multiplier: Decimal
    points_earned: int


class PointsEarnRequest(BaseModel):
    customer_id: UUID
    points: int = Field(gt=0)
    reference_type: str = Field(default="invoice", max_length=20)
    reference_id: UUID | None = None
    reference_code: str | None = Field(default=None, max_length=30)
    note: str | None = None


class PointsEarnResponse(BaseModel):
    success: bool
    points_earned: int
    new_balance: int
    tier_changed: bool
    new_tier: str


class PointsRedeemRequest(BaseModel):
    customer_id: UUID
    points: int = Field(gt=0)
    reference_type: str = Field(default="invoice", max_length=20)
    reference_id: UUID | None = None
    reference_code: str | None = Field(default=None, max_length=30)
    note: str | None = None


class PointsRedeemResponse(BaseModel):
    success: bool
    points_used: int
    discount_amount: Decimal
    new_balance: int


class PointsRollbackRequest(BaseModel):
    customer_id: UUID
    points: int = Field(gt=0)
    reference_type: str = Field(default="invoice_cancel", max_length=20)
    reference_id: UUID | None = None
    reference_code: str | None = Field(default=None, max_length=30)
    note: str | None = None


class PointsRollbackResponse(BaseModel):
    success: bool
    rollback_mode: Literal["reverse_earn", "reverse_redeem"]
    points_rolled_back: int
    new_balance: int


class PromotionValidateRequest(BaseModel):
    promotion_code: str = Field(min_length=1, max_length=30)
    customer_id: UUID | None = None
    order_amount: Decimal = Field(ge=0)
    product_ids: list[UUID] | None = None
    group_ids: list[UUID] | None = None

    @field_validator("promotion_code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class PromotionValidateResponse(BaseModel):
    valid: bool
    promotion: dict | None = None
    calculated_discount: Decimal | None = None
    reason: str | None = None


class PromotionApplyRequest(BaseModel):
    promotion_code: str = Field(min_length=1, max_length=30)
    customer_id: UUID | None = None
    order_amount: Decimal = Field(ge=0)
    product_ids: list[UUID] | None = None
    group_ids: list[UUID] | None = None
    invoice_id: UUID
    invoice_code: str | None = Field(default=None, max_length=30)

    @field_validator("promotion_code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class PromotionApplyResponse(BaseModel):
    success: bool
    usage_id: UUID
    promotion_id: UUID
    promotion_code: str
    discount_amount: Decimal
    current_usage: int


class PromotionRollbackRequest(BaseModel):
    promotion_id: UUID
    usage_id: UUID
    reason: str | None = None


class PromotionRollbackResponse(BaseModel):
    success: bool
    promotion_id: UUID
    new_usage_count: int


class PromotionSuggestionItem(BaseModel):
    promotion: dict
    discount_amount: Decimal
    auto_apply: bool


class PromotionSuggestResponse(BaseModel):
    suggestions: list[PromotionSuggestionItem]
    best_auto_apply: dict | None


class StatsUpdateRequest(BaseModel):
    customer_id: UUID
    order_amount: Decimal = Field(ge=0)
    purchased_at: datetime | None = None


class StatsUpdateResponse(BaseModel):
    success: bool
    total_orders: int
    total_spent: Decimal
    last_purchase_at: datetime | None
