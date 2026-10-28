"""API danh sách sản phẩm trả kèm đơn vị để bảng Danh mục thuốc hiện giá ngay, không cần mở chi tiết."""

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

from Source.catalog import to_product_list_item

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)


def _unit(product_id, name, role, conversion, price, *, base=False, active=True):
    return SimpleNamespace(
        id=uuid4(), product_id=product_id, unit_name=name, conversion_rate=conversion, unit_role=role,
        barcode=None, selling_price=Decimal(price), is_base_unit=base, is_active=active,
        created_at=NOW, updated_at=NOW,
    )


def _product():
    pid = uuid4()
    return SimpleNamespace(
        id=pid, code="T0182", barcode=None, name="Arginine", active_ingredient=None, registration_number=None,
        group=None, manufacturer=None, vat_rate=Decimal("0"), other_tax_rate=Decimal("0"), is_active=True,
        created_at=NOW, updated_at=NOW,
        units=[
            _unit(pid, "Viên", "retail", 1, "2000", base=True),
            _unit(pid, "Hộp", "import", 60, "120000"),
            _unit(pid, "Vỉ", "intermediate", 5, "10000"),
        ],
    )


def test_list_item_includes_units_in_role_order():
    item = to_product_list_item(_product())
    assert [(u.unit_name, u.conversion_rate) for u in item.units] == [("Hộp", 60), ("Vỉ", 5), ("Viên", 1)]
    # Field cũ giữ nguyên cho các client đang dùng (Inventory sync, POS search).
    assert (item.base_unit, item.base_price) == ("Viên", Decimal("2000"))


def test_list_item_serializes_unit_prices():
    data = to_product_list_item(_product()).model_dump(mode="json")
    prices = {u["unit_name"]: u["selling_price"] for u in data["units"]}
    assert float(prices["Hộp"]) == 120000 and float(prices["Viên"]) == 2000
