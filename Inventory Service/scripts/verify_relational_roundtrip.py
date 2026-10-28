"""Kiểm chứng end-to-end lưu trữ quan hệ trên một DB TEST bằng chính code của service.

    python scripts/verify_relational_roundtrip.py --dsn postgresql://postgres:testpass@127.0.0.1:55433/pharmar_inventory_test

Script DROP toàn bộ bảng inventory_* nên TỪ CHỐI chạy nếu tên database không chứa "test".
Quy trình: nạp payload thật vào blob legacy -> load (migrate) -> snapshot -> mutate -> save ->
reset tiến trình -> load lại -> so sánh với snapshot, và so blob với bảng.
Exit code 0 = PASS, 1 = FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

SERVICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_DIR.parent
sys.path.insert(0, str(SERVICE_DIR))

DEFAULT_PAYLOAD = REPO_ROOT / "recovery" / "rebuilt_payload.json"


def _db_name(dsn: str) -> str:
    return urlparse(dsn).path.lstrip("/").split("?")[0]


class Report:
    def __init__(self) -> None:
        self.checks: list[tuple[str, bool, str]] = []
        self.timings: list[tuple[str, float]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

    def time(self, name: str, seconds: float) -> None:
        self.timings.append((name, seconds))
        print(f"  [time] {name}: {seconds * 1000:.1f} ms")

    @property
    def ok(self) -> bool:
        return all(ok for _, ok, _ in self.checks)


async def run(dsn: str, payload_path: Path) -> bool:
    import asyncpg

    from Routers import Inventory as inv
    from Source.persistence.relational_store import ALL_TABLES, RelationalStore, canonical_json

    rep = Report()
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    print(f"Payload: {payload_path} ({ {k: len(v) for k, v in payload.items() if hasattr(v, '__len__')} })")

    inv.settings.STATE_PERSISTENCE = "postgres"
    inv.settings.STATE_STORAGE_MODE = "relational"
    inv.settings.STATE_LEGACY_BLOB_DUAL_WRITE = True
    inv.settings.DATABASE_URL = dsn
    inv.STATE_LOAD_MAX_ATTEMPTS = 1
    inv.STATE_LOAD_RETRY_BASE_SECONDS = 0

    async def _noop_fetch(force=False):
        return None

    inv.fetch_inventory_settings = _noop_fetch
    rs = inv.runtime_state

    async def fresh_process() -> None:
        await inv._discard_pg_pool()
        rs.lock = asyncio.Lock()
        rs.save_lock = asyncio.Lock()
        rs.relational_store = RelationalStore()
        rs.relational_ready = False
        rs.storage_mode = None
        rs.save_failed = False
        rs.state_unavailable = False
        rs.pg_pool = None
        inv.initialize_empty_state()

    def snapshot() -> str:
        return canonical_json(inv._build_state_payload())

    # -- chuẩn bị DB -------------------------------------------------------------------
    conn = await asyncpg.connect(dsn)
    try:
        for t in ALL_TABLES:
            await conn.execute(f"DROP TABLE IF EXISTS {t}")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state")
        await conn.execute("DROP TABLE IF EXISTS inventory_runtime_state_history")
        await conn.execute(
            "CREATE TABLE inventory_runtime_state (id SMALLINT PRIMARY KEY CHECK (id=1), payload JSONB NOT NULL,"
            " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        )
        await conn.execute("INSERT INTO inventory_runtime_state(id, payload) VALUES (1, $1::jsonb)", json.dumps(payload))
    finally:
        await conn.close()

    # -- 1. load + migrate -------------------------------------------------------------
    print("1. Khởi động lần đầu: migrate blob -> bảng")
    await fresh_process()
    t0 = time.perf_counter()
    loaded = await inv.reload_runtime_state_from_storage()
    rep.time("load+migrate (reload_runtime_state_from_storage)", time.perf_counter() - t0)
    rep.check("load trả True", loaded is True)
    rep.check("state không bị đánh dấu unavailable", not rs.state_unavailable)
    rep.check("mode = relational", inv.get_state_storage_mode() == "relational", inv.get_state_storage_mode())
    conn = await asyncpg.connect(dsn)
    try:
        rep.check("đã có marker migrate", await RelationalStore().is_migrated(conn))
        for coll, mem in (("drugs", rs.drugs), ("batches", rs.batches), ("receipts", rs.receipts),
                          ("movements", rs.movements), ("reservations", rs.reservations)):
            n = await conn.fetchval(f"SELECT count(*) FROM inventory_{coll}")
            rep.check(f"số dòng inventory_{coll} == bộ nhớ", n == len(mem), f"{n} vs {len(mem)}")
    finally:
        await conn.close()
    rep.check("số drugs khớp payload gốc", len(rs.drugs) == len(payload["drugs"]))
    snap0 = snapshot()

    # -- 2. lần save đầu sau load: chuẩn hóa một lần ------------------------------------
    plan = inv._get_store().compute_diff(inv._build_state_payload())
    print(f"2. Diff ngay sau load (chuẩn hóa định dạng một lần): {plan.summary()['updated']} / insert {plan.summary()['inserted']}")
    t0 = time.perf_counter()
    await inv.save_runtime_state_safe()
    rep.time("save sau load (normalize)", time.perf_counter() - t0)
    rep.check("save không lỗi", not rs.save_failed)
    plan2 = inv._get_store().compute_diff(inv._build_state_payload())
    rep.check("diff rỗng sau save", plan2.is_empty())
    t0 = time.perf_counter()
    await inv.save_runtime_state_safe()
    rep.time("save không đổi gì (bỏ qua DB)", time.perf_counter() - t0)

    # -- 3. mutate + save --------------------------------------------------------------
    print("3. Mutate: đổi qty một lô, thêm 1 movement, xóa 1 reservation")
    batch = next(iter(rs.batches.values()))
    batch["qty_remaining"] = int(batch.get("qty_remaining") or 0) + 5
    inv.add_movement(
        inv.MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], 5, "verify", "verify-1", "verify-script"
    )
    if rs.reservations:
        rs.reservations.pop(0)
    rs.counters["movement"] = rs.counters.get("movement", 0)
    mutated = snapshot()
    rep.check("mutation làm đổi state", mutated != snap0)
    t0 = time.perf_counter()
    await inv.save_runtime_state_safe()
    rep.time("save sau mutate (3 thay đổi)", time.perf_counter() - t0)
    rep.check("save không lỗi", not rs.save_failed)

    # -- 4. restart + so sánh ---------------------------------------------------------
    print("4. Khởi động lại từ bảng và so sánh")
    await fresh_process()
    t0 = time.perf_counter()
    loaded = await inv.reload_runtime_state_from_storage()
    rep.time("load từ bảng (không migrate)", time.perf_counter() - t0)
    rep.check("load lại trả True", loaded is True)
    rep.check("state sau restart == state đã mutate", snapshot() == mutated)

    # -- 5. blob == bảng ---------------------------------------------------------------
    print("5. So blob với bảng")
    conn = await asyncpg.connect(dsn)
    try:
        blob = json.loads(await conn.fetchval("SELECT payload FROM inventory_runtime_state WHERE id=1"))
        tables = await RelationalStore().load_payload(conn)
        marker = await conn.fetchval("SELECT value FROM inventory_meta WHERE key='__migration__'")
        blob_ts = await conn.fetchval("SELECT updated_at FROM inventory_runtime_state WHERE id=1")
        deleted = await conn.fetchval("SELECT count(*) FROM inventory_deleted_rows")
    finally:
        await conn.close()
    rep.check("blob == bảng (canonical)", canonical_json(blob) == canonical_json(tables))
    synced = json.loads(marker).get("blob_synced_updated_at")
    rep.check("blob sync marker == blob.updated_at", synced is not None and synced == blob_ts.isoformat(), str(synced))
    print(f"   inventory_deleted_rows: {deleted} dòng (mong đợi 1 = reservation đã xóa)")
    rep.check("reservation bị xóa đã được archive", deleted == 1, str(deleted))

    await inv._discard_pg_pool()

    print()
    print("Timings:")
    for name, sec in rep.timings:
        print(f"  {name}: {sec * 1000:.1f} ms")
    failed = [n for n, ok, _ in rep.checks if not ok]
    print(f"\n{'PASS' if rep.ok else 'FAIL'}: {len(rep.checks) - len(failed)}/{len(rep.checks)} checks")
    for n in failed:
        print(f"  FAILED: {n}")
    return rep.ok


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--payload", default=str(DEFAULT_PAYLOAD))
    args = ap.parse_args()

    name = _db_name(args.dsn)
    if "test" not in name.lower():
        print(
            f"TỪ CHỐI chạy: tên database {name!r} không chứa 'test'. Script này DROP các bảng inventory_* "
            "nên chỉ được chạy trên database dùng để test.",
            file=sys.stderr,
        )
        return 2
    payload_path = Path(args.payload)
    if not payload_path.is_absolute():
        payload_path = (REPO_ROOT / payload_path) if (REPO_ROOT / payload_path).exists() else payload_path.resolve()
    if not payload_path.exists():
        print(f"Không tìm thấy payload: {payload_path}", file=sys.stderr)
        return 2
    try:
        ok = asyncio.run(run(args.dsn, payload_path))
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"FAIL: ngoại lệ {exc!r}")
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
