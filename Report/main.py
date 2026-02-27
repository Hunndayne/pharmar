import asyncio
import json
import logging
from typing import Any

import aio_pika
from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis


logger = logging.getLogger("report.events")


class Settings(BaseSettings):
    APP_NAME: str = "Report Service"
    APP_PORT: int = 8004

    REDIS_URL: str = "redis://redis:6379/0"

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
app = FastAPI(title=settings.APP_NAME, version="0.1.0")

_SUMMARY_KEY = "report:summary"
_EVENTS_KEY = "report:events"
_EVENTS_DEDUP_KEY = "report:events:dedup"
_MAX_EVENTS = 100


def _to_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _routing_keys() -> list[str]:
    keys = [item.strip() for item in settings.RABBITMQ_ROUTING_KEYS.split(",")]
    return [item for item in keys if item]


async def _is_duplicate_event(event_id: str) -> bool:
    added = await app.state.redis.sadd(_EVENTS_DEDUP_KEY, event_id)
    if int(added) == 0:
        return True
    await app.state.redis.expire(_EVENTS_DEDUP_KEY, settings.REPORT_EVENT_DEDUP_TTL_SECONDS)
    return False


async def _apply_sale_event(envelope: dict[str, Any]) -> None:
    event_id = str(envelope.get("event_id") or "").strip()
    if event_id:
        if await _is_duplicate_event(event_id):
            return

    event_type = str(envelope.get("event_type") or "").strip()
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}

    pipe = app.state.redis.pipeline()

    # Keep endpoint compatibility: /report/events continues to expose invoice-created rows.
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
    app.state.consumer_task = asyncio.create_task(consume_sale_events_rabbitmq())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    app.state.consumer_task.cancel()
    await asyncio.gather(app.state.consumer_task, return_exceptions=True)
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
    return [json.loads(e) for e in raw_events]
