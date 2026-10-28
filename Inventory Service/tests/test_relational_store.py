"""Test lớp lưu trữ quan hệ (Source/persistence/relational_store.py).

Phần "pure" luôn chạy (không cần DB). Phần DB cần INVENTORY_TEST_DSN, ví dụ:
    docker run -d --name pharmar-pg-test -e POSTGRES_PASSWORD=testpass \
        -e POSTGRES_DB=pharmar_inventory_test -p 55433:5432 postgres:16-alpine
    INVENTORY_TEST_DSN=postgresql://postgres:testpass@127.0.0.1:55433/pharmar_inventory_test \
        python -m pytest tests/test_relational_store.py -q
Mỗi test DB DROP toàn bộ ALL_TABLES trước khi chạy.
"""

import asyncio
import copy
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Source.persistence import relational_store as rs  # noqa: E402
from Source.persistence.relational_store import (  # noqa: E402
    ALL_TABLES,
    DICT_COLLECTIONS,
    LIST_COLLECTIONS,
    META_KEYS,
    RelationalStateMismatch,
    RelationalStore,
    canonical_json,
)

DSN = os.environ.get("INVENTORY_TEST_DSN")
needs_db = pytest.mark.skipif(not DSN, reason="Cần INVENTORY_TEST_DSN trỏ tới một Postgres dùng để test")
REAL_PAYLOAD_PATH = Path(__file__).resolve().parents[2] / "recovery" / "rebuilt_payload.json"


def _real_payload() -> dict:
    if not REAL_PAYLOAD_PATH.exists():
        pytest.skip("Thiếu rebuilt_payload.json")
    return json.loads(REAL_PAYLOAD_PATH.read_text(encoding="utf-8"))


def _small_payload() -> dict:
    return {
        "counters": {"batch": 3, "movement": 3},
        "suppliers": {"S1": {"id": "S1", "name": "NCC 1"}},
        "drugs": {f"D{i}": {"id": f"D{i}", "code": f"T{i}", "name": f"Thuoc {i}"} for i in range(3)},
        "receipts": {"R1": {"id": "R1", "receipt_date": "2026-07-01", "status": "confirmed", "supplier_id": "S1"}},
        "batches": {
            f"B{i}": {"id": f"B{i}", "drug_id": f"D{i}", "batch_code": f"L{i}", "exp_date": "2027-01-01",
                      "qty_remaining": 10 + i, "cancelled": False}
            for i in range(3)
        },
        "audits": {},
        "drug_recalls": {},
        "movements": [{"id": f"mv-{i}", "event_type": "import_receipt", "drug_id": "D0", "batch_id": "B0",
                       "quantity_delta": i, "occurred_at": "2026-07-01T00:00:00+00:00"} for i in range(1, 4)],
        "reservations": [{"id": "rsv-1", "sale_id": "HD1", "reserved_at": "2026-07-01T00:00:00+00:00"}],
        "disposal_log": [],
        "sale_events": [{"x": 1}],
        "catalog_last_sync_at": "2026-07-11T05:20:41+00:00",
    }


def _loaded_store(payload: dict) -> RelationalStore:
    """Mô phỏng 'đã lưu payload này vào DB' mà không cần DB."""
    s = RelationalStore()
    s.commit_diff(s.compute_diff(payload))
    return s


def _roundtrip_equal(a: dict, b: dict, keys=None) -> None:
    keys = keys or [k for k in (*DICT_COLLECTIONS, *LIST_COLLECTIONS, *META_KEYS) if k in a]
    for k in keys:
        assert canonical_json(a[k]) == canonical_json(b[k]), k


# ------------------------------------------------------------------ pure tests


def test_row_keys_basic_duplicates_and_missing_ids():
    items = [{"id": "a"}, {"id": "b"}, {"id": "a"}, {"id": "a"}, {"x": 1}, "str", None, {"id": ""}, {"id": 7}]
    assert rs.list_row_keys(items) == ["a", "b", "a#2", "a#3", "__idx_4", "__idx_5", "__idx_6", "__idx_7", "7"]
    # tất định
    assert rs.list_row_keys(items) == rs.list_row_keys(copy.deepcopy(items))
    # không trùng kể cả khi id thật giống khóa sinh ra
    keys = rs.list_row_keys([{"id": "a"}, {"id": "a"}, {"id": "a#2"}])
    assert len(set(keys)) == 3


