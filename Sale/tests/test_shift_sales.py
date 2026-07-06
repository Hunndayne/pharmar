"""update_shift_sales_by_method — tested with a simple stub Shift-like object."""

from decimal import Decimal
from types import SimpleNamespace

from Source import sale


def make_shift(**overrides):
    fields = dict(
        cash_sales=Decimal("0"),
        card_sales=Decimal("0"),
        transfer_sales=Decimal("0"),
        momo_sales=Decimal("0"),
        zalopay_sales=Decimal("0"),
        vnpay_sales=Decimal("0"),
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


def test_update_shift_sales_cash_accumulates_and_rounds():
    shift = make_shift(cash_sales=Decimal("100"))
    sale.update_shift_sales_by_method(shift, "cash", Decimal("50.6"))
    assert shift.cash_sales == Decimal("151")  # 50.6 rounds to 51 first


def test_update_shift_sales_card():
    shift = make_shift(card_sales=Decimal("10"))
    sale.update_shift_sales_by_method(shift, "card", Decimal("5"))
    assert shift.card_sales == Decimal("15")


def test_update_shift_sales_transfer_method():
    shift = make_shift()
    sale.update_shift_sales_by_method(shift, "transfer", Decimal("20"))
    assert shift.transfer_sales == Decimal("20")


def test_update_shift_sales_bank_method_also_lands_in_transfer_bucket():
    # "bank" and "transfer" share the same transfer_sales accumulator.
    shift = make_shift(transfer_sales=Decimal("30"))
    sale.update_shift_sales_by_method(shift, "bank", Decimal("20"))
    assert shift.transfer_sales == Decimal("50")


def test_update_shift_sales_momo():
    shift = make_shift()
    sale.update_shift_sales_by_method(shift, "momo", Decimal("15"))
    assert shift.momo_sales == Decimal("15")


def test_update_shift_sales_zalopay():
    shift = make_shift()
    sale.update_shift_sales_by_method(shift, "zalopay", Decimal("25"))
    assert shift.zalopay_sales == Decimal("25")


def test_update_shift_sales_vnpay():
    shift = make_shift()
    sale.update_shift_sales_by_method(shift, "vnpay", Decimal("35"))
    assert shift.vnpay_sales == Decimal("35")


def test_update_shift_sales_unknown_method_is_a_silent_no_op():
    shift = make_shift(cash_sales=Decimal("10"))
    sale.update_shift_sales_by_method(shift, "bitcoin", Decimal("999"))
    assert shift.cash_sales == Decimal("10")
    assert shift.card_sales == Decimal("0")
    assert shift.transfer_sales == Decimal("0")
    assert shift.momo_sales == Decimal("0")
    assert shift.zalopay_sales == Decimal("0")
    assert shift.vnpay_sales == Decimal("0")
