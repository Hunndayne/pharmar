from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator, model_validator


T = TypeVar("T")

PaymentMethodCode = Literal["cash", "card", "transfer", "momo", "zalopay", "vnpay", "mixed"]
InvoiceStatus = Literal["pending", "completed", "cancelled", "returned"]
ReturnStatus = Literal["pending", "completed", "rejected"]
HeldOrderStatus = Literal["active", "resumed", "expired", "cancelled"]
ShiftStatus = Literal["open", "closed"]
ServiceFeeMode = Literal["split", "separate"]

MONEY_FIELD_NAMES = (
    "unit_price",
    "discount_amount",
    "amount",
    "service_fee_amount",
    "amount_paid",
    "change_amount",
    "subtotal",
    "total_amount",
    "tier_discount",
    "promotion_discount",
    "points_discount",
    "line_total",
    "return_amount",
    "total_return_amount",
    "refund_amount",
    "opening_amount",
    "closing_amount",
    "expected_amount",
    "difference",
    "total_sales",
    "total_returns",
    "total_cancelled",
    "net_sales",
    "cash_sales",
    "card_sales",
    "transfer_sales",
    "momo_sales",
    "zalopay_sales",
    "vnpay_sales",
    "commission_amount",
    "avg_invoice_value",
)


def _round_money_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        parsed = Decimal("0")
    return parsed.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


class MoneyInputModel(BaseModel):
    @field_validator(*MONEY_FIELD_NAMES, mode="before", check_fields=False)
    @classmethod
    def normalize_money_fields(cls, value: Any) -> Any:
        rounded = _round_money_decimal(value)
        return value if rounded is None else rounded


class MoneyOutputModel(BaseModel):
    @field_serializer(*MONEY_FIELD_NAMES, when_used="json", check_fields=False)
    def serialize_money_fields(self, value: Any) -> Any:
        rounded = _round_money_decimal(value)
        return None if rounded is None else int(rounded)


class PageResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int


class PaymentMethodCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=50)
    is_active: bool = True
    display_order: int = 0
    requires_reference: bool = False

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().lower()


class PaymentMethodUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    is_active: bool | None = None
    display_order: int | None = None
    requires_reference: bool | None = None


class PaymentMethodResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    name: str
    is_active: bool
    display_order: int
    requires_reference: bool
    created_at: datetime


class InvoiceCheckoutItemRequest(MoneyInputModel):
    sku: str | None = Field(default=None, max_length=64)
    product_id: str = Field(min_length=1, max_length=64)
    product_code: str | None = Field(default=None, max_length=50)
    product_name: str | None = Field(default=None, max_length=300)
    unit_id: str = Field(min_length=1, max_length=64)
    unit_name: str | None = Field(default=None, max_length=30)
    conversion_rate: int = Field(default=1, ge=1)
    batch_id: str = Field(min_length=1, max_length=64)
    lot_number: str | None = Field(default=None, max_length=50)
    expiry_date: date | None = None
    quantity: int = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    discount_amount: Decimal = Field(default=Decimal("0.00"), ge=0)


class InvoiceCheckoutPaymentRequest(MoneyInputModel):
    method: str = Field(min_length=1, max_length=20)
    amount: Decimal = Field(gt=0)
    reference_code: str | None = Field(default=None, max_length=50)
    card_type: str | None = Field(default=None, max_length=20)
    card_last_4: str | None = Field(default=None, max_length=4)
    note: str | None = None

    @field_validator("method")
    @classmethod
    def normalize_method(cls, value: str) -> str:
        return value.strip().lower()