def test_compute_diff_rejects_non_dict():
    s = RelationalStore()
    for bad in (None, [], "x", 5):
        with pytest.raises(ValueError):
            s.compute_diff(bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        s.compute_diff({"drugs": []})
    with pytest.raises(ValueError):
        s.compute_diff({"movements": {}})


def test_empty_dict_payload_is_noop_and_never_deletes():
    s = _loaded_store(_small_payload())
    plan = s.compute_diff({})
    assert plan.is_empty() and not plan.destructive


def test_diff_insert_update_delete():
    p = _small_payload()
    s = RelationalStore()
    plan = s.compute_diff(p)
    sm = plan.summary()
    assert sm["inserted"]["drugs"] == 3 and sm["inserted"]["batches"] == 3 and sm["inserted"]["movements"] == 3
    assert sm["inserted"]["meta"] == 3 and not plan.is_empty()
    s.commit_diff(plan)
    assert s.compute_diff(p).is_empty()

    p2 = copy.deepcopy(p)
    p2["batches"]["B1"]["qty_remaining"] = 99
    p2["batches"]["B9"] = {"id": "B9", "drug_id": "D1"}
    del p2["drugs"]["D2"]
    p2["counters"]["batch"] = 4
    plan = s.compute_diff(p2)
    sm = plan.summary()
    assert sm["updated"]["batches"] == 1 and sm["inserted"]["batches"] == 1 and sm["deleted"]["drugs"] == 1
    assert sm["updated"]["meta"] == 1
    assert sm["updated"]["drugs"] == 0 and sm["deleted"]["batches"] == 0
    s.commit_diff(plan)
    assert s.compute_diff(p2).is_empty()


def test_dict_key_order_does_not_matter_for_diff():
    p = _small_payload()
    s = _loaded_store(p)
    p2 = copy.deepcopy(p)
    p2["drugs"] = dict(reversed(list(p["drugs"].items())))
    p2["batches"]["B0"] = dict(reversed(list(p["batches"]["B0"].items())))
    assert s.compute_diff(p2).is_empty()


def test_list_append_keeps_seqs():
    p = _small_payload()
    s = _loaded_store(p)
    p["movements"].append({"id": "mv-4", "quantity_delta": 4})
    p["movements"].append({"id": "mv-5", "quantity_delta": 5})
    plan = s.compute_diff(p)
    cd = plan.collections["movements"]
    assert [(k, seq) for k, _, seq in cd.inserts] == [("mv-4", 3), ("mv-5", 4)]
    assert not cd.updates and not cd.reseq and not cd.deletes
    s.commit_diff(plan)
    assert s.compute_diff(p).is_empty()


def test_list_removal_from_middle_keeps_remaining_seqs():
    p = _small_payload()
    s = _loaded_store(p)
    p["movements"] = [m for m in p["movements"] if m["id"] != "mv-2"]
    p["movements"].append({"id": "mv-4"})
    plan = s.compute_diff(p)
    cd = plan.collections["movements"]
    assert cd.deletes == ["mv-2"] and not cd.reseq and not cd.updates
    assert cd.inserts == [("mv-4", canonical_json({"id": "mv-4"}), 3)]
    s.commit_diff(plan)
    assert s._state.seq["movements"] == {"mv-1": 0, "mv-3": 2, "mv-4": 3}
    assert s.compute_diff(p).is_empty()


def test_list_reorder_triggers_reseq():
    p = _small_payload()
    s = _loaded_store(p)
    p["movements"].reverse()
    plan = s.compute_diff(p)
    cd = plan.collections["movements"]
    assert {k: seq for k, seq in cd.reseq} == {"mv-3": 0, "mv-1": 2}  # mv-2 giữ seq 1
    assert not cd.inserts and not cd.updates and not cd.deletes
    s.commit_diff(plan)
    assert [k for k, _ in sorted(s._state.seq["movements"].items(), key=lambda kv: kv[1])] == ["mv-3", "mv-2", "mv-1"]
    assert s.compute_diff(p).is_empty()


def test_new_key_in_middle_triggers_reseq():
    p = _small_payload()
    s = _loaded_store(p)
    p["movements"].insert(1, {"id": "mv-new"})
    plan = s.compute_diff(p)
    cd = plan.collections["movements"]
    assert [(k, seq) for k, _, seq in cd.inserts] == [("mv-new", 1)]
    assert {k: seq for k, seq in cd.reseq} == {"mv-2": 2, "mv-3": 3}


def test_reservation_cap_slicing_is_not_destructive_and_keeps_seq():
    p = {"reservations": [{"id": f"r{i}"} for i in range(600)]}
    s = _loaded_store(p)
    p["reservations"] = p["reservations"][-500:]
    plan = s.compute_diff(p)
    cd = plan.collections["reservations"]
    assert len(cd.deletes) == 100 and not cd.reseq and not cd.inserts and not plan.destructive


def test_destructive_warnings():
    p = {"batches": {f"B{i}": {"id": f"B{i}"} for i in range(521)}, "movements": [{"id": "a"}], "drugs": {"D": {}}}
    s = _loaded_store(p)
    plan = s.compute_diff({"batches": {f"B{i}": {"id": f"B{i}"} for i in range(3)}, "movements": [], "drugs": {"D": {}}})
    assert "batches 521->3" in plan.destructive and "movements 1->0" in plan.destructive
    assert len(plan.destructive) == 2
    # dưới ngưỡng: 20 -> 11 không cảnh báo, 20 -> 9 có cảnh báo, 5 -> 3 không
    s2 = _loaded_store({"drugs": {f"D{i}": {} for i in range(20)}})
    assert not s2.compute_diff({"drugs": {f"D{i}": {} for i in range(11)}}).destructive
    assert s2.compute_diff({"drugs": {f"D{i}": {} for i in range(9)}}).destructive == ["drugs 20->9"]
    s3 = _loaded_store({"drugs": {f"D{i}": {} for i in range(5)}})
    assert not s3.compute_diff({"drugs": {"D0": {}, "D1": {}, "D2": {}}}).destructive
    # warning thôi: plan vẫn chứa deletes
    assert s2.compute_diff({"drugs": {}}).collections["drugs"].deletes


class _Color(Enum):
    RED = "red"


def _reference_default(value):
    # Bản sao nguyên văn _json_default trong Routers/Inventory.py
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def test_canonical_json_matches_legacy_default():
    value = {
        "b": datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc),
        "a": date(2026, 7, 1),
        "c": [_Color.RED, {"z": "Tiếng Việt", "y": 1.5}],
        "d": None,
    }
    expected = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=_reference_default)
    assert canonical_json(value) == expected
    assert '"2026-07-01"' in expected and '"red"' in expected and "Tiếng Việt" in expected
    try:  # nếu import được service thật thì so luôn với hàm gốc
        from Routers import Inventory as inv  # noqa: WPS433

        assert json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=inv._json_default) == expected
    except ImportError:
        pass
    with pytest.raises(TypeError):
        canonical_json({"x": object()})


