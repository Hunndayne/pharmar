"""Trường hóa đơn trên phiếu nhập (AI import): view, tìm theo hóa đơn, search, create/update."""

import asyncio
from collections import defaultdict
from datetime import date, datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from Routers import Inventory as inv
from Source.schemas.inventory import (
    ImportReceiptCreateRequest,
    ImportReceiptLineRequest,
    ImportReceiptUpdateRequest,
)


def _receipt(idx: int, **extra) -> dict:
    receipt = {
        "id": f"rcp-{idx}",
        "code": f"PN{idx:04d}",
        "receipt_date": date(2026, 10, idx),
        "supplier_id": "sup-1",
        "note": "",
        "status": inv.ReceiptStatus.CONFIRMED,
        "created_by": "tester",
        "created_at": datetime(2026, 10, idx, 8, 0, 0),
        "updated_at": datetime(2026, 10, idx, 8, 0, 0),
        "total_value": 1000,
        "lines": [],
    }
    receipt.update(extra)
    return receipt


def _install(monkeypatch, receipts: list[dict]):
    state = SimpleNamespace(
        receipts={r["id"]: r for r in receipts},
        suppliers={"sup-1": {"name": "NCC A", "contact_name": "Lan", "phone": "0900"}},
        batches={},
        movements=[],
    )
    monkeypatch.setattr(inv, "runtime_state", state)
    return state


def _by_invoice(number, serial=None):
    return asyncio.run(inv.find_import_receipts_by_invoice(serial=serial, number=number))


def _paged(search):
    return asyncio.run(
        inv.list_import_receipts_paged(
            page=1, size=20, date_from=None, date_to=None, supplier_id=None,
            status_filter=None, payment_status=None, search=search, include_lines=False,
        )
    )


def _line():
    return ImportReceiptLineRequest(
        drug_id="drug-1", lot_number="L1", quantity=5,
        mfg_date=date(2026, 1, 1), exp_date=date(2028, 1, 1), import_price=1000,
    )


def test_views_default_invoice_fields_for_legacy_receipt(monkeypatch):
    legacy = _receipt(1)
    _install(monkeypatch, [legacy])
    for view in (inv.receipt_to_view(legacy), inv.receipt_list_item_to_view(legacy)):
        assert view["invoice_serial"] is None
        assert view["invoice_number"] is None
        assert view["invoice_date"] is None
        assert view["invoice_file_ids"] == []


def test_views_output_invoice_fields(monkeypatch):
    r = _receipt(1, invoice_serial="C26TAA", invoice_number="14320",
                 invoice_date=date(2026, 10, 1), invoice_file_ids=["f1", "f2"])
    _install(monkeypatch, [r])
    for view in (inv.receipt_to_view(r), inv.receipt_list_item_to_view(r)):
        assert view["invoice_serial"] == "C26TAA"
        assert view["invoice_number"] == "14320"
        assert view["invoice_date"] == date(2026, 10, 1)
        assert view["invoice_file_ids"] == ["f1", "f2"]


def test_by_invoice_matching(monkeypatch):
    _install(monkeypatch, [
        _receipt(1, invoice_serial="C26TAA", invoice_number="00014320"),
        _receipt(2, invoice_serial="c26taa", invoice_number="14320", status=inv.ReceiptStatus.CANCELLED),
        _receipt(3, invoice_serial="C26TBB", invoice_number="14320"),
        _receipt(4),
    ])
    # serial tùy chọn: khớp cả 3 phiếu có số 14320, kể cả phiếu đã hủy
    assert {r["id"] for r in _by_invoice("14320")} == {"rcp-1", "rcp-2", "rcp-3"}
    # bỏ số 0 đầu ở cả hai phía
    assert {r["id"] for r in _by_invoice("00014320", serial="C26TAA")} == {"rcp-1", "rcp-2"}
    # không phân biệt hoa thường, bỏ khoảng trắng
    assert {r["id"] for r in _by_invoice(" 14320 ", serial=" c26tbb ")} == {"rcp-3"}
    result = _by_invoice("14320", serial="C26TAA")
    cancelled = [r for r in result if r["id"] == "rcp-2"][0]
    assert cancelled["status"] == inv.ReceiptStatus.CANCELLED
    assert set(cancelled) == {"id", "code", "receipt_date", "supplier_id", "status"}


