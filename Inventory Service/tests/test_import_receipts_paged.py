"""GET /import-receipts/paged: include_lines trả đầy đủ phiếu, mặc định giữ dạng rút gọn."""

import asyncio
from datetime import date, datetime
from types import SimpleNamespace

from Routers import Inventory as inv


def _receipt(idx: int, receipt_date: date, batch_id: str) -> dict:
    return {
        "id": f"rcp-{idx}",
        "code": f"PN{idx:04d}",
        "receipt_date": receipt_date,
        "supplier_id": "sup-1",
        "note": "",
        "status": inv.ReceiptStatus.CONFIRMED,
        "created_by": "tester",
        "created_at": datetime(2026, 10, idx, 8, 0, 0),
        "updated_at": datetime(2026, 10, idx, 8, 0, 0),
        "total_value": 100000 * idx,
        "lines": [
            {
                "id": f"ln-{idx}",
                "batch_id": batch_id,
                "quantity": 10,
                "import_price": 10000 * idx,
                "unit_prices": [{"unit_id": "u1", "unit_name": "Hộp", "conversion": 1, "price": 12000}],
            }
        ],
    }


def _install_state(monkeypatch, count: int = 3):
    receipts = {}
    batches = {}
    for idx in range(1, count + 1):
        batch_id = f"bt-{idx}"
        batches[batch_id] = {
            "id": batch_id,
            "cancelled": False,
            "qty_remaining": 10,
            "qty_in": 10,
            "force_expired": False,
            "exp_date": date(2030, 1, 1),
        }
        receipts[f"rcp-{idx}"] = _receipt(idx, date(2026, 10, idx), batch_id)
    state = SimpleNamespace(
        receipts=receipts,
        suppliers={"sup-1": {"name": "NCC A", "contact_name": "Lan", "phone": "0900"}},
        batches=batches,
        movements=[],
    )
    monkeypatch.setattr(inv, "runtime_state", state)
    return state


def _call(include_lines: bool, page: int = 1, size: int = 20):
    return asyncio.run(
        inv.list_import_receipts_paged(
            page=page,
            size=size,
            date_from=None,
            date_to=None,
            supplier_id=None,
            status_filter=None,
            payment_status=None,
            search=None,
            include_lines=include_lines,
        )
    )


def test_default_returns_list_items_without_lines(monkeypatch):
    _install_state(monkeypatch)
    result = _call(False)

    assert result["total"] == 3
    assert [item["id"] for item in result["items"]] == ["rcp-3", "rcp-2", "rcp-1"]
    for item in result["items"]:
        assert "lines" not in item
        assert item["line_count"] == 1


def test_include_lines_returns_full_receipt_views(monkeypatch):
    state = _install_state(monkeypatch)
    default = _call(False)
    full = _call(True)

    expected = [inv.receipt_to_view(state.receipts[item["id"]]) for item in default["items"]]
    assert full["items"] == expected
    assert all(isinstance(item["lines"], list) and item["lines"] for item in full["items"])
    for key in ("total", "page", "size", "pages"):
        assert full[key] == default[key]


def test_include_lines_respects_pagination(monkeypatch):
    _install_state(monkeypatch)
    default = _call(False, page=2, size=2)
    full = _call(True, page=2, size=2)

    assert [item["id"] for item in full["items"]] == [item["id"] for item in default["items"]] == ["rcp-1"]
    assert (full["total"], full["page"], full["pages"]) == (3, 2, 2)
