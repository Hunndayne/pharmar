"""Test các chế độ lưu trữ của Inventory: relational (mặc định), blob (rollback), blob-fallback.

Cần Postgres dùng để test (đặt INVENTORY_TEST_DSN), ví dụ:
    docker run -d --name pharmar-pg-test -e POSTGRES_PASSWORD=testpass \
        -e POSTGRES_DB=pharmar_inventory_test -p 55433:5432 postgres:16-alpine
    INVENTORY_TEST_DSN=postgresql://postgres:testpass@127.0.0.1:55433/pharmar_inventory_test \
        python -m pytest tests/test_storage_modes.py -q
Mỗi test DROP toàn bộ bảng legacy + ALL_TABLES trước khi chạy.
"""

import asyncio
import json
import logging
import os

import asyncpg
import pytest

from Routers import Inventory as inv
from Source.persistence.relational_store import (
    ALL_TABLES,
    RelationalStateMismatch,
    RelationalStore,
    canonical_json,
)

DSN = os.environ.get("INVENTORY_TEST_DSN")

pytestmark = pytest.mark.skipif(
    not DSN, reason="Cần INVENTORY_TEST_DSN trỏ tới một Postgres dùng để test"
)

DRUGS, BATCHES, RECEIPTS = 20, 15, 12


def _payload():
    return {
        "counters": {"batch": BATCHES, "movement": 6},
        "suppliers": {"S1": {"id": "S1", "code": "S1", "name": "NCC 1"}},
        "drugs": {f"D{i}": {"id": f"D{i}", "code": f"T{i}", "name": f"Thuoc {i}"} for i in range(DRUGS)},
        "batches": {
            f"B{i}": {
                "id": f"B{i}", "drug_id": f"D{i}", "batch_code": f"L{i}", "exp_date": "2027-01-01",
                "received_date": "2026-07-01", "mfg_date": "2026-01-01",
                "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00",
                "qty_remaining": 10 + i, "cancelled": False,
            }
            for i in range(BATCHES)
        },
        "receipts": {
            f"R{i}": {
                "id": f"R{i}", "code": f"PN{i}", "receipt_date": "2026-07-01", "supplier_id": "S1",
                "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00",
                "lines": [{"drug_id": "D1", "mfg_date": "2026-01-01", "exp_date": "2027-01-01"}],
            }
            for i in range(RECEIPTS)
        },
        "movements": [
            {"id": f"mv-{i}", "event_type": "import_receipt", "drug_id": "D0", "batch_id": "B0",
             "quantity_delta": i, "occurred_at": "2026-07-01T00:00:00+00:00"}
            for i in range(1, 7)
        ],
        "reservations": [
            {"id": f"rsv-{i}", "sale_id": f"HD{i}", "reserved_at": "2026-07-01T00:00:00+00:00"} for i in range(3)
        ],
        "sale_events": [{"x": 1}],
        "audits": {},
        "drug_recalls": {},
        "disposal_log": [],
        "catalog_last_sync_at": "2026-07-11T05:20:41+00:00",
        "catalog_drugs_last_sync_at": "2026-07-11T05:20:41+00:00",
        "catalog_suppliers_last_sync_at": "2026-07-11T05:20:41+00:00",
    }


async def _connect():
    return await asyncpg.connect(DSN)


async def _reset_db(payload=None):
    conn = await _connect()
    try:
        for table in ALL_TABLES:
            await conn.execute(f"DROP TABLE IF EXISTS {table}")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state_history")
        if payload is not None:
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


async def _fetchval(sql, *args):
    conn = await _connect()
    try:
        return await conn.fetchval(sql, *args)
    finally:
        await conn.close()


