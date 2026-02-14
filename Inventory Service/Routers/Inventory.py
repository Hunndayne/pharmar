import asyncio
import json
from datetime import date, datetime, time, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from redis.asyncio import Redis
from types import SimpleNamespace

from Source.core.config import settings
from Source.domain import (
    BatchStatus,
    MovementType,
    PaymentMethod,
    PaymentStatus,
    PromoType,
    ReceiptStatus,
)
from Source.schemas.inventory import (
    BatchStatusUpdateRequest,
    ImportReceiptCreateRequest,
    ImportReceiptUpdateRequest,
    ReserveRequest,
    StockAdjustmentRequest,
)

router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])
runtime_state = SimpleNamespace()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc_datetime(day: date, hour: int = 9, minute: int = 0) -> datetime:
    return datetime.combine(day, time(hour=hour, minute=minute), tzinfo=timezone.utc)


def normalize_key(value: str) -> str:
    return value.strip().lower()


def normalize_code(value: str) -> str:
    return value.strip().upper()


def highest_unit_for_drug(drug: dict[str, Any]) -> dict[str, Any] | None:
    units = drug.get("units", [])
    if not units:
        return None
    return max(units, key=lambda item: item.get("conversion", 0))


def default_line_unit_prices(drug: dict[str, Any]) -> list[dict[str, Any]]:
    unit_map = {unit["id"]: unit for unit in drug.get("units", [])}
    result: list[dict[str, Any]] = []
    for unit_price in drug.get("unit_prices", []):
        unit_meta = unit_map.get(unit_price["unit_id"])
        if unit_meta is None:
            continue
        result.append(
            {
                "unit_id": unit_price["unit_id"],
                "unit_name": unit_meta["name"],
                "conversion": unit_meta["conversion"],
                "price": unit_price["price"],
            }
        )
    return result


def resolve_line_unit_prices(line: Any, drug: dict[str, Any]) -> list[dict[str, Any]]:
    if getattr(line, "unit_prices", None):
        return [
            {
                "unit_id": item.unit_id,
                "unit_name": item.unit_name,
                "conversion": item.conversion,
                "price": item.price,
            }
            for item in line.unit_prices
        ]
    return default_line_unit_prices(drug)


def resolve_line_promo_note(line: Any) -> str | None:
    if line.promo_note:
        return line.promo_note
    if line.promo_type == PromoType.BUY_X_GET_Y:
        return f"Mua {line.promo_buy_qty} tặng {line.promo_get_qty}"
    if line.promo_type == PromoType.DISCOUNT_PERCENT:
        return f"Giảm {line.promo_discount_percent}%"
    return None


def resolve_line_barcode(line: Any, drug: dict[str, Any]) -> str:
    if line.barcode:
        return line.barcode.strip()
    highest_unit = highest_unit_for_drug(drug)
    return highest_unit["barcode"] if highest_unit else ""


def get_current_actor(token: str) -> tuple[str, str, str]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    token_type = payload.get("type")
    if token_type not in {None, "access"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
            headers={"WWW-Authenticate": "Bearer"},
        )

    subject = payload.get("sub")
    if subject is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
            headers={"WWW-Authenticate": "Bearer"},
        )
    role = str(payload.get("role") or "").strip().lower()
    username = str(payload.get("username") or "").strip().lower()
    return str(subject), role, username


def get_current_subject(token: str) -> str:
    subject, _, _ = get_current_actor(token)
    return subject


def can_override_receipt_lock(role: str, username: str) -> bool:
    return role in {"owner", "admin"} or username == "admin"


def next_id(counter_name: str, prefix: str) -> str:
    runtime_state.counters[counter_name] += 1
    return f"{prefix}-{runtime_state.counters[counter_name]}"


def receipt_code_for_date(receipt_date: date) -> str:
    same_day = sum(1 for r in runtime_state.receipts.values() if r["receipt_date"] == receipt_date)
    return f"PN{receipt_date.strftime('%Y%m%d')}{same_day + 1:03d}"


def batch_code_for_date(receipt_date: date) -> str:
    same_day = sum(1 for b in runtime_state.batches.values() if b["received_date"] == receipt_date)
    return f"LO{receipt_date.strftime('%Y%m%d')}{same_day + 1:03d}"


def get_supplier_or_404(supplier_id: str) -> dict[str, Any]:
    supplier = runtime_state.suppliers.get(supplier_id)
    if supplier is None:
        raise HTTPException(status_code=404, detail=f"Supplier '{supplier_id}' not found")
    return supplier


def resolve_drug(drug_id: str | None = None, drug_code_or_sku: str | None = None) -> dict[str, Any]:
    if drug_id:
        by_id = runtime_state.drugs.get(drug_id)
        if by_id:
            return by_id
    if drug_code_or_sku:
        needle = normalize_key(drug_code_or_sku)
        for drug in runtime_state.drugs.values():
            candidates = {normalize_key(drug["id"]), normalize_key(drug["code"])}
            candidates.update(normalize_key(alias) for alias in drug.get("sku_aliases", []))
            if needle in candidates:
                return drug
    raise HTTPException(status_code=404, detail=f"Drug not found for '{drug_id or drug_code_or_sku}'")


def get_batch_or_404(batch_id: str) -> dict[str, Any]:
    batch = runtime_state.batches.get(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"Batch '{batch_id}' not found")
    return batch


def get_receipt_or_404(receipt_id: str) -> dict[str, Any]:
    receipt = runtime_state.receipts.get(receipt_id)
    if receipt is None:
        raise HTTPException(status_code=404, detail=f"Import receipt '{receipt_id}' not found")
    return receipt


