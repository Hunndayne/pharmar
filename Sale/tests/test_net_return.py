"""net_return_amount — refund net of line discounts and pro-rata invoice-level discounts."""

from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from Source import sale

D = Decimal


def make_invoice(lines, total_amount, service_fee_amount="0", service_fee_mode="split"):
    """lines: list of (unit_price, quantity, line_discount)."""
    items = [
        SimpleNamespace(
            unit_price=D(str(price)),
            quantity=qty,
            discount_amount=D(str(disc)),
            line_total=D(str(price)) * qty - D(str(disc)),
        )
        for price, qty, disc in lines
    ]
    invoice = SimpleNamespace(
        items=items,
        total_amount=D(str(total_amount)),
        service_fee_amount=D(str(service_fee_amount)),
        service_fee_mode=service_fee_mode,
    )
    return invoice


def test_no_discounts_equals_unit_price():
    inv = make_invoice([(10000, 3, 0), (5000, 2, 0)], 40000)
    assert sale.net_return_amount(inv, inv.items[0], 2) == D("20000")
    assert sale.net_return_amount(inv, inv.items[1], 1) == D("5000")


def test_line_discount_only():
    inv = make_invoice([(10000, 4, 4000)], 36000)
    # net unit = 9000
    assert sale.net_return_amount(inv, inv.items[0], 1) == D("9000")
    assert sale.net_return_amount(inv, inv.items[0], 4) == D("36000")


def test_invoice_level_discount_pro_rata():
    # lines 60000 + 40000 = 100000, invoice discount 10% -> total 90000
    inv = make_invoice([(20000, 3, 0), (40000, 1, 0)], 90000)
    assert sale.net_return_amount(inv, inv.items[0], 1) == D("18000")
    assert sale.net_return_amount(inv, inv.items[1], 1) == D("36000")


def test_line_and_invoice_discount_combined():
    inv = make_invoice([(10000, 2, 2000), (10000, 1, 0)], 24300)  # lines 18000+10000=28000, factor 0.8678..
    first = sale.net_return_amount(inv, inv.items[0], 2)
    second = sale.net_return_amount(inv, inv.items[1], 1)
    assert first + second <= inv.total_amount
    assert inv.total_amount - (first + second) <= 1


def test_full_return_sum_never_exceeds_total_amount():
    inv = make_invoice([(3333, 3, 0), (1777, 7, 100), (9999, 1, 0)], 17000)
    total = sum(sale.net_return_amount(inv, row, row.quantity) for row in inv.items)
    assert total <= inv.total_amount
    assert inv.total_amount - total <= len(inv.items)


def test_successive_partial_returns_telescope_to_full_return():
    inv = make_invoice([(3333, 7, 0)], 17000)
    item = inv.items[0]
    full = sale.net_return_amount(inv, item, 7)
    parts = D("0")
    prior = 0
    for qty in (2, 1, 4):
        parts += sale.net_return_amount(inv, item, qty, prior)
        prior += qty
    assert parts == full
    assert full <= inv.total_amount


def test_zero_subtotal_returns_zero():
    inv = make_invoice([(0, 2, 0)], 0)
    assert sale.net_return_amount(inv, inv.items[0], 2) == D("0")


def test_zero_quantity_or_zero_line_quantity_guard():
    inv = make_invoice([(10000, 2, 0)], 20000)
    assert sale.net_return_amount(inv, inv.items[0], 0) == D("0")
    inv.items[0].quantity = 0
    assert sale.net_return_amount(inv, inv.items[0], 1) == D("0")


def test_factor_capped_at_one_when_rounded_up():
    inv = make_invoice([(10000, 1, 0)], 11000)  # customer rounded up; do not refund more than the line
    assert sale.net_return_amount(inv, inv.items[0], 1) == D("10000")


def test_separate_service_fee_is_not_refunded():
    inv = make_invoice([(10000, 2, 0)], 25000, service_fee_amount="5000", service_fee_mode="separate")
    assert sale.net_return_amount(inv, inv.items[0], 2) == D("20000")


def test_clamp_counts_pending_quantity():
    assert sale.clamp_return_quantity(2, 5, 1, 2) == 2
    with pytest.raises(HTTPException) as exc_info:
        sale.clamp_return_quantity(3, 5, 1, 2)
    assert exc_info.value.status_code == 400
