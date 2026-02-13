from enum import Enum


class BatchStatus(str, Enum):
    ACTIVE = "active"
    DEPLETED = "depleted"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class ReceiptStatus(str, Enum):
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"


class MovementType(str, Enum):
    IMPORT_RECEIPT = "import_receipt"
    SALE_RESERVE = "sale_reserve"
    STOCK_ADJUSTMENT = "stock_adjustment"
    RECEIPT_CANCEL = "receipt_cancel"