def batch_status(batch: dict[str, Any], as_of: date | None = None) -> BatchStatus:
    day = as_of or date.today()
    if batch["cancelled"]:
        return BatchStatus.CANCELLED
    if batch["qty_remaining"] <= 0:
        return BatchStatus.DEPLETED
    if batch["force_expired"] or batch["exp_date"] < day:
        return BatchStatus.EXPIRED
    return BatchStatus.ACTIVE


def is_batch_code_used(batch_code: str, ignore_ids: set[str] | None = None) -> bool:
    needle = normalize_code(batch_code)
    ignored = ignore_ids or set()
    for batch in runtime_state.batches.values():
        if batch["id"] in ignored:
            continue
        if normalize_code(batch["batch_code"]) == needle:
            return True
    return False


def add_movement(
    event_type: MovementType,
    drug_id: str,
    batch_id: str,
    quantity_delta: int,
    reference_type: str,
    reference_id: str,
    actor: str | None,
    note: str | None = None,
    occurred_at: datetime | None = None,
) -> dict[str, Any]:
    movement = {
        "id": next_id("movement", "mv"),
        "event_type": event_type,
        "drug_id": drug_id,
        "batch_id": batch_id,
        "quantity_delta": quantity_delta,
        "reference_type": reference_type,
        "reference_id": reference_id,
        "actor": actor,
        "note": note,
        "occurred_at": occurred_at or utc_now(),
    }
    runtime_state.movements.append(movement)
    return movement

def stock_total_for_drug(drug_id: str) -> int:
    return sum(
        batch["qty_remaining"]
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug_id and not batch["cancelled"]
    )


def stock_status_for_drug(drug_id: str, as_of: date | None = None) -> str:
    day = as_of or date.today()
    drug = runtime_state.drugs[drug_id]
    batches = [
        batch
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug_id and not batch["cancelled"] and batch["qty_remaining"] > 0
    ]
    total = sum(batch["qty_remaining"] for batch in batches)

    if total <= 0:
        return "out_of_stock"
    if any(batch_status(batch, day) == BatchStatus.EXPIRED for batch in batches):
        return "expired"

    nearest_expiry = min(batch["exp_date"] for batch in batches)
    days_to_expiry = (nearest_expiry - day).days

    if days_to_expiry < 30:
        return "expiring_soon"
    if days_to_expiry < 90:
        return "near_date"
    if total < drug["reorder_level"]:
        return "low_stock"
    return "normal"


def movement_to_view(movement: dict[str, Any]) -> dict[str, Any]:
    batch = runtime_state.batches.get(movement["batch_id"])
    drug = runtime_state.drugs.get(movement["drug_id"])
    return {
        "id": movement["id"],
        "event_type": movement["event_type"],
        "drug_id": movement["drug_id"],
        "drug_code": drug["code"] if drug else None,
        "drug_name": drug["name"] if drug else None,
        "batch_id": movement["batch_id"],
        "batch_code": batch["batch_code"] if batch else None,
        "lot_number": batch["lot_number"] if batch else None,
        "quantity_delta": movement["quantity_delta"],
        "reference_type": movement["reference_type"],
        "reference_id": movement["reference_id"],
        "actor": movement["actor"],
        "note": movement["note"],
        "occurred_at": movement["occurred_at"],
    }


def batch_to_view(batch: dict[str, Any], as_of: date | None = None) -> dict[str, Any]:
    day = as_of or date.today()
    drug = runtime_state.drugs[batch["drug_id"]]
    supplier = runtime_state.suppliers[batch["supplier_id"]]
    return {
        "id": batch["id"],
        "batch_code": batch["batch_code"],
        "lot_number": batch["lot_number"],
        "receipt_id": batch["receipt_id"],
        "drug_id": batch["drug_id"],
        "drug_code": drug["code"],
        "drug_name": drug["name"],
        "drug_group": drug["group"],
        "supplier_id": batch["supplier_id"],
        "supplier_name": supplier["name"],
        "supplier_contact": f"{supplier['contact_name']} - {supplier['phone']}",
        "received_date": batch["received_date"],
        "mfg_date": batch["mfg_date"],
        "exp_date": batch["exp_date"],
        "days_to_expiry": (batch["exp_date"] - day).days,
        "qty_in": batch["qty_in"],
        "qty_remaining": batch["qty_remaining"],
        "import_price": batch["import_price"],
        "barcode": batch.get("barcode", ""),
        "promo_type": batch.get("promo_type", PromoType.NONE),
        "promo_buy_qty": batch.get("promo_buy_qty"),
        "promo_get_qty": batch.get("promo_get_qty"),
        "promo_discount_percent": batch.get("promo_discount_percent"),
        "unit_prices": batch.get("unit_prices", []),
        "promo_note": batch["promo_note"],
        "status": batch_status(batch, day),
        "created_at": batch["created_at"],
        "updated_at": batch["updated_at"],
    }


def receipt_is_editable(
    receipt: dict[str, Any],
    raise_if_not: bool = True,
    allow_privileged: bool = False,
) -> bool:
    if receipt["status"] != ReceiptStatus.CONFIRMED:
        if raise_if_not:
            raise HTTPException(status_code=409, detail="Only confirmed receipts can be updated")
        return False

    if allow_privileged:
        return True

    for line in receipt["lines"]:
        batch = runtime_state.batches.get(line["batch_id"])
        if batch is None:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt has missing batch")
            return False
        if batch["qty_remaining"] != batch["qty_in"]:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt cannot be modified because batch has sales/adjustments")
            return False
        non_import = any(
            m["batch_id"] == batch["id"] and m["event_type"] != MovementType.IMPORT_RECEIPT
            for m in runtime_state.movements
        )
        if non_import:
            if raise_if_not:
                raise HTTPException(status_code=409, detail="Receipt cannot be modified because batch has sales/adjustments")
            return False

    return True