def test_by_invoice_no_match(monkeypatch):
    _install(monkeypatch, [_receipt(1, invoice_serial="A", invoice_number="1"), _receipt(2)])
    assert _by_invoice("999") == []
    assert _by_invoice("1", serial="B") == []
    assert _by_invoice("000") == []


def test_search_matches_invoice_number_and_serial(monkeypatch):
    _install(monkeypatch, [
        _receipt(1, invoice_serial="C26TAA", invoice_number="14320"),
        _receipt(2),
    ])
    assert [i["id"] for i in _paged("14320")["items"]] == ["rcp-1"]
    assert [i["id"] for i in _paged("c26taa")["items"]] == ["rcp-1"]
    assert _paged("zzz")["items"] == []


def test_schema_normalises_invoice_fields():
    base = dict(receipt_date=date(2026, 10, 1), supplier_id="sup-1", lines=[_line()])
    req = ImportReceiptCreateRequest(**base, invoice_serial="  ", invoice_number=" 0012 ")
    assert req.invoice_serial is None and req.invoice_number == "0012"
    assert req.invoice_file_ids == []
    with pytest.raises(ValidationError):
        ImportReceiptCreateRequest(**base, invoice_file_ids=[f"f{i}" for i in range(21)])
    with pytest.raises(ValidationError):
        ImportReceiptCreateRequest(**base, invoice_file_ids=[""])
    with pytest.raises(ValidationError):
        ImportReceiptCreateRequest(**base, invoice_number="x" * 33)


@pytest.fixture
def write_env(monkeypatch):
    state = SimpleNamespace(
        lock=asyncio.Lock(), counters=defaultdict(int), receipts={}, batches={}, movements=[],
        suppliers={"sup-1": {"id": "sup-1", "name": "NCC A", "contact_name": "Lan", "phone": "0900", "address": ""}},
    )
    monkeypatch.setattr(inv, "runtime_state", state)
    monkeypatch.setattr(inv, "get_current_subject", lambda token: "tester")
    monkeypatch.setattr(inv, "get_current_actor", lambda token: ("1", "owner", "tester"))

    async def supplier(supplier_id, token=None):
        return state.suppliers[supplier_id]

    async def drug(line, token=None):
        return {"id": "drug-1", "code": "T1", "name": "Thuốc 1", "units": [], "barcode": ""}

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(inv, "resolve_supplier_or_404", supplier)
    monkeypatch.setattr(inv, "resolve_or_register_drug", drug)
    monkeypatch.setattr(inv, "save_runtime_state_safe", noop)
    monkeypatch.setattr(inv, "_trigger_restock_refresh", noop)
    monkeypatch.setattr(inv, "default_line_unit_prices", lambda d: [])
    return state


def test_create_stores_and_update_keeps_invoice_fields(write_env):
    base = dict(receipt_date=date(2026, 10, 1), supplier_id="sup-1", lines=[_line()])
    created = asyncio.run(inv.create_import_receipt(
        ImportReceiptCreateRequest(
            **base, invoice_serial="C26TAA", invoice_number="14320",
            invoice_date=date(2026, 9, 30), invoice_file_ids=["f1"],
        ),
        token="t",
    ))
    assert created["invoice_number"] == "14320"
    assert created["invoice_file_ids"] == ["f1"]
    rid = created["id"]
    assert write_env.receipts[rid]["invoice_serial"] == "C26TAA"

    # update không gửi trường hóa đơn -> giữ nguyên
    updated = asyncio.run(inv.update_import_receipt(
        rid, ImportReceiptUpdateRequest(**base, note="sửa"), token="t",
    ))
    assert updated["note"] == "sửa"
    assert updated["invoice_serial"] == "C26TAA"
    assert updated["invoice_number"] == "14320"
    assert updated["invoice_date"] == date(2026, 9, 30)
    assert updated["invoice_file_ids"] == ["f1"]

    # update có gửi -> ghi đè
    updated = asyncio.run(inv.update_import_receipt(
        rid, ImportReceiptUpdateRequest(**base, invoice_number="99", invoice_file_ids=[]), token="t",
    ))
    assert updated["invoice_number"] == "99"
    assert updated["invoice_file_ids"] == []
    assert updated["invoice_serial"] == "C26TAA"
