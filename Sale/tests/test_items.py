"""extract_item_sku — the different item shapes it accepts."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from Source import sale


def test_extract_item_sku_prefers_product_id():
    item = SimpleNamespace(product_id=" ABC123 ", sku="SKU-1", product_code="PC-1")
    assert sale.extract_item_sku(item) == "ABC123"


def test_extract_item_sku_falls_back_to_sku_when_no_product_id():
    item = SimpleNamespace(product_id=None, sku=" SKU-1 ")
    assert sale.extract_item_sku(item) == "SKU-1"


def test_extract_item_sku_falls_back_to_sku_when_product_id_blank():
    # An empty/whitespace-only product_id string is falsy after strip(),
    # so it falls through to sku even though product_id "exists".
    item = SimpleNamespace(product_id="   ", sku="SKU-2")
    assert sale.extract_item_sku(item) == "SKU-2"


def test_extract_item_sku_falls_back_to_product_code():
    item = SimpleNamespace(product_id=None, sku=None, product_code=" PC-9 ")
    assert sale.extract_item_sku(item) == "PC-9"


def test_extract_item_sku_ignores_non_string_product_id():
    # product_id=123 (int) fails the isinstance(str) check and is skipped
    # entirely, even though it is "truthy".
    item = SimpleNamespace(product_id=123, sku="SKU-3")
    assert sale.extract_item_sku(item) == "SKU-3"


def test_extract_item_sku_missing_attributes_raise():
    item = SimpleNamespace()
    with pytest.raises(HTTPException) as exc_info:
        sale.extract_item_sku(item)
    assert exc_info.value.status_code == 400


def test_extract_item_sku_all_blank_raises():
    item = SimpleNamespace(product_id="", sku="  ", product_code=None)
    with pytest.raises(HTTPException) as exc_info:
        sale.extract_item_sku(item)
    assert exc_info.value.status_code == 400


def test_extract_item_sku_dict_shaped_item_raises():
    # dicts don't expose their keys as attributes, so getattr(...) always
    # falls back to the default None -> no sku is ever resolved from a plain dict.
    item = {"product_id": "ABC"}
    with pytest.raises(HTTPException):
        sale.extract_item_sku(item)
