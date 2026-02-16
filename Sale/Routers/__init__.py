from .HeldOrders import router as held_orders_router
from .Invoices import router as invoices_router
from .PaymentMethods import router as payment_methods_router
from .Returns import router as returns_router
from .Shifts import router as shifts_router
from .Stats import router as stats_router

__all__ = [
    "payment_methods_router",
    "invoices_router",
    "held_orders_router",
    "returns_router",
    "shifts_router",
    "stats_router",
]
