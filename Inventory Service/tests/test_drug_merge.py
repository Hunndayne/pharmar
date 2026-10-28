"""Gộp thuốc mồ côi (Arginine T0386 -> T0182, sự cố 10/2026).

Không cần Postgres. Test trên backup production thật chạy khi đặt PHARMAR_BACKUP_SQL.
"""

import asyncio
import copy
import json
import os
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from Routers import Inventory as inv
from Source.drug_merge import DrugMergeError, apply_plan, plan_drug_merge, revert_plan
from Source.schemas.inventory import DrugMergeRequest

OLD = "old-id"
NEW = "new-id"
OTHER = "other-id"


def _units(prefix):
    return [
        {"id": f"{prefix}-hop", "name": "Hộp", "conversion": 60, "barcode": ""},
        {"id": f"{prefix}-vi", "name": "Vỉ", "conversion": 5, "barcode": ""},
        {"id": f"{prefix}-vien", "name": "Viên", "conversion": 1, "barcode": ""},
    ]


def _state():
    def unit_prices(prefix):
        return [
            {"unit_id": f"{prefix}-hop", "unit_name": "Hộp", "conversion": 60, "price": 120000},
            {"unit_id": f"{prefix}-vien", "unit_name": "Viên", "conversion": 1, "price": 2000},
        ]

    return {
        "drugs": {
            OLD: {"id": OLD, "code": "T0386", "name": "Arginine", "units": _units("old")},
            NEW: {"id": NEW, "code": "T0182", "name": "Arginine", "units": _units("new")},
            OTHER: {"id": OTHER, "code": "T0386", "name": "Natri clorid", "units": _units("oth")},
        },
        "batches": {
            "bt-1": {"id": "bt-1", "drug_id": OLD, "qty_remaining": 45, "cancelled": False, "unit_prices": unit_prices("old")},
            "bt-2": {"id": "bt-2", "drug_id": NEW, "qty_remaining": 464, "cancelled": False, "unit_prices": unit_prices("new")},
            "bt-3": {"id": "bt-3", "drug_id": OTHER, "qty_remaining": 100, "cancelled": False, "unit_prices": unit_prices("oth")},
            "bt-4": {"id": "bt-4", "drug_id": OLD, "qty_remaining": 999, "cancelled": True, "unit_prices": []},
        },
        "receipts": {
            "rcp-1": {
                "id": "rcp-1",
                "lines": [
                    {"id": "l1", "drug_id": OLD, "drug_code": "T0386", "drug_name": "Arginine", "unit_prices": unit_prices("old")},
                    {"id": "l2", "drug_id": OTHER, "drug_code": "T0386", "drug_name": "Natri clorid", "unit_prices": unit_prices("oth")},
                ],
            }
        },
        "movements": [
            {"id": "mv-1", "drug_id": OLD, "batch_id": "bt-1", "quantity_delta": 300},
            {"id": "mv-2", "drug_id": OTHER, "batch_id": "bt-3", "quantity_delta": 100},
        ],
        "reservations": [],
        "sale_events": [],
        "audits": {},
        "disposal_log": [],
        "drug_recalls": {},
    }


def _plan(state, source=OLD, target=NEW):
    return plan_drug_merge(
        drugs=state["drugs"], collections=state, batches=state["batches"], source_id=source, target_id=target
    )


def test_merge_repoints_everything_and_leaves_other_drugs_alone():
    state = _state()
    plan = _plan(state)
    assert plan.source_stock == 45  # lô đã hủy không tính
    assert plan.target_stock == 464
    apply_plan(plan, state["drugs"])

    assert OLD not in state["drugs"]
    assert state["batches"]["bt-1"]["drug_id"] == NEW
    assert [u["unit_id"] for u in state["batches"]["bt-1"]["unit_prices"]] == ["new-hop", "new-vien"]
    line = state["receipts"]["rcp-1"]["lines"][0]
    assert (line["drug_id"], line["drug_code"]) == (NEW, "T0182")
    assert [u["unit_id"] for u in line["unit_prices"]] == ["new-hop", "new-vien"]
    assert state["movements"][0]["drug_id"] == NEW
    # Thuốc khác trùng mã T0386 không bị đụng tới.
    other_line = state["receipts"]["rcp-1"]["lines"][1]
    assert (other_line["drug_id"], other_line["drug_code"]) == (OTHER, "T0386")
    assert state["batches"]["bt-3"]["drug_id"] == OTHER
    assert state["movements"][1]["drug_id"] == OTHER


def test_stock_total_is_preserved():
    state = _state()
    plan = _plan(state)
    before = sum(b["qty_remaining"] for b in state["batches"].values() if not b["cancelled"])
    apply_plan(plan, state["drugs"])
    after = sum(b["qty_remaining"] for b in state["batches"].values() if not b["cancelled"])
    assert after == before
    assert sum(b["qty_remaining"] for b in state["batches"].values() if b["drug_id"] == NEW and not b["cancelled"]) == 509


