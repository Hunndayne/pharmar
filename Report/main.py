import asyncio
import base64
import hashlib
import hmac
import json
import logging
import math
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from typing import Any
from zoneinfo import ZoneInfo

import aio_pika
import httpx
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis


logger = logging.getLogger("report.events")

MONEY_QUANT = Decimal("1")
RATIO_QUANT = Decimal("0.0001")
PERCENT_QUANT = Decimal("0.01")


class Settings(BaseSettings):
    APP_NAME: str = "Report Service"
    APP_PORT: int = 8004

    REDIS_URL: str = "redis://redis:6379/0"
    SALE_SERVICE_URL: str = "http://sale-service:8003"
    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    STORE_SERVICE_URL: str = "http://store-service:8005"
    REPORT_CACHE_TTL_SECONDS: int = 120
    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"
    INTERNAL_SERVICE_TOKEN_EXPIRE_MINUTES: int = 30

    AI_DASHBOARD_INSIGHTS_ENABLED: bool = False
    AI_WORKER_DASHBOARD_INSIGHTS_URL: str = ""
    AI_WORKER_API_KEY: str = ""
    AI_WORKER_TIMEOUT_SECONDS: float = 45.0

    RABBITMQ_ENABLED: bool = True
    RABBITMQ_URL: str = "amqp://guest:guest@rabbitmq:5672/"
    RABBITMQ_EXCHANGE: str = "pharmar.events"
    RABBITMQ_QUEUE: str = "report.sale.events"
    RABBITMQ_ROUTING_KEYS: str = "sale.invoice.created,sale.invoice.cancelled,sale.return.approved"

    REPORT_EVENT_DEDUP_TTL_SECONDS: int = 60 * 60 * 24 * 7

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
app = FastAPI(title=settings.APP_NAME, version="0.2.0")

_SUMMARY_KEY = "report:summary"
_EVENTS_KEY = "report:events"
_EVENTS_DEDUP_KEY = "report:events:dedup"
_MAX_EVENTS = 100
REPORT_TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")
DEFAULT_RESTOCK_SALES_WINDOW_DAYS = 60
DEFAULT_RESTOCK_TARGET_COVER_DAYS = 14
RESTOCK_DAY_QUANT = Decimal("0.1")
AI_DASHBOARD_SLOTS = (7, 12, 18)
AI_SLOT_MARKER_TTL_SECONDS = 60 * 60 * 24 * 8
AI_SLOT_LOCK_TTL_SECONDS = 60 * 10
AI_REFRESH_LOCK_TTL_SECONDS = 60 * 5
AI_DASHBOARD_INSIGHTS_SNAPSHOT_KEY = "report:ai:dashboard:snapshot"
AI_DASHBOARD_INSIGHTS_META_KEY = "report:ai:dashboard:meta"
AI_DASHBOARD_INSIGHTS_SLOT_KEY_PREFIX = "report:ai:dashboard:slot"
AI_DASHBOARD_INSIGHTS_SLOT_LOCK_PREFIX = "report:ai:dashboard:slot-lock"
AI_DASHBOARD_INSIGHTS_REFRESH_LOCK_KEY = "report:ai:dashboard:refresh-lock"
AI_DASHBOARD_MAX_ITEMS = 5
AI_DASHBOARD_ALLOWED_SEVERITIES = {"high", "medium", "low"}
AI_DASHBOARD_DEFAULT_MODEL = "cloudflare-worker"


def _active_report_timezone() -> ZoneInfo:
    return getattr(app.state, "report_timezone", REPORT_TIMEZONE)


def _active_report_timezone_name() -> str:
    return getattr(app.state, "report_timezone_name", REPORT_TIMEZONE.key)


def _now_local() -> datetime:
    return datetime.now(_active_report_timezone())


def _to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _to_decimal(value: Any) -> Decimal:
    try:
        if value is None or value == "":
            return Decimal("0")
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _to_money(value: Decimal | float | int) -> int:
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return int(amount.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP))