def test_datetime_in_memory_equals_iso_string_in_cache():
    now = datetime(2026, 7, 1, 8, 0, tzinfo=timezone.utc)
    s = _loaded_store({"batches": {"B": {"id": "B", "updated_at": now.isoformat(), "exp_date": "2027-01-01"}}})
    mem = {"batches": {"B": {"id": "B", "updated_at": now, "exp_date": date(2027, 1, 1)}}}
    assert s.compute_diff(mem).is_empty()


def test_extraction_garbage_never_raises():
    garbage = [
        {"exp_date": "31/02/2026-RAC", "qty_remaining": "abc", "cancelled": "yes", "drug_id": {"x": 1}, "batch_code": None},
        {"exp_date": "2026-02-31", "qty_remaining": True, "cancelled": 1, "drug_id": 12},
        {"exp_date": "0001-01-01", "qty_remaining": 10**30, "cancelled": None},
        {"exp_date": 12345, "qty_remaining": 1.5, "drug_id": "a\x00b"},
        {"exp_date": "2026-07-01", "qty_remaining": "12", "cancelled": True, "drug_id": "ok"},
        {"qty_remaining": 7.0},
        [], "str", None, 5,
    ]
    for rec in garbage:
        for coll in (*DICT_COLLECTIONS, *LIST_COLLECTIONS):
            vals = rs._extract(coll, canonical_json(rec))
            assert len(vals) == len(rs._COLUMNS[coll])
    b = rs._extract("batches", canonical_json(garbage[4]))
    assert b[0] == "ok" and b[2] == date(2026, 7, 1) and b[3] == 12 and b[4] is True
    b = rs._extract("batches", canonical_json(garbage[1]))
    assert b[2] is None and b[3] is None and b[4] is None and b[0] == "12"  # bool không phải int/bool lẫn lộn
    assert rs._extract("batches", canonical_json(garbage[5]))[3] == 7
    assert rs._extract("batches", canonical_json(garbage[2]))[2:5] == (None, None, None)
    m = rs._extract("movements", canonical_json({"occurred_at": "2026-07-01T10:00:00", "quantity_delta": -3}))
    assert m[6] == datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc) and m[5] == -3
    assert rs._extract("movements", canonical_json({"occurred_at": "không phải ngày"}))[6] is None