def receipt_to_view(receipt: dict[str, Any]) -> dict[str, Any]:
    supplier = runtime_state.suppliers[receipt["supplier_id"]]
    lines = []
    for line in receipt["lines"]:
        batch = runtime_state.batches.get(line["batch_id"])
        lines.append(
            {
                **line,
                "line_total": round(line["quantity"] * line["import_price"], 2),
                "batch_status": batch_status(batch) if batch else BatchStatus.CANCELLED,
            }
        )

    return {
        "id": receipt["id"],
        "code": receipt["code"],
        "receipt_date": receipt["receipt_date"],
        "supplier_id": receipt["supplier_id"],
        "supplier_name": supplier["name"],
        "supplier_contact": f"{supplier['contact_name']} - {supplier['phone']}",
        "shipping_carrier": receipt.get("shipping_carrier"),
        "payment_status": receipt.get("payment_status", PaymentStatus.PAID),
        "payment_method": receipt.get("payment_method", PaymentMethod.BANK),
        "note": receipt["note"],
        "status": receipt["status"],
        "created_by": receipt["created_by"],
        "created_at": receipt["created_at"],
        "updated_at": receipt["updated_at"],
        "total_value": receipt["total_value"],
        "line_count": len(lines),
        "lines": lines,
        "can_edit": receipt_is_editable(receipt, raise_if_not=False),
    }


def issue_sort_key(batch: dict[str, Any], as_of: date) -> tuple[int, date, date, datetime]:
    days_to_expiry = (batch["exp_date"] - as_of).days
    if days_to_expiry < settings.FEFO_THRESHOLD_DAYS:
        return (0, batch["exp_date"], batch["received_date"], batch["created_at"])
    return (1, batch["received_date"], batch["exp_date"], batch["created_at"])


def issue_strategy(batch: dict[str, Any], as_of: date) -> str:
    days_to_expiry = (batch["exp_date"] - as_of).days
    return "fefo" if days_to_expiry < settings.FEFO_THRESHOLD_DAYS else "fifo"