def test_reservation_sku_is_repointed_only_on_source_lines():
    state = _state()
    state["reservations"] = [
        {
            "id": "rs-1",
            "items": [
                {"sku": OLD, "drug_id": OLD, "drug_code": "T0386", "drug_name": "Arginine", "allocations": []},
                {"sku": "T0386", "drug_id": OLD, "drug_code": "T0386", "drug_name": "Arginine", "allocations": []},
                # Natri clorid cùng mã T0386: sku là mã nhưng dòng không thuộc thuốc nguồn.
                {"sku": "T0386", "drug_id": OTHER, "drug_code": "T0386", "drug_name": "Natri clorid", "allocations": []},
            ],
        }
    ]
    plan = _plan(state)
    assert plan.changed_by_collection["reservations"] == 1
    apply_plan(plan, state["drugs"])

    items = state["reservations"][0]["items"]
    assert [(i["sku"], i["drug_id"]) for i in items] == [(NEW, NEW), ("T0182", NEW), ("T0386", OTHER)]
    assert OLD not in json.dumps(state)


def test_report_counts_top_level_records():
    state = _state()
    report = _plan(state).report(state["drugs"][OLD], state["drugs"][NEW])
    assert report["records_changed"] == {"batches": 2, "receipts": 1, "movements": 1}
    assert report["stock_after_merge"] == 509


def test_plan_does_not_mutate_and_revert_restores():
    state = _state()
    snapshot = copy.deepcopy(state)
    source = state["drugs"][OLD]
    plan = _plan(state)
    assert state == snapshot  # tính plan không đổi gì

    apply_plan(plan, state["drugs"])
    assert state != snapshot
    revert_plan(plan, state["drugs"], source)
    assert state == snapshot


def test_rejects_name_mismatch():
    state = _state()
    state["drugs"][NEW]["name"] = "Paracetamol"
    with pytest.raises(DrugMergeError, match="Tên khác nhau"):
        _plan(state)


def test_rejects_missing_unit_on_target():
    state = _state()
    state["drugs"][NEW]["units"] = [u for u in state["drugs"][NEW]["units"] if u["conversion"] != 5]
    with pytest.raises(DrugMergeError, match="thiếu đơn vị"):
        _plan(state)


def test_rejects_same_and_unknown_drug():
    state = _state()
    with pytest.raises(DrugMergeError) as same:
        _plan(state, OLD, OLD)
    assert same.value.status_code == 400
    with pytest.raises(DrugMergeError) as unknown:
        _plan(state, "nope", NEW)
    assert unknown.value.status_code == 404


# ---------- endpoint ----------

@pytest.fixture
def endpoint_env(monkeypatch):
    state = _state()
    saved = []

    monkeypatch.setattr(
        inv, "runtime_state",
        SimpleNamespace(
            lock=asyncio.Lock(), save_failed=False, state_unavailable=False,
            counters={}, suppliers={}, catalog_drugs_last_sync_at=None, catalog_suppliers_last_sync_at=None,
            **state,
        ),
    )
    monkeypatch.setattr(inv, "get_current_actor", lambda token: ("1", token, token))
    catalog = {NEW: {"id": NEW, "is_active": True}}
    errors = {}  # product_id -> mã HTTP Catalog trả về, hoặc "down" khi không kết nối được

    def handler(request):
        product_id = request.url.path.rsplit("/", 1)[-1]
        if errors.get(product_id) == "down":
            raise httpx.ConnectError("catalog down", request=request)
        if product_id in errors:
            return httpx.Response(errors[product_id])
        if product_id in catalog:
            return httpx.Response(200, json=catalog[product_id])
        return httpx.Response(404)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        inv.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )

    async def fake_save():
        saved.append(copy.deepcopy(inv.runtime_state.drugs))

    async def fake_archive():
        return True

    monkeypatch.setattr(inv, "save_runtime_state_safe", fake_save)
    monkeypatch.setattr(inv, "_archive_state_snapshot", fake_archive)
    monkeypatch.setattr(inv.settings, "STATE_PERSISTENCE", "postgres")
    return SimpleNamespace(catalog=catalog, errors=errors, saved=saved)


def _call(**kwargs):
    token = kwargs.pop("role", "owner")
    return asyncio.run(inv.merge_drugs(DrugMergeRequest(source_drug_id=OLD, target_drug_id=NEW, **kwargs), token=token))