def test_meta_diff_and_absent_keys_untouched():
    p = _small_payload()
    s = _loaded_store(p)
    p2 = {k: v for k, v in p.items() if k != "catalog_last_sync_at"}
    assert s.compute_diff(p2).is_empty()  # thiếu key = không đụng tới
    p["catalog_last_sync_at"] = None
    plan = s.compute_diff(p)
    assert plan.meta_changed == {"catalog_last_sync_at": "null"}


def test_failed_commit_not_called_keeps_diff():
    p = _small_payload()
    s = _loaded_store(p)
    p["batches"]["B0"]["qty_remaining"] = 1
    plan1 = s.compute_diff(p)  # "transaction" lỗi -> không commit_diff
    plan2 = s.compute_diff(p)
    assert plan1.summary() == plan2.summary() and not plan2.is_empty()


def test_stale_plan_after_reset_is_ignored():
    p = _small_payload()
    s = RelationalStore()
    plan = s.compute_diff(p)
    s.reset_cache()
    s.commit_diff(plan)
    assert not s.compute_diff(p).is_empty()  # cache vẫn trống


def test_compute_diff_timing_on_real_payload():
    payload = _real_payload()
    s = _loaded_store(payload)
    payload["movements"][5000]["note"] = "changed"
    best = 1e9
    for _ in range(5):
        t0 = time.perf_counter()
        plan = s.compute_diff(payload)
        best = min(best, time.perf_counter() - t0)
    print(f"\ncompute_diff real payload, 1 changed movement: {best * 1000:.1f} ms")
    assert plan.summary()["updated"]["movements"] == 1 and plan.summary()["inserted"]["movements"] == 0
    assert sum(plan.summary()["updated"].values()) == 1
    assert best < 2.0


# ------------------------------------------------------------------ DB tests


def _db(coro_fn):
    """Chạy coro_fn(conn) trên kết nối mới sau khi DROP toàn bộ bảng."""
    import asyncpg

    async def runner():
        conn = await asyncpg.connect(DSN)
        try:
            for t in ALL_TABLES:
                await conn.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
            return await coro_fn(conn)
        finally:
            await conn.close()

    return asyncio.run(runner())


async def _count(conn, table, where="TRUE"):
    return await conn.fetchval(f"SELECT count(*) FROM {table} WHERE {where}")


