"""Ngày nghiệp vụ tính theo giờ cửa hàng (Asia/Ho_Chi_Minh), không theo UTC của container."""

import asyncio
from datetime import date, datetime, timezone
from types import SimpleNamespace

from Routers import Inventory as inv
from Source.schemas.inventory import BatchStatus


def _batch(exp):
    return {"cancelled": False, "qty_remaining": 5, "force_expired": False, "exp_date": exp}


def _use_now(monkeypatch, value):
    monkeypatch.setattr(inv, "runtime_state", SimpleNamespace())
    monkeypatch.setattr(inv, "utc_now", lambda: value)


def test_store_today_is_next_day_after_utc_17h(monkeypatch):
    _use_now(monkeypatch, datetime(2026, 11, 3, 17, 30, tzinfo=timezone.utc))  # 00:30 VN ngày 11-04
    assert inv.store_today() == date(2026, 11, 4)


def test_store_today_same_day_before_utc_17h(monkeypatch):
    _use_now(monkeypatch, datetime(2026, 11, 3, 16, 30, tzinfo=timezone.utc))  # 23:30 VN ngày 11-03
    assert inv.store_today() == date(2026, 11, 3)


def test_batch_expires_at_vietnam_midnight(monkeypatch):
    batch = _batch(date(2026, 11, 3))
    # Rule thực tế: exp_date < hôm nay mới hết hạn (còn dùng được trong chính ngày hết hạn).
    _use_now(monkeypatch, datetime(2026, 11, 3, 17, 30, tzinfo=timezone.utc))
    assert inv.batch_status(batch) == BatchStatus.EXPIRED
    _use_now(monkeypatch, datetime(2026, 11, 3, 16, 30, tzinfo=timezone.utc))
    assert inv.batch_status(batch) == BatchStatus.ACTIVE


def test_runtime_store_timezone_overrides_default(monkeypatch):
    from zoneinfo import ZoneInfo

    _use_now(monkeypatch, datetime(2026, 11, 3, 17, 30, tzinfo=timezone.utc))
    inv.runtime_state.store_timezone = ZoneInfo("UTC")
    assert inv.store_today() == date(2026, 11, 3)


def test_local_date_naive_assumed_utc(monkeypatch):
    monkeypatch.setattr(inv, "runtime_state", SimpleNamespace())
    assert inv.local_date(datetime(2026, 11, 3, 20, 0)) == date(2026, 11, 4)
    assert inv.local_date(datetime(2026, 11, 3, 10, 0)) == date(2026, 11, 3)


def test_local_date_aware(monkeypatch):
    monkeypatch.setattr(inv, "runtime_state", SimpleNamespace())
    assert inv.local_date(datetime(2026, 11, 3, 18, 0, tzinfo=timezone.utc)) == date(2026, 11, 4)


def test_movement_report_groups_by_vietnam_date(monkeypatch):
    state = SimpleNamespace(
        drugs={"d1": {"id": "d1", "code": "T1", "name": "X"}},
        movements=[
            {"drug_id": "d1", "event_type": inv.MovementType.IMPORT_RECEIPT, "quantity_delta": 10,
             "occurred_at": datetime(2026, 11, 3, 18, 0, tzinfo=timezone.utc)},  # 01:00 VN ngày 11-04
        ],
    )
    monkeypatch.setattr(inv, "runtime_state", state)
    rows = asyncio.run(inv.movement_report(date_from=date(2026, 11, 4), date_to=date(2026, 11, 4), drug=None))
    row = rows["rows"][0]
    assert row["opening_stock"] == 0
    assert row["closing_stock"] == 10
