import asyncio
import json
import logging

import aio_pika

from .core.config import get_settings
from .db.models import AlertRule, Notification
from .db.session import SessionLocal

logger = logging.getLogger("notification.rabbitmq")
settings = get_settings()

# Map routing keys to notification categories
ROUTING_KEY_CATEGORY: dict[str, str] = {
    "sale.invoice.created": "sale",
    "sale.invoice.cancelled": "sale",
    "sale.return.approved": "sale",
    "inventory.low_stock": "low_stock",
}

ROUTING_KEY_TITLE: dict[str, str] = {
    "sale.invoice.created": "Hóa đơn mới",
    "sale.invoice.cancelled": "Hóa đơn đã hủy",
    "sale.return.approved": "Trả hàng được duyệt",
    "inventory.low_stock": "Cảnh báo tồn kho thấp",
}


async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    async with message.process():
        try:
            routing_key = message.routing_key or ""
            body = json.loads(message.body.decode())

            category = ROUTING_KEY_CATEGORY.get(routing_key, "system")
            title = ROUTING_KEY_TITLE.get(routing_key, f"Sự kiện: {routing_key}")

            # Build body text from event data
            body_text = body.get("message", json.dumps(body, ensure_ascii=False, default=str))

            async with SessionLocal() as db:
                # Check if alert rule exists and is active
                from sqlalchemy import select

                result = await db.execute(
                    select(AlertRule).where(AlertRule.code == category, AlertRule.is_active == True)  # noqa: E712
                )
                rule = result.scalar_one_or_none()

                # If no rule found or rule is inactive, skip
                if rule is None:
                    return

                if not rule.send_web:
                    return

                notification = Notification(
                    title=title,
                    body=body_text,
                    category=category,
                )

                if rule.send_email:
                    from .email_sender import send_email

                    sent = await send_email(db, "", title, f"<p>{body_text}</p>")
                    notification.email_sent = sent

                db.add(notification)
                await db.commit()

            logger.info("Notification created from event: %s", routing_key)

        except Exception:
            logger.exception("Failed to process message")


async def start_consumer(stop_event: asyncio.Event) -> None:
    """Connect to RabbitMQ and consume events. Re-connects on failure."""
    if not settings.RABBITMQ_ENABLED:
        logger.info("RabbitMQ disabled — consumer will not start.")
        return

    routing_keys = [k.strip() for k in settings.RABBITMQ_ROUTING_KEYS.split(",") if k.strip()]
    if not routing_keys:
        logger.warning("No routing keys configured — consumer will not start.")
        return

    while not stop_event.is_set():
        try:
            connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=10)

                exchange = await channel.declare_exchange(
                    settings.RABBITMQ_EXCHANGE,
                    aio_pika.ExchangeType.TOPIC,
                    durable=True,
                )

                queue = await channel.declare_queue(
                    settings.RABBITMQ_QUEUE,
                    durable=True,
                )

                for key in routing_keys:
                    await queue.bind(exchange, routing_key=key)

                logger.info(
                    "RabbitMQ consumer started — queue=%s, keys=%s",
                    settings.RABBITMQ_QUEUE,
                    routing_keys,
                )

                await queue.consume(_on_message)

                # Wait until stop is requested
                await stop_event.wait()

        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("RabbitMQ consumer error — reconnecting in 5s")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=5)
            except asyncio.TimeoutError:
                continue
