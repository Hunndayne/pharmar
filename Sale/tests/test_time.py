"""future_time, build_print_datetime, build_utc_range_for_local_dates."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from Source import sale

ICT = ZoneInfo("Asia/Ho_Chi_Minh")


def test_future_time_adds_requested_minutes():
    before = datetime.now(timezone.utc)
    result = sale.future_time(10)
    after = datetime.now(timezone.utc)
    assert before + timedelta(minutes=9, seconds=55) <= result <= after + timedelta(minutes=10, seconds=5)


def test_future_time_clamps_zero_to_one_minute_minimum():
    before = datetime.now(timezone.utc)
    result = sale.future_time(0)
    assert result > before
    assert result <= before + timedelta(minutes=1, seconds=5)


def test_future_time_clamps_negative_to_one_minute_minimum():
    before = datetime.now(timezone.utc)
    result = sale.future_time(-30)
    assert result > before
    assert result <= before + timedelta(minutes=1, seconds=5)


def test_build_print_datetime_converts_utc_input():
    value = datetime(2024, 6, 15, 23, 45, tzinfo=timezone.utc)
    assert sale.build_print_datetime(value) == "15/06/2024 23:45"


def test_build_print_datetime_converts_non_utc_input_to_utc():
    # 2024-01-01 10:30 in Asia/Ho_Chi_Minh (UTC+7) -> 2024-01-01 03:30 UTC.
    value = datetime(2024, 1, 1, 10, 30, tzinfo=ICT)
    assert sale.build_print_datetime(value) == "01/01/2024 03:30"


def test_build_print_datetime_crosses_date_boundary():
    # Early morning ICT rolls back to the previous UTC day.
    value = datetime(2024, 1, 2, 2, 0, tzinfo=ICT)
    assert sale.build_print_datetime(value) == "01/01/2024 19:00"


def test_build_utc_range_both_none():
    assert sale.build_utc_range_for_local_dates(None, None, ICT) == (None, None)


def test_build_utc_range_from_only():
    start_at, end_at = sale.build_utc_range_for_local_dates(date(2024, 1, 10), None, ICT)
    assert start_at == datetime(2024, 1, 9, 17, 0, tzinfo=timezone.utc)
    assert end_at is None


def test_build_utc_range_to_only():
    start_at, end_at = sale.build_utc_range_for_local_dates(None, date(2024, 1, 15), ICT)
    assert start_at is None
    assert end_at == datetime(2024, 1, 15, 17, 0, tzinfo=timezone.utc)


def test_build_utc_range_full_range_is_exclusive_end():
    # date_to is inclusive of the whole local day, so the UTC end boundary
    # is midnight local time of the *following* day.
    start_at, end_at = sale.build_utc_range_for_local_dates(date(2024, 1, 10), date(2024, 1, 15), ICT)
    assert start_at == datetime(2024, 1, 9, 17, 0, tzinfo=timezone.utc)
    assert end_at == datetime(2024, 1, 15, 17, 0, tzinfo=timezone.utc)


def test_build_utc_range_single_day_spans_24_hours():
    start_at, end_at = sale.build_utc_range_for_local_dates(date(2024, 1, 10), date(2024, 1, 10), ICT)
    assert end_at - start_at == timedelta(days=1)