def test_endpoint_dry_run_is_default_and_writes_nothing(endpoint_env):
    result = asyncio.run(inv.merge_drugs(DrugMergeRequest(source_drug_id=OLD, target_drug_id=NEW), token="owner"))
    assert result["dry_run"] is True
    assert OLD in inv.runtime_state.drugs
    assert endpoint_env.saved == []


def test_endpoint_real_merge_saves_and_removes_source(endpoint_env):
    result = _call(dry_run=False)
    assert result["dry_run"] is False and result["archived_snapshot"] is True
    assert OLD not in inv.runtime_state.drugs
    assert len(endpoint_env.saved) == 1


def test_endpoint_requires_owner(endpoint_env):
    with pytest.raises(HTTPException) as exc:
        _call(role="cashier", dry_run=False)
    assert exc.value.status_code == 403
    assert OLD in inv.runtime_state.drugs


def test_endpoint_refuses_when_source_still_in_catalog(endpoint_env):
    endpoint_env.catalog[OLD] = {"id": OLD, "is_active": True}
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 409
    assert OLD in inv.runtime_state.drugs


def test_endpoint_refuses_soft_deleted_source(endpoint_env):
    # Đồng bộ không lọc is_active nên thuốc xóa mềm sẽ được kéo về lại sau khi gộp.
    endpoint_env.catalog[OLD] = {"id": OLD, "is_active": False}
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 409
    assert "xóa mềm" in exc.value.detail
    assert OLD in inv.runtime_state.drugs


def test_endpoint_refuses_when_target_missing_in_catalog(endpoint_env):
    endpoint_env.catalog.clear()
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 409
    assert OLD in inv.runtime_state.drugs


@pytest.mark.parametrize("failure", ["down", 500, 503])
def test_endpoint_does_not_treat_catalog_error_on_source_as_missing(endpoint_env, failure):
    # Đích đọc được nhưng lần đọc nguồn lỗi: không được hiểu thành "nguồn không còn trong Catalog".
    endpoint_env.errors[OLD] = failure
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 502
    assert OLD in inv.runtime_state.drugs
    assert endpoint_env.saved == []


def test_endpoint_reverts_when_save_fails(endpoint_env, monkeypatch):
    async def failing_save():
        inv.runtime_state.save_failed = True

    monkeypatch.setattr(inv, "save_runtime_state_safe", failing_save)
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 500
    assert OLD in inv.runtime_state.drugs
    assert inv.runtime_state.batches["bt-1"]["drug_id"] == OLD


def test_endpoint_aborts_without_snapshot(endpoint_env, monkeypatch):
    async def no_archive():
        return False

    monkeypatch.setattr(inv, "_archive_state_snapshot", no_archive)
    with pytest.raises(HTTPException) as exc:
        _call(dry_run=False)
    assert exc.value.status_code == 500
    assert OLD in inv.runtime_state.drugs


# ---------- backup production thật ----------

BACKUP = os.environ.get("PHARMAR_BACKUP_SQL")


