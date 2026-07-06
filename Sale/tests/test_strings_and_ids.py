"""normalize_optional_string and safe_uuid."""

from uuid import UUID, uuid4

from Source import sale


def test_normalize_optional_string_none_stays_none():
    assert sale.normalize_optional_string(None) is None


def test_normalize_optional_string_empty_becomes_none():
    assert sale.normalize_optional_string("") is None


def test_normalize_optional_string_whitespace_only_becomes_none():
    assert sale.normalize_optional_string("   ") is None


def test_normalize_optional_string_strips_surrounding_whitespace():
    assert sale.normalize_optional_string("  hello  ") == "hello"


def test_normalize_optional_string_leaves_internal_whitespace():
    assert sale.normalize_optional_string("  hello world  ") == "hello world"


def test_safe_uuid_none_returns_none():
    assert sale.safe_uuid(None) is None


def test_safe_uuid_returns_existing_uuid_instance_unchanged():
    value = uuid4()
    assert sale.safe_uuid(value) is value


def test_safe_uuid_parses_valid_string():
    raw = "123e4567-e89b-12d3-a456-426614174000"
    assert sale.safe_uuid(raw) == UUID(raw)


def test_safe_uuid_invalid_string_returns_none():
    assert sale.safe_uuid("not-a-uuid") is None


def test_safe_uuid_short_numeric_string_returns_none():
    assert sale.safe_uuid(12345) is None


def test_safe_uuid_empty_string_returns_none():
    assert sale.safe_uuid("") is None