def suggest_issue_plan(drug: dict[str, Any], quantity: int, as_of: date | None = None) -> tuple[list[dict[str, Any]], int]:
    day = as_of or date.today()
    candidates = [
        batch
        for batch in runtime_state.batches.values()
        if batch["drug_id"] == drug["id"]
        and batch_status(batch, day) == BatchStatus.ACTIVE
        and batch["qty_remaining"] > 0
    ]
    candidates.sort(key=lambda batch: issue_sort_key(batch, day))

    remaining = quantity
    allocations: list[dict[str, Any]] = []

    for batch in candidates:
        if remaining <= 0:
            break
        allocated = min(remaining, batch["qty_remaining"])
        if allocated <= 0:
            continue
        allocations.append(
            {
                "batch_id": batch["id"],
                "batch_code": batch["batch_code"],
                "lot_number": batch["lot_number"],
                "drug_id": batch["drug_id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "received_date": batch["received_date"],
                "exp_date": batch["exp_date"],
                "available": batch["qty_remaining"],
                "allocated": allocated,
                "strategy": issue_strategy(batch, day),
            }
        )
        remaining -= allocated

    return allocations, remaining


def find_batch_by_qr(qr_value: str) -> dict[str, Any] | None:
    needle = normalize_code(qr_value)
    for batch in runtime_state.batches.values():
        if normalize_code(batch["batch_code"]) == needle or normalize_code(batch["lot_number"]) == needle:
            return batch
    return None


def seed_demo_data() -> None:
    runtime_state.counters = {"receipt": 0, "receipt_line": 0, "batch": 0, "movement": 0, "reservation": 0}
    runtime_state.suppliers = {}
    runtime_state.drugs = {}
    runtime_state.receipts = {}
    runtime_state.batches = {}
    runtime_state.movements = []
    runtime_state.reservations = []
    runtime_state.sale_events = []

    suppliers = [
        {"id": "s1", "name": "Phuong Dong", "contact_name": "Nguyen Minh Ha", "phone": "028 3838 8899", "address": "Q1, HCMC"},
        {"id": "s2", "name": "Phu Hung", "contact_name": "Tran Quoc Bao", "phone": "028 3799 1166", "address": "Binh Thanh, HCMC"},
        {"id": "s3", "name": "Mediphar", "contact_name": "Le My Anh", "phone": "028 3877 5555", "address": "Thu Duc, HCMC"},
        {"id": "s4", "name": "An Khang", "contact_name": "Pham Thanh Tung", "phone": "028 3666 3322", "address": "Tan Binh, HCMC"},
    ]
    for supplier in suppliers:
        runtime_state.suppliers[supplier["id"]] = supplier

    drugs = [
        {"id": "d1", "code": "T0001", "name": "Panadol Extra", "group": "Giam dau", "base_unit": "Vien", "reorder_level": 200, "units": [{"id": "d1-u3", "name": "Hop", "conversion": 100, "barcode": "8936012345003"}, {"id": "d1-u2", "name": "Vi", "conversion": 10, "barcode": "8936012345002"}, {"id": "d1-u1", "name": "Vien", "conversion": 1, "barcode": "8936012345001"}], "unit_prices": [{"unit_id": "d1-u3", "price": 320000}, {"unit_id": "d1-u2", "price": 28000}, {"unit_id": "d1-u1", "price": 3000}], "sku_aliases": ["PANADOL"]},
        {"id": "d2", "code": "T0034", "name": "Vitamin C 1000", "group": "Vitamin", "base_unit": "Vien", "reorder_level": 120, "units": [{"id": "d2-u2", "name": "Chai", "conversion": 30, "barcode": "8936017777002"}, {"id": "d2-u1", "name": "Vien", "conversion": 1, "barcode": "8936017777001"}], "unit_prices": [{"unit_id": "d2-u2", "price": 185000}, {"unit_id": "d2-u1", "price": 6000}], "sku_aliases": ["VITC1000"]},
        {"id": "d3", "code": "T0088", "name": "Amoxicillin 500mg", "group": "Khang sinh", "base_unit": "Vien", "reorder_level": 150, "units": [{"id": "d3-u2", "name": "Vi", "conversion": 10, "barcode": "8936011111002"}, {"id": "d3-u1", "name": "Vien", "conversion": 1, "barcode": "8936011111001"}], "unit_prices": [{"unit_id": "d3-u2", "price": 42000}, {"unit_id": "d3-u1", "price": 4200}], "sku_aliases": ["AMOX500"]},
        {"id": "d4", "code": "T0104", "name": "Oresol", "group": "Tieu hoa", "base_unit": "Goi", "reorder_level": 80, "units": [{"id": "d4-u1", "name": "Goi", "conversion": 1, "barcode": "8936013333001"}], "unit_prices": [{"unit_id": "d4-u1", "price": 6000}], "sku_aliases": ["ORESOL"]},
        {"id": "d5", "code": "T0145", "name": "Nuoc muoi sinh ly", "group": "Cham soc", "base_unit": "Chai", "reorder_level": 60, "units": [{"id": "d5-u1", "name": "Chai", "conversion": 1, "barcode": "8936014444001"}], "unit_prices": [{"unit_id": "d5-u1", "price": 12000}], "sku_aliases": ["SALINE"]},
    ]
    for drug in drugs:
        runtime_state.drugs[drug["id"]] = drug
    # Không seed phiếu nhập/lô tồn kho mẫu.
    # Dữ liệu phát sinh từ thao tác nghiệp vụ thực tế qua API.


async def consume_sale_events() -> None:
    while True:
        pubsub = None
        try:
            pubsub = runtime_state.redis.pubsub()
            await pubsub.subscribe("sale.created")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    payload = json.loads(message["data"])
                    runtime_state.sale_events.append(payload)
                    runtime_state.sale_events = runtime_state.sale_events[-200:]
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(1)
        finally:
            if pubsub is not None:
                await pubsub.close()


async def startup_event() -> None:
    runtime_state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    runtime_state.lock = asyncio.Lock()
    seed_demo_data()
    runtime_state.consumer_task = asyncio.create_task(consume_sale_events())


async def shutdown_event() -> None:
    runtime_state.consumer_task.cancel()
    await asyncio.gather(runtime_state.consumer_task, return_exceptions=True)
    await runtime_state.redis.aclose()

@router.get("/events")
async def get_events() -> list[dict[str, Any]]:
    return runtime_state.sale_events


@router.get("/meta/drugs")
async def get_drugs() -> list[dict[str, Any]]:
    return list(runtime_state.drugs.values())


@router.get("/meta/suppliers")
async def get_suppliers() -> list[dict[str, Any]]:
    return list(runtime_state.suppliers.values())


@router.get("/stock")
async def get_stock() -> dict[str, int]:
    stock_map: dict[str, int] = {}
    for drug in runtime_state.drugs.values():
        total = stock_total_for_drug(drug["id"])
        stock_map[drug["code"]] = total
        if drug.get("sku_aliases"):
            stock_map[drug["sku_aliases"][0]] = total
    return stock_map


@router.get("/stock/summary")
async def get_stock_summary() -> list[dict[str, Any]]:
    day = date.today()
    rows: list[dict[str, Any]] = []
    for drug in runtime_state.drugs.values():
        batches = [
            batch
            for batch in runtime_state.batches.values()
            if batch["drug_id"] == drug["id"] and not batch["cancelled"] and batch["qty_remaining"] > 0
        ]
        nearest = min((batch["exp_date"] for batch in batches), default=None)
        rows.append(
            {
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "drug_group": drug["group"],
                "base_unit": drug["base_unit"],
                "reorder_level": drug["reorder_level"],
                "total_qty": stock_total_for_drug(drug["id"]),
                "nearest_expiry": nearest,
                "days_to_nearest_expiry": (nearest - day).days if nearest else None,
                "status": stock_status_for_drug(drug["id"], day),
            }
        )
    rows.sort(key=lambda row: row["drug_code"])
    return rows


@router.get("/stock/drugs/{drug_id}")
async def get_stock_detail(drug_id: str) -> dict[str, Any]:
    drug = resolve_drug(drug_id=drug_id)
    day = date.today()
    batches = [batch for batch in runtime_state.batches.values() if batch["drug_id"] == drug["id"]]
    batches.sort(key=lambda batch: (batch["exp_date"], batch["received_date"], batch["batch_code"]))
    return {
        "drug": drug,
        "summary": {
            "total_qty": stock_total_for_drug(drug["id"]),
            "status": stock_status_for_drug(drug["id"], day),
            "reorder_level": drug["reorder_level"],
        },
        "batches": [batch_to_view(batch, day) for batch in batches],
    }

@router.get("/import-receipts")
async def list_import_receipts(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: ReceiptStatus | None = Query(default=None, alias="status"),
) -> list[dict[str, Any]]:
    receipts = list(runtime_state.receipts.values())
    if date_from is not None:
        receipts = [receipt for receipt in receipts if receipt["receipt_date"] >= date_from]
    if date_to is not None:
        receipts = [receipt for receipt in receipts if receipt["receipt_date"] <= date_to]
    if supplier_id is not None:
        receipts = [receipt for receipt in receipts if receipt["supplier_id"] == supplier_id]
    if status_filter is not None:
        receipts = [receipt for receipt in receipts if receipt["status"] == status_filter]
    receipts.sort(key=lambda receipt: (receipt["receipt_date"], receipt["created_at"]), reverse=True)
    return [receipt_to_view(receipt) for receipt in receipts]


@router.get("/import-receipts/{receipt_id}")
async def get_import_receipt(receipt_id: str) -> dict[str, Any]:
    return receipt_to_view(get_receipt_or_404(receipt_id))


@router.post("/import-receipts", status_code=status.HTTP_201_CREATED)
async def create_import_receipt(payload: ImportReceiptCreateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        supplier = get_supplier_or_404(payload.supplier_id)
        receipt_id = next_id("receipt", "rcp")
        now = utc_now()
        lines: list[dict[str, Any]] = []
        total = 0.0

        for line in payload.lines:
            drug = resolve_drug(drug_id=line.drug_id, drug_code_or_sku=line.drug_code)
            batch_code = normalize_code(line.batch_code) if line.batch_code else batch_code_for_date(payload.receipt_date)
            if is_batch_code_used(batch_code):
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")

            batch_id = next_id("batch", "bt")
            line_id = next_id("receipt_line", "rline")
            promo_note = resolve_line_promo_note(line)
            barcode = resolve_line_barcode(line, drug)
            unit_prices = resolve_line_unit_prices(line, drug)

            batch = {
                "id": batch_id,
                "batch_code": batch_code,
                "lot_number": line.lot_number.strip(),
                "receipt_id": receipt_id,
                "drug_id": drug["id"],
                "supplier_id": supplier["id"],
                "received_date": payload.receipt_date,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "qty_in": line.quantity,
                "qty_remaining": line.quantity,
                "import_price": line.import_price,
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "force_expired": False,
                "cancelled": False,
                "created_at": now,
                "updated_at": now,
            }
            runtime_state.batches[batch_id] = batch

            row = {
                "id": line_id,
                "batch_id": batch_id,
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "lot_number": batch["lot_number"],
                "batch_code": batch["batch_code"],
                "quantity": line.quantity,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "import_price": line.import_price,
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
            }
            lines.append(row)
            total += line.quantity * line.import_price

            add_movement(MovementType.IMPORT_RECEIPT, drug["id"], batch_id, line.quantity, "import_receipt", receipt_id, actor, "create import receipt")

        receipt = {
            "id": receipt_id,
            "code": receipt_code_for_date(payload.receipt_date),
            "receipt_date": payload.receipt_date,
            "supplier_id": supplier["id"],
            "shipping_carrier": payload.shipping_carrier,
            "payment_status": payload.payment_status,
            "payment_method": payload.payment_method,
            "note": payload.note,
            "status": ReceiptStatus.CONFIRMED,
            "created_by": actor,
            "created_at": now,
            "updated_at": now,
            "total_value": round(total, 2),
            "lines": lines,
        }
        runtime_state.receipts[receipt_id] = receipt

    return receipt_to_view(receipt)


@router.put("/import-receipts/{receipt_id}")
async def update_import_receipt(receipt_id: str, payload: ImportReceiptUpdateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor, role, username = get_current_actor(token)
    allow_privileged = can_override_receipt_lock(role, username)
    async with runtime_state.lock:
        receipt = get_receipt_or_404(receipt_id)
        supplier = get_supplier_or_404(payload.supplier_id)
        editable = receipt_is_editable(receipt, raise_if_not=False)
        receipt_is_editable(receipt, raise_if_not=True, allow_privileged=allow_privileged)

        now = utc_now()

        if not editable:
            existing_by_batch_code: dict[str, dict[str, Any]] = {}
            for existing_line in receipt["lines"]:
                key = normalize_code(existing_line["batch_code"])
                if key in existing_by_batch_code:
                    raise HTTPException(status_code=409, detail="Receipt has duplicated batch code and cannot be updated safely")
                existing_by_batch_code[key] = existing_line

            existing_batch_ids = {line["batch_id"] for line in receipt["lines"]}
            incoming_batch_codes: set[str] = set()
            lines: list[dict[str, Any]] = []
            total = 0.0

            for line in payload.lines:
                payload_batch_code = normalize_code(line.batch_code or "")
                if not payload_batch_code:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt has sales/adjustments. Owner/admin update requires existing batch_code for every line.",
                    )
                if payload_batch_code in incoming_batch_codes:
                    raise HTTPException(status_code=409, detail=f"Batch code '{payload_batch_code}' is duplicated in payload")
                incoming_batch_codes.add(payload_batch_code)

                existing_line = existing_by_batch_code.get(payload_batch_code)
                if existing_line is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt has sales/adjustments. Owner/admin cannot add/remove lines.",
                    )

                batch = runtime_state.batches.get(existing_line["batch_id"])
                if batch is None:
                    raise HTTPException(status_code=409, detail="Receipt has missing batch")

                drug = resolve_drug(drug_id=line.drug_id, drug_code_or_sku=line.drug_code)
                if drug["id"] != existing_line["drug_id"]:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt has sales/adjustments. Owner/admin cannot change drug of existing line.",
                    )
                if line.quantity != existing_line["quantity"]:
                    raise HTTPException(
                        status_code=409,
                        detail="Receipt has sales/adjustments. Owner/admin cannot change quantity.",
                    )

                batch_code = normalize_code(line.batch_code)
                if is_batch_code_used(batch_code, ignore_ids=existing_batch_ids):
                    raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")

                promo_note = resolve_line_promo_note(line)
                barcode = resolve_line_barcode(line, drug)
                unit_prices = resolve_line_unit_prices(line, drug)

                row = {
                    "id": existing_line["id"],
                    "batch_id": existing_line["batch_id"],
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "lot_number": line.lot_number.strip(),
                    "batch_code": batch_code,
                    "quantity": existing_line["quantity"],
                    "mfg_date": line.mfg_date,
                    "exp_date": line.exp_date,
                    "import_price": line.import_price,
                    "barcode": barcode,
                    "promo_type": line.promo_type,
                    "promo_buy_qty": line.promo_buy_qty,
                    "promo_get_qty": line.promo_get_qty,
                    "promo_discount_percent": line.promo_discount_percent,
                    "unit_prices": unit_prices,
                    "promo_note": promo_note,
                }
                lines.append(row)
                total += row["quantity"] * row["import_price"]

                batch["batch_code"] = row["batch_code"]
                batch["lot_number"] = row["lot_number"]
                batch["supplier_id"] = supplier["id"]
                batch["received_date"] = payload.receipt_date
                batch["mfg_date"] = row["mfg_date"]
                batch["exp_date"] = row["exp_date"]
                batch["import_price"] = row["import_price"]
                batch["barcode"] = row["barcode"]
                batch["promo_type"] = row["promo_type"]
                batch["promo_buy_qty"] = row["promo_buy_qty"]
                batch["promo_get_qty"] = row["promo_get_qty"]
                batch["promo_discount_percent"] = row["promo_discount_percent"]
                batch["unit_prices"] = row["unit_prices"]
                batch["promo_note"] = row["promo_note"]
                batch["updated_at"] = now

            if len(incoming_batch_codes) != len(existing_by_batch_code):
                raise HTTPException(
                    status_code=409,
                    detail="Receipt has sales/adjustments. Owner/admin cannot add/remove lines.",
                )

            receipt["receipt_date"] = payload.receipt_date
            receipt["supplier_id"] = supplier["id"]
            receipt["shipping_carrier"] = payload.shipping_carrier
            receipt["payment_status"] = payload.payment_status
            receipt["payment_method"] = payload.payment_method
            receipt["note"] = payload.note
            receipt["lines"] = lines
            receipt["total_value"] = round(total, 2)
            receipt["updated_at"] = now
            return receipt_to_view(receipt)

        old_batch_ids = {line["batch_id"] for line in receipt["lines"]}
        for batch_id in old_batch_ids:
            runtime_state.batches.pop(batch_id, None)

        runtime_state.movements = [
            m
            for m in runtime_state.movements
            if not (m["batch_id"] in old_batch_ids and m["event_type"] == MovementType.IMPORT_RECEIPT and m["reference_id"] == receipt["id"])
        ]

        lines: list[dict[str, Any]] = []
        total = 0.0

        for line in payload.lines:
            drug = resolve_drug(drug_id=line.drug_id, drug_code_or_sku=line.drug_code)
            batch_code = normalize_code(line.batch_code) if line.batch_code else batch_code_for_date(payload.receipt_date)
            if is_batch_code_used(batch_code):
                raise HTTPException(status_code=409, detail=f"Batch code '{batch_code}' already exists")

            batch_id = next_id("batch", "bt")
            line_id = next_id("receipt_line", "rline")
            promo_note = resolve_line_promo_note(line)
            barcode = resolve_line_barcode(line, drug)
            unit_prices = resolve_line_unit_prices(line, drug)

            batch = {
                "id": batch_id,
                "batch_code": batch_code,
                "lot_number": line.lot_number.strip(),
                "receipt_id": receipt["id"],
                "drug_id": drug["id"],
                "supplier_id": supplier["id"],
                "received_date": payload.receipt_date,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "qty_in": line.quantity,
                "qty_remaining": line.quantity,
                "import_price": line.import_price,
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
                "force_expired": False,
                "cancelled": False,
                "created_at": now,
                "updated_at": now,
            }
            runtime_state.batches[batch_id] = batch

            row = {
                "id": line_id,
                "batch_id": batch_id,
                "drug_id": drug["id"],
                "drug_code": drug["code"],
                "drug_name": drug["name"],
                "lot_number": batch["lot_number"],
                "batch_code": batch["batch_code"],
                "quantity": line.quantity,
                "mfg_date": line.mfg_date,
                "exp_date": line.exp_date,
                "import_price": line.import_price,
                "barcode": barcode,
                "promo_type": line.promo_type,
                "promo_buy_qty": line.promo_buy_qty,
                "promo_get_qty": line.promo_get_qty,
                "promo_discount_percent": line.promo_discount_percent,
                "unit_prices": unit_prices,
                "promo_note": promo_note,
            }
            lines.append(row)
            total += line.quantity * line.import_price

            add_movement(MovementType.IMPORT_RECEIPT, drug["id"], batch_id, line.quantity, "import_receipt", receipt["id"], actor, "update import receipt")

        receipt["receipt_date"] = payload.receipt_date
        receipt["supplier_id"] = supplier["id"]
        receipt["shipping_carrier"] = payload.shipping_carrier
        receipt["payment_status"] = payload.payment_status
        receipt["payment_method"] = payload.payment_method
        receipt["note"] = payload.note
        receipt["lines"] = lines
        receipt["total_value"] = round(total, 2)
        receipt["updated_at"] = now

    return receipt_to_view(receipt)


