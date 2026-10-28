"""Lưu trữ kho dạng bảng quan hệ (mỗi record một dòng) thay cho MỘT row JSONB duy nhất.

Sự cố mất trắng kho 7/2026 xảy ra vì toàn bộ dữ liệu nằm trong một row bị ghi đè. Module này
giữ nguyên mô hình in-memory (payload dict giống blob cũ) nhưng ghi theo từng record:
chỉ những dòng có dạng canonical thay đổi mới bị ghi, mọi DELETE đều được lưu vào
`inventory_deleted_rows` trước. Cột `data` (JSONB) là nguồn sự thật; các cột trích xuất chỉ
phục vụ truy vấn SQL sau này và KHÔNG BAO GIỜ được làm hỏng một lần lưu.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import Enum
from typing import Any

DICT_COLLECTIONS: tuple[str, ...] = ("suppliers", "drugs", "receipts", "batches", "audits", "drug_recalls")
LIST_COLLECTIONS: tuple[str, ...] = ("movements", "reservations", "disposal_log")
META_KEYS: tuple[str, ...] = (
    "counters",
    "sale_events",
    "catalog_last_sync_at",
    "catalog_drugs_last_sync_at",
    "catalog_suppliers_last_sync_at",
)

_ALL_COLLECTIONS: tuple[str, ...] = DICT_COLLECTIONS + LIST_COLLECTIONS
_META_TABLE = "inventory_meta"
_DELETED_TABLE = "inventory_deleted_rows"
_MARKER_KEY = "__migration__"
_LOCK_KEY = 7_315_002_001  # advisory lock cho migrate/ensure_schema


def _table(collection: str) -> str:
    return f"inventory_{collection}"


ALL_TABLES: tuple[str, ...] = tuple(_table(c) for c in _ALL_COLLECTIONS) + (_META_TABLE, _DELETED_TABLE)


# --------------------------------------------------------------------------- serialization


def _json_default(value: Any) -> Any:
    # Giống hệt _json_default trong Routers/Inventory.py (datetime là con của date nên kiểm tra trước).
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=_json_default)


# --------------------------------------------------------------------------- best-effort extraction
# Mọi hàm dưới đây có thể raise nội bộ nhưng _extract nuốt lỗi và trả None:
# một ngày tháng sai không bao giờ được làm hỏng việc lưu.


def _to_text(v: Any) -> str | None:
    if isinstance(v, str):
        return None if "\x00" in v else v
    if isinstance(v, int) and not isinstance(v, bool):
        return str(v)
    return None


def _to_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")) or v != int(v):
            return None
        v = int(v)
    elif isinstance(v, str):
        s = v.strip()
        if not re.fullmatch(r"[+-]?\d{1,18}", s):
            return None
        v = int(s)
    if isinstance(v, int) and -(2**63) <= v < 2**63:
        return v
    return None


def _to_bool(v: Any) -> bool | None:
    return v if isinstance(v, bool) else None


def _to_date(v: Any) -> date | None:
    if isinstance(v, datetime):
        d: date = v.date()
    elif isinstance(v, date):
        d = v
    elif isinstance(v, str):
        m = re.match(r"\s*(\d{4}-\d{2}-\d{2})", v)
        if not m:
            return None
        d = date.fromisoformat(m.group(1))
    else:
        return None
    return d if 1900 <= d.year <= 2200 else None


def _to_ts(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        dt = v
    elif isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        if s.endswith(("Z", "z")):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt if 1900 <= dt.year <= 2200 else None


_CONVERTERS = {"txt": _to_text, "int": _to_int, "bool": _to_bool, "date": _to_date, "ts": _to_ts}
_SQL_TYPES = {"txt": "TEXT", "int": "BIGINT", "bool": "BOOLEAN", "date": "DATE", "ts": "TIMESTAMPTZ"}

# collection -> [(tên cột, kiểu, field nguồn)], và các cột cần index
_COLUMNS: dict[str, list[tuple[str, str, str]]] = {
    "suppliers": [("code", "txt", "code"), ("name", "txt", "name")],
    "drugs": [("code", "txt", "code"), ("name", "txt", "name")],
    "receipts": [
        ("code", "txt", "code"),
        ("receipt_date", "date", "receipt_date"),
        ("supplier_id", "txt", "supplier_id"),
        ("status", "txt", "status"),
    ],
    "batches": [
        ("drug_id", "txt", "drug_id"),
        ("batch_code", "txt", "batch_code"),
        ("exp_date", "date", "exp_date"),
        ("qty_remaining", "int", "qty_remaining"),
        ("cancelled", "bool", "cancelled"),
        ("receipt_id", "txt", "receipt_id"),
    ],
    "audits": [("code", "txt", "code"), ("status", "txt", "status")],
    "drug_recalls": [("drug_id", "txt", "drug_id"), ("batch_id", "txt", "batch_id"), ("issued_date", "date", "issued_date")],
    "movements": [
        ("event_type", "txt", "event_type"),
        ("drug_id", "txt", "drug_id"),
        ("batch_id", "txt", "batch_id"),
        ("reference_type", "txt", "reference_type"),
        ("reference_id", "txt", "reference_id"),
        ("quantity_delta", "int", "quantity_delta"),
        ("occurred_at", "ts", "occurred_at"),
    ],
    "reservations": [("sale_id", "txt", "sale_id"), ("reserved_at", "ts", "reserved_at")],
    "disposal_log": [("batch_id", "txt", "batch_id"), ("drug_id", "txt", "drug_id"), ("disposed_at", "ts", "disposed_at")],
}
_INDEXED: dict[str, tuple[str, ...]] = {
    "suppliers": ("code",),
    "drugs": ("code",),
    "receipts": ("receipt_date", "supplier_id"),
    "batches": ("drug_id", "exp_date"),
    "audits": (),
    "drug_recalls": ("drug_id", "batch_id"),
    "movements": ("drug_id", "batch_id", "reference_id", "occurred_at"),
    "reservations": ("sale_id",),
    "disposal_log": ("batch_id",),
}


def _extract(collection: str, canon: str) -> tuple[Any, ...]:
    """Trả về giá trị các cột trích xuất; không bao giờ raise."""
    cols = _COLUMNS[collection]
    try:
        obj = json.loads(canon)
    except Exception:
        obj = None
    out: list[Any] = []
    for _name, kind, src in cols:
        try:
            out.append(_CONVERTERS[kind](obj.get(src)) if isinstance(obj, dict) else None)
        except Exception:
            out.append(None)
    return tuple(out)


# --------------------------------------------------------------------------- row keys


def list_row_keys(items: list[Any]) -> list[str]:
    """Khóa dòng tất định: id; bản trùng thứ n>=2 -> `id#n`; thiếu id/không phải dict -> `__idx_<vị trí>`."""
    used: set[str] = set()
    counts: dict[str, int] = {}
    keys: list[str] = []
    for pos, item in enumerate(items):
        rid = item.get("id") if isinstance(item, dict) else None
        base = f"__idx_{pos}" if rid is None or rid == "" else str(rid)
        n = counts.get(base, 0) + 1
        key = base if n == 1 else f"{base}#{n}"
        while key in used:
            n += 1
            key = f"{base}#{n}"
        counts[base] = n
        used.add(key)
        keys.append(key)
    return keys


# --------------------------------------------------------------------------- plan / state


class RelationalStateMismatch(Exception):
    """Dữ liệu đọc lại từ bảng không khớp payload đầu vào (transaction phải rollback)."""


@dataclass
class _CollectionDiff:
    inserts: list[tuple[str, str, int | None]] = field(default_factory=list)  # (row_key, canon, seq)
    updates: list[tuple[str, str, int | None]] = field(default_factory=list)  # data đổi
    reseq: list[tuple[str, int]] = field(default_factory=list)  # chỉ đổi seq
    deletes: list[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.inserts or self.updates or self.reseq or self.deletes)


@dataclass
class DiffPlan:
    collections: dict[str, _CollectionDiff] = field(default_factory=dict)
    meta_new: dict[str, str] = field(default_factory=dict)
    meta_changed: dict[str, str] = field(default_factory=dict)
    meta_deletes: list[str] = field(default_factory=list)
    destructive: list[str] = field(default_factory=list)
    _gen: int = 0

    def is_empty(self) -> bool:
        return (
            all(cd.is_empty() for cd in self.collections.values())
            and not self.meta_new
            and not self.meta_changed
            and not self.meta_deletes
        )

    def summary(self) -> dict[str, dict[str, int]]:
        ins: dict[str, int] = {}
        upd: dict[str, int] = {}
        dele: dict[str, int] = {}
        for c in _ALL_COLLECTIONS:
            cd = self.collections.get(c) or _CollectionDiff()
            ins[c] = len(cd.inserts)
            upd[c] = len(cd.updates) + len(cd.reseq)
            dele[c] = len(cd.deletes)
        ins["meta"] = len(self.meta_new)
        upd["meta"] = len(self.meta_changed)
        dele["meta"] = len(self.meta_deletes)
        return {"inserted": ins, "updated": upd, "deleted": dele}


class _State:
    """Bản sao trong RAM của những gì đang nằm trong DB (dạng canonical)."""

    def __init__(self) -> None:
        self.canon: dict[str, dict[str, str]] = {c: {} for c in _ALL_COLLECTIONS}
        self.seq: dict[str, dict[str, int]] = {c: {} for c in LIST_COLLECTIONS}
        self.meta: dict[str, str] = {}


def _check_payload(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ValueError("payload phải là dict")
    for c in DICT_COLLECTIONS:
        if c in payload and not isinstance(payload[c], dict):
            raise ValueError(f"payload[{c!r}] phải là dict, nhận {type(payload[c]).__name__}")
    for c in LIST_COLLECTIONS:
        if c in payload and not isinstance(payload[c], (list, tuple)):
            raise ValueError(f"payload[{c!r}] phải là list, nhận {type(payload[c]).__name__}")


def _is_destructive(old: int, new: int) -> bool:
    return (old > 0 and new == 0) or (old >= 10 and new < old / 2)


def _build_plan(payload: dict, state: _State, gen: int) -> DiffPlan:
    _check_payload(payload)
    plan = DiffPlan(_gen=gen)

    for c in DICT_COLLECTIONS:
        if c not in payload:  # thiếu key = không đụng tới, KHÔNG coi là rỗng
            continue
        cached = state.canon[c]
        cd = _CollectionDiff()
        new_keys: set[str] = set()
        for k, rec in payload[c].items():
            key = str(k)
            new_keys.add(key)
            canon = canonical_json(rec)
            old = cached.get(key)
            if old is None:
                cd.inserts.append((key, canon, None))
            elif old != canon:
                cd.updates.append((key, canon, None))
        cd.deletes = [k for k in cached if k not in new_keys]
        if _is_destructive(len(cached), len(new_keys)):
            plan.destructive.append(f"{c} {len(cached)}->{len(new_keys)}")
        plan.collections[c] = cd

    for c in LIST_COLLECTIONS:
        if c not in payload:
            continue
        items = list(payload[c])
        cached = state.canon[c]
        cseq = state.seq[c]
        keys = list_row_keys(items)
        canons = [canonical_json(it) for it in items]

        # Chế độ append: các key cũ còn lại giữ nguyên thứ tự seq và key mới đều nằm sau key cũ cuối cùng.
        existing_pos = [i for i, k in enumerate(keys) if k in cseq]
        append_ok = True
        prev = None
        for i in existing_pos:
            s = cseq[keys[i]]
            if prev is not None and s <= prev:
                append_ok = False
                break
            prev = s
        if append_ok and existing_pos:
            last = existing_pos[-1]
            append_ok = all(k in cseq for k in keys[: last + 1])

        next_seq = max(cseq.values(), default=-1) + 1
        cd = _CollectionDiff()
        for i, (k, canon) in enumerate(zip(keys, canons)):
            if append_ok:
                if k in cseq:
                    target = cseq[k]
                else:
                    target = next_seq
                    next_seq += 1
            else:
                target = i
            old = cached.get(k)
            if old is None:
                cd.inserts.append((k, canon, target))
            elif old != canon:
                cd.updates.append((k, canon, target))
            elif cseq.get(k) != target:
                cd.reseq.append((k, target))
        key_set = set(keys)
        cd.deletes = [k for k in cached if k not in key_set]
        if _is_destructive(len(cached), len(keys)):
            plan.destructive.append(f"{c} {len(cached)}->{len(keys)}")
        plan.collections[c] = cd

    for mk in META_KEYS:
        if mk not in payload:
            continue
        canon = canonical_json(payload[mk])
        old = state.meta.get(mk)
        if old is None:
            plan.meta_new[mk] = canon
        elif old != canon:
            plan.meta_changed[mk] = canon
    return plan


# --------------------------------------------------------------------------- SQL


def _create_statements() -> list[str]:
    stmts: list[str] = []
    for c in _ALL_COLLECTIONS:
        t = _table(c)
        is_list = c in LIST_COLLECTIONS
        extra = "seq BIGINT NOT NULL" if is_list else "ins_ord BIGSERIAL"  # ins_ord giữ thứ tự chèn của dict
        cols = ",\n  ".join(f"{n} {_SQL_TYPES[k]}" for n, k, _ in _COLUMNS[c])
        stmts.append(
            f"CREATE TABLE IF NOT EXISTS {t} (\n  row_key TEXT PRIMARY KEY,\n  data JSONB NOT NULL,\n"
            f"  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  {extra},\n  {cols}\n)"
        )
        if is_list:
            stmts.append(f"CREATE INDEX IF NOT EXISTS ix_{t}_seq ON {t}(seq)")
        else:
            stmts.append(f"CREATE INDEX IF NOT EXISTS ix_{t}_ins_ord ON {t}(ins_ord)")
        for col in _INDEXED[c]:
            stmts.append(f"CREATE INDEX IF NOT EXISTS ix_{t}_{col} ON {t}({col})")
    stmts.append(
        f"CREATE TABLE IF NOT EXISTS {_META_TABLE} (key TEXT PRIMARY KEY, value JSONB NOT NULL,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    stmts.append(
        f"CREATE TABLE IF NOT EXISTS {_DELETED_TABLE} (id BIGSERIAL PRIMARY KEY, collection TEXT NOT NULL,"
        " row_key TEXT NOT NULL, data JSONB, reason TEXT, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    )
    stmts.append(f"CREATE INDEX IF NOT EXISTS ix_{_DELETED_TABLE}_deleted_at ON {_DELETED_TABLE}(deleted_at)")
    return stmts


def _upsert_sql(c: str) -> str:
    t = _table(c)
    names = ["row_key", "data"] + (["seq"] if c in LIST_COLLECTIONS else []) + [n for n, _, _ in _COLUMNS[c]]
    ph = ["$1", "$2::jsonb"] + [f"${i}" for i in range(3, len(names) + 1)]
    sets = ", ".join(f"{n}=EXCLUDED.{n}" for n in names[1:])
    return (
        f"INSERT INTO {t} ({', '.join(names)}) VALUES ({', '.join(ph)}) "
        f"ON CONFLICT (row_key) DO UPDATE SET {sets}, updated_at=NOW()"
    )


def _parse_dt(v: Any) -> datetime | None:
    try:
        return _to_ts(v)
    except Exception:
        return None


# --------------------------------------------------------------------------- store


class RelationalStore:
    def __init__(self) -> None:
        self._state = _State()
        self._gen = 0

    # -- cache -------------------------------------------------------------------------

    def reset_cache(self) -> None:
        self._state = _State()
        self._gen += 1

    def _replace_state(self, state: _State) -> None:
        self._state = state
        self._gen += 1

    # -- schema / marker ---------------------------------------------------------------

    async def ensure_schema(self, conn) -> None:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", _LOCK_KEY)
            for stmt in _create_statements():
                await conn.execute(stmt)

    async def _marker(self, conn) -> dict | None:
        exists = await conn.fetchval(f"SELECT to_regclass('public.{_META_TABLE}') IS NOT NULL")
        if not exists:
            return None
        raw = await conn.fetchval(f"SELECT value FROM {_META_TABLE} WHERE key=$1", _MARKER_KEY)
        if raw is None:
            return None
        val = json.loads(raw) if isinstance(raw, str) else raw
        return val if isinstance(val, dict) else {}

    async def is_migrated(self, conn) -> bool:
        return await self._marker(conn) is not None

    async def needs_migration_from_blob(self, conn, blob_updated_at: datetime | None) -> bool:
        if blob_updated_at is None:
            return False
        marker = await self._marker(conn)
        if marker is None:
            return True
        synced = _parse_dt(marker.get("blob_synced_updated_at"))
        if synced is None:
            return False  # bảng là nguồn chính thức
        blob_dt = _parse_dt(blob_updated_at)
        if blob_dt is None:
            return False
        return blob_dt > synced

    async def write_blob_sync_marker(self, conn, blob_updated_at: datetime) -> None:
        ts = _parse_dt(blob_updated_at)
        if ts is None:
            raise ValueError("blob_updated_at không hợp lệ")
        # Chỉ UPDATE: không bao giờ tự tạo marker (sẽ làm bảng rỗng trông như đã migrate).
        res = await conn.execute(
            f"UPDATE {_META_TABLE} SET value = jsonb_set(value, '{{blob_synced_updated_at}}', to_jsonb($2::text)),"
            " updated_at=NOW() WHERE key=$1",
            _MARKER_KEY,
            ts.isoformat(),
        )
        if res.endswith(" 0"):
            raise RuntimeError("Chưa có marker migrate; không thể ghi blob sync marker")

    # -- read --------------------------------------------------------------------------

    async def _read_back(self, conn) -> tuple[dict, _State]:
        """Đọc toàn bộ bảng; trả (payload, state) với state dựng từ canonical của dữ liệu thực sự đã lưu."""
        payload: dict[str, Any] = {}
        state = _State()
        for c in _ALL_COLLECTIONS:
            t = _table(c)
            if c in LIST_COLLECTIONS:
                rows = await conn.fetch(f"SELECT row_key, data, seq FROM {t} ORDER BY seq, row_key")
                out_list: list[Any] = []
                for r in rows:
                    obj = json.loads(r["data"])
                    out_list.append(obj)
                    state.canon[c][r["row_key"]] = canonical_json(obj)
                    state.seq[c][r["row_key"]] = r["seq"]
                payload[c] = out_list
            else:
                rows = await conn.fetch(f"SELECT row_key, data FROM {t} ORDER BY ins_ord")
                out_dict: dict[str, Any] = {}
                for r in rows:
                    obj = json.loads(r["data"])
                    out_dict[r["row_key"]] = obj
                    state.canon[c][r["row_key"]] = canonical_json(obj)
                payload[c] = out_dict
        for r in await conn.fetch(f"SELECT key, value FROM {_META_TABLE} WHERE key <> $1 ORDER BY key", _MARKER_KEY):
            obj = json.loads(r["value"])
            payload[r["key"]] = obj
            state.meta[r["key"]] = canonical_json(obj)
        return payload, state

    async def load_payload(self, conn) -> dict | None:
        if not await self.is_migrated(conn):
            return None
        if conn.is_in_transaction():
            payload, state = await self._read_back(conn)
        else:
            async with conn.transaction(isolation="repeatable_read", readonly=True):
                payload, state = await self._read_back(conn)
        self._replace_state(state)
        return payload

    # -- diff --------------------------------------------------------------------------

    def compute_diff(self, payload: dict) -> DiffPlan:
        return _build_plan(payload, self._state, self._gen)

    async def _archive_and_delete(
        self, conn, table: str, label: str, key_col: str, data_col: str, keys: list[str], reason: str
    ) -> None:
        await conn.execute(
            f"INSERT INTO {_DELETED_TABLE} (collection, row_key, data, reason) "
            f"SELECT $1, {key_col}, {data_col}, $3 FROM {table} WHERE {key_col} = ANY($2::text[])",
            label,
            keys,
            reason,
        )
        await conn.execute(f"DELETE FROM {table} WHERE {key_col} = ANY($1::text[])", keys)

    async def _apply(self, conn, plan: DiffPlan) -> None:
        for c in _ALL_COLLECTIONS:
            cd = plan.collections.get(c)
            if cd is None or cd.is_empty():
                continue
            t = _table(c)
            is_list = c in LIST_COLLECTIONS
            if cd.deletes:
                await self._archive_and_delete(conn, t, c, "row_key", "data", cd.deletes, "save")
            if cd.inserts:
                # Chỉ xảy ra ghi đè khi cache lệch DB; vẫn lưu bản cũ trước khi đè.
                await conn.execute(
                    f"INSERT INTO {_DELETED_TABLE} (collection, row_key, data, reason) "
                    f"SELECT $1, row_key, data, 'save-overwrite' FROM {t} WHERE row_key = ANY($2::text[])",
                    c,
                    [k for k, _, _ in cd.inserts],
                )
            rows = []
            for k, canon, seq in cd.inserts + cd.updates:
                ext = _extract(c, canon)
                rows.append((k, canon, seq, *ext) if is_list else (k, canon, *ext))
            if rows:
                await conn.executemany(_upsert_sql(c), rows)
            if cd.reseq:
                await conn.executemany(f"UPDATE {t} SET seq=$2 WHERE row_key=$1", cd.reseq)
        if plan.meta_deletes:
            await self._archive_and_delete(conn, _META_TABLE, "meta", "key", "value", plan.meta_deletes, "save")
        meta_rows = list(plan.meta_new.items()) + list(plan.meta_changed.items())
        if meta_rows:
            await conn.executemany(
                f"INSERT INTO {_META_TABLE} (key, value) VALUES ($1, $2::jsonb) "
                "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()",
                meta_rows,
            )

    async def apply_diff(self, conn, plan: DiffPlan) -> None:
        if not conn.is_in_transaction():
            raise RuntimeError("apply_diff phải được gọi bên trong transaction của caller")
        await self._apply(conn, plan)

    def commit_diff(self, plan: DiffPlan) -> None:
        if plan._gen != self._gen:
            # Cache đã bị thay (load/reset) từ lúc tính diff; lần diff sau tự đồng bộ lại (các lệnh đều idempotent).
            return
        st = self._state
        for c, cd in plan.collections.items():
            for k in cd.deletes:
                st.canon[c].pop(k, None)
                if c in LIST_COLLECTIONS:
                    st.seq[c].pop(k, None)
            for k, canon, seq in cd.inserts + cd.updates:
                st.canon[c][k] = canon
                if seq is not None:
                    st.seq[c][k] = seq
            for k, seq in cd.reseq:
                st.seq[c][k] = seq
        for k in plan.meta_deletes:
            st.meta.pop(k, None)
        st.meta.update(plan.meta_new)
        st.meta.update(plan.meta_changed)

    # -- migrate -----------------------------------------------------------------------

    async def migrate_from_payload(self, conn, payload: dict, blob_updated_at: datetime | None) -> DiffPlan:
        _check_payload(payload)
        if not any(c in payload for c in _ALL_COLLECTIONS):
            raise ValueError("payload không chứa collection nào; từ chối migrate")
        if conn.is_in_transaction():
            raise RuntimeError("migrate_from_payload tự mở transaction; không gọi trong transaction khác")

        plan = _build_plan(payload, _State(), -1)
        blob_ts = _parse_dt(blob_updated_at)
        marker = {
            "migrated_at": datetime.now(timezone.utc).isoformat(),
            "blob_synced_updated_at": blob_ts.isoformat() if blob_ts else None,
        }
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", _LOCK_KEY)
            await self.ensure_schema(conn)
            for c in _ALL_COLLECTIONS:
                t = _table(c)
                await conn.execute(
                    f"INSERT INTO {_DELETED_TABLE} (collection, row_key, data, reason) "
                    f"SELECT $1, row_key, data, 'remigrate' FROM {t}",
                    c,
                )
                await conn.execute(f"DELETE FROM {t}")
            await conn.execute(
                f"INSERT INTO {_DELETED_TABLE} (collection, row_key, data, reason) "
                f"SELECT 'meta', key, value, 'remigrate' FROM {_META_TABLE}"
            )
            await conn.execute(f"DELETE FROM {_META_TABLE}")

            await self._apply(conn, plan)
            await conn.execute(
                f"INSERT INTO {_META_TABLE} (key, value) VALUES ($1, $2::jsonb)", _MARKER_KEY, canonical_json(marker)
            )

            _, state = await self._read_back(conn)
            problems = self._compare(plan, state)
            if problems:
                raise RelationalStateMismatch(
                    f"{len(problems)} khác biệt sau khi ghi; ví dụ: " + " | ".join(problems[:5])
                )
        # Đến đây transaction đã commit.
        self._replace_state(state)
        return plan

    @staticmethod
    def _compare(plan: DiffPlan, state: _State) -> list[str]:
        problems: list[str] = []
        for c in _ALL_COLLECTIONS:
            cd = plan.collections.get(c) or _CollectionDiff()
            expected = sorted(cd.inserts, key=lambda x: x[2] or 0) if c in LIST_COLLECTIONS else cd.inserts
            exp_map = {k: canon for k, canon, _ in expected}
            got = state.canon[c]
            for k, v in exp_map.items():
                if k not in got:
                    problems.append(f"{c}: thiếu {k!r}")
                elif got[k] != v:
                    problems.append(f"{c}[{k!r}]: {v[:80]!r} != {got[k][:80]!r}")
            for k in got:
                if k not in exp_map:
                    problems.append(f"{c}: thừa {k!r}")
            if not problems and list(got) != [k for k, _, _ in expected]:
                problems.append(f"{c}: thứ tự khác")
        exp_meta = {**plan.meta_new, **plan.meta_changed}
        for k, v in exp_meta.items():
            if k not in state.meta:
                problems.append(f"meta: thiếu {k!r}")
            elif state.meta[k] != v:
                problems.append(f"meta[{k!r}]: {v[:80]!r} != {state.meta[k][:80]!r}")
        for k in state.meta:
            if k not in exp_meta:
                problems.append(f"meta: thừa {k!r}")
        return problems