@needs_db
def test_db_migrate_real_payload_roundtrip():
    payload = _real_payload()
    blob_ts = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)

    async def body(conn):
        s = RelationalStore()
        assert not await s.is_migrated(conn)
        plan = await s.migrate_from_payload(conn, payload, blob_ts)
        assert plan.summary()["inserted"]["movements"] == 10057
        assert await s.is_migrated(conn)
        expected = {"drugs": 447, "batches": 521, "receipts": 133, "movements": 10057, "reservations": 500}
        for c, n in expected.items():
            assert await _count(conn, f"inventory_{c}") == n, c
        assert s.compute_diff(payload).is_empty()

        fresh = RelationalStore()
        loaded = await fresh.load_payload(conn)
        _roundtrip_equal(payload, loaded)
        assert canonical_json({k: payload[k] for k in payload}) == canonical_json({k: loaded[k] for k in payload})
        assert list(loaded["drugs"]) == list(payload["drugs"])  # thứ tự dict giữ nguyên
        assert [m["id"] for m in loaded["movements"]] == [m["id"] for m in payload["movements"]]
        assert fresh.compute_diff(payload).is_empty()
        # cột trích xuất
        assert await _count(conn, "inventory_batches", "exp_date IS NOT NULL") > 0
        assert await _count(conn, "inventory_movements", "occurred_at IS NOT NULL") == 10057

    _db(body)


@needs_db
def test_db_apply_commit_then_fresh_load_equals_mutated():
    payload = _real_payload()

    async def body(conn):
        s = RelationalStore()
        await s.migrate_from_payload(conn, payload, None)
        p = copy.deepcopy(payload)
        some_batch = next(iter(p["batches"]))
        p["batches"][some_batch]["qty_remaining"] = 123456
        p["batches"]["bt-new"] = {"id": "bt-new", "drug_id": "x", "exp_date": date(2030, 1, 2), "cancelled": False}
        del p["receipts"][next(iter(p["receipts"]))]
        p["movements"] = [m for m in p["movements"] if m["id"] != "mv-100"]
        p["movements"].append({"id": "mv-new", "event_type": _Color.RED, "occurred_at": datetime(2026, 8, 1, tzinfo=timezone.utc),
                               "quantity_delta": -2})
        p["reservations"] = p["reservations"][50:]
        p["counters"]["movement"] += 1
        p["sale_events"] = [{"a": 1}]
        plan = s.compute_diff(p)
        assert not plan.is_empty()
        async with conn.transaction():
            await s.apply_diff(conn, plan)
        s.commit_diff(plan)
        assert s.compute_diff(p).is_empty()

        fresh = RelationalStore()
        loaded = await fresh.load_payload(conn)
        _roundtrip_equal(p, loaded)
        assert [m["id"] for m in loaded["movements"]][-1] == "mv-new"
        assert fresh.compute_diff(p).is_empty()
        assert await _count(conn, "inventory_movements", "row_key='mv-new' AND quantity_delta=-2 AND event_type='red'") == 1

    _db(body)


@needs_db
def test_db_deletes_are_archived():
    payload = _small_payload()

    async def body(conn):
        s = RelationalStore()
        await s.migrate_from_payload(conn, payload, None)
        p = copy.deepcopy(payload)
        del p["drugs"]["D2"]
        p["movements"] = p["movements"][:1]
        del p["catalog_last_sync_at"]
        plan = s.compute_diff(p)
        plan.meta_deletes.append("catalog_last_sync_at")  # xóa meta tường minh
        async with conn.transaction():
            await s.apply_diff(conn, plan)
        s.commit_diff(plan)
        rows = await conn.fetch("SELECT collection,row_key,data,reason FROM inventory_deleted_rows WHERE reason='save'")
        got = {(r["collection"], r["row_key"]) for r in rows}
        assert got == {("drugs", "D2"), ("movements", "mv-2"), ("movements", "mv-3"), ("meta", "catalog_last_sync_at")}
        d2 = next(r for r in rows if r["row_key"] == "D2")
        assert json.loads(d2["data"])["name"] == "Thuoc 2"
        assert await _count(conn, "inventory_drugs") == 2

    _db(body)