@router.post("/import-receipts/{receipt_id}/cancel")
async def cancel_import_receipt(receipt_id: str, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        receipt = get_receipt_or_404(receipt_id)
        if receipt["status"] == ReceiptStatus.CANCELLED:
            return {"message": "Receipt already cancelled", "receipt": receipt_to_view(receipt)}

        receipt_is_editable(receipt, raise_if_not=True)
        now = utc_now()

        for line in receipt["lines"]:
            batch = runtime_state.batches.get(line["batch_id"])
            if batch is None:
                continue
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.RECEIPT_CANCEL, batch["drug_id"], batch["id"], -batch["qty_remaining"], "import_receipt", receipt["id"], actor, "cancel receipt")
            batch["qty_remaining"] = 0
            batch["cancelled"] = True
            batch["force_expired"] = False
            batch["updated_at"] = now

        receipt["status"] = ReceiptStatus.CANCELLED
        receipt["updated_at"] = now

    return {"message": "Import receipt cancelled and stock rolled back", "receipt": receipt_to_view(receipt)}


@router.get("/batches")
async def list_batches(
    search: str | None = Query(default=None),
    drug: str | None = Query(default=None),
    supplier_id: str | None = Query(default=None),
    status_filter: BatchStatus | None = Query(default=None, alias="status"),
    exp_from: date | None = Query(default=None),
    exp_to: date | None = Query(default=None),
) -> list[dict[str, Any]]:
    day = date.today()
    records = list(runtime_state.batches.values())

    if drug:
        resolved = resolve_drug(drug_id=drug, drug_code_or_sku=drug)
        records = [batch for batch in records if batch["drug_id"] == resolved["id"]]
    if supplier_id:
        records = [batch for batch in records if batch["supplier_id"] == supplier_id]
    if exp_from:
        records = [batch for batch in records if batch["exp_date"] >= exp_from]
    if exp_to:
        records = [batch for batch in records if batch["exp_date"] <= exp_to]
    if search:
        keyword = normalize_key(search)
        records = [
            batch
            for batch in records
            if keyword in normalize_key(batch["batch_code"])
            or keyword in normalize_key(batch["lot_number"])
            or keyword in normalize_key(runtime_state.drugs[batch["drug_id"]]["name"])
            or keyword in normalize_key(runtime_state.drugs[batch["drug_id"]]["code"])
        ]
    if status_filter:
        records = [batch for batch in records if batch_status(batch, day) == status_filter]

    records.sort(key=lambda batch: (batch["exp_date"], batch["received_date"], batch["batch_code"]))
    return [batch_to_view(batch, day) for batch in records]


