"""clamp_return_quantity — boundary cases: over-return, zero, negative, exact remainder.

Note: despite the name, this function does NOT clamp the requested quantity
down to what's available — it raises HTTPException(400) when the request
exceeds the remaining returnable amount, and simply returns `requested`
unchanged otherwise (including when `requested` is negative). These tests
pin down that current behavior rather than the "clamp" the name implies.
"""

import pytest
from fastapi import HTTPException

from Source import sale


def test_clamp_return_quantity_within_available():
    assert sale.clamp_return_quantity(5, 10, 0) == 5


def test_clamp_return_quantity_exact_remainder_boundary():
    assert sale.clamp_return_quantity(10, 10, 0) == 10


def test_clamp_return_quantity_zero_requested_always_allowed():
    assert sale.clamp_return_quantity(0, 10, 5) == 0


def test_clamp_return_quantity_zero_requested_with_nothing_purchased():
    assert sale.clamp_return_quantity(0, 0, 0) == 0


def test_clamp_return_quantity_over_return_raises():
    with pytest.raises(HTTPException) as exc_info:
        sale.clamp_return_quantity(11, 10, 0)
    assert exc_info.value.status_code == 400


def test_clamp_return_quantity_already_fully_returned_raises():
    with pytest.raises(HTTPException) as exc_info:
        sale.clamp_return_quantity(1, 5, 5)
    assert exc_info.value.status_code == 400


def test_clamp_return_quantity_negative_already_returned_widens_available():
    # available = max(0, purchased - already_returned); a negative
    # already_returned effectively increases the available amount.
    assert sale.clamp_return_quantity(5, 3, -2) == 5


def test_clamp_return_quantity_negative_requested_is_not_rejected():
    # Current behavior: negative `requested` passes the `requested >
    # available` check trivially and is returned as-is, uncaught.
    assert sale.clamp_return_quantity(-1, 10, 0) == -1


def test_clamp_return_quantity_over_returned_already_clamps_available_to_zero():
    with pytest.raises(HTTPException) as exc_info:
        sale.clamp_return_quantity(1, 5, 10)
    assert exc_info.value.status_code == 400
    assert "0" in str(exc_info.value.detail)