@needs_db
def test_db_apply_diff_outside_transaction_raises():
    async def body(conn):
        s = RelationalStore()
        await s.migrate_from_payload(conn, _small_payload(), None)
        p = _small_payload()
        p["drugs"]["D0"]["name"] = "đổi"
        plan = s.compute_diff(p)
        with pytest.raises(RuntimeError):
            await s.apply_diff(conn, plan)
        assert (await RelationalStore().load_payload(conn))["drugs"]["D0"]["name"] == "Thuoc 0"

    _db(body)


@needs_db
def test_db_failed_transaction_keeps_cache_and_diff():
    payload = _small_payload()

    async def body(conn):
        s = RelationalStore()
        await s.migrate_from_payload(conn, payload, None)
        p = copy.deepcopy(payload)
        p["batches"]["B0"]["qty_remaining"] = 777
        p["movements"].append({"id": "mv-9"})
        plan = s.compute_diff(p)
        with pytest.raises(RuntimeError, match="boom"):
            async with conn.transaction():
                await s.apply_diff(conn, plan)
                raise RuntimeError("boom")
        # DB không đổi, cache không đổi, diff kế tiếp vẫn chứa thay đổi
        loaded = await RelationalStore().load_payload(conn)
        _roundtrip_equal(payload, loaded)
        plan2 = s.compute_diff(p)
        assert plan2.summary() == plan.summary()
        async with conn.transaction():
            await s.apply_diff(conn, plan2)
        s.commit_diff(plan2)
        _roundtrip_equal(p, await RelationalStore().load_payload(conn))

    _db(body)


@needs_db
def test_db_state_mismatch_rolls_back(monkeypatch):
    payload = _small_payload()

    async def body(conn):
        s = RelationalStore()
        await s.ensure_schema(conn)
        orig = RelationalStore._read_back

        async def corrupt(self, c):
            pl, st = await orig(self, c)
            st.canon["drugs"]["D0"] = '{"corrupted":true}'
            return pl, st

        monkeypatch.setattr(RelationalStore, "_read_back", corrupt)
        with pytest.raises(RelationalStateMismatch, match="drugs"):
            await s.migrate_from_payload(conn, payload, None)
        monkeypatch.setattr(RelationalStore, "_read_back", orig)
        for c in (*DICT_COLLECTIONS, *LIST_COLLECTIONS):
            assert await _count(conn, f"inventory_{c}") == 0
        assert await _count(conn, "inventory_meta") == 0
        assert not await s.is_migrated(conn)
        assert s.compute_diff(payload).summary()["inserted"]["drugs"] == 3  # cache chưa bị đụng

        # Remigrate lỗi không được làm mất dữ liệu đã migrate trước đó
        await s.migrate_from_payload(conn, payload, None)
        monkeypatch.setattr(RelationalStore, "_read_back", corrupt)
        with pytest.raises(RelationalStateMismatch):
            await s.migrate_from_payload(conn, _small_payload() | {"drugs": {}}, None)
        monkeypatch.setattr(RelationalStore, "_read_back", orig)
        assert await _count(conn, "inventory_drugs") == 3
        assert await s.is_migrated(conn)
        assert s.compute_diff(payload).is_empty()

    _db(body)


@needs_db
def test_db_needs_migration_from_blob_cases():
    t0 = datetime(2026, 7, 27, 10, 0, tzinfo=timezone.utc)

    async def body(conn):
        s = RelationalStore()
        assert not await s.needs_migration_from_blob(conn, None)
        assert await s.needs_migration_from_blob(conn, t0)  # chưa có bảng nào
        await s.ensure_schema(conn)
        assert await s.needs_migration_from_blob(conn, t0)  # có bảng, chưa migrate
        await s.migrate_from_payload(conn, _small_payload(), None)  # blob_synced = null
        assert not await s.needs_migration_from_blob(conn, t0)
        assert not await s.needs_migration_from_blob(conn, None)
        await s.migrate_from_payload(conn, _small_payload(), t0)
        assert not await s.needs_migration_from_blob(conn, t0)
        assert not await s.needs_migration_from_blob(conn, t0 - timedelta(hours=1))
        assert await s.needs_migration_from_blob(conn, t0 + timedelta(microseconds=1))
        assert not await s.needs_migration_from_blob(conn, t0.replace(tzinfo=None))  # naive coi như UTC
        t1 = t0 + timedelta(hours=2)
        async with conn.transaction():
            await s.write_blob_sync_marker(conn, t1)
        assert not await s.needs_migration_from_blob(conn, t1)
        assert await s.needs_migration_from_blob(conn, t1 + timedelta(seconds=1))
        # marker chưa tồn tại thì không được tự tạo
        await conn.execute("DELETE FROM inventory_meta WHERE key='__migration__'")
        with pytest.raises(RuntimeError):
            await s.write_blob_sync_marker(conn, t1)
        assert not await s.is_migrated(conn)

    _db(body)


