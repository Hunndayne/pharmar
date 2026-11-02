"""Cancel restock/points math, checkout stock compensation guard, and points/rollback payload constraints."""

import re
from decimal import Decimal
from pathlib import Path

from Source import sale

ROUTERS_DIR = Path(__file__).resolve().parents[1] / "Routers"
CUSTOMER_REFERENCE_TYPE_MAX_LEN = 20


def test_restock_quantity_excludes_returned_units():
    assert sale.restock_quantity(10, 4, 1) == 6


def test_restock_quantity_applies_conversion_rate():
    assert sale.restock_quantity(10, 4, 10) == 60


def test_restock_quantity_fully_returned_is_zero():
    assert sale.restock_quantity(5, 5, 1) == 0


def test_restock_quantity_never_negative_and_handles_none():
    assert sale.restock_quantity(3, 5, 1) == 0
    assert sale.restock_quantity(3, None, None) == 3


def test_should_compensate_stock_only_after_reserve_succeeded():
    assert sale.should_compensate_stock({}) is False
    assert sale.should_compensate_stock({"invoice_id": "x"}) is False
    assert sale.should_compensate_stock({"stock_reserved": True}) is True


def test_remaining_points_after_returns_no_returns():
    assert sale.remaining_points_after_returns(30, 100, Decimal("1000"), Decimal("0"), 0) == (30, 100)


def test_remaining_points_after_returns_partial_return():
    # Half the invoice value returned: 50 earned points and 10 redeemed points were already reversed.
    assert sale.remaining_points_after_returns(30, 100, Decimal("1000"), Decimal("500"), 10) == (20, 50)


def test_remaining_points_after_returns_never_negative():
    assert sale.remaining_points_after_returns(5, 10, Decimal("100"), Decimal("200"), 9) == (0, 0)


def test_points_rollback_reference_types_fit_customer_limit():
    literals = []
    for path in ROUTERS_DIR.glob("*.py"):
        literals += re.findall(r'"reference_type":\s*"([^"]+)"', path.read_text(encoding="utf-8"))
    assert literals
    too_long = [value for value in literals if len(value) > CUSTOMER_REFERENCE_TYPE_MAX_LEN]
    assert not too_long


def test_every_points_rollback_payload_sets_mode():
    for path in ROUTERS_DIR.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        calls = text.count('"points/rollback"')
        modes = len(re.findall(r'"mode":\s*"reverse_(?:earn|redeem)"', text))
        assert modes == calls, f"{path.name}: {calls} points/rollback calls but {modes} explicit modes"
