"""normalize_page_size — clamping page/size."""

from Source import sale


def test_normalize_page_size_clamps_page_below_one():
    assert sale.normalize_page_size(0, 10) == (1, 10)


def test_normalize_page_size_clamps_negative_page():
    assert sale.normalize_page_size(-5, 10) == (1, 10)


def test_normalize_page_size_clamps_size_below_one():
    assert sale.normalize_page_size(1, 0) == (1, 1)


def test_normalize_page_size_clamps_negative_size():
    assert sale.normalize_page_size(1, -20) == (1, 1)


def test_normalize_page_size_clamps_size_above_default_max():
    assert sale.normalize_page_size(2, 5000) == (2, 200)


def test_normalize_page_size_respects_custom_max_size():
    assert sale.normalize_page_size(3, 50, max_size=10) == (3, 10)


def test_normalize_page_size_passes_through_valid_values():
    assert sale.normalize_page_size(4, 25) == (4, 25)


def test_normalize_page_size_exact_boundary_at_max():
    assert sale.normalize_page_size(1, 200) == (1, 200)