@router.get("/batches/qr/{qr_value}")
async def get_batch_by_qr(qr_value: str) -> dict[str, Any]:
    batch = find_batch_by_qr(qr_value)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"Batch not found for QR '{qr_value}'")

    history = [
        movement_to_view(m)
        for m in sorted((m for m in runtime_state.movements if m["batch_id"] == batch["id"]), key=lambda item: item["occurred_at"], reverse=True)
    ]
    return {"batch": batch_to_view(batch), "history": history}


@router.get("/batches/suggest-issue")
async def suggest_batches_for_issue(
    quantity: int = Query(gt=0),
    drug_id: str | None = Query(default=None),
    drug_code: str | None = Query(default=None),
    as_of: date | None = Query(default=None),
) -> dict[str, Any]:
    if not drug_id and not drug_code:
        raise HTTPException(status_code=400, detail="Provide drug_id or drug_code")
    drug = resolve_drug(drug_id=drug_id, drug_code_or_sku=drug_code)
    day = as_of or date.today()
    allocations, shortage = suggest_issue_plan(drug, quantity, day)
    return {
        "drug_id": drug["id"],
        "drug_code": drug["code"],
        "drug_name": drug["name"],
        "requested": quantity,
        "allocated": quantity - shortage,
        "shortage": shortage,
        "rule": {"fefo_threshold_days": settings.FEFO_THRESHOLD_DAYS, "description": "expiry < threshold => FEFO, otherwise FIFO"},
        "allocations": allocations,
    }


