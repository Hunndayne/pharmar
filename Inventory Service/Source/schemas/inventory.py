from datetime import date

from pydantic import BaseModel, Field, model_validator

from ..domain import BatchStatus, PaymentMethod, PaymentStatus, PromoType


class ReserveItemRequest(BaseModel):
    sku: str = Field(min_length=1, max_length=64)
    quantity: int = Field(gt=0)


class ReserveRequest(BaseModel):
    sale_id: str = Field(min_length=1, max_length=64)
    items: list[ReserveItemRequest] = Field(min_length=1)


class ImportReceiptLineUnitPriceRequest(BaseModel):
    unit_id: str = Field(min_length=1, max_length=64)
    unit_name: str = Field(min_length=1, max_length=64)
    conversion: int = Field(ge=1)
    price: float = Field(ge=0)


class ImportReceiptLineRequest(BaseModel):
    drug_id: str | None = Field(default=None, max_length=64)
    drug_code: str | None = Field(default=None, max_length=64)
    batch_code: str | None = Field(default=None, max_length=64)
    lot_number: str = Field(min_length=1, max_length=64)
    quantity: int = Field(gt=0)
    mfg_date: date
    exp_date: date
    import_price: float = Field(ge=0)
    barcode: str | None = Field(default=None, max_length=128)
    promo_type: PromoType = PromoType.NONE
    promo_buy_qty: int | None = Field(default=None, ge=1)
    promo_get_qty: int | None = Field(default=None, ge=1)
    promo_discount_percent: float | None = Field(default=None, gt=0, le=100)
    unit_prices: list[ImportReceiptLineUnitPriceRequest] = Field(default_factory=list)
    promo_note: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def validate_line(self):
        if not self.drug_id and not self.drug_code:
            raise ValueError("Either drug_id or drug_code is required")
        if self.exp_date <= self.mfg_date:
            raise ValueError("exp_date must be later than mfg_date")
        if self.promo_type == PromoType.BUY_X_GET_Y:
            if self.promo_buy_qty is None or self.promo_get_qty is None:
                raise ValueError("promo_buy_qty and promo_get_qty are required for buy_x_get_y")
        if self.promo_type == PromoType.DISCOUNT_PERCENT and self.promo_discount_percent is None:
            raise ValueError("promo_discount_percent is required for discount_percent")
        return self


class ImportReceiptCreateRequest(BaseModel):
    receipt_date: date
    supplier_id: str = Field(min_length=1, max_length=64)
    shipping_carrier: str | None = Field(default=None, max_length=64)
    payment_status: PaymentStatus = PaymentStatus.PAID
    payment_method: PaymentMethod = PaymentMethod.BANK
    note: str | None = Field(default=None, max_length=500)
    lines: list[ImportReceiptLineRequest] = Field(min_length=1)


class ImportReceiptUpdateRequest(BaseModel):
    receipt_date: date
    supplier_id: str = Field(min_length=1, max_length=64)
    shipping_carrier: str | None = Field(default=None, max_length=64)
    payment_status: PaymentStatus = PaymentStatus.PAID
    payment_method: PaymentMethod = PaymentMethod.BANK
    note: str | None = Field(default=None, max_length=500)
    lines: list[ImportReceiptLineRequest] = Field(min_length=1)


class BatchStatusUpdateRequest(BaseModel):
    status: BatchStatus


class StockAdjustmentRequest(BaseModel):
    batch_id: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1, max_length=255)
    note: str | None = Field(default=None, max_length=500)
    quantity_delta: int | None = None
    new_quantity: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_qty(self):
        has_delta = self.quantity_delta is not None
        has_new = self.new_quantity is not None
        if has_delta == has_new:
            raise ValueError("Provide exactly one of quantity_delta or new_quantity")
        if self.quantity_delta == 0:
            raise ValueError("quantity_delta cannot be 0")
        return self
