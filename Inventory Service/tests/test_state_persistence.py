"""Bảo vệ chống sự cố mất trắng toàn bộ kho (7/2026).

Sự cố: toàn bộ tồn kho nằm trong MỘT row Postgres (`inventory_runtime_state` id=1).
`load_runtime_state_safe()` nuốt mọi exception và trả về False — không phân biệt được
"đọc lỗi" với "chưa có dữ liệu" — nên `reload_runtime_state_from_storage()` seed state
rỗng rồi GHI ĐÈ lên bản dữ liệu duy nhất. Chỉ một ngày tháng sai trong một dòng phiếu
nhập là đủ để xóa sạch kho ở lần restart kế tiếp.

Các test cần Postgres. Đặt INVENTORY_TEST_DSN để chạy, ví dụ:
    docker run -d --name pg-test -e POSTGRES_PASSWORD=testpass \
        -e POSTGRES_DB=pharmar_inventory -p 55433:5432 postgres:16-alpine
    INVENTORY_TEST_DSN=postgresql://postgres:testpass@127.0.0.1:55433/pharmar_inventory \
        pytest "Inventory Service/tests"
"""

import asyncio
import json
import os

import asyncpg
import pytest

from Routers import Inventory as inv

DSN = os.environ.get("INVENTORY_TEST_DSN")

pytestmark = pytest.mark.skipif(
    not DSN, reason="Cần INVENTORY_TEST_DSN trỏ tới một Postgres dùng để test"
)


def _payload(drugs=40, batches=25, receipts=12, bad_date=False):
    lines = [{"drug_id": "D1", "mfg_date": "31/02/2026-RAC" if bad_date else "2026-01-01"}]
    return {
        "counters": {},
        "suppliers": {},
        "drugs": {f"D{i}": {"id": f"D{i}", "name": f"Thuoc {i}"} for i in range(drugs)},
        "batches": {f"B{i}": {"id": f"B{i}", "drug_id": f"D{i}"} for i in range(batches)},
        "receipts": {
            f"R{i}": {
                "id": f"R{i}",
                "receipt_date": "2026-07-01",
                "created_at": "2026-07-01T00:00:00+00:00",
                "updated_at": "2026-07-01T00:00:00+00:00",
                "lines": lines,
            }
            for i in range(receipts)
        },
        "movements": [],
        "reservations": [],
        "sale_events": [],
        "audits": {},
        "drug_recalls": {},
        "disposal_log": [],
    }


async def _reset_db(payload):
    conn = await asyncpg.connect(DSN)
    try:
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state_history")
        await conn.execute(
            "CREATE TABLE inventory_runtime_state ("
            " id SMALLINT PRIMARY KEY CHECK (id=1), payload JSONB NOT NULL,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        await conn.execute(
            "INSERT INTO inventory_runtime_state(id, payload) VALUES (1, $1::jsonb)",
            json.dumps(payload),
        )
    finally:
        await conn.close()


async def _drugs_in_db():
    conn = await asyncpg.connect(DSN)
    try:
        return await conn.fetchval(
            "SELECT count(*) FROM jsonb_object_keys("
            " (SELECT payload->'drugs' FROM inventory_runtime_state WHERE id=1))"
        )
    finally:
        await conn.close()


async def _history_count():
    conn = await asyncpg.connect(DSN)
    try:
        return await conn.fetchval("SELECT count(*) FROM inventory_runtime_state_history")
    finally:
        await conn.close()


