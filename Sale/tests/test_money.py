"""quantize_money / safe_decimal — Decimal handling, rounding, bad-input defaults."""

from decimal import Decimal

from Source import sale


def test_quantize_money_rounds_half_up_positive():
    assert sale.quantize_money(Decimal("10.5")) == Decimal("11")


def test_quantize_money_rounds_down_below_half():
    assert sale.quantize_money(Decimal("10.4")) == Decimal("10")


def test_quantize_money_rounds_half_up_negative_away_from_zero():
    # ROUND_HALF_UP ties go away from zero, so -10.5 -> -11 (not -10).
    assert sale.quantize_money(Decimal("-10.5")) == Decimal("-11")


def test_quantize_money_accepts_int():
    assert sale.quantize_money(42) == Decimal("42")


def test_quantize_money_accepts_float():
    assert sale.quantize_money(10.5) == Decimal("11")


def test_quantize_money_accepts_numeric_string():
    assert sale.quantize_money("123.49") == Decimal("123")


def test_quantize_money_bad_string_defaults_to_zero():
    assert sale.quantize_money("not-a-number") == Decimal("0")


def test_quantize_money_none_defaults_to_zero():
    assert sale.quantize_money(None) == Decimal("0")


def test_quantize_money_zero():
    assert sale.quantize_money(Decimal("0")) == Decimal("0")


def test_quantize_money_infinite_decimal_raises():
    # Unlike the string/None paths, a Decimal("Infinity") is used as-is
    # (isinstance(value, Decimal) branch skips the try/except) and
    # `.quantize()` on infinity is invalid -> InvalidOperation propagates.
    # This is exactly why safe_decimal() exists as a wrapper.
    import pytest
    from decimal import InvalidOperation

    with pytest.raises(InvalidOperation):
        sale.quantize_money(Decimal("Infinity"))


def test_safe_decimal_falls_back_on_infinite_decimal():
    assert sale.safe_decimal(Decimal("Infinity")) == sale.DECIMAL_ZERO


def test_safe_decimal_falls_back_on_infinite_decimal_custom_default():
    default = Decimal("7")
    assert sale.safe_decimal(Decimal("Infinity"), default) == default


def test_safe_decimal_bad_string_uses_default():
    assert sale.safe_decimal("garbage") == sale.DECIMAL_ZERO


def test_safe_decimal_valid_value_is_quantized():
    assert sale.safe_decimal("99.6") == Decimal("100")


def test_safe_decimal_nan_falls_back_to_default():
    # quantize_money raises on non-finite values (NaN would otherwise pass
    # through .quantize() silently), so safe_decimal falls back to default.
    assert sale.safe_decimal(Decimal("NaN")) == sale.DECIMAL_ZERO
    assert sale.safe_decimal(Decimal("NaN"), Decimal("7")) == Decimal("7")