@router.get("/batches/{batch_id}")
async def get_batch_detail(batch_id: str) -> dict[str, Any]:
    batch = get_batch_or_404(batch_id)
    history = [
        movement_to_view(m)
        for m in sorted((m for m in runtime_state.movements if m["batch_id"] == batch["id"]), key=lambda item: item["occurred_at"], reverse=True)
    ]
    return {"batch": batch_to_view(batch), "history": history}

@router.patch("/batches/{batch_id}/status")
async def update_batch_status(batch_id: str, payload: BatchStatusUpdateRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        batch = get_batch_or_404(batch_id)
        now = utc_now()
        today = date.today()

        if payload.status == BatchStatus.CANCELLED:
            if batch["cancelled"]:
                return batch_to_view(batch)
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], -batch["qty_remaining"], "batch_status", batch["id"], actor, "manual cancel batch")
            batch["qty_remaining"] = 0
            batch["cancelled"] = True
            batch["force_expired"] = False

        elif payload.status == BatchStatus.DEPLETED:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be marked depleted")
            if batch["qty_remaining"] > 0:
                add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], -batch["qty_remaining"], "batch_status", batch["id"], actor, "manual set depleted")
            batch["qty_remaining"] = 0
            batch["force_expired"] = False

        elif payload.status == BatchStatus.EXPIRED:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be marked expired")
            batch["force_expired"] = True

        elif payload.status == BatchStatus.ACTIVE:
            if batch["cancelled"]:
                raise HTTPException(status_code=409, detail="Cancelled batch cannot be activated")
            if batch["qty_remaining"] <= 0:
                raise HTTPException(status_code=409, detail="Batch with zero quantity cannot be active")
            if batch["exp_date"] < today:
                raise HTTPException(status_code=409, detail="Expired batch cannot be activated")
            batch["force_expired"] = False

        batch["updated_at"] = now

    return batch_to_view(batch)