def _to_percent(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _to_rate(value: Decimal) -> float:
    return float(value.quantize(RATIO_QUANT, rounding=ROUND_HALF_UP))


def _to_days(value: Decimal) -> float:
    return float(value.quantize(RESTOCK_DAY_QUANT, rounding=ROUND_HALF_UP))


def _to_non_negative_int(value: Any, default: int = 0) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return max(0, default)
    return parsed if parsed >= 0 else max(0, default)


def _to_int_with_minimum(value: Any, default: int, minimum: int) -> int:
    parsed = _to_non_negative_int(value, default)
    return parsed if parsed >= minimum else default


def _routing_keys() -> list[str]:
    keys = [item.strip() for item in settings.RABBITMQ_ROUTING_KEYS.split(",")]
    return [item for item in keys if item]


def _require_authorization(authorization: str | None) -> str:
    token = (authorization or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    return token


def _parse_timestamp(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _local_datetime(value: str) -> datetime | None:
    parsed = _parse_timestamp(value)
    if parsed is None:
        return None
    return parsed.astimezone(_active_report_timezone())


def _local_date(value: str) -> date | None:
    local_dt = _local_datetime(value)
    return local_dt.date() if local_dt is not None else None


def _in_local_date_range(value: str, date_from: date | None, date_to: date | None) -> bool:
    local_value = _local_date(value)
    if local_value is None:
        return False
    if date_from is not None and local_value < date_from:
        return False
    if date_to is not None and local_value > date_to:
        return False
    return True


def _period_day_key(value: str) -> str:
    local_dt = _local_datetime(value)
    return local_dt.date().isoformat() if local_dt is not None else ""


def _period_week_key(value: str) -> str:
    local_dt = _local_datetime(value)
    if local_dt is None:
        return ""
    iso = local_dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def _period_month_key(value: str) -> str:
    local_dt = _local_datetime(value)
    return local_dt.strftime("%Y-%m") if local_dt is not None else ""


def _cache_key(prefix: str, payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return f"{prefix}:{encoded}"


def _parse_optional_date(value: str | None, field_name: str) -> date | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field_name} must be in YYYY-MM-DD format") from exc


def _extract_service_fee_from_note(note: Any) -> tuple[Decimal, str | None]:
    raw = str(note or "").strip()
    if not raw:
        return Decimal("0"), None
    if "Phí dịch vụ" not in raw and "Phi dich vu" not in raw:
        return Decimal("0"), None

    match = re.search(r"Ph[íi]\s+d[ịi]ch\s+v[ụu]\s*:\s*([\d\.\,]+)", raw, re.IGNORECASE)
    if not match:
        return Decimal("0"), None

    amount_text = match.group(1).replace(".", "").replace(",", "").strip()
    amount = _to_decimal(amount_text)
    mode = "separate" if "mục riêng" in raw.lower() or "muc rieng" in raw.lower() else None
    return amount, mode


async def _get_cached_json(key: str) -> Any | None:
    raw = await app.state.redis.get(key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def _set_cached_json(key: str, payload: Any, ttl_seconds: int) -> None:
    await app.state.redis.set(key, json.dumps(payload, ensure_ascii=False), ex=max(1, ttl_seconds))


async def _set_json_value(key: str, payload: Any) -> None:
    await app.state.redis.set(key, json.dumps(payload, ensure_ascii=False))


async def _request_service_json(
    method: str,
    url: str,
    authorization: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> Any:
    headers = {"Authorization": authorization}
    sanitized_params = None
    if params is not None:
        sanitized_params = {
            key: value
            for key, value in params.items()
            if value is not None and value != ""
        }
    response = await app.state.http_client.request(
        method=method,
        url=url,
        headers=headers,
        params=sanitized_params,
        json=json_body,
    )
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.")
    if response.status_code == 403:
        raise HTTPException(status_code=403, detail="Bạn không có quyền xem báo cáo này.")
    if response.status_code >= 400:
        detail = None
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message")
        except Exception:
            detail = None
        raise HTTPException(
            status_code=502,
            detail=detail or f"Internal report dependency failed ({response.status_code})",
        )
    return response.json()


async def _fetch_profit_source_invoices(
    authorization: str,
    date_from: date | None,
    date_to: date | None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    pages = 1

    query_from = date_from - timedelta(days=1) if date_from else None
    query_to = date_to + timedelta(days=1) if date_to else None

    while page <= pages:
        payload = await _request_service_json(
            "GET",
            f"{settings.SALE_SERVICE_URL}/api/v1/sale/reports/profit-source",
            authorization,
            params={
                "page": page,
                "size": 200,
                "date_from": query_from.isoformat() if query_from else None,
                "date_to": query_to.isoformat() if query_to else None,
            },
        )
        rows = payload.get("items") if isinstance(payload, dict) else []
        if isinstance(rows, list):
            items.extend(row for row in rows if isinstance(row, dict))
        pages = max(1, int((payload or {}).get("pages", 1) or 1))
        page += 1

    return items


async def _fetch_batch_costs(
    authorization: str,
    batch_ids: list[str],
) -> dict[str, dict[str, Any]]:
    cost_map: dict[str, dict[str, Any]] = {}
    if not batch_ids:
        return cost_map

    deduped: list[str] = []
    seen: set[str] = set()
    for batch_id in batch_ids:
        normalized = str(batch_id or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)

    chunk_size = 500
    for start in range(0, len(deduped), chunk_size):
        chunk = deduped[start : start + chunk_size]
        payload = await _request_service_json(
            "POST",
            f"{settings.INVENTORY_SERVICE_URL}/api/v1/inventory/reports/batch-costs",
            authorization,
            json_body={"batch_ids": chunk},
        )
        rows = payload.get("items") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            batch_id = str(row.get("batch_id") or "").strip()
            if batch_id:
                cost_map[batch_id] = row

    return cost_map


async def _fetch_stock_summary(authorization: str) -> list[dict[str, Any]]:
    payload = await _request_service_json(
        "GET",
        f"{settings.INVENTORY_SERVICE_URL}/api/v1/inventory/stock/summary",
        authorization,
    )
    if not isinstance(payload, list):
        return []
    return [row for row in payload if isinstance(row, dict)]


async def _fetch_inventory_settings(authorization: str) -> dict[str, Any]:
    payload = await _request_service_json(
        "GET",
        f"{settings.STORE_SERVICE_URL}/api/v1/store/settings/group/inventory",
        authorization,
    )
    return payload if isinstance(payload, dict) else {}


async def _fetch_system_settings(authorization: str) -> dict[str, Any]:
    payload = await _request_service_json(
        "GET",
        f"{settings.STORE_SERVICE_URL}/api/v1/store/settings/group/system",
        authorization,
    )
    return payload if isinstance(payload, dict) else {}


async def _fetch_expense_summary(
    authorization: str,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, Any]:
    try:
        payload = await _request_service_json(
            "GET",
            f"{settings.STORE_SERVICE_URL}/api/v1/store/expenses/summary",
            authorization,
            params={
                "date_from": date_from.isoformat() if date_from else None,
                "date_to": date_to.isoformat() if date_to else None,
            },
        )
        return payload if isinstance(payload, dict) else {"items": [], "grand_total": 0}
    except Exception:
        logger.warning("Failed to fetch expense summary from store service")
        return {"items": [], "grand_total": 0}


def _paginate_rows(items: list[dict[str, Any]], page: int, size: int) -> dict[str, Any]:
    total = len(items)
    pages = max(1, (total + size - 1) // size)
    current_page = min(max(1, page), pages)
    start = (current_page - 1) * size
    end = start + size
    return {
        "items": items[start:end],
        "total": total,
        "page": current_page,
        "size": size,
        "pages": pages,
    }


def _build_profit_dataset(
    invoices: list[dict[str, Any]],
    batch_costs: dict[str, dict[str, Any]],
    date_from: date | None,
    date_to: date | None,
) -> dict[str, Any]:
    summary_invoice_count = 0
    summary_net_revenue = Decimal("0")
    summary_cogs = Decimal("0")
    summary_gross_profit = Decimal("0")
    summary_collected_profit = Decimal("0")
    summary_service_fee_total = Decimal("0")

    invoice_rows: list[dict[str, Any]] = []
    daily_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "period_key": "",
        "invoice_count": 0,
        "net_revenue": Decimal("0"),
        "cogs": Decimal("0"),
        "gross_profit": Decimal("0"),
        "collected_profit": Decimal("0"),
    })
    weekly_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "period_key": "",
        "invoice_count": 0,
        "net_revenue": Decimal("0"),
        "cogs": Decimal("0"),
        "gross_profit": Decimal("0"),
        "collected_profit": Decimal("0"),
    })
    monthly_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "period_key": "",
        "invoice_count": 0,
        "net_revenue": Decimal("0"),
        "cogs": Decimal("0"),
        "gross_profit": Decimal("0"),
        "collected_profit": Decimal("0"),
    })
    product_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "product_id": "",
        "product_code": "",
        "product_name": "",
        "sold_base_qty": Decimal("0"),
        "net_revenue": Decimal("0"),
        "cogs": Decimal("0"),
        "gross_profit": Decimal("0"),
    })

    for invoice in invoices:
        created_at = str(invoice.get("created_at") or "")
        items = invoice.get("items") if isinstance(invoice.get("items"), list) else []
        if not created_at or not items:
            continue
        if not _in_local_date_range(created_at, date_from, date_to):
            continue

        subtotal = _to_decimal(invoice.get("subtotal"))
        total_amount = _to_decimal(invoice.get("total_amount"))
        amount_paid = _to_decimal(invoice.get("amount_paid"))
        change_amount = _to_decimal(invoice.get("change_amount"))
        tier_discount = _to_decimal(invoice.get("tier_discount"))
        promotion_discount = _to_decimal(invoice.get("promotion_discount"))
        points_discount = _to_decimal(invoice.get("points_discount"))
        service_fee_amount = _to_decimal(invoice.get("service_fee_amount"))
        service_fee_mode = str(invoice.get("service_fee_mode") or "split").strip().lower()
        if service_fee_amount <= 0:
            parsed_service_fee, parsed_service_fee_mode = _extract_service_fee_from_note(invoice.get("note"))
            if parsed_service_fee > 0:
                service_fee_amount = parsed_service_fee
            if parsed_service_fee_mode:
                service_fee_mode = parsed_service_fee_mode
        invoice_discount_pool = tier_discount + promotion_discount + points_discount
        summary_service_fee_total += service_fee_amount

        line_total_sum = sum((_to_decimal(item.get("line_total")) for item in items), Decimal("0"))
        remaining_discount = invoice_discount_pool
        invoice_product_revenue = Decimal("0")
        invoice_cogs = Decimal("0")

        for index, item in enumerate(items):
            line_total = _to_decimal(item.get("line_total"))
            quantity = max(0, int(item.get("quantity") or 0))
            returned_quantity = min(quantity, max(0, int(item.get("returned_quantity") or 0)))
            effective_quantity = max(0, quantity - returned_quantity)
            conversion_rate = max(1, int(item.get("conversion_rate") or 1))

            if line_total_sum > 0:
                if index == len(items) - 1:
                    allocated_discount = remaining_discount
                else:
                    allocated_discount = invoice_discount_pool * line_total / line_total_sum
                    remaining_discount -= allocated_discount
            else:
                allocated_discount = Decimal("0")

            line_net_before_returns = max(Decimal("0"), line_total - allocated_discount)
            sold_ratio = (
                Decimal(effective_quantity) / Decimal(quantity)
                if quantity > 0
                else Decimal("0")
            )
            line_net_revenue = line_net_before_returns * sold_ratio
            base_quantity = Decimal(effective_quantity * conversion_rate)
            batch_cost = batch_costs.get(str(item.get("batch_id") or "").strip(), {})
            cost_per_base_unit = _to_decimal(batch_cost.get("cost_per_base_unit"))
            line_cogs = base_quantity * cost_per_base_unit
            line_profit = line_net_revenue - line_cogs

            invoice_product_revenue += line_net_revenue
            invoice_cogs += line_cogs

            product_key = str(item.get("product_id") or item.get("product_code") or "")
            product_row = product_map[product_key]
            product_row["product_id"] = str(item.get("product_id") or "")
            product_row["product_code"] = str(item.get("product_code") or "")
            product_row["product_name"] = str(item.get("product_name") or "")
            product_row["sold_base_qty"] += base_quantity
            product_row["net_revenue"] += line_net_revenue
            product_row["cogs"] += line_cogs
            product_row["gross_profit"] += line_profit

        invoice_net_revenue = invoice_product_revenue
        if service_fee_mode == "separate" and service_fee_amount > 0:
            invoice_net_revenue += service_fee_amount

        invoice_profit = invoice_net_revenue - invoice_cogs
        collected_amount = min(total_amount, max(Decimal("0"), amount_paid - change_amount))
        collected_ratio = Decimal("1")
        if total_amount > 0:
            collected_ratio = min(Decimal("1"), (collected_amount / total_amount).quantize(RATIO_QUANT))
        collected_profit = invoice_profit * collected_ratio
        debt_amount = max(Decimal("0"), total_amount - collected_amount)

        summary_invoice_count += 1
        summary_net_revenue += invoice_net_revenue
        summary_cogs += invoice_cogs
        summary_gross_profit += invoice_profit
        summary_collected_profit += collected_profit

        day_key = _period_day_key(created_at)
        week_key = _period_week_key(created_at)
        month_key = _period_month_key(created_at)
        for bucket, period_key in (
            (daily_map, day_key),
            (weekly_map, week_key),
            (monthly_map, month_key),
        ):
            if not period_key:
                continue
            row = bucket[period_key]
            row["period_key"] = period_key
            row["invoice_count"] += 1
            row["net_revenue"] += invoice_net_revenue
            row["cogs"] += invoice_cogs
            row["gross_profit"] += invoice_profit
            row["collected_profit"] += collected_profit

        invoice_rows.append(
            {
                "invoice_id": str(invoice.get("id") or ""),
                "invoice_code": str(invoice.get("code") or ""),
                "created_at": created_at,
                "customer_name": invoice.get("customer_name") or "Khách vãng lai",
                "customer_phone": invoice.get("customer_phone") or "",
                "status": invoice.get("status") or "",
                "subtotal": _to_money(subtotal),
                "net_revenue": _to_money(invoice_net_revenue),
                "cogs": _to_money(invoice_cogs),
                "gross_profit": _to_money(invoice_profit),
                "collected_profit": _to_money(collected_profit),
                "amount_paid": _to_money(collected_amount),
                "debt_amount": _to_money(debt_amount),
                "service_fee_amount": _to_money(service_fee_amount),
                "service_fee_mode": service_fee_mode,
            }
        )

    def finalize_period_rows(source: dict[str, dict[str, Any]], descending: bool = True) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for row in source.values():
            rows.append(
                {
                    "period_key": row["period_key"],
                    "invoice_count": int(row["invoice_count"]),
                    "net_revenue": _to_money(row["net_revenue"]),
                    "cogs": _to_money(row["cogs"]),
                    "gross_profit": _to_money(row["gross_profit"]),
                    "collected_profit": _to_money(row["collected_profit"]),
                }
            )
        rows.sort(key=lambda item: item["period_key"], reverse=descending)
        return rows

    product_rows: list[dict[str, Any]] = []
    for row in product_map.values():
        net_revenue = row["net_revenue"]
        gross_profit = row["gross_profit"]
        margin_percent = Decimal("0")
        if net_revenue > 0:
            margin_percent = (gross_profit / net_revenue) * Decimal("100")
        product_rows.append(
            {
                "product_id": row["product_id"],
                "product_code": row["product_code"],
                "product_name": row["product_name"],
                "sold_base_qty": int(row["sold_base_qty"]),
                "net_revenue": _to_money(net_revenue),
                "cogs": _to_money(row["cogs"]),
                "gross_profit": _to_money(gross_profit),
                "margin_percent": _to_percent(margin_percent),
            }
        )
    product_rows.sort(key=lambda item: (item["gross_profit"], item["net_revenue"]), reverse=True)

    gross_margin_percent = Decimal("0")
    if summary_net_revenue > 0:
        gross_margin_percent = (summary_gross_profit / summary_net_revenue) * Decimal("100")

    invoice_rows.sort(key=lambda item: item["created_at"], reverse=True)

    return {
        "summary": {
            "invoice_count": summary_invoice_count,
            "net_revenue": _to_money(summary_net_revenue),
            "cogs": _to_money(summary_cogs),
            "gross_profit": _to_money(summary_gross_profit),
            "collected_profit": _to_money(summary_collected_profit),
            "gross_margin_percent": _to_percent(gross_margin_percent),
            "service_fee_total": _to_money(summary_service_fee_total),
        },
        "breakdowns": {
            "invoice": invoice_rows,
            "day": finalize_period_rows(daily_map),
            "week": finalize_period_rows(weekly_map),
            "month": finalize_period_rows(monthly_map),
            "product": product_rows,
        },
        "top_products": product_rows[:10],
    }


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _create_internal_service_token() -> str:
    algorithm = settings.JWT_ALGORITHM.strip().upper()
    if algorithm != "HS256":
        raise RuntimeError(f"Unsupported JWT algorithm for internal token: {settings.JWT_ALGORITHM}")

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=max(1, settings.INTERNAL_SERVICE_TOKEN_EXPIRE_MINUTES))
    header = {"alg": algorithm, "typ": "JWT"}
    payload = {
        "sub": "report-service",
        "username": "report-service",
        "role": "owner",
        "type": "access",
        "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    encoded_header = _base64url_encode(json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    encoded_payload = _base64url_encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(settings.JWT_SECRET_KEY.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{_base64url_encode(signature)}"


def _internal_authorization_header() -> str:
    return f"Bearer {_create_internal_service_token()}"


def _resolve_timezone(value: str | None) -> ZoneInfo:
    raw = (value or "").strip()
    if not raw:
        return REPORT_TIMEZONE
    try:
        return ZoneInfo(raw)
    except Exception:
        logger.warning("Invalid system.timezone=%s. Falling back to %s", raw, REPORT_TIMEZONE.key)
        return REPORT_TIMEZONE


async def _refresh_report_timezone(authorization: str) -> ZoneInfo:
    try:
        system_settings = await _fetch_system_settings(authorization)
    except Exception:
        logger.exception("Cannot load system timezone. Keep current timezone=%s", _active_report_timezone_name())
        return _active_report_timezone()

    timezone_name = str(system_settings.get("system.timezone") or "").strip()
    next_timezone = _resolve_timezone(timezone_name)
    app.state.report_timezone = next_timezone
    app.state.report_timezone_name = next_timezone.key
    return next_timezone


def _slot_key(slot_at: datetime) -> str:
    return slot_at.isoformat()


def _slot_marker_key(slot_at: datetime) -> str:
    return f"{AI_DASHBOARD_INSIGHTS_SLOT_KEY_PREFIX}:{_slot_key(slot_at)}"


def _slot_lock_key(slot_at: datetime) -> str:
    return f"{AI_DASHBOARD_INSIGHTS_SLOT_LOCK_PREFIX}:{_slot_key(slot_at)}"


def _slot_datetime(target_date: date, hour: int, tz: ZoneInfo) -> datetime:
    return datetime(target_date.year, target_date.month, target_date.day, hour, 0, 0, tzinfo=tz)


def _latest_due_ai_slot(now_local: datetime) -> datetime | None:
    for hour in reversed(AI_DASHBOARD_SLOTS):
        slot_at = _slot_datetime(now_local.date(), hour, now_local.tzinfo or _active_report_timezone())
        if slot_at <= now_local:
            return slot_at
    return None


def _next_ai_slot(now_local: datetime) -> datetime:
    tz = now_local.tzinfo or _active_report_timezone()
    for hour in AI_DASHBOARD_SLOTS:
        slot_at = _slot_datetime(now_local.date(), hour, tz)
        if slot_at > now_local:
            return slot_at
    return _slot_datetime(now_local.date() + timedelta(days=1), AI_DASHBOARD_SLOTS[0], tz)


def _normalize_ai_item(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    title = str(raw.get("title") or "").strip()
    summary = str(raw.get("summary") or "").strip()
    why_it_matters = str(raw.get("why_it_matters") or raw.get("why") or summary).strip()
    recommended_action = str(raw.get("recommended_action") or raw.get("action") or "").strip()
    severity = str(raw.get("severity") or "").strip().lower()
    if not title or not summary or not why_it_matters or severity not in AI_DASHBOARD_ALLOWED_SEVERITIES:
        return None

    try:
        confidence = float(raw.get("confidence"))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    source_refs_raw = raw.get("source_refs")
    source_refs = (
        [
            str(item).strip()
            for item in source_refs_raw
            if str(item).strip()
        ]
        if isinstance(source_refs_raw, list)
        else []
    )
    if not source_refs:
        return None

    return {
        "title": title,
        "summary": summary,
        "why_it_matters": why_it_matters,
        "recommended_action": recommended_action or "Kiểm tra chi tiết trên dashboard và thực hiện xử lý trong ngày.",
        "severity": severity,
        "confidence": round(confidence, 4),
        "source_refs": source_refs,
    }


def _normalize_ai_worker_response(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("AI worker response must be a JSON object")

    model = str(raw.get("model") or "").strip() or AI_DASHBOARD_DEFAULT_MODEL
    items_raw = raw.get("items")
    if not isinstance(items_raw, list):
        raise ValueError("AI worker response items must be an array")

    items = [
        item
        for item in (_normalize_ai_item(entry) for entry in items_raw[:AI_DASHBOARD_MAX_ITEMS])
        if item is not None
    ]
    if not items:
        raise ValueError("AI worker response did not include valid insight items")

    return {
        "model": model,
        "items": items,
    }


def _dashboard_ai_response(
    status: str,
    *,
    generated_at: str = "",
    slot_at: str = "",
    model: str = "",
    items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "generated_at": generated_at,
        "slot_at": slot_at,
        "model": model,
        "items": items or [],
    }


def _dashboard_ai_snapshot(
    *,
    slot_at: datetime,
    model: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "generated_at": _now_local().isoformat(),
        "slot_at": slot_at.isoformat(),
        "model": model,
        "items": items,
    }


async def _fetch_dashboard_ai_snapshot() -> dict[str, Any] | None:
    payload = await _get_cached_json(AI_DASHBOARD_INSIGHTS_SNAPSHOT_KEY)
    if not isinstance(payload, dict):
        return None

    generated_at = str(payload.get("generated_at") or "").strip()
    slot_at = str(payload.get("slot_at") or "").strip()
    model = str(payload.get("model") or "").strip()
    items_raw = payload.get("items")
    if not generated_at or not slot_at or not model or not isinstance(items_raw, list):
        return None

    items = [
        item
        for item in (_normalize_ai_item(entry) for entry in items_raw)
        if item is not None
    ]
    if not items:
        return None

    return {
        "generated_at": generated_at,
        "slot_at": slot_at,
        "model": model,
        "items": items,
    }


async def _fetch_dashboard_ai_meta() -> dict[str, Any]:
    payload = await _get_cached_json(AI_DASHBOARD_INSIGHTS_META_KEY)
    return payload if isinstance(payload, dict) else {}


def _is_ai_dashboard_enabled() -> bool:
    return (
        settings.AI_DASHBOARD_INSIGHTS_ENABLED
        and bool(settings.AI_WORKER_DASHBOARD_INSIGHTS_URL.strip())
        and bool(settings.AI_WORKER_API_KEY.strip())
    )


def _build_inventory_health(stock_summary: list[dict[str, Any]]) -> dict[str, Any]:
    total_items = len(stock_summary)
    counts = {
        "out_of_stock": 0,
        "low_stock": 0,
        "near_date": 0,
        "expiring_soon": 0,
        "expired": 0,
        "normal": 0,
    }

    for row in stock_summary:
        status = str(row.get("status") or "").strip().lower()
        if status in counts:
            counts[status] += 1
        else:
            counts["normal"] += 1

    safe_count = counts["normal"]
    return {
        "total_items": total_items,
        "safe_count": safe_count,
        "safe_rate": round((safe_count / total_items) * 100, 2) if total_items > 0 else 0,
        **counts,
    }


def _build_revenue_trend_rows(dataset: dict[str, Any], *, date_from: date, date_to: date) -> list[dict[str, Any]]:
    daily_rows = {
        str(item.get("period_key") or ""): item
        for item in dataset.get("breakdowns", {}).get("day", [])
        if isinstance(item, dict)
    }

    rows: list[dict[str, Any]] = []
    current = date_from
    while current <= date_to:
        day_key = current.isoformat()
        row = daily_rows.get(day_key, {})
        rows.append(
            {
                "date": day_key,
                "invoice_count": _to_non_negative_int(row.get("invoice_count")),
                "net_revenue": _to_money(_to_decimal(row.get("net_revenue"))),
                "gross_profit": _to_money(_to_decimal(row.get("gross_profit"))),
                "collected_profit": _to_money(_to_decimal(row.get("collected_profit"))),
            }
        )
        current += timedelta(days=1)
    return rows


def _format_ai_insight_number(value: Any, digits: int = 0) -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 0.0
    formatted = f"{numeric:,.{digits}f}"
    if digits == 0:
        formatted = formatted.split(".")[0]
    return formatted.replace(",", "X").replace(".", ",").replace("X", ".")


def _compute_dashboard_revenue_delta(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if len(rows) < 2:
        return None

    midpoint = len(rows) // 2
    previous_rows = rows[:midpoint]
    recent_rows = rows[midpoint:]

    previous_revenue = sum(_to_decimal(item.get("net_revenue")) for item in previous_rows if isinstance(item, dict))
    recent_revenue = sum(_to_decimal(item.get("net_revenue")) for item in recent_rows if isinstance(item, dict))
    previous_invoice_count = sum(
        _to_non_negative_int(item.get("invoice_count"))
        for item in previous_rows
        if isinstance(item, dict)
    )
    recent_invoice_count = sum(
        _to_non_negative_int(item.get("invoice_count"))
        for item in recent_rows
        if isinstance(item, dict)
    )

    if previous_revenue <= 0 and recent_revenue <= 0:
        return None

    if previous_revenue > 0:
        change_percent = ((recent_revenue - previous_revenue) / previous_revenue) * Decimal("100")
    else:
        change_percent = Decimal("100")

    return {
        "previous_revenue": _to_money(previous_revenue),
        "recent_revenue": _to_money(recent_revenue),
        "previous_invoice_count": previous_invoice_count,
        "recent_invoice_count": recent_invoice_count,
        "change_percent": float(change_percent.quantize(PERCENT_QUANT, rounding=ROUND_HALF_UP)),
    }


def _build_dashboard_revenue_signal(rows: list[dict[str, Any]]) -> dict[str, Any]:
    delta = _compute_dashboard_revenue_delta(rows)
    if delta is None:
        return {
            "trend": "flat",
            "change_percent": 0.0,
            "recent_7d_net_revenue": 0,
            "previous_7d_net_revenue": 0,
            "recent_7d_invoice_count": 0,
            "previous_7d_invoice_count": 0,
        }

    change_percent = float(delta["change_percent"])
    if change_percent >= 8:
        trend = "up"
    elif change_percent <= -8:
        trend = "down"
    else:
        trend = "flat"

    return {
        "trend": trend,
        "change_percent": change_percent,
        "recent_7d_net_revenue": delta["recent_revenue"],
        "previous_7d_net_revenue": delta["previous_revenue"],
        "recent_7d_invoice_count": delta["recent_invoice_count"],
        "previous_7d_invoice_count": delta["previous_invoice_count"],
    }


def _build_dashboard_restock_risk(restock_payload: dict[str, Any]) -> dict[str, Any]:
    total_actionable = _to_non_negative_int(restock_payload.get("total_actionable"))
    critical_count = _to_non_negative_int(restock_payload.get("critical_count"))
    high_count = _to_non_negative_int(restock_payload.get("high_count"))
    items = restock_payload.get("items") if isinstance(restock_payload.get("items"), list) else []
    prioritized_items = [
        {
            "drug_code": str(item.get("drug_code") or "").strip(),
            "drug_name": str(item.get("drug_name") or "").strip(),
            "current_qty": _to_non_negative_int(item.get("current_qty")),
            "suggested_qty": _to_non_negative_int(item.get("suggested_qty")),
            "sold_qty_window": _to_non_negative_int(item.get("sold_qty_window")),
            "avg_daily_sold": _to_float(item.get("avg_daily_sold")),
            "days_cover": item.get("days_cover"),
            "urgency": str(item.get("urgency") or "").strip().lower(),
        }
        for item in items[:3]
        if isinstance(item, dict)
    ]
    return {
        "total_actionable": total_actionable,
        "critical_count": critical_count,
        "high_count": high_count,
        "priority_item_count": len(prioritized_items),
        "prioritized_items": prioritized_items,
    }


def _build_dashboard_inventory_pressure(inventory_health: dict[str, Any]) -> dict[str, Any]:
    total_items = _to_non_negative_int(inventory_health.get("total_items"))
    risky_item_count = sum(
        _to_non_negative_int(inventory_health.get(key))
        for key in ("out_of_stock", "low_stock", "expiring_soon", "expired")
    )
    at_risk_rate = round((risky_item_count / total_items) * 100, 2) if total_items > 0 else 0.0
    return {
        "total_items": total_items,
        "risky_item_count": risky_item_count,
        "at_risk_rate": at_risk_rate,
        "out_of_stock": _to_non_negative_int(inventory_health.get("out_of_stock")),
        "low_stock": _to_non_negative_int(inventory_health.get("low_stock")),
        "expiring_soon": _to_non_negative_int(inventory_health.get("expiring_soon")),
        "expired": _to_non_negative_int(inventory_health.get("expired")),
        "safe_rate": _to_float(inventory_health.get("safe_rate")),
    }


def _build_dashboard_debt_signal(
    *,
    customer_debt_total: Decimal,
    invoice_with_debt_count: int,
    month_net_revenue: int,
) -> dict[str, Any]:
    debt_ratio = Decimal("0")
    if month_net_revenue > 0:
        debt_ratio = (customer_debt_total / Decimal(str(month_net_revenue))) * Decimal("100")

    if customer_debt_total >= Decimal("20000000") or invoice_with_debt_count >= 20:
        level = "high"
    elif customer_debt_total >= Decimal("5000000") or invoice_with_debt_count >= 5:
        level = "medium"
    else:
        level = "low"

    return {
        "customer_debt_total": _to_money(customer_debt_total),
        "invoice_with_debt_count": invoice_with_debt_count,
        "debt_to_month_revenue_percent": float(debt_ratio.quantize(PERCENT_QUANT, rounding=ROUND_HALF_UP)),
        "risk_level": level,
    }


def _build_dashboard_top_product_signal(top_products: list[dict[str, Any]]) -> dict[str, Any]:
    lead_product = next((item for item in top_products if isinstance(item, dict)), None)
    if lead_product is None:
        return {
            "lead_product_name": "",
            "lead_product_code": "",
            "sold_base_qty": 0,
            "net_revenue": 0,
            "gross_profit": 0,
            "margin_percent": 0.0,
        }

    return {
        "lead_product_name": str(lead_product.get("product_name") or "").strip(),
        "lead_product_code": str(lead_product.get("product_code") or "").strip(),
        "sold_base_qty": _to_non_negative_int(lead_product.get("sold_base_qty")),
        "net_revenue": _to_non_negative_int(lead_product.get("net_revenue")),
        "gross_profit": _to_non_negative_int(lead_product.get("gross_profit")),
        "margin_percent": _to_float(lead_product.get("margin_percent")),
    }


def _build_dashboard_priority_actions(
    *,
    revenue_signal: dict[str, Any],
    restock_risk: dict[str, Any],
    inventory_pressure: dict[str, Any],
    debt_signal: dict[str, Any],
    top_product_signal: dict[str, Any],
) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []

    if _to_non_negative_int(restock_risk.get("critical_count")) > 0:
        actions.append(
            {
                "priority": "high",
                "title": "Xử lý nhóm thuốc sắp thiếu hàng",
                "action": (
                    f"Rà soát ngay {_to_non_negative_int(restock_risk.get('critical_count'))} mã critical và "
                    f"ưu tiên đặt lại các mã có days_cover thấp nhất trong hôm nay."
                ),
            }
        )

    if _to_non_negative_int(inventory_pressure.get("expired")) > 0 or _to_non_negative_int(inventory_pressure.get("expiring_soon")) > 0:
        actions.append(
            {
                "priority": "high" if _to_non_negative_int(inventory_pressure.get("expired")) > 0 else "medium",
                "title": "Kiểm tra nhóm hàng cận hạn",
                "action": (
                    f"Kiểm tra {_to_non_negative_int(inventory_pressure.get('expiring_soon'))} mã sắp hết hạn và "
                    f"{_to_non_negative_int(inventory_pressure.get('expired'))} mã đã hết hạn để có hướng xử lý."
                ),
            }
        )

    if str(revenue_signal.get("trend") or "") == "down":
        actions.append(
            {
                "priority": "medium",
                "title": "Rà soát nguyên nhân doanh thu giảm",
                "action": (
                    f"So sánh 7 ngày gần nhất với 7 ngày trước đó và kiểm tra ngay các mã bán chạy đang thiếu hàng "
                    f"hoặc biên lợi nhuận giảm."
                ),
            }
        )

    if str(debt_signal.get("risk_level") or "") in {"high", "medium"}:
        actions.append(
            {
                "priority": "medium",
                "title": "Theo dõi công nợ cần thu",
                "action": (
                    f"Ưu tiên đối chiếu {_to_non_negative_int(debt_signal.get('invoice_with_debt_count'))} hóa đơn còn dư nợ "
                    f"và lên kế hoạch nhắc thu trong ngày."
                ),
            }
        )

    if str(top_product_signal.get("lead_product_name") or "").strip():
        actions.append(
            {
                "priority": "low",
                "title": "Giữ ổn định nguồn hàng sản phẩm dẫn đầu",
                "action": (
                    f"Theo dõi tồn của {str(top_product_signal.get('lead_product_name') or '').strip()} để tránh thiếu hàng "
                    f"khi nhu cầu tiếp tục tăng."
                ),
            }
        )

    return actions[:5]


def _build_dashboard_sales_patterns(trend_dataset: dict[str, Any]) -> dict[str, Any]:
    invoice_rows = trend_dataset.get("breakdowns", {}).get("invoice", [])
    
    hour_counts: dict[str, int] = defaultdict(int)
    day_revenue: dict[str, Decimal] = defaultdict(Decimal)
    
    for row in invoice_rows:
        if not isinstance(row, dict):
            continue
        created_at_str = str(row.get("created_at") or "")
        dt = _local_datetime(created_at_str)
        if not dt:
            continue
            
        hour = dt.hour
        hour_key = f"{hour:02d}:00-{hour+1:02d}:00"
        hour_counts[hour_key] += 1
        
        weekday = dt.weekday()
        weekdays = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ Nhật"]
        day_revenue[weekdays[weekday]] += _to_decimal(row.get("net_revenue"))

    sorted_hours = sorted(hour_counts.items(), key=lambda x: x[1], reverse=True)
    peak_hours = [k for k, v in sorted_hours[:2] if v > 0]
    
    sorted_days = sorted(day_revenue.items(), key=lambda x: x[1], reverse=True)
    best_selling_days = [k for k, v in sorted_days[:2] if v > 0]
    
    total_14d = sum(_to_decimal(row.get("net_revenue")) for row in invoice_rows if isinstance(row, dict))
    forecast_7d = _to_money(total_14d / Decimal("2"))
    
    return {
        "peak_hours": peak_hours,
        "best_selling_days": best_selling_days,
        "revenue_forecast_7d": forecast_7d,
    }

def _build_dashboard_inventory_insights(restock_highlights: dict[str, Any]) -> dict[str, Any]:
    items = restock_highlights.get("items") if isinstance(restock_highlights.get("items"), list) else []
    potential_stockouts = []
    dead_stock = []
    
    for item in items:
        if not isinstance(item, dict):
            continue
        avg_sold = _to_float(item.get("avg_daily_sold"))
        current_qty = _to_non_negative_int(item.get("current_qty"))
        name = str(item.get("drug_name") or item.get("drug_code") or "").strip()
        days_cover = _to_float(item.get("days_cover")) if item.get("days_cover") is not None else 0.0
        
        if avg_sold > 0 and days_cover < 3.0:
            potential_stockouts.append({
                "product_name": name,
                "current_stock": current_qty,
                "avg_sales_per_day": round(avg_sold, 1),
                "lead_time_days": 3,
            })
        elif avg_sold == 0 and current_qty > 0:
            dead_stock.append({
                "product_name": name,
                "current_stock": current_qty,
                "days_without_sales": 30,
            })
            
    potential_stockouts.sort(key=lambda x: x["current_stock"] / max(x["avg_sales_per_day"], 0.1))
    
    return {
        "potential_stockouts": potential_stockouts[:3],
        "dead_stock": dead_stock[:3],
    }


def _build_dashboard_ai_fallback(payload: dict[str, Any]) -> dict[str, Any]:
    facts = payload.get("facts") if isinstance(payload.get("facts"), dict) else {}
    restock = facts.get("restock") if isinstance(facts.get("restock"), dict) else {}
    inventory = facts.get("inventory_health") if isinstance(facts.get("inventory_health"), dict) else {}
    debt = facts.get("debt_summary") if isinstance(facts.get("debt_summary"), dict) else {}
    month = facts.get("month_kpis") if isinstance(facts.get("month_kpis"), dict) else {}
    revenue_signal = facts.get("revenue_signal_14d") if isinstance(facts.get("revenue_signal_14d"), dict) else {}
    restock_risk = facts.get("restock_risk") if isinstance(facts.get("restock_risk"), dict) else {}
    inventory_pressure = facts.get("inventory_pressure") if isinstance(facts.get("inventory_pressure"), dict) else {}
    debt_signal = facts.get("debt_signal") if isinstance(facts.get("debt_signal"), dict) else {}
    top_product_signal = facts.get("top_product_signal") if isinstance(facts.get("top_product_signal"), dict) else {}
    priority_actions = facts.get("priority_actions") if isinstance(facts.get("priority_actions"), list) else []
    trend_rows = facts.get("revenue_trend_14d") if isinstance(facts.get("revenue_trend_14d"), list) else []
    top_products = facts.get("top_products_30d") if isinstance(facts.get("top_products_30d"), list) else []

    items: list[dict[str, Any]] = []

    total_actionable = _to_non_negative_int(restock.get("total_actionable"))
    critical_count = _to_non_negative_int(restock.get("critical_count"))
    high_count = _to_non_negative_int(restock.get("high_count"))
    lead_restock = next(
        (item for item in restock.get("items", []) if isinstance(item, dict)),
        None,
    )
    if total_actionable > 0:
        lead_name = str((lead_restock or {}).get("drug_name") or (lead_restock or {}).get("drug_code") or "").strip()
        days_cover = (lead_restock or {}).get("days_cover")
        suffix = ""
        if lead_name:
            suffix = f" Mặt hàng cần ưu tiên là {lead_name}"
            try:
                suffix += f", còn khoảng {_format_ai_insight_number(days_cover, 1)} ngày phủ hàng."
            except Exception:
                suffix += "."

        items.append(
            {
                "title": "Cần ưu tiên kế hoạch nhập hàng",
                "summary": (
                    f"Hiện có {_format_ai_insight_number(total_actionable)} mặt hàng cần hành động, "
                    f"gồm {_format_ai_insight_number(critical_count)} mức critical và "
                    f"{_format_ai_insight_number(high_count)} mức high.{suffix}"
                ),
                "why_it_matters": (
                    f"Có {_format_ai_insight_number(critical_count)} mã critical và "
                    f"{_format_ai_insight_number(high_count)} mã high, nên nguy cơ hụt doanh thu trong ngày là rõ ràng."
                ),
                "recommended_action": (
                    f"Ưu tiên kiểm tra tồn thực tế và chốt đơn nhập cho {lead_name or 'nhóm thuốc nguy cơ cao'} trong hôm nay."
                ),
                "severity": "high" if critical_count > 0 else "medium" if high_count > 0 else "low",
                "confidence": 0.96,
                "source_refs": ["restock", "restock_risk"],
            }
        )

    out_of_stock = _to_non_negative_int(inventory.get("out_of_stock"))
    low_stock = _to_non_negative_int(inventory.get("low_stock"))
    expiring_soon = _to_non_negative_int(inventory.get("expiring_soon"))
    expired = _to_non_negative_int(inventory.get("expired"))
    if out_of_stock > 0 or low_stock > 0 or expiring_soon > 0 or expired > 0:
        items.append(
            {
                "title": "Sức khỏe tồn kho cần được theo dõi sát",
                "summary": (
                    f"Kho hiện có {_format_ai_insight_number(out_of_stock)} mặt hàng hết hàng, "
                    f"{_format_ai_insight_number(low_stock)} mặt hàng tồn thấp, "
                    f"{_format_ai_insight_number(expiring_soon)} mặt hàng sắp hết hạn và "
                    f"{_format_ai_insight_number(expired)} mặt hàng đã hết hạn."
                ),
                "why_it_matters": (
                    f"Tổng cộng {_format_ai_insight_number(inventory_pressure.get('risky_item_count'))} mã đang ở trạng thái rủi ro, "
                    "làm tăng khả năng mất hàng bán được hoặc phát sinh hủy hàng cận hạn."
                ),
                "recommended_action": (
                    "Ưu tiên kiểm kê nhóm hết hàng và cận hạn, sau đó tách riêng các mã cần xả hàng hoặc dừng nhập."
                ),
                "severity": "high" if expired > 0 or out_of_stock >= 10 else "medium",
                "confidence": 0.94,
                "source_refs": ["inventory_health", "inventory_pressure"],
            }
        )

    revenue_delta = _compute_dashboard_revenue_delta([item for item in trend_rows if isinstance(item, dict)])
    if revenue_delta is not None and abs(revenue_delta["change_percent"]) >= 8:
        direction = "tăng" if revenue_delta["change_percent"] >= 0 else "giảm"
        items.append(
            {
                "title": f"Doanh thu 14 ngày gần đây đang {direction}",
                "summary": (
                    f"Doanh thu 7 ngày gần nhất {direction} "
                    f"{_format_ai_insight_number(abs(revenue_delta['change_percent']), 1)}% "
                    f"so với 7 ngày trước đó, với "
                    f"{_format_ai_insight_number(revenue_delta['recent_invoice_count'])} hóa đơn trong giai đoạn gần nhất."
                ),
                "why_it_matters": (
                    f"Nhịp bán hiện tại đang lệch khỏi xu hướng gần đây, với "
                    f"{_format_ai_insight_number(revenue_signal.get('recent_7d_invoice_count'))} hóa đơn ở 7 ngày gần nhất."
                ),
                "recommended_action": (
                    "Đối chiếu ngay nhóm sản phẩm bán chạy, tình trạng thiếu hàng và các thay đổi khuyến mãi để tìm nguyên nhân chính."
                ),
                "severity": "high" if revenue_delta["change_percent"] <= -15 else "medium",
                "confidence": 0.88,
                "source_refs": ["revenue_trend_14d", "revenue_signal_14d"],
            }
        )

    customer_debt_total = _to_decimal(debt.get("customer_debt_total"))
    invoice_with_debt_count = _to_non_negative_int(debt.get("invoice_with_debt_count"))
    if customer_debt_total > 0:
        items.append(
            {
                "title": "Cần theo dõi công nợ khách hàng",
                "summary": (
                    f"Công nợ hiện tại là {_format_ai_insight_number(customer_debt_total)} VND trên "
                    f"{_format_ai_insight_number(invoice_with_debt_count)} hóa đơn còn dư nợ."
                ),
                "why_it_matters": (
                    f"Tỷ trọng công nợ hiện ở mức {_format_ai_insight_number(debt_signal.get('debt_to_month_revenue_percent'), 1)}% "
                    "so với doanh thu tháng, có thể gây áp lực dòng tiền."
                ),
                "recommended_action": (
                    "Lập danh sách các hóa đơn dư nợ lớn và ưu tiên nhắc thu hoặc chốt lịch thanh toán trong ngày."
                ),
                "severity": "medium" if customer_debt_total >= Decimal("10000000") else "low",
                "confidence": 0.91,
                "source_refs": ["debt_summary", "debt_signal"],
            }
        )

    lead_product = next((item for item in top_products if isinstance(item, dict)), None)
    if lead_product is not None:
        product_name = str(lead_product.get("product_name") or lead_product.get("product_code") or "").strip()
        if product_name:
            items.append(
                {
                    "title": "Sản phẩm dẫn đầu cần được duy trì nguồn hàng",
                    "summary": (
                        f"{product_name} đang dẫn đầu 30 ngày gần đây với "
                        f"{_format_ai_insight_number(lead_product.get('sold_base_qty'))} đơn vị bán ra và "
                        f"doanh thu {_format_ai_insight_number(lead_product.get('net_revenue'))} VND."
                    ),
                    "why_it_matters": "Nếu mã này bị thiếu hàng, doanh thu từ nhóm bán nhanh sẽ bị ảnh hưởng ngay.",
                    "recommended_action": (
                        f"Theo dõi tồn thực tế của {product_name} và giữ mức tồn an toàn cao hơn nhóm còn lại."
                    ),
                    "severity": "low",
                    "confidence": 0.84,
                    "source_refs": ["top_products_30d", "top_product_signal"],
                }
            )

    lead_action = next((item for item in priority_actions if isinstance(item, dict)), None)
    if lead_action is not None:
        raw_priority = str(lead_action.get("priority") or "").strip().lower()
        items.append(
            {
                "title": str(lead_action.get("title") or "Hành động ưu tiên hôm nay").strip() or "Hành động ưu tiên hôm nay",
                "summary": str(lead_action.get("action") or "").strip() or "Cần một hành động xử lý trong ngày.",
                "why_it_matters": "Đây là hành động ưu tiên được tổng hợp từ các tín hiệu rủi ro hiện tại trên dashboard.",
                "recommended_action": str(lead_action.get("action") or "").strip() or "Thực hiện hành động ưu tiên trong ngày.",
                "severity": raw_priority if raw_priority in AI_DASHBOARD_ALLOWED_SEVERITIES else "medium",
                "confidence": 0.83,
                "source_refs": ["priority_actions"],
            }
        )

    if not items:
        items.append(
            {
                "title": "Chưa phát hiện biến động lớn trên dashboard",
                "summary": (
                    f"Tháng hiện tại ghi nhận {_format_ai_insight_number(month.get('invoice_count'))} hóa đơn với "
                    f"doanh thu {_format_ai_insight_number(month.get('net_revenue'))} VND và "
                    f"lợi nhuận gộp {_format_ai_insight_number(month.get('gross_profit'))} VND."
                ),
                "why_it_matters": "Chưa có tín hiệu rủi ro nổi bật vượt ngưỡng cần cảnh báo ở snapshot hiện tại.",
                "recommended_action": "Tiếp tục theo dõi lịch phân tích tự động và kiểm tra lại khi có biến động mới.",
                "severity": "low",
                "confidence": 0.8,
                "source_refs": ["month_kpis", "today_kpis"],
            }
        )

    return {
        "model": "report-service:fallback",
        "items": items[:AI_DASHBOARD_MAX_ITEMS],
    }


async def _build_dashboard_ai_payload(authorization: str, slot_at: datetime) -> dict[str, Any]:
    as_of = slot_at.date()
    today_from = as_of
    month_from = as_of.replace(day=1)
    trend_from = as_of - timedelta(days=13)
    top_products_from = as_of - timedelta(days=29)

    today_dataset, month_dataset, trend_dataset, top_products_dataset, stock_summary, restock_highlights = await asyncio.gather(
        _load_profit_dataset(authorization, today_from, as_of),
        _load_profit_dataset(authorization, month_from, as_of),
        _load_profit_dataset(authorization, trend_from, as_of),
        _load_profit_dataset(authorization, top_products_from, as_of),
        _fetch_stock_summary(authorization),
        _load_restock_highlights(authorization, 5),
    )

    month_invoice_rows = month_dataset.get("breakdowns", {}).get("invoice", [])
    customer_debt_total = sum(
        _to_decimal(item.get("debt_amount"))
        for item in month_invoice_rows
        if isinstance(item, dict)
    )

    top_products_rows = [
        {
            "product_code": str(item.get("product_code") or "").strip(),
            "product_name": str(item.get("product_name") or "").strip(),
            "sold_base_qty": _to_non_negative_int(item.get("sold_base_qty")),
            "net_revenue": _to_money(_to_decimal(item.get("net_revenue"))),
            "gross_profit": _to_money(_to_decimal(item.get("gross_profit"))),
            "margin_percent": _to_percent(_to_decimal(item.get("margin_percent"))),
        }
        for item in top_products_dataset.get("top_products", [])[:5]
        if isinstance(item, dict)
    ]

    restock_items = [
        {
            "drug_code": str(item.get("drug_code") or "").strip(),
            "drug_name": str(item.get("drug_name") or "").strip(),
            "current_qty": _to_non_negative_int(item.get("current_qty")),
            "suggested_qty": _to_non_negative_int(item.get("suggested_qty")),
            "sold_qty_window": _to_non_negative_int(item.get("sold_qty_window")),
            "avg_daily_sold": _to_float(item.get("avg_daily_sold")),
            "days_cover": item.get("days_cover"),
            "urgency": str(item.get("urgency") or "").strip(),
        }
        for item in restock_highlights.get("items", [])[:5]
        if isinstance(item, dict)
    ]

    inventory_health = _build_inventory_health(stock_summary)
    restock_payload = {
        "total_actionable": _to_non_negative_int(restock_highlights.get("total_actionable")),
        "critical_count": _to_non_negative_int(restock_highlights.get("critical_count")),
        "high_count": _to_non_negative_int(restock_highlights.get("high_count")),
        "items": restock_items,
    }
    debt_invoice_count = sum(
        1
        for item in month_invoice_rows
        if isinstance(item, dict) and _to_decimal(item.get("debt_amount")) > 0
    )
    revenue_signal = _build_dashboard_revenue_signal(_build_revenue_trend_rows(trend_dataset, date_from=trend_from, date_to=as_of))
    restock_risk = _build_dashboard_restock_risk(restock_payload)
    inventory_pressure = _build_dashboard_inventory_pressure(inventory_health)
    debt_signal = _build_dashboard_debt_signal(
        customer_debt_total=customer_debt_total,
        invoice_with_debt_count=debt_invoice_count,
        month_net_revenue=_to_money(_to_decimal(month_dataset.get("summary", {}).get("net_revenue"))),
    )
    top_product_signal = _build_dashboard_top_product_signal(top_products_rows)
    priority_actions = _build_dashboard_priority_actions(
        revenue_signal=revenue_signal,
        restock_risk=restock_risk,
        inventory_pressure=inventory_pressure,
        debt_signal=debt_signal,
        top_product_signal=top_product_signal,
    )
    sales_patterns = _build_dashboard_sales_patterns(trend_dataset)
    inventory_insights = _build_dashboard_inventory_insights(restock_highlights)

    return {
        "slot_at": slot_at.isoformat(),
        "generated_at": _now_local().isoformat(),
        "timezone": _active_report_timezone_name(),
        "facts": {
            "today_kpis": {
                "invoice_count": _to_non_negative_int(today_dataset.get("summary", {}).get("invoice_count")),
                "net_revenue": _to_money(_to_decimal(today_dataset.get("summary", {}).get("net_revenue"))),
                "gross_profit": _to_money(_to_decimal(today_dataset.get("summary", {}).get("gross_profit"))),
                "collected_profit": _to_money(_to_decimal(today_dataset.get("summary", {}).get("collected_profit"))),
            },
            "month_kpis": {
                "invoice_count": _to_non_negative_int(month_dataset.get("summary", {}).get("invoice_count")),
                "net_revenue": _to_money(_to_decimal(month_dataset.get("summary", {}).get("net_revenue"))),
                "gross_profit": _to_money(_to_decimal(month_dataset.get("summary", {}).get("gross_profit"))),
                "gross_margin_percent": _to_percent(_to_decimal(month_dataset.get("summary", {}).get("gross_margin_percent"))),
                "service_fee_total": _to_money(_to_decimal(month_dataset.get("summary", {}).get("service_fee_total"))),
            },
            "revenue_trend_14d": _build_revenue_trend_rows(trend_dataset, date_from=trend_from, date_to=as_of),
            "revenue_signal_14d": revenue_signal,
            "top_products_30d": top_products_rows,
            "top_product_signal": top_product_signal,
            "inventory_health": inventory_health,
            "inventory_pressure": inventory_pressure,
            "restock": restock_payload,
            "restock_risk": restock_risk,
            "debt_summary": {
                "customer_debt_total": _to_money(customer_debt_total),
                "invoice_with_debt_count": debt_invoice_count,
            },
            "debt_signal": debt_signal,
            "priority_actions": priority_actions,
            "sales_patterns": sales_patterns,
            "inventory_insights": inventory_insights,
        },
    }


async def _request_dashboard_ai_worker(payload: dict[str, Any]) -> dict[str, Any]:
    response = await app.state.http_client.post(
        settings.AI_WORKER_DASHBOARD_INSIGHTS_URL.strip(),
        headers={
            "Content-Type": "application/json",
            "X-Internal-AI-Key": settings.AI_WORKER_API_KEY.strip(),
        },
        json=payload,
        timeout=settings.AI_WORKER_TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        detail = None
        try:
            raw = response.json()
            if isinstance(raw, dict):
                detail = raw.get("detail") or raw.get("message") or raw.get("error")
        except Exception:
            detail = None
        raise RuntimeError(detail or f"AI worker request failed ({response.status_code})")

    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise ValueError("AI worker returned non-JSON response") from exc
    return _normalize_ai_worker_response(body)


async def _store_dashboard_ai_attempt_result(
    *,
    slot_at: datetime,
    state: str,
    snapshot: dict[str, Any] | None = None,
) -> None:
    meta_payload = {
        "last_attempt_at": _now_local().isoformat(),
        "last_attempt_slot_at": slot_at.isoformat(),
        "last_attempt_state": state,
    }
    await _set_json_value(AI_DASHBOARD_INSIGHTS_META_KEY, meta_payload)
    if snapshot is not None:
        await _set_json_value(AI_DASHBOARD_INSIGHTS_SNAPSHOT_KEY, snapshot)


async def _generate_dashboard_ai_snapshot(
    authorization: str,
    *,
    slot_at: datetime,
) -> tuple[dict[str, Any], str]:
    payload = await _build_dashboard_ai_payload(authorization, slot_at)

    try:
        ai_result = await _request_dashboard_ai_worker(payload)
        snapshot = _dashboard_ai_snapshot(
            slot_at=slot_at,
            model=ai_result["model"],
            items=ai_result["items"],
        )
        await _store_dashboard_ai_attempt_result(slot_at=slot_at, state="success", snapshot=snapshot)
        logger.info("AI dashboard insights refreshed for slot=%s", slot_at.isoformat())
        return snapshot, "success"
    except Exception:
        logger.exception("AI dashboard worker failed for slot=%s; storing fallback snapshot", slot_at.isoformat())
        fallback = _build_dashboard_ai_fallback(payload)
        snapshot = _dashboard_ai_snapshot(
            slot_at=slot_at,
            model=fallback["model"],
            items=fallback["items"],
        )
        await _store_dashboard_ai_attempt_result(slot_at=slot_at, state="fallback", snapshot=snapshot)
        return snapshot, "fallback"


async def _run_dashboard_ai_for_slot(slot_at: datetime, authorization: str) -> None:
    marker_key = _slot_marker_key(slot_at)
    if await app.state.redis.exists(marker_key):
        return

    lock_key = _slot_lock_key(slot_at)
    acquired = await app.state.redis.set(lock_key, "1", ex=AI_SLOT_LOCK_TTL_SECONDS, nx=True)
    if not acquired:
        return

    refresh_lock_acquired = await app.state.redis.set(
        AI_DASHBOARD_INSIGHTS_REFRESH_LOCK_KEY,
        "1",
        ex=AI_REFRESH_LOCK_TTL_SECONDS,
        nx=True,
    )
    if not refresh_lock_acquired:
        await app.state.redis.delete(lock_key)
        return

    attempt_state = "failed"
    should_mark_slot = True
    try:
        if await app.state.redis.exists(marker_key):
            should_mark_slot = False
            return

        _, attempt_state = await _generate_dashboard_ai_snapshot(authorization, slot_at=slot_at)
    except Exception:
        logger.exception("AI dashboard insight generation failed for slot=%s", slot_at.isoformat())
        await _store_dashboard_ai_attempt_result(slot_at=slot_at, state="failed")
    finally:
        if should_mark_slot:
            await app.state.redis.set(marker_key, attempt_state, ex=AI_SLOT_MARKER_TTL_SECONDS)
        await app.state.redis.delete(AI_DASHBOARD_INSIGHTS_REFRESH_LOCK_KEY)
        await app.state.redis.delete(lock_key)


async def _dashboard_ai_scheduler(stop_event: asyncio.Event) -> None:
    if not _is_ai_dashboard_enabled():
        logger.info("AI dashboard insights scheduler disabled")
        return

    while not stop_event.is_set():
        try:
            authorization = _internal_authorization_header()
            timezone_info = await _refresh_report_timezone(authorization)
            now_local = datetime.now(timezone_info)

            due_slot = _latest_due_ai_slot(now_local)
            if due_slot is not None:
                await _run_dashboard_ai_for_slot(due_slot, authorization)

            next_slot = _next_ai_slot(datetime.now(_active_report_timezone()))
            wait_seconds = max(1, math.ceil((next_slot - datetime.now(_active_report_timezone())).total_seconds()))
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=wait_seconds)
            except asyncio.TimeoutError:
                continue
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("AI dashboard scheduler error")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=60)
            except asyncio.TimeoutError:
                continue


async def _load_dashboard_ai_snapshot() -> dict[str, Any]:
    if not _is_ai_dashboard_enabled():
        return _dashboard_ai_response("disabled")

    snapshot = await _fetch_dashboard_ai_snapshot()
    meta = await _fetch_dashboard_ai_meta()
    if snapshot is None:
        return _dashboard_ai_response("pending")

    status = "ready"
    last_attempt_state = str(meta.get("last_attempt_state") or "").strip().lower()
    last_attempt_slot_at = str(meta.get("last_attempt_slot_at") or "").strip()
    if last_attempt_state == "fallback":
        status = "stale"
    elif last_attempt_state == "failed" and last_attempt_slot_at and last_attempt_slot_at != snapshot["slot_at"]:
        status = "stale"

    return _dashboard_ai_response(
        status,
        generated_at=snapshot["generated_at"],
        slot_at=snapshot["slot_at"],
        model=snapshot["model"],
        items=snapshot["items"],
    )


async def _refresh_dashboard_ai_snapshot_now(authorization: str) -> dict[str, Any]:
    if not _is_ai_dashboard_enabled():
        return _dashboard_ai_response("disabled")

    acquired = await app.state.redis.set(
        AI_DASHBOARD_INSIGHTS_REFRESH_LOCK_KEY,
        "1",
        ex=AI_REFRESH_LOCK_TTL_SECONDS,
        nx=True,
    )
    if not acquired:
        raise HTTPException(status_code=409, detail="AI Insight đang được phân tích. Vui lòng thử lại sau ít phút.")

    try:
        await _refresh_report_timezone(authorization)
        slot_at = _now_local().replace(microsecond=0)
        snapshot, attempt_state = await _generate_dashboard_ai_snapshot(authorization, slot_at=slot_at)
        return _dashboard_ai_response(
            "ready" if attempt_state == "success" else "stale",
            generated_at=snapshot["generated_at"],
            slot_at=snapshot["slot_at"],
            model=snapshot["model"],
            items=snapshot["items"],
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Manual AI dashboard insight refresh failed")
        raise HTTPException(status_code=503, detail="Không thể phân tích AI Insight lúc này.") from exc
    finally:
        await app.state.redis.delete(AI_DASHBOARD_INSIGHTS_REFRESH_LOCK_KEY)


def _build_restock_highlights(
    invoices: list[dict[str, Any]],
    stock_summary: list[dict[str, Any]],
    *,
    date_from: date,
    date_to: date,
    sales_window_days: int,
    target_cover_days: int,
    limit: int,
) -> dict[str, Any]:
    sold_qty_by_drug: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))

    for invoice in invoices:
        created_at = str(invoice.get("created_at") or "").strip()
        items = invoice.get("items") if isinstance(invoice.get("items"), list) else []
        if not created_at or not items:
            continue
        if not _in_local_date_range(created_at, date_from, date_to):
            continue

        for item in items:
            if not isinstance(item, dict):
                continue

            drug_id = str(item.get("product_id") or "").strip()
            if not drug_id:
                continue

            quantity = _to_non_negative_int(item.get("quantity"))
            returned_quantity = _to_non_negative_int(item.get("returned_quantity"))
            returned_quantity = min(quantity, returned_quantity)
            conversion_rate = max(1, _to_non_negative_int(item.get("conversion_rate"), 1))
            sold_base_qty = max(0, quantity - returned_quantity) * conversion_rate
            if sold_base_qty <= 0:
                continue

            sold_qty_by_drug[drug_id] += Decimal(sold_base_qty)

    urgency_order = {"critical": 0, "high": 1, "normal": 2}
    target_cover_days_decimal = Decimal(target_cover_days)
    sales_window_days_decimal = Decimal(sales_window_days)

    actionable_rows: list[dict[str, Any]] = []
    critical_count = 0
    high_count = 0

    for row in stock_summary:
        drug_id = str(row.get("drug_id") or "").strip()
        if not drug_id:
            continue

        current_qty = _to_non_negative_int(row.get("total_qty"))
        reorder_level = _to_non_negative_int(row.get("reorder_level"))
        sold_qty_window = sold_qty_by_drug.get(drug_id, Decimal("0"))
        avg_daily_sold = sold_qty_window / sales_window_days_decimal if sales_window_days > 0 else Decimal("0")
        target_by_sales = int(
            (avg_daily_sold * target_cover_days_decimal).to_integral_value(rounding=ROUND_CEILING)
        )
        target_qty = max(reorder_level, target_by_sales)
        suggested_qty = max(0, target_qty - current_qty)
        if suggested_qty <= 0:
            continue

        days_cover: float | None = None
        if avg_daily_sold > 0:
            days_cover = _to_days(Decimal(current_qty) / avg_daily_sold)

        urgency = "normal"
        if current_qty <= 0 or (days_cover is not None and days_cover <= 3):
            urgency = "critical"
            critical_count += 1
        elif current_qty < reorder_level or (days_cover is not None and days_cover <= 7):
            urgency = "high"
            high_count += 1

        actionable_rows.append(
            {
                "drug_id": drug_id,
                "drug_code": str(row.get("drug_code") or "").strip(),
                "drug_name": str(row.get("drug_name") or "").strip(),
                "base_unit": str(row.get("base_unit") or "").strip(),
                "current_qty": current_qty,
                "reorder_level": reorder_level,
                "sold_qty_window": int(sold_qty_window),
                "avg_daily_sold": _to_rate(avg_daily_sold),
                "target_qty": target_qty,
                "suggested_qty": suggested_qty,
                "days_cover": days_cover,
                "stock_status": str(row.get("status") or "").strip(),
                "urgency": urgency,
            }
        )

    actionable_rows.sort(
        key=lambda item: (
            urgency_order.get(str(item.get("urgency") or "normal"), 99),
            -_to_non_negative_int(item.get("suggested_qty")),
            -_to_rate(_to_decimal(item.get("avg_daily_sold"))),
            str(item.get("drug_name") or ""),
        )
    )

    generated_at = _now_local().isoformat()
    return {
        "generated_at": generated_at,
        "sales_window_days": sales_window_days,
        "target_cover_days": target_cover_days,
        "total_actionable": len(actionable_rows),
        "critical_count": critical_count,
        "high_count": high_count,
        "items": actionable_rows[:limit],
    }


async def _load_profit_dataset(
    authorization: str,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, Any]:
    cache_key = _cache_key(
        "report:profit:dataset:v2",
        {
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
            "timezone": _active_report_timezone_name(),
        },
    )
    cached = await _get_cached_json(cache_key)
    if isinstance(cached, dict):
        return cached

    invoices = await _fetch_profit_source_invoices(authorization, date_from, date_to)
    batch_ids = [
        str(item.get("batch_id") or "").strip()
        for invoice in invoices
        for item in (invoice.get("items") if isinstance(invoice.get("items"), list) else [])
        if isinstance(item, dict)
    ]
    batch_costs_task = _fetch_batch_costs(authorization, batch_ids)
    expense_summary_task = _fetch_expense_summary(authorization, date_from, date_to)
    batch_costs, expense_summary = await asyncio.gather(batch_costs_task, expense_summary_task)

    dataset = _build_profit_dataset(invoices, batch_costs, date_from, date_to)

    # Enrich with operating expenses and net profit
    expense_items = expense_summary.get("items") if isinstance(expense_summary.get("items"), list) else []
    operating_expenses_total = Decimal(str(expense_summary.get("grand_total") or 0))
    gross_profit = _to_decimal(dataset["summary"]["gross_profit"])
    net_profit = gross_profit - operating_expenses_total
    net_revenue = _to_decimal(dataset["summary"]["net_revenue"])
    net_margin_percent = Decimal("0")
    if net_revenue > 0:
        net_margin_percent = (net_profit / net_revenue) * Decimal("100")

    dataset["summary"]["operating_expenses"] = _to_money(operating_expenses_total)
    dataset["summary"]["net_profit"] = _to_money(net_profit)
    dataset["summary"]["net_margin_percent"] = _to_percent(net_margin_percent)
    dataset["summary"]["expense_breakdown"] = [
        {
            "category": str(item.get("category") or ""),
            "total_amount": _to_money(_to_decimal(item.get("total_amount"))),
            "count": int(item.get("count") or 0),
        }
        for item in expense_items
        if isinstance(item, dict)
    ]

    await _set_cached_json(cache_key, dataset, settings.REPORT_CACHE_TTL_SECONDS)
    return dataset


async def _load_restock_highlights(
    authorization: str,
    limit: int,
) -> dict[str, Any]:
    inventory_settings = await _fetch_inventory_settings(authorization)
    sales_window_days = _to_int_with_minimum(
        inventory_settings.get("inventory.restock_sales_window_days"),
        default=DEFAULT_RESTOCK_SALES_WINDOW_DAYS,
        minimum=7,
    )
    target_cover_days = _to_int_with_minimum(
        inventory_settings.get("inventory.restock_target_cover_days"),
        default=DEFAULT_RESTOCK_TARGET_COVER_DAYS,
        minimum=1,
    )
    as_of = _now_local().date()

    cache_key = _cache_key(
        "report:restock:highlights",
        {
            "limit": limit,
            "sales_window_days": sales_window_days,
            "target_cover_days": target_cover_days,
            "as_of": as_of.isoformat(),
            "timezone": _active_report_timezone_name(),
        },
    )
    cached = await _get_cached_json(cache_key)
    if isinstance(cached, dict):
        return cached

    date_from = as_of - timedelta(days=max(0, sales_window_days - 1))
    invoices, stock_summary = await asyncio.gather(
        _fetch_profit_source_invoices(authorization, date_from, as_of),
        _fetch_stock_summary(authorization),
    )
    dataset = _build_restock_highlights(
        invoices,
        stock_summary,
        date_from=date_from,
        date_to=as_of,
        sales_window_days=sales_window_days,
        target_cover_days=target_cover_days,
        limit=limit,
    )
    await _set_cached_json(cache_key, dataset, settings.REPORT_CACHE_TTL_SECONDS)
    return dataset


async def _is_duplicate_event(event_id: str) -> bool:
    added = await app.state.redis.sadd(_EVENTS_DEDUP_KEY, event_id)
    if int(added) == 0:
        return True
    await app.state.redis.expire(_EVENTS_DEDUP_KEY, settings.REPORT_EVENT_DEDUP_TTL_SECONDS)
    return False


async def _apply_sale_event(envelope: dict[str, Any]) -> None:
    event_id = str(envelope.get("event_id") or "").strip()
    if event_id and await _is_duplicate_event(event_id):
        return

    event_type = str(envelope.get("event_type") or "").strip()
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    pipe = app.state.redis.pipeline()

    if event_type == "sale.invoice.created":
        total_amount = _to_float(payload.get("total_amount"))
        pipe.hincrbyfloat(_SUMMARY_KEY, "total_revenue", total_amount)
        pipe.hincrby(_SUMMARY_KEY, "total_sales", 1)
        pipe.lpush(_EVENTS_KEY, json.dumps(payload, ensure_ascii=False, default=str))
        pipe.ltrim(_EVENTS_KEY, 0, _MAX_EVENTS - 1)
    elif event_type == "sale.invoice.cancelled":
        total_amount = _to_float(payload.get("total_amount"))
        pipe.hincrby(_SUMMARY_KEY, "total_cancelled", 1)
        pipe.hincrbyfloat(_SUMMARY_KEY, "cancelled_amount", total_amount)
    elif event_type == "sale.return.approved":
        return_amount = _to_float(payload.get("total_return_amount"))
        pipe.hincrbyfloat(_SUMMARY_KEY, "total_returns", return_amount)

    await pipe.execute()


async def consume_sale_events_rabbitmq() -> None:
    if not settings.RABBITMQ_ENABLED:
        logger.info("RabbitMQ consumer disabled")
        return

    keys = _routing_keys()
    if not keys:
        logger.warning("RabbitMQ consumer has no routing keys configured")
        return

    while True:
        connection: aio_pika.abc.AbstractRobustConnection | None = None
        channel: aio_pika.abc.AbstractChannel | None = None

        try:
            connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=100)

            exchange = await channel.declare_exchange(
                settings.RABBITMQ_EXCHANGE,
                aio_pika.ExchangeType.TOPIC,
                durable=True,
            )
            queue = await channel.declare_queue(settings.RABBITMQ_QUEUE, durable=True)

            for key in keys:
                await queue.bind(exchange, routing_key=key)

            logger.info(
                "RabbitMQ consumer connected exchange=%s queue=%s keys=%s",
                settings.RABBITMQ_EXCHANGE,
                settings.RABBITMQ_QUEUE,
                ",".join(keys),
            )

            async with queue.iterator() as iterator:
                async for message in iterator:
                    async with message.process(requeue=True):
                        try:
                            envelope = json.loads(message.body.decode("utf-8"))
                        except Exception:
                            logger.warning("Skip malformed event payload")
                            continue
                        if not isinstance(envelope, dict):
                            logger.warning("Skip non-object event payload")
                            continue
                        await _apply_sale_event(envelope)

        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("RabbitMQ consumer error, retrying...")
            await asyncio.sleep(2)
        finally:
            if channel is not None:
                await channel.close()
            if connection is not None:
                await connection.close()


@app.on_event("startup")
async def startup_event() -> None:
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.http_client = httpx.AsyncClient(timeout=45.0)
    app.state.report_timezone = REPORT_TIMEZONE
    app.state.report_timezone_name = REPORT_TIMEZONE.key
    app.state.ai_scheduler_stop = asyncio.Event()
    app.state.consumer_task = asyncio.create_task(consume_sale_events_rabbitmq())
    app.state.ai_scheduler_task = (
        asyncio.create_task(_dashboard_ai_scheduler(app.state.ai_scheduler_stop))
        if _is_ai_dashboard_enabled()
        else None
    )


@app.on_event("shutdown")
async def shutdown_event() -> None:
    app.state.consumer_task.cancel()
    ai_scheduler_task = getattr(app.state, "ai_scheduler_task", None)
    if ai_scheduler_task is not None:
        app.state.ai_scheduler_stop.set()
        ai_scheduler_task.cancel()
        await asyncio.gather(app.state.consumer_task, ai_scheduler_task, return_exceptions=True)
    else:
        await asyncio.gather(app.state.consumer_task, return_exceptions=True)
    await app.state.http_client.aclose()
    await app.state.redis.aclose()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"service": "report", "status": "ok"}


