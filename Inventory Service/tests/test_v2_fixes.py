"""V2.0: /reserve không âm tồn, kiểm kê không xóa hàng đã bán, sort kiểm kê/thu hồi, mã thuốc phiếu kiểm kê.

Không cần Postgres: dùng runtime_state giả trong bộ nhớ.
"""

import asyncio
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from Routers import Inventory as inv
from Source.schemas.inventory import ReserveItemRequest, ReserveRequest

DRUG = "drug-1"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _batch(batch_id, qty, received_offset=0):
    return {
        "id": batch_id,
        "drug_id": DRUG,
        "batch_code": batch_id.upper(),
        "lot_number": "L1",
        "qty_remaining": qty,
        "cancelled": False,
        "force_expired": False,
        "received_date": date.today() - timedelta(days=10 - received_offset),
        "exp_date": date.today() + timedelta(days=365),
        "created_at": NOW + timedelta(days=received_offset),
        "updated_at": NOW,
    }


@pytest.fixture
def env(monkeypatch):
    state = SimpleNamespace(
        lock=asyncio.Lock(),
        drugs={DRUG: {"id": DRUG, "code": "T0001", "name": "Paracetamol", "units": []}},
        batches={"bt-1": _batch("bt-1", 15)},
        movements=[],
        reservations=[],
        audits={},
        drug_recalls={},
        suppliers={},
        counters={"movement": 0, "reservation": 0, "audit": 0, "drug_recall": 0},
    )
    monkeypatch.setattr(inv, "runtime_state", state)
    monkeypatch.setattr(inv, "get_current_actor", lambda token: ("1", token, token))

    async def no_settings(force=False):
        return {}

    async def no_save():
        return None

    monkeypatch.setattr(inv, "fetch_inventory_settings", no_settings)
    monkeypatch.setattr(inv, "save_runtime_state_safe", no_save)
    return state


def _reserve(*items):
    payload = ReserveRequest(
        sale_id="s1",
        items=[ReserveItemRequest(sku=sku, quantity=qty, batch_id=batch_id) for sku, qty, batch_id in items],
    )
    return asyncio.run(inv.reserve(payload, token="owner"))


# ---------- (a) /reserve ----------

def test_reserve_two_lines_same_explicit_batch_over_stock_rejected(env):
    with pytest.raises(HTTPException) as exc:
        _reserve(("T0001", 10, "bt-1"), ("T0001", 8, "bt-1"))
    assert exc.value.status_code == 409
    detail = exc.value.detail
    assert detail["batch_id"] == "bt-1"
    assert detail["requested"] == 8
    assert detail["available"] == 5
    assert detail["shortage"] == 3
    assert env.batches["bt-1"]["qty_remaining"] == 15
    assert env.movements == []
    assert env.reservations == []


def test_reserve_two_lines_same_explicit_batch_within_stock_ok(env):
    result = _reserve(("T0001", 10, "bt-1"), ("T0001", 5, "bt-1"))
    assert env.batches["bt-1"]["qty_remaining"] == 0
    assert len(result["reservation"]["items"]) == 2


def test_reserve_two_lines_auto_pick_over_stock_rejected(env):
    with pytest.raises(HTTPException) as exc:
        _reserve(("T0001", 10, None), ("T0001", 8, None))
    assert exc.value.status_code == 409
    assert exc.value.detail["shortage"] == 3
    assert exc.value.detail["available"] == 5
    assert env.batches["bt-1"]["qty_remaining"] == 15
    assert env.movements == []


def test_reserve_auto_pick_spans_batches_without_double_counting(env):
    env.batches["bt-2"] = _batch("bt-2", 10, received_offset=1)
    result = _reserve(("T0001", 12, None), ("T0001", 10, None))
    assert env.batches["bt-1"]["qty_remaining"] == 0
    assert env.batches["bt-2"]["qty_remaining"] == 3
    assert all(b["qty_remaining"] >= 0 for b in env.batches.values())
    second = result["reservation"]["items"][1]["allocations"]
    assert sum(a["allocated"] for a in second) == 10

    with pytest.raises(HTTPException) as exc:
        _reserve(("T0001", 2, None))
        _reserve(("T0001", 2, None))
    assert exc.value.status_code == 409
    assert all(b["qty_remaining"] >= 0 for b in env.batches.values())


def test_reserve_explicit_then_auto_shares_pending(env):
    with pytest.raises(HTTPException) as exc:
        _reserve(("T0001", 10, "bt-1"), ("T0001", 6, None))
    assert exc.value.status_code == 409
    assert env.batches["bt-1"]["qty_remaining"] == 15


# ---------- (b) hoàn tất kiểm kê ----------

def _audit_with(env, system_qty, actual_qty):
    env.audits["au-1"] = {
        "id": "au-1",
        "code": "KK1",
        "status": "draft",
        "items": [
            {
                "batch_id": "bt-1",
                "drug_id": DRUG,
                "system_qty": system_qty,
                "actual_qty": actual_qty,
                "diff_qty": None,
            }
        ],
    }


def _complete():
    return asyncio.run(inv.complete_stock_audit("au-1", token="owner"))