@router.post("/stock/adjustments")
async def adjust_stock(payload: StockAdjustmentRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    actor = get_current_subject(token)
    async with runtime_state.lock:
        batch = get_batch_or_404(payload.batch_id)
        if batch["cancelled"]:
            raise HTTPException(status_code=409, detail="Cannot adjust cancelled batch")

        if payload.quantity_delta is not None:
            quantity_delta = payload.quantity_delta
        else:
            quantity_delta = payload.new_quantity - batch["qty_remaining"]

        next_qty = batch["qty_remaining"] + quantity_delta
        if next_qty < 0:
            raise HTTPException(status_code=409, detail="Adjustment would make stock negative")

        batch["qty_remaining"] = next_qty
        batch["updated_at"] = utc_now()
        movement = add_movement(MovementType.STOCK_ADJUSTMENT, batch["drug_id"], batch["id"], quantity_delta, "stock_adjustment", next_id("reservation", "adj"), actor, f"{payload.reason}: {payload.note or ''}".strip())

    return {"message": "Stock adjusted", "batch": batch_to_view(batch), "adjustment": movement_to_view(movement)}


@router.get("/reports/movement")
async def movement_report(
    date_from: date = Query(...),
    date_to: date = Query(...),
    drug: str | None = Query(default=None),
) -> dict[str, Any]:
    if date_to < date_from:
        raise HTTPException(status_code=400, detail="date_to must be greater than or equal to date_from")

    if drug:
        target_drug = resolve_drug(drug_id=drug, drug_code_or_sku=drug)
        target_ids = {target_drug["id"]}
    else:
        target_ids = set(runtime_state.drugs.keys())

    rows: list[dict[str, Any]] = []
    for drug_id in sorted(target_ids):
        drug_record = runtime_state.drugs[drug_id]
        movements = [m for m in runtime_state.movements if m["drug_id"] == drug_id]

        opening_stock = sum(m["quantity_delta"] for m in movements if m["occurred_at"].date() < date_from)
        in_period = [m for m in movements if date_from <= m["occurred_at"].date() <= date_to]

        imported_qty = sum(m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.IMPORT_RECEIPT and m["quantity_delta"] > 0)
        exported_qty = sum(-m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.SALE_RESERVE and m["quantity_delta"] < 0)
        adjusted_in = sum(m["quantity_delta"] for m in in_period if m["event_type"] == MovementType.STOCK_ADJUSTMENT and m["quantity_delta"] > 0)
        adjusted_out = sum(-m["quantity_delta"] for m in in_period if m["event_type"] in {MovementType.STOCK_ADJUSTMENT, MovementType.RECEIPT_CANCEL} and m["quantity_delta"] < 0)
        closing_stock = opening_stock + sum(m["quantity_delta"] for m in in_period)

        rows.append(
            {
                "drug_id": drug_record["id"],
                "drug_code": drug_record["code"],
                "drug_name": drug_record["name"],
                "opening_stock": opening_stock,
                "imported_qty": imported_qty,
                "exported_qty": exported_qty,
                "adjusted_in": adjusted_in,
                "adjusted_out": adjusted_out,
                "closing_stock": closing_stock,
            }
        )

    return {"date_from": date_from, "date_to": date_to, "rows": rows}


@router.get("/alerts")
async def inventory_alerts(
    low_stock_threshold: int | None = Query(default=None, ge=0),
    as_of: date | None = Query(default=None),
) -> dict[str, Any]:
    day = as_of or date.today()
    low_stock: list[dict[str, Any]] = []
    expired: list[dict[str, Any]] = []
    expiring_soon: list[dict[str, Any]] = []
    near_date: list[dict[str, Any]] = []

    for drug in runtime_state.drugs.values():
        total = stock_total_for_drug(drug["id"])
        threshold = low_stock_threshold if low_stock_threshold is not None else drug["reorder_level"]
        if total < threshold:
            low_stock.append(
                {
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "current_qty": total,
                    "threshold": threshold,
                }
            )

    for batch in runtime_state.batches.values():
        if batch["cancelled"] or batch["qty_remaining"] <= 0:
            continue
        days = (batch["exp_date"] - day).days
        entry = {"batch": batch_to_view(batch, day), "days_to_expiry": days}
        if days < 0:
            expired.append(entry)
        elif days < 30:
            expiring_soon.append(entry)
        elif days < 90:
            near_date.append(entry)

    return {
        "as_of": day,
        "totals": {
            "low_stock": len(low_stock),
            "expiring_soon": len(expiring_soon),
            "near_date": len(near_date),
            "expired": len(expired),
        },
        "low_stock": low_stock,
        "expiring_soon": expiring_soon,
        "near_date": near_date,
        "expired": expired,
    }


@router.post("/reserve")
async def reserve(payload: ReserveRequest, token: str = Depends(oauth2_scheme)) -> dict[str, Any]:
    user_id = get_current_subject(token)
    async with runtime_state.lock:
        reservation_items: list[dict[str, Any]] = []

        for item in payload.items:
            drug = resolve_drug(drug_code_or_sku=item.sku)
            allocations, shortage = suggest_issue_plan(drug, item.quantity, date.today())
            if shortage > 0:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": f"Not enough stock for '{item.sku}'",
                        "requested": item.quantity,
                        "available": item.quantity - shortage,
                        "shortage": shortage,
                    },
                )
            reservation_items.append(
                {
                    "sku": item.sku,
                    "drug_id": drug["id"],
                    "drug_code": drug["code"],
                    "drug_name": drug["name"],
                    "requested": item.quantity,
                    "allocations": allocations,
                }
            )

        for reservation_item in reservation_items:
            for allocation in reservation_item["allocations"]:
                batch = get_batch_or_404(allocation["batch_id"])
                batch["qty_remaining"] -= allocation["allocated"]
                batch["updated_at"] = utc_now()
                add_movement(MovementType.SALE_RESERVE, batch["drug_id"], batch["id"], -allocation["allocated"], "sale", payload.sale_id, user_id, f"reserve for sale {payload.sale_id}")

        reservation_record = {
            "id": next_id("reservation", "rsv"),
            "sale_id": payload.sale_id,
            "reserved_by": user_id,
            "reserved_at": utc_now(),
            "items": reservation_items,
        }
        runtime_state.reservations.append(reservation_record)
        runtime_state.reservations = runtime_state.reservations[-500:]

    return {"message": "Stock reserved", "reservation": reservation_record}