class InvoiceCreateRequest(MoneyInputModel):
    customer_id: UUID | None = None
    items: list[InvoiceCheckoutItemRequest] = Field(min_length=1)
    promotion_code: str | None = Field(default=None, max_length=30)
    points_used: int = Field(default=0, ge=0)
    payment_method: str | None = Field(default="cash", max_length=20)
    service_fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0)
    service_fee_mode: ServiceFeeMode = "split"
    amount_paid: Decimal | None = Field(default=None, ge=0)
    payments: list[InvoiceCheckoutPaymentRequest] | None = None
    note: str | None = None

    @field_validator("promotion_code")
    @classmethod
    def normalize_promo_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().upper()
        return cleaned or None

    @field_validator("payment_method")
    @classmethod
    def normalize_payment_method(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None

    @field_validator("service_fee_mode")
    @classmethod
    def normalize_service_fee_mode(cls, value: ServiceFeeMode) -> ServiceFeeMode:
        cleaned = str(value).strip().lower()
        if cleaned not in {"split", "separate"}:
            raise ValueError("service_fee_mode must be split or separate")
        return cleaned  # type: ignore[return-value]

    @model_validator(mode="after")
    def validate_payment_input(self):
        has_mixed = bool(self.payments)
        if has_mixed:
            if self.payment_method is not None and self.payment_method not in {"mixed", ""}:
                self.payment_method = "mixed"
            if self.amount_paid is None:
                self.amount_paid = sum((item.amount for item in self.payments or []), Decimal("0.00"))
        else:
            if self.payment_method is None:
                raise ValueError("payment_method is required when payments is empty")
            if self.amount_paid is None:
                raise ValueError("amount_paid is required when payments is empty")
        return self


class InvoiceItemResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    invoice_id: UUID
    product_id: str
    product_code: str
    product_name: str
    unit_id: str
    unit_name: str
    conversion_rate: int
    batch_id: str
    lot_number: str | None
    expiry_date: date | None
    unit_price: Decimal
    quantity: int
    discount_amount: Decimal
    line_total: Decimal
    returned_quantity: int
    created_at: datetime


class InvoicePaymentResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    invoice_id: UUID
    payment_method: str
    amount: Decimal
    reference_code: str | None
    card_type: str | None
    card_last_4: str | None
    note: str | None
    created_at: datetime


class InvoiceResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    customer_id: UUID | None
    customer_code: str | None
    customer_name: str | None
    customer_phone: str | None
    customer_tier: str | None
    subtotal: Decimal
    discount_amount: Decimal
    tier_discount: Decimal
    promotion_discount: Decimal
    points_discount: Decimal
    total_amount: Decimal
    points_used: int
    points_earned: int
    promotion_id: UUID | None
    promotion_usage_id: UUID | None
    promotion_code: str | None
    payment_method: str
    service_fee_amount: Decimal
    service_fee_mode: str
    amount_paid: Decimal
    change_amount: Decimal
    status: str
    cancelled_at: datetime | None
    cancelled_by: str | None
    cancel_reason: str | None
    created_by: str
    created_by_name: str | None
    cashier_code: str | None
    commission_rate: Decimal
    commission_amount: Decimal
    shift_id: UUID | None
    note: str | None
    created_at: datetime
    updated_at: datetime
    items: list[InvoiceItemResponse] = []
    payments: list[InvoicePaymentResponse] = []


class InvoiceListItemResponse(MoneyOutputModel):
    id: UUID
    code: str
    customer_name: str | None
    customer_phone: str | None
    total_amount: Decimal
    amount_paid: Decimal
    payment_method: str
    service_fee_amount: Decimal
    service_fee_mode: str
    status: str
    cashier_name: str | None
    created_at: datetime


class PublicInvoiceListItemResponse(MoneyOutputModel):
    id: UUID
    code: str
    customer_name: str | None
    customer_phone: str | None
    total_amount: Decimal
    amount_paid: Decimal
    payment_method: str
    service_fee_amount: Decimal
    service_fee_mode: str
    status: str
    created_at: datetime


class PublicInvoiceItemResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    product_code: str
    product_name: str
    unit_name: str
    lot_number: str | None
    expiry_date: date | None
    unit_price: Decimal
    quantity: int
    discount_amount: Decimal
    line_total: Decimal
    returned_quantity: int
    created_at: datetime


class PublicInvoicePaymentResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    payment_method: str
    amount: Decimal
    note: str | None
    created_at: datetime


class PublicInvoiceResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    customer_name: str | None
    customer_phone: str | None
    customer_tier: str | None
    subtotal: Decimal
    discount_amount: Decimal
    tier_discount: Decimal
    promotion_discount: Decimal
    points_discount: Decimal
    total_amount: Decimal
    points_used: int
    points_earned: int
    promotion_code: str | None
    payment_method: str
    service_fee_amount: Decimal
    service_fee_mode: str
    amount_paid: Decimal
    change_amount: Decimal
    status: str
    cancel_reason: str | None
    note: str | None
    created_at: datetime
    updated_at: datetime
    items: list[PublicInvoiceItemResponse] = []
    payments: list[PublicInvoicePaymentResponse] = []


class InvoiceCancelRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class HeldOrderItemRequest(MoneyInputModel):
    product_id: str = Field(min_length=1, max_length=64)
    product_code: str | None = Field(default=None, max_length=50)
    product_name: str | None = Field(default=None, max_length=300)
    unit_id: str = Field(min_length=1, max_length=64)
    unit_name: str | None = Field(default=None, max_length=30)
    batch_id: str = Field(min_length=1, max_length=64)
    quantity: int = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    line_total: Decimal | None = Field(default=None, ge=0)


class HeldOrderCreateRequest(MoneyInputModel):
    customer_id: UUID | None = None
    customer_name: str | None = Field(default=None, max_length=100)
    customer_phone: str | None = Field(default=None, max_length=20)
    customer_tier: str | None = Field(default=None, max_length=20)
    items: list[HeldOrderItemRequest] = Field(min_length=1)
    subtotal: Decimal = Field(default=Decimal("0.00"), ge=0)
    promotion_code: str | None = Field(default=None, max_length=30)
    points_to_use: int = Field(default=0, ge=0)
    priority: int = 0
    note: str | None = None


class HeldOrderUpdateRequest(MoneyInputModel):
    customer_id: UUID | None = None
    customer_name: str | None = Field(default=None, max_length=100)
    customer_phone: str | None = Field(default=None, max_length=20)
    customer_tier: str | None = Field(default=None, max_length=20)
    items: list[HeldOrderItemRequest] | None = None
    subtotal: Decimal | None = Field(default=None, ge=0)
    promotion_code: str | None = Field(default=None, max_length=30)
    points_to_use: int | None = Field(default=None, ge=0)
    priority: int | None = None
    note: str | None = None


class HeldOrderResumeRequest(MoneyInputModel):
    additional_items: list[InvoiceCheckoutItemRequest] = Field(default_factory=list)
    payment_method: str | None = Field(default="cash", max_length=20)
    amount_paid: Decimal | None = Field(default=None, ge=0)
    payments: list[InvoiceCheckoutPaymentRequest] | None = None
    note: str | None = None


class HeldOrderResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    customer_id: UUID | None
    customer_name: str | None
    customer_phone: str | None
    customer_tier: str | None
    items: list[dict[str, Any]]
    subtotal: Decimal
    promotion_code: str | None
    points_to_use: int
    status: str
    expires_at: datetime
    priority: int
    note: str | None
    created_by: str
    created_by_name: str | None
    created_at: datetime
    resumed_at: datetime | None
    resumed_invoice_id: UUID | None


class ReturnCreateItemRequest(BaseModel):
    invoice_item_id: UUID
    quantity: int = Field(gt=0)
    reason: str | None = None
    condition: Literal["good", "damaged", "expired"] = "good"


class ReturnCreateRequest(BaseModel):
    invoice_id: UUID
    items: list[ReturnCreateItemRequest] = Field(min_length=1)
    refund_method: Literal["cash", "card", "points"] = "cash"
    reason: str | None = None


class ReturnRejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class ProfitSourceInvoiceItemResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    product_id: str
    product_code: str
    product_name: str
    unit_name: str
    conversion_rate: int
    batch_id: str
    quantity: int
    returned_quantity: int
    unit_price: Decimal
    line_total: Decimal


class ProfitSourceInvoiceResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    customer_name: str | None
    customer_phone: str | None
    payment_method: str
    status: str
    subtotal: Decimal
    total_amount: Decimal
    amount_paid: Decimal
    change_amount: Decimal
    tier_discount: Decimal
    promotion_discount: Decimal
    points_discount: Decimal
    service_fee_amount: Decimal
    service_fee_mode: str
    note: str | None
    created_at: datetime
    updated_at: datetime
    items: list[ProfitSourceInvoiceItemResponse] = []


class ReturnItemResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    return_id: UUID
    invoice_item_id: UUID
    product_id: str
    product_name: str
    unit_name: str
    batch_id: str
    quantity: int
    unit_price: Decimal
    return_amount: Decimal
    reason: str | None
    condition: str
    created_at: datetime


class ReturnResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    invoice_id: UUID
    invoice_code: str
    customer_id: UUID | None
    customer_name: str | None
    total_return_amount: Decimal
    points_returned: int
    refund_method: str | None
    refund_amount: Decimal
    status: str
    reason: str | None
    created_by: str
    created_by_name: str | None
    approved_by: str | None
    approved_at: datetime | None
    created_at: datetime
    items: list[ReturnItemResponse] = []


class ShiftOpenRequest(MoneyInputModel):
    opening_amount: Decimal = Field(default=Decimal("0.00"), ge=0)
    note: str | None = None


class ShiftCloseRequest(MoneyInputModel):
    closing_amount: Decimal = Field(ge=0)
    note: str | None = None


class ShiftResponse(MoneyOutputModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    code: str
    cashier_id: str
    cashier_name: str
    cashier_code: str | None
    started_at: datetime
    ended_at: datetime | None
    opening_amount: Decimal
    closing_amount: Decimal | None
    expected_amount: Decimal | None
    difference: Decimal | None
    total_invoices: int
    total_sales: Decimal
    total_returns: Decimal
    total_cancelled: Decimal
    cash_sales: Decimal
    card_sales: Decimal
    transfer_sales: Decimal
    momo_sales: Decimal
    zalopay_sales: Decimal
    vnpay_sales: Decimal
    status: str
    note: str | None
    created_at: datetime
    updated_at: datetime


class ShiftReportResponse(BaseModel):
    shift: ShiftResponse
    summary: dict[str, Any]
    payment_breakdown: dict[str, Decimal]
    cash_flow: dict[str, Decimal]
    invoices: list[dict[str, Any]]


class StatsTodayResponse(MoneyOutputModel):
    date: date
    total_invoices: int
    total_sales: Decimal
    total_returns: Decimal
    total_cancelled: Decimal
    net_sales: Decimal


class CashierStatsItemResponse(MoneyOutputModel):
    user_id: str
    user_code: str | None
    user_name: str | None
    total_invoices: int
    total_sales: Decimal
    total_returns: Decimal
    net_sales: Decimal
    commission_rate: Decimal
    commission_amount: Decimal
    avg_invoice_value: Decimal


class CashierStatsResponse(BaseModel):
    period: dict[str, date]
    cashiers: list[CashierStatsItemResponse]
    totals: dict[str, Decimal | int]


class InvoicePrintResponse(BaseModel):
    store: dict[str, Any]
    invoice: dict[str, Any]
    customer: dict[str, Any]
    items: list[dict[str, Any]]
    summary: dict[str, Any]
    payment: dict[str, Any]
    points: dict[str, Any]
    footer: dict[str, Any]