def _load_backup_payload(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("COPY public.inventory_runtime_state ("))
    raw = lines[start + 1].rstrip("\n").split("\t")[1]
    out, i = [], 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            out.append({"n": "\n", "t": "\t", "r": "\r", "\\": "\\"}.get(raw[i + 1], raw[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return json.loads("".join(out))


@pytest.mark.skipif(not BACKUP, reason="Đặt PHARMAR_BACKUP_SQL trỏ tới file backup production để chạy")
def test_real_backup_arginine_merge():
    old = "cdb8e3f4-d1f7-480c-8ae6-e37989d3e63a"
    new = "1c85520f-96ee-4943-85ec-fab9f0fbc44f"
    p = _load_backup_payload(BACKUP)
    total_before = sum(b["qty_remaining"] for b in p["batches"].values() if not b["cancelled"])
    plan = plan_drug_merge(drugs=p["drugs"], collections=p, batches=p["batches"], source_id=old, target_id=new)
    report = plan.report(p["drugs"][old], p["drugs"][new])
    assert (plan.source_stock, plan.target_stock) == (45, 464)
    assert report["records_changed"]["batches"] == 1
    assert report["records_changed"]["receipts"] == 1
    assert report["records_changed"]["movements"] == 28

    apply_plan(plan, p["drugs"])
    assert old not in p["drugs"] and len(p["drugs"]) == 533
    assert "cdb8e3f4" not in json.dumps(p, ensure_ascii=False)  # không còn tham chiếu nào
    assert sum(b["qty_remaining"] for b in p["batches"].values() if not b["cancelled"]) == total_before
    # Natri clorid giữ nguyên mã T0386 và lô của nó.
    natri = "d6813d01-1eee-46dc-9d79-588432a48d86"
    assert p["drugs"][natri]["code"] == "T0386"
    assert sum(1 for b in p["batches"].values() if b["drug_id"] == natri) == 2


# ---------- end-to-end trên Postgres thật + backup production ----------

DSN = os.environ.get("INVENTORY_TEST_DSN")


async def _load_into_db(payload):
    import asyncpg
    from Source.persistence.relational_store import ALL_TABLES

    conn = await asyncpg.connect(DSN)
    try:
        for table in ALL_TABLES:
            await conn.execute(f"DROP TABLE IF EXISTS {table}")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state_history")
        await conn.execute(
            "CREATE TABLE inventory_runtime_state ("
            " id SMALLINT PRIMARY KEY CHECK (id=1), payload JSONB NOT NULL,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        await conn.execute(
            "INSERT INTO inventory_runtime_state(id, payload) VALUES (1, $1::jsonb)", json.dumps(payload)
        )
    finally:
        await conn.close()


async def _db_scalar(sql):
    import asyncpg

    conn = await asyncpg.connect(DSN)
    try:
        return await conn.fetchval(sql)
    finally:
        await conn.close()


@pytest.mark.skipif(not (DSN and BACKUP), reason="Cần INVENTORY_TEST_DSN và PHARMAR_BACKUP_SQL")
@pytest.mark.parametrize("mode", ["blob", "relational"])
def test_real_backup_merge_end_to_end_on_postgres(monkeypatch, mode):
    from Source.persistence.relational_store import RelationalStore

    old = "cdb8e3f4-d1f7-480c-8ae6-e37989d3e63a"
    new = "1c85520f-96ee-4943-85ec-fab9f0fbc44f"

    async def noop_fetch(force=False):
        return None

    async def fake_catalog(product_id, token):
        return {"id": new, "is_active": True} if product_id == new else None

    monkeypatch.setattr(inv.settings, "STATE_PERSISTENCE", "postgres")
    monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
    monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", mode)
    monkeypatch.setattr(inv, "fetch_inventory_settings", noop_fetch)
    monkeypatch.setattr(inv, "fetch_catalog_product_strict", fake_catalog)
    monkeypatch.setattr(inv, "get_current_actor", lambda token: ("1", "owner", "owner"))
    inv.runtime_state.pg_pool = None
    inv.runtime_state.save_failed = False
    inv.runtime_state.state_unavailable = False
    inv.runtime_state.lock = asyncio.Lock()
    inv.runtime_state.save_lock = None
    inv.runtime_state.relational_store = RelationalStore()
    inv.runtime_state.relational_ready = False
    inv.runtime_state.storage_mode = None
    inv.initialize_empty_state()

    payload = _load_backup_payload(BACKUP)
    total_before = sum(b["qty_remaining"] for b in payload["batches"].values() if not b["cancelled"])

    async def scenario():
        await _load_into_db(payload)
        try:
            assert await inv.reload_runtime_state_from_storage() is True
            assert old in inv.runtime_state.drugs

            dry = await inv.merge_drugs(DrugMergeRequest(source_drug_id=old, target_drug_id=new), token="t")
            assert dry["dry_run"] is True
            assert await _db_scalar("SELECT count(*) FROM inventory_runtime_state_history") == 0

            done = await inv.merge_drugs(
                DrugMergeRequest(source_drug_id=old, target_drug_id=new, dry_run=False), token="t"
            )
            assert done["archived_snapshot"] is True and done["stock_after_merge"] == 509
            assert inv.runtime_state.save_failed is False

            # Snapshot là bản TRƯỚC khi gộp: còn 534 thuốc và còn id cũ.
            assert await _db_scalar("SELECT count(*) FROM inventory_runtime_state_history") == 1
            assert await _db_scalar("SELECT drug_count FROM inventory_runtime_state_history") == 534
            assert await _db_scalar(
                f"SELECT payload::text LIKE '%{old}%' FROM inventory_runtime_state_history"
            ) is True
            # Blob hiện tại: đã gộp, không còn tham chiếu nào.
            assert await _db_scalar("SELECT drug_count FROM inventory_runtime_state WHERE id=1") == 533
            assert await _db_scalar(
                f"SELECT payload::text LIKE '%{old}%' FROM inventory_runtime_state WHERE id=1"
            ) is False

            # Nạp lại từ storage (như sau khi restart) phải ra đúng trạng thái đã gộp.
            inv.runtime_state.relational_ready = False
            inv.runtime_state.relational_store = RelationalStore()
            inv.initialize_empty_state()
            assert await inv.reload_runtime_state_from_storage() is True
            assert old not in inv.runtime_state.drugs and len(inv.runtime_state.drugs) == 533
            assert inv.runtime_state.batches["bt-470"]["drug_id"] == new
            return sum(b["qty_remaining"] for b in inv.runtime_state.batches.values() if not b["cancelled"])
        finally:
            await inv._discard_pg_pool()

    assert asyncio.run(scenario()) == total_before