@app.get("/api/v1/report/summary")
async def summary() -> dict[str, float | int]:
    saved = await app.state.redis.hgetall(_SUMMARY_KEY)
    return {
        "total_sales": int(saved.get("total_sales", 0)),
        "total_revenue": round(float(saved.get("total_revenue", 0.0)), 2),
        "total_returns": round(float(saved.get("total_returns", 0.0)), 2),
        "total_cancelled": int(saved.get("total_cancelled", 0)),
    }


@app.get("/api/v1/report/events")
async def events() -> list[dict[str, object]]:
    raw_events = await app.state.redis.lrange(_EVENTS_KEY, 0, _MAX_EVENTS - 1)
    return [json.loads(event) for event in raw_events]


@app.get("/api/v1/report/profit/summary")
async def profit_summary(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    token = _require_authorization(authorization)
    await _refresh_report_timezone(token)
    dataset = await _load_profit_dataset(
        token,
        _parse_optional_date(date_from, "date_from"),
        _parse_optional_date(date_to, "date_to"),
    )
    return dataset["summary"]


@app.get("/api/v1/report/profit/breakdown")
async def profit_breakdown(
    group_by: str = Query(default="invoice"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    token = _require_authorization(authorization)
    await _refresh_report_timezone(token)
    group_key = group_by.strip().lower()
    if group_key not in {"invoice", "day", "week", "month", "product"}:
        raise HTTPException(status_code=400, detail="group_by must be invoice, day, week, month or product")
    dataset = await _load_profit_dataset(
        token,
        _parse_optional_date(date_from, "date_from"),
        _parse_optional_date(date_to, "date_to"),
    )
    return _paginate_rows(list(dataset["breakdowns"][group_key]), page, size)


@app.get("/api/v1/report/profit/top-products")
async def profit_top_products(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=100),
    authorization: str | None = Header(default=None),
) -> list[dict[str, Any]]:
    token = _require_authorization(authorization)
    await _refresh_report_timezone(token)
    dataset = await _load_profit_dataset(
        token,
        _parse_optional_date(date_from, "date_from"),
        _parse_optional_date(date_to, "date_to"),
    )
    return list(dataset["top_products"][:limit])


@app.get("/api/v1/report/restock/highlights")
async def restock_highlights(
    limit: int = Query(default=8, ge=1, le=20),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    token = _require_authorization(authorization)
    await _refresh_report_timezone(token)
    return await _load_restock_highlights(token, limit)


@app.get("/api/v1/report/ai/dashboard-insights")
async def ai_dashboard_insights(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authorization(authorization)
    return await _load_dashboard_ai_snapshot()


@app.post("/api/v1/report/ai/dashboard-insights/refresh")
async def refresh_ai_dashboard_insights(
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    token = _require_authorization(authorization)
    return await _refresh_dashboard_ai_snapshot_now(token)
