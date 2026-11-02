import asyncio
from uuid import UUID

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from Source.customer import _rollback_mode_hint, resolve_points_rollback, resolve_rollback_mode
from Source.db.models import PointTransaction
from Source.customer import build_point_transaction
from Source.schemas.customer import PointsRollbackRequest

CUSTOMER_ID = "00000000-0000-0000-0000-000000000001"


def test_explicit_mode_wins_over_keywords():
    assert resolve_rollback_mode("reverse_redeem", "invoice_return_earn", "earn") == "reverse_redeem"
    assert resolve_rollback_mode("reverse_earn", "inv_return_redeem", "redeem") == "reverse_earn"


@pytest.mark.parametrize(
    ("reference_type", "note", "expected"),
    [
        ("inv_create_failed", None, "reverse_earn"),
        ("inv_cancel_redeem", None, "reverse_redeem"),
        ("inv_return_redeem", None, "reverse_redeem"),
        ("invoice_return_earn", "Return goods rollback earn points", "reverse_earn"),
        ("invoice_return_earn", None, "reverse_earn"),
        ("inv_return_earn", None, "reverse_earn"),
        ("invoice_return", None, "reverse_redeem"),
        ("invoice_cancel", None, "reverse_earn"),
        ("invoice_cancel", "cancel", "reverse_earn"),
        ("invoice", "Return goods rollback earn points", "reverse_earn"),
    ],
)
def test_keyword_fallback(reference_type, note, expected):
    assert resolve_rollback_mode(None, reference_type, note) == expected
    assert _rollback_mode_hint(reference_type, note) == expected


def test_reference_type_beats_note():
    assert _rollback_mode_hint("inv_cancel_redeem", "refund earn") == "reverse_redeem"


def test_request_schema_mode_optional_and_validated():
    base = {"customer_id": CUSTOMER_ID, "points": 5}
    assert PointsRollbackRequest(**base).mode is None
    assert PointsRollbackRequest(**base, mode="reverse_earn").mode == "reverse_earn"
    with pytest.raises(ValidationError):
        PointsRollbackRequest(**base, mode="bogus")


def test_transaction_reference_type_truncated_to_column_length():
    txn = build_point_transaction(
        customer_id=CUSTOMER_ID,
        transaction_type="rollback",
        points=-1,
        balance_after=0,
        reference_type="x" * 40,
    )
    assert isinstance(txn, PointTransaction)
    assert len(txn.reference_type) == 20


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeDb:
    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _stmt):
        return _FakeResult(self._rows)


def _resolve(rows, points, mode):
    return asyncio.run(
        resolve_points_rollback(
            db=_FakeDb(rows),
            customer_id=UUID(CUSTOMER_ID),
            points=points,
            reference_type="inv_cancel_redeem",
            reference_id=UUID(CUSTOMER_ID),
            reference_code=None,
            note=None,
            mode=mode,
        )
    )


def test_explicit_mode_clamps_to_available():
    rows = [("earn", 30), ("rollback", -10)]
    mode, applied, avail_earn, _ = _resolve(rows, 30, "reverse_earn")
    assert (mode, applied, avail_earn) == ("reverse_earn", 20, 20)


def test_explicit_mode_within_available_unchanged():
    mode, applied, _, _ = _resolve([("earn", 30)], 12, "reverse_earn")
    assert (mode, applied) == ("reverse_earn", 12)


def test_explicit_mode_nothing_left_raises_400():
    rows = [("earn", 30), ("rollback", -30)]
    with pytest.raises(HTTPException) as exc:
        _resolve(rows, 30, "reverse_earn")
    assert exc.value.status_code == 400


def test_explicit_mode_does_not_use_other_direction():
    rows = [("redeem", -50)]
    with pytest.raises(HTTPException) as exc:
        _resolve(rows, 10, "reverse_earn")
    assert exc.value.status_code == 400


def test_implicit_mode_still_rejects_over_available():
    with pytest.raises(HTTPException) as exc:
        _resolve([("earn", 20)], 30, None)
    assert exc.value.status_code == 400