def test_audit_complete_applies_delta_to_current_qty_no_diff(env):
    _audit_with(env, 100, 100)
    env.batches["bt-1"]["qty_remaining"] = 90  # bán 10 trong lúc kiểm kê
    result = _complete()
    assert env.batches["bt-1"]["qty_remaining"] == 90
    assert result["adjustments"] == []


def test_audit_complete_applies_delta_to_current_qty(env):
    _audit_with(env, 100, 95)
    env.batches["bt-1"]["qty_remaining"] = 90
    result = _complete()
    assert env.batches["bt-1"]["qty_remaining"] == 85
    assert result["adjustments"][0]["quantity_delta"] == -5
    assert env.audits["au-1"]["status"] == "completed"


def test_audit_complete_clamps_at_zero_and_records_applied_delta(env):
    _audit_with(env, 100, 40)
    env.batches["bt-1"]["qty_remaining"] = 30
    result = _complete()
    assert env.batches["bt-1"]["qty_remaining"] == 0
    assert result["adjustments"][0]["quantity_delta"] == -30


# ---------- (c) sort helper + list endpoints ----------

def test_sort_key_datetime_handles_mixed_types():
    aware = datetime(2026, 5, 1, 10, 0, tzinfo=timezone.utc)
    assert inv._sort_key_datetime(None) == ""
    assert inv._sort_key_datetime(aware) == aware.isoformat()
    assert inv._sort_key_datetime(date(2026, 5, 1)) == "2026-05-01"
    assert inv._sort_key_datetime("2026-05-01T10:00:00+00:00") == "2026-05-01T10:00:00+00:00"
    keys = [inv._sort_key_datetime(v) for v in (aware, "2026-04-01T00:00:00+00:00", None)]
    assert sorted(keys) == ["", "2026-04-01T00:00:00+00:00", aware.isoformat()]


def test_list_stock_audits_with_mixed_created_at(env):
    env.audits["a"] = {"id": "a", "status": "draft", "created_at": "2026-01-01T00:00:00+00:00"}
    env.audits["b"] = {"id": "b", "status": "draft", "created_at": datetime(2026, 3, 1, tzinfo=timezone.utc)}
    env.audits["c"] = {"id": "c", "status": "draft", "created_at": None}
    result = asyncio.run(inv.list_stock_audits(status=None, page=1, size=20, token="owner"))
    assert [a["id"] for a in result["items"]] == ["b", "a", "c"]


def test_list_drug_recalls_with_datetime_created_at(env):
    env.drug_recalls["r1"] = {"id": "r1", "issued_date": "", "created_at": datetime(2026, 3, 1, tzinfo=timezone.utc)}
    env.drug_recalls["r2"] = {"id": "r2", "issued_date": "2026-02-01", "created_at": "2026-01-01T00:00:00+00:00"}
    env.drug_recalls["r3"] = {"id": "r3", "issued_date": "", "created_at": "2026-01-15T00:00:00+00:00"}
    result = asyncio.run(
        inv.list_drug_recalls(date_from=None, date_to=None, sort="desc", page=1, size=20, token="owner")
    )
    assert [r["id"] for r in result["items"]] == ["r1", "r2", "r3"]
    filtered = asyncio.run(
        inv.list_drug_recalls(date_from="2026-02-01", date_to=None, sort="asc", page=1, size=20, token="owner")
    )
    assert [r["id"] for r in filtered["items"]] == ["r2", "r1"]


# ---------- mã thuốc trên phiếu kiểm kê ----------

def test_create_stock_audit_fills_drug_code(env):
    payload = SimpleNamespace(note="", inspector_name="", audit_type="periodic")
    result = asyncio.run(inv.create_stock_audit(payload, token="owner"))
    assert result["audit"]["items"][0]["drug_code"] == "T0001"


# ---------- tồn bán được không gồm lô hết hạn ----------

def test_stock_total_excludes_expired_and_force_expired(env):
    expired = _batch("bt-exp", 7, 1)
    expired["exp_date"] = date.today() - timedelta(days=1)
    forced = _batch("bt-force", 4, 2)
    forced["force_expired"] = True
    env.batches.update({"bt-exp": expired, "bt-force": forced})
    assert inv.stock_total_for_drug(DRUG) == 15


def test_alerts_include_force_expired_batch_with_future_exp_date(env):
    env.drugs[DRUG]["reorder_level"] = 0
    forced = _batch("bt-force", 4, 2)
    forced["force_expired"] = True
    forced.update(
        receipt_id="r1", supplier_id="sup-1", mfg_date=date.today() - timedelta(days=30), qty_in=4,
        import_price=1000, promo_note=""
    )
    env.batches["bt-force"] = forced
    env.batches["bt-1"].update(
        receipt_id="r1", supplier_id="sup-1", mfg_date=date.today() - timedelta(days=30), qty_in=15,
        import_price=1000, promo_note=""
    )
    result = asyncio.run(inv.inventory_alerts(low_stock_threshold=None, as_of=None))
    assert [e["batch"]["id"] for e in result["expired"]] == ["bt-force"]
    assert result["totals"]["expired"] == 1
    assert all(e["batch"]["id"] != "bt-force" for e in result["expiring_soon"] + result["warning"] + result["near_date"])
