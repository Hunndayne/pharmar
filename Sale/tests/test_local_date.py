"""local_today / generate_next_daily_code use the Vietnam calendar date."""

import asyncio
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from Source import sale



class FakeDb:
    def __init__(self, codes=()):
        self.codes = list(codes)

    async def scalars(self, _stmt):
        return list(self.codes)


class _Col:
    def like(self, _pattern):
        return self


def _patch_codes(monkeypatch):
    # select(code_column) needs a real column; replace select with a stub.
    class _Stmt:
        def where(self, _clause):
            return self

    monkeypatch.setattr(sale, "select", lambda *_a, **_k: _Stmt())


def test_local_today_after_utc_17h_is_next_vietnam_day(monkeypatch):
    monkeypatch.setattr(sale, "now_utc", lambda: datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc))
    assert sale.local_today() == date(2026, 11, 4)


def test_local_today_before_utc_17h_is_same_day(monkeypatch):
    monkeypatch.setattr(sale, "now_utc", lambda: datetime(2026, 11, 3, 16, 59, tzinfo=timezone.utc))
    assert sale.local_today() == date(2026, 11, 3)


def test_local_today_honours_explicit_timezone(monkeypatch):
    monkeypatch.setattr(sale, "now_utc", lambda: datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc))
    assert sale.local_today(ZoneInfo("UTC")) == date(2026, 11, 3)


def test_generate_next_daily_code_uses_vietnam_date(monkeypatch):
    monkeypatch.setattr(sale, "now_utc", lambda: datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc))

    async def fake_tz():
        return sale.DEFAULT_STORE_TIMEZONE

    monkeypatch.setattr(sale, "get_store_timezone_cached", fake_tz)
    _patch_codes(monkeypatch)
    code = asyncio.run(sale.generate_next_daily_code(FakeDb(), object, _Col(), "HD"))
    assert code == "HD20261104001"


def test_generate_next_daily_code_increments_existing(monkeypatch):
    monkeypatch.setattr(sale, "now_utc", lambda: datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc))

    async def fake_tz():
        return sale.DEFAULT_STORE_TIMEZONE

    monkeypatch.setattr(sale, "get_store_timezone_cached", fake_tz)
    _patch_codes(monkeypatch)
    db = FakeDb(["HD20261104001", "HD20261104007"])
    code = asyncio.run(sale.generate_next_daily_code(db, object, _Col(), "HD"))
    assert code == "HD20261104008"


def test_get_store_timezone_cached_falls_back_on_error(monkeypatch):
    monkeypatch.setattr(sale, "_store_timezone_cache", {"value": None, "fetched_at": None})

    async def boom(token=None):
        raise RuntimeError("store down")

    monkeypatch.setattr(sale, "get_store_timezone", boom)
    assert asyncio.run(sale.get_store_timezone_cached()) == sale.DEFAULT_STORE_TIMEZONE
