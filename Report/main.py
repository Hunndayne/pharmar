import asyncio
import json
import logging
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any
from zoneinfo import ZoneInfo

import aio_pika
import httpx
from fastapi import FastAPI, Header, HTTPException, Query
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis


logger = logging.getLogger("report.events")

MONEY_QUANT = Decimal("0.01")
RATIO_QUANT = Decimal("0.0001")


class Settings(BaseSettings):
    APP_NAME: str = "Report Service"
    APP_PORT: int = 8004

    REDIS_URL: str = "redis://redis:6379/0"
    SALE_SERVICE_URL: str = "http://sale-service:8003"
    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    REPORT_CACHE_TTL_SECONDS: int = 120

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


def _to_money(value: Decimal | float | int) -> float:
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return float(amount.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP))


def _to_percent(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


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
    return parsed.astimezone(REPORT_TIMEZONE)


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


async def _load_profit_dataset(
    authorization: str,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, Any]:
    cache_key = _cache_key(
        "report:profit:dataset",
        {
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
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
    batch_costs = await _fetch_batch_costs(authorization, batch_ids)
    dataset = _build_profit_dataset(invoices, batch_costs, date_from, date_to)
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
    app.state.consumer_task = asyncio.create_task(consume_sale_events_rabbitmq())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    app.state.consumer_task.cancel()
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
    dataset = await _load_profit_dataset(
        token,
        _parse_optional_date(date_from, "date_from"),
        _parse_optional_date(date_to, "date_to"),
    )
    return list(dataset["top_products"][:limit])
