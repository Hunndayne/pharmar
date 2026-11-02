"""Restock email scheduler fires at HH:MM store time (Asia/Ho_Chi_Minh), not container UTC."""

from datetime import datetime, timezone

from Source import restock_checker


def test_before_target_same_day():
    now = datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc)  # 06:30 VN on 11-04
    assert restock_checker._seconds_until_next("07:00", now) == 1800


def test_after_target_rolls_to_next_day():
    now = datetime(2026, 11, 4, 0, 30, tzinfo=timezone.utc)  # 07:30 VN on 11-04
    assert restock_checker._seconds_until_next("07:00", now) == 84600


def test_exactly_at_target_rolls_to_next_day():
    now = datetime(2026, 11, 4, 0, 0, tzinfo=timezone.utc)  # 07:00 VN
    assert restock_checker._seconds_until_next("07:00", now) == 86400


def test_invalid_timezone_falls_back_to_vietnam(monkeypatch):
    monkeypatch.setattr(restock_checker.settings, "STORE_TIMEZONE", "Not/AZone")
    now = datetime(2026, 11, 3, 23, 30, tzinfo=timezone.utc)
    assert restock_checker._seconds_until_next("07:00", now) == 1800