async def _existing_new_tables():
    conn = await _connect()
    try:
        return [t for t in ALL_TABLES if await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", f"public.{t}")]
    finally:
        await conn.close()


async def _blob_row():
    conn = await _connect()
    try:
        row = await conn.fetchrow("SELECT payload, updated_at FROM inventory_runtime_state WHERE id=1")
        return json.loads(row["payload"]), row["updated_at"]
    finally:
        await conn.close()


async def _tables_payload():
    conn = await _connect()
    try:
        return await RelationalStore().load_payload(conn)
    finally:
        await conn.close()


def _snapshot() -> str:
    return canonical_json(inv._build_state_payload())


def _mutate():
    first_batch = next(iter(inv.runtime_state.batches.values()))
    first_batch["qty_remaining"] += 7
    inv.runtime_state.movements.append(
        {"id": "mv-new", "event_type": inv.MovementType.STOCK_ADJUSTMENT, "drug_id": "D0", "batch_id": "B0",
         "quantity_delta": 7, "occurred_at": inv._parse_iso_datetime("2026-07-20T00:00:00+00:00")}
    )
    inv.runtime_state.reservations.pop(0)


async def _restart() -> bool:
    """Mô phỏng khởi động lại tiến trình: bỏ pool/cache/state rồi nạp lại từ storage."""
    await inv._discard_pg_pool()
    rs = inv.runtime_state
    rs.relational_store = RelationalStore()
    rs.relational_ready = False
    rs.storage_mode = None
    rs.save_failed = False
    rs.state_unavailable = False
    inv.initialize_empty_state()
    return await inv.reload_runtime_state_from_storage()


@pytest.fixture
def state(monkeypatch):
    monkeypatch.setattr(inv.settings, "STATE_PERSISTENCE", "postgres")
    monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", "relational")
    monkeypatch.setattr(inv.settings, "STATE_LEGACY_BLOB_DUAL_WRITE", True)
    monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
    monkeypatch.setattr(inv, "STATE_LOAD_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(inv, "STATE_LOAD_RETRY_BASE_SECONDS", 0)
    monkeypatch.setattr(inv, "fetch_inventory_settings", _noop_fetch)

    rs = inv.runtime_state
    rs.pg_pool = None
    rs.save_failed = False
    rs.state_unavailable = False
    rs.lock = asyncio.Lock()
    rs.save_lock = None
    rs.relational_store = RelationalStore()
    rs.relational_ready = False
    rs.storage_mode = None
    inv.initialize_empty_state()
    yield inv
    asyncio.run(inv._discard_pg_pool())


async def _noop_fetch(force=False):
    return None


def test_blob_migrates_to_relational_at_startup(state):
    async def scenario():
        await _reset_db(_payload())
        loaded = await _restart()
        conn = await _connect()
        try:
            migrated = await RelationalStore().is_migrated(conn)
            drugs = await conn.fetchval("SELECT count(*) FROM inventory_drugs")
            movements = await conn.fetchval("SELECT count(*) FROM inventory_movements")
        finally:
            await conn.close()
        return loaded, migrated, drugs, movements

    loaded, migrated, drugs, movements = asyncio.run(scenario())
    assert loaded is True and migrated is True
    assert (drugs, movements) == (DRUGS, 6)
    assert len(state.runtime_state.drugs) == DRUGS
    assert state.get_state_storage_mode() == "relational"
    assert state.runtime_state.relational_ready is True


def test_save_then_reload_equals(state):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _mutate()
        await state.save_runtime_state_safe()
        before = _snapshot()
        await _restart()
        return before, _snapshot()

    before, after = asyncio.run(scenario())
    assert before == after
    assert state.runtime_state.save_failed is False
    assert [r["id"] for r in state.runtime_state.reservations] == ["rsv-1", "rsv-2"]
    assert any(m["id"] == "mv-new" for m in state.runtime_state.movements)


def test_dual_write_keeps_blob_identical_to_tables(state):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _mutate()
        await state.save_runtime_state_safe()
        blob, _ = await _blob_row()
        return blob, await _tables_payload()

    blob, tables = asyncio.run(scenario())
    assert canonical_json(blob) == canonical_json(tables)


def test_blob_mode_never_touches_new_tables(state, monkeypatch):
    monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", "blob")

    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _mutate()
        await state.save_runtime_state_safe()
        blob, _ = await _blob_row()
        return await _existing_new_tables(), blob

    tables, blob = asyncio.run(scenario())
    assert tables == []
    assert state.get_state_storage_mode() == "blob"
    assert any(m["id"] == "mv-new" for m in blob["movements"])
    assert len(blob["reservations"]) == 2


def test_unknown_mode_value_falls_back_to_blob(state, monkeypatch):
    monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", "relationl")
    assert state.get_state_storage_mode() == "blob"


def test_blob_writes_after_migration_are_remigrated(state, monkeypatch):
    """Rollback sang blob rồi quay lại relational: blob mới hơn marker => migrate lại, không mất thay đổi."""

    async def scenario():
        await _reset_db(_payload())
        await _restart()  # migrate lần đầu

        monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", "blob")
        await _restart()
        _mutate()
        await state.save_runtime_state_safe()
        blob_snapshot = _snapshot()

        monkeypatch.setattr(inv.settings, "STATE_STORAGE_MODE", "relational")
        await _restart()
        archived = await _fetchval("SELECT count(*) FROM inventory_deleted_rows WHERE reason='remigrate'")
        return blob_snapshot, _snapshot(), archived, await _tables_payload()

    blob_snapshot, relational_snapshot, archived, tables = asyncio.run(scenario())
    assert blob_snapshot == relational_snapshot
    assert archived > 0
    assert any(m["id"] == "mv-new" for m in tables["movements"])


def test_mismatch_falls_back_to_blob(state, monkeypatch):
    async def boom(self, conn, payload, blob_updated_at):
        raise RelationalStateMismatch("giả lập khác biệt")

    monkeypatch.setattr(RelationalStore, "migrate_from_payload", boom)

    async def scenario():
        await _reset_db(_payload())
        loaded = await _restart()
        mode_after_load = state.get_state_storage_mode()
        _mutate()
        await state.save_runtime_state_safe()
        blob, _ = await _blob_row()
        conn = await _connect()
        try:
            migrated = await RelationalStore().is_migrated(conn)
            drugs = await conn.fetchval("SELECT count(*) FROM inventory_drugs")
        finally:
            await conn.close()
        return loaded, mode_after_load, blob, migrated, drugs

    loaded, mode, blob, migrated, drugs = asyncio.run(scenario())
    assert loaded is True and mode == "blob-fallback"
    assert len(state.runtime_state.drugs) == DRUGS
    assert migrated is False and drugs == 0  # bảng quan hệ không bị đụng tới
    assert any(m["id"] == "mv-new" for m in blob["movements"])  # blob vẫn nhận ghi
    assert state.runtime_state.save_failed is False


def test_fresh_install_first_save_creates_both(state):
    async def scenario():
        await _reset_db(None)
        loaded = await _restart()
        state.runtime_state.drugs["D1"] = {"id": "D1", "code": "T1", "name": "Thuoc 1"}
        await state.save_runtime_state_safe()
        blob, _ = await _blob_row()
        conn = await _connect()
        try:
            migrated = await RelationalStore().is_migrated(conn)
            # Xóa blob để chứng minh lần nạp kế tiếp đọc từ BẢNG.
            await conn.execute("DELETE FROM inventory_runtime_state")
        finally:
            await conn.close()
        reloaded = await _restart()
        return loaded, blob, migrated, reloaded, dict(state.runtime_state.drugs)

    loaded, blob, migrated, reloaded, drugs = asyncio.run(scenario())
    assert loaded is False
    assert list(blob["drugs"]) == ["D1"]
    assert migrated is True and reloaded is True
    assert list(drugs) == ["D1"]
    assert state.runtime_state.relational_ready is True


def test_tripwire_blocks_save_in_relational_mode(state):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        state.runtime_state.state_unavailable = True
        state.runtime_state.drugs = {}
        state.runtime_state.batches = {}
        state.runtime_state.receipts = {}
        await state.save_runtime_state_safe()
        return (
            await _fetchval("SELECT count(*) FROM inventory_drugs"),
            await _fetchval("SELECT count(*) FROM inventory_batches"),
            await _fetchval("SELECT drug_count FROM inventory_runtime_state WHERE id=1"),
            await _fetchval("SELECT count(*) FROM inventory_deleted_rows"),
        )

    assert asyncio.run(scenario()) == (DRUGS, BATCHES, DRUGS, 0)


def test_failed_load_resets_cache_so_empty_state_cannot_delete(state, monkeypatch):
    """Dù tripwire hỏng, cache rỗng + state rỗng không sinh DELETE."""

    async def scenario():
        await _reset_db(_payload())
        await _restart()
        monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN.replace("testpass", "wrongpass"))
        await inv._discard_pg_pool()
        await state.reload_runtime_state_from_storage()
        assert state.runtime_state.state_unavailable is True
        monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
        # Cố tình qua mặt tripwire:
        state.runtime_state.state_unavailable = False
        await state.save_runtime_state_safe()
        return await _fetchval("SELECT count(*) FROM inventory_drugs")

    assert asyncio.run(scenario()) == DRUGS


def test_destructive_diff_logs_and_archives_deleted_rows(state, caplog):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        state.runtime_state.drugs = {}
        state.runtime_state.batches = {}
        state.runtime_state.receipts = {}
        with caplog.at_level(logging.ERROR, logger=inv.logger.name):
            await state.save_runtime_state_safe()
        return (
            await _fetchval("SELECT count(*) FROM inventory_deleted_rows WHERE collection='drugs'"),
            await _fetchval("SELECT count(*) FROM inventory_drugs"),
            await _fetchval("SELECT count(*) FROM inventory_runtime_state_history"),
        )

    archived, remaining, history = asyncio.run(scenario())
    assert archived == DRUGS and remaining == 0
    assert history == 1  # tripwire blob cũng archive bản cũ
    assert any("diff phá hủy" in r.getMessage() for r in caplog.records)


def test_empty_plan_skips_db(state):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        await state.save_runtime_state_safe()  # chuẩn hóa các trường do hàm nạp thêm vào
        _, t1 = await _blob_row()
        await state.save_runtime_state_safe()  # không đổi gì
        _, t2 = await _blob_row()
        _mutate()
        await state.save_runtime_state_safe()
        _, t3 = await _blob_row()
        return t1, t2, t3

    t1, t2, t3 = asyncio.run(scenario())
    assert t1 == t2
    assert t3 > t2


def test_failed_apply_marks_save_failed_and_retry_recovers(state, monkeypatch):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _mutate()
        expected = _snapshot()

        real_apply = RelationalStore.apply_diff
        calls = {"n": 0}

        async def flaky(self, conn, plan):
            calls["n"] += 1
            if calls["n"] == 1:
                await real_apply(self, conn, plan)  # ghi thật rồi mới lỗi => transaction phải rollback
                raise RuntimeError("giả lập lỗi giữa chừng")
            await real_apply(self, conn, plan)

        monkeypatch.setattr(RelationalStore, "apply_diff", flaky)
        await state.save_runtime_state_safe()
        failed = state.runtime_state.save_failed
        mid_blob, _ = await _blob_row()
        await state.save_runtime_state_safe()  # vòng retry
        await _restart()
        return failed, mid_blob, expected, _snapshot()

    failed, mid_blob, expected, final = asyncio.run(scenario())
    assert failed is True
    assert not any(m["id"] == "mv-new" for m in mid_blob["movements"])
    assert state.runtime_state.save_failed is False
    assert final == expected


def test_dual_write_off_leaves_blob_untouched_but_tables_authoritative(state, monkeypatch):
    monkeypatch.setattr(inv.settings, "STATE_LEGACY_BLOB_DUAL_WRITE", False)

    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _, t0 = await _blob_row()
        _mutate()
        await state.save_runtime_state_safe()
        blob, t1 = await _blob_row()
        expected = _snapshot()
        await _restart()  # blob không mới hơn marker => nạp từ bảng, giữ thay đổi
        return t0, t1, blob, expected, _snapshot()

    t0, t1, blob, expected, final = asyncio.run(scenario())
    assert t0 == t1
    assert not any(m["id"] == "mv-new" for m in blob["movements"])
    assert final == expected


def test_concurrent_saves_are_serialized(state):
    async def scenario():
        await _reset_db(_payload())
        await _restart()
        _mutate()
        await asyncio.gather(*(state.save_runtime_state_safe() for _ in range(5)))
        expected = _snapshot()
        await _restart()
        return expected, _snapshot()

    expected, final = asyncio.run(scenario())
    assert expected == final
    assert state.runtime_state.save_failed is False