@needs_db
def test_db_remigrate_archives_old_rows():
    async def body(conn):
        s = RelationalStore()
        p1 = _small_payload()
        await s.migrate_from_payload(conn, p1, None)
        p2 = _small_payload()
        p2["drugs"] = {"D9": {"id": "D9", "name": "mới"}}
        p2["movements"] = []
        await s.migrate_from_payload(conn, p2, None)
        archived = await conn.fetch("SELECT collection,row_key FROM inventory_deleted_rows WHERE reason='remigrate'")
        keys = {(r["collection"], r["row_key"]) for r in archived}
        assert {("drugs", "D0"), ("drugs", "D1"), ("drugs", "D2"), ("movements", "mv-1"), ("meta", "counters"),
                ("meta", "__migration__")} <= keys
        loaded = await RelationalStore().load_payload(conn)
        _roundtrip_equal(p2, loaded)
        assert list(loaded["drugs"]) == ["D9"]
        assert await _count(conn, "inventory_deleted_rows", "reason='remigrate' AND collection='drugs'") == 3

    _db(body)


@needs_db
def test_db_extraction_with_garbage_values_does_not_fail_save():
    async def body(conn):
        s = RelationalStore()
        p = _small_payload()
        await s.migrate_from_payload(conn, p, None)
        p["batches"]["B0"].update({"exp_date": "31/02/2026-RAC", "qty_remaining": "abc", "cancelled": "maybe"})
        p["batches"]["B1"].update({"exp_date": 20260101, "qty_remaining": 10**30, "drug_id": {"nested": 1}})
        p["receipts"]["R1"]["receipt_date"] = "không phải ngày"
        p["movements"].append({"id": "mv-bad", "occurred_at": "xx", "quantity_delta": 1.5, "event_type": ["a"]})
        p["movements"].append({"no_id": True})
        p["movements"].append("không phải dict")
        p["movements"].append({"id": "mv-1"})  # id trùng
        p["reservations"].append({"id": "rsv-2", "reserved_at": 12345})
        plan = s.compute_diff(p)
        async with conn.transaction():
            await s.apply_diff(conn, plan)
        s.commit_diff(plan)
        row = await conn.fetchrow("SELECT exp_date, qty_remaining, cancelled FROM inventory_batches WHERE row_key='B0'")
        assert row["exp_date"] is None and row["qty_remaining"] is None and row["cancelled"] is None
        loaded = await RelationalStore().load_payload(conn)
        _roundtrip_equal(p, loaded)
        assert [k for k in await conn.fetchval("SELECT array_agg(row_key ORDER BY seq) FROM inventory_movements")][-4:] == [
            "mv-bad", "__idx_4", "__idx_5", "mv-1#2"]

    _db(body)


@needs_db
def test_db_list_reorder_persisted_in_order():
    async def body(conn):
        s = RelationalStore()
        p = _small_payload()
        await s.migrate_from_payload(conn, p, None)
        p["movements"].reverse()
        p["movements"].append({"id": "mv-4"})
        plan = s.compute_diff(p)
        async with conn.transaction():
            await s.apply_diff(conn, plan)
        s.commit_diff(plan)
        loaded = await RelationalStore().load_payload(conn)
        assert [m["id"] for m in loaded["movements"]] == ["mv-3", "mv-2", "mv-1", "mv-4"]

    _db(body)