@pytest.fixture
def state(monkeypatch):
    monkeypatch.setattr(inv.settings, "STATE_PERSISTENCE", "postgres")
    monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
    monkeypatch.setattr(inv, "STATE_LOAD_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(inv, "STATE_LOAD_RETRY_BASE_SECONDS", 0)
    monkeypatch.setattr(inv, "fetch_inventory_settings", _noop_fetch)

    inv.runtime_state.pg_pool = None
    inv.runtime_state.save_failed = False
    inv.runtime_state.state_unavailable = False
    inv.runtime_state.lock = asyncio.Lock()
    inv.initialize_empty_state()
    yield inv
    asyncio.run(inv._discard_pg_pool())


async def _noop_fetch(force=False):
    return None


def test_corrupt_date_does_not_wipe_inventory(state):
    """Một mfg_date rác không được phép xóa cả kho — nguyên nhân thật của sự cố."""

    async def scenario():
        await _reset_db(_payload(bad_date=True))
        await state.reload_runtime_state_from_storage()
        return await _drugs_in_db()

    assert asyncio.run(scenario()) == 40


def test_corrupt_date_still_loads_remaining_data(state):
    """Bản ghi lỗi bị bỏ qua, phần còn lại vẫn nạp bình thường."""

    async def scenario():
        await _reset_db(_payload(bad_date=True))
        loaded = await state.reload_runtime_state_from_storage()
        return loaded, len(state.runtime_state.drugs)

    loaded, drugs = asyncio.run(scenario())
    assert loaded is True
    assert drugs == 40


def test_unreadable_storage_does_not_wipe_inventory(state, monkeypatch):
    """Không đọc được storage => KHÔNG seed, KHÔNG ghi. Dữ liệu trong DB còn nguyên."""

    async def scenario():
        await _reset_db(_payload())
        monkeypatch.setattr(
            inv.settings, "DATABASE_URL",
            DSN.replace("testpass", "wrongpass") if "testpass" in DSN else DSN + "?x=1",
        )
        await inv._discard_pg_pool()
        loaded = await state.reload_runtime_state_from_storage()
        monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
        return loaded, await _drugs_in_db()

    loaded, drugs = asyncio.run(scenario())
    assert loaded is False
    assert state.runtime_state.state_unavailable is True
    assert drugs == 40


def test_save_is_refused_while_state_unavailable(state):
    """Tripwire: state chưa nạp được thì mọi lệnh ghi phải bị từ chối."""

    async def scenario():
        await _reset_db(_payload())
        await inv.init_state_store()
        state.runtime_state.state_unavailable = True
        state.runtime_state.drugs = {}
        state.runtime_state.batches = {}
        state.runtime_state.receipts = {}
        await state.save_runtime_state_safe()
        return await _drugs_in_db()

    assert asyncio.run(scenario()) == 40


def test_endpoints_return_503_while_state_unavailable(state):
    state.runtime_state.state_unavailable = True
    with pytest.raises(inv.HTTPException) as excinfo:
        asyncio.run(state.ensure_state_ready())
    assert excinfo.value.status_code == 503


def test_endpoints_pass_when_state_ready(state):
    state.runtime_state.state_unavailable = False
    assert asyncio.run(state.ensure_state_ready()) is None


def test_destructive_write_archives_previous_state(state):
    """Ghi đè làm mất sạch bản ghi phải archive bản cũ để còn cứu được."""

    async def scenario():
        await _reset_db(_payload())
        await inv.init_state_store()
        state.runtime_state.state_unavailable = False
        state.runtime_state.drugs = {}
        state.runtime_state.batches = {}
        state.runtime_state.receipts = {}
        await state.save_runtime_state_safe()
        return await _history_count()

    assert asyncio.run(scenario()) == 1


def test_normal_update_does_not_archive(state):
    """Thay đổi bình thường không được kích hoạt tripwire (tránh phình history)."""

    async def scenario():
        await _reset_db(_payload())
        await inv.init_state_store()
        state.runtime_state.state_unavailable = False
        state.runtime_state.drugs = {f"D{i}": {"id": f"D{i}"} for i in range(39)}
        state.runtime_state.batches = {f"B{i}": {"id": f"B{i}"} for i in range(25)}
        state.runtime_state.receipts = {f"R{i}": {"id": f"R{i}"} for i in range(12)}
        await state.save_runtime_state_safe()
        return await _history_count()

    assert asyncio.run(scenario()) == 0


def test_recovers_when_storage_comes_back(state, monkeypatch):
    """Sau khi DB trở lại, service tự nạp được state và bỏ cờ không-sẵn-sàng."""

    async def scenario():
        await _reset_db(_payload())
        monkeypatch.setattr(
            inv.settings, "DATABASE_URL",
            DSN.replace("testpass", "wrongpass") if "testpass" in DSN else DSN + "?x=1",
        )
        await inv._discard_pg_pool()
        await state.reload_runtime_state_from_storage()
        assert state.runtime_state.state_unavailable is True

        monkeypatch.setattr(inv.settings, "DATABASE_URL", DSN)
        await inv._discard_pg_pool()
        loaded = await state.reload_runtime_state_from_storage()
        return loaded, len(state.runtime_state.drugs)

    loaded, drugs = asyncio.run(scenario())
    assert loaded is True
    assert state.runtime_state.state_unavailable is False
    assert drugs == 40


@pytest.mark.parametrize(
    "old_counts,new_counts,expected",
    [
        ((40, 25, 12), (0, 0, 0), True),      # xóa sạch
        ((40, 25, 12), (0, 25, 12), True),    # xóa sạch một nhóm
        ((40, 25, 12), (19, 25, 12), True),   # mất hơn nửa
        ((40, 25, 12), (39, 25, 12), False),  # xóa 1 bản ghi — bình thường
        ((40, 25, 12), (41, 26, 13), False),  # thêm mới — bình thường
        ((0, 0, 0), (0, 0, 0), False),        # lần chạy đầu, chưa có gì
        ((5, 0, 0), (2, 0, 0), False),        # dữ liệu ít, không áp ngưỡng 50%
    ],
)
def test_is_destructive_write(old_counts, new_counts, expected):
    assert inv._is_destructive_write(old_counts, new_counts) is expected
