"""proportion_points — proportional split incl. zero-total, rounding."""

from decimal import Decimal

from Source import sale


def test_proportion_points_zero_points_returns_zero():
    assert sale.proportion_points(0, Decimal("50"), Decimal("100")) == 0


def test_proportion_points_negative_points_returns_zero():
    assert sale.proportion_points(-10, Decimal("50"), Decimal("100")) == 0


def test_proportion_points_zero_total_returns_zero():
    assert sale.proportion_points(100, Decimal("50"), Decimal("0")) == 0


def test_proportion_points_negative_total_returns_zero():
    assert sale.proportion_points(100, Decimal("50"), Decimal("-10")) == 0


def test_proportion_points_half_split():
    assert sale.proportion_points(100, Decimal("50"), Decimal("100")) == 50


def test_proportion_points_full_amount_gets_all_points():
    assert sale.proportion_points(100, Decimal("100"), Decimal("100")) == 100


def test_proportion_points_rounds_half_up():
    # ratio = 0.5 -> 3 * 0.5 = 1.5 -> rounds up to 2
    assert sale.proportion_points(3, Decimal("1"), Decimal("2")) == 2


def test_proportion_points_rounds_down_repeating_decimal():
    # ratio = 1/3 = 0.333... -> 10 * ratio = 3.333... -> rounds down to 3
    assert sale.proportion_points(10, Decimal("1"), Decimal("3")) == 3


def test_proportion_points_zero_part_of_positive_total():
    assert sale.proportion_points(100, Decimal("0"), Decimal("100")) == 0
