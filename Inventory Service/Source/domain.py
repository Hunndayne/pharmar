from enum import Enum


class BatchStatus(str, Enum):
    ACTIVE = "active"
    DEPLETED = "depleted"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class ReceiptStatus(str, Enum):
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"


class PaymentStatus(str, Enum):
    PAID = "paid"
    DEBT = "debt"


class PaymentMethod(str, Enum):
    BANK = "bank"
    EWALLET = "ewallet"
    CARD = "card"


class PromoType(str, Enum):
    NONE = "none"
    BUY_X_GET_Y = "buy_x_get_y"
    DISCOUNT_PERCENT = "discount_percent"


class MovementType(str, Enum):
    IMPORT_RECEIPT = "import_receipt"
    SALE_RESERVE = "sale_reserve"
    STOCK_ADJUSTMENT = "stock_adjustment"
    RECEIPT_CANCEL = "receipt_cancel"
