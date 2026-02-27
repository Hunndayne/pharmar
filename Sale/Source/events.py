from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import aio_pika


logger = logging.getLogger("sale.events")


class RabbitEventPublisher:
    def __init__(
        self,
        *,
        enabled: bool,
        url: str,
        exchange_name: str,
    ) -> None:
        self._enabled = enabled
        self._url = url
        self._exchange_name = exchange_name
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._exchange: aio_pika.abc.AbstractExchange | None = None

    async def start(self) -> None:
        if not self._enabled:
            logger.info("RabbitMQ publisher disabled")
            return

        if self._connection is not None and not self._connection.is_closed and self._exchange is not None:
            return

        try:
            self._connection = await aio_pika.connect_robust(self._url)
            self._channel = await self._connection.channel(publisher_confirms=False)
            self._exchange = await self._channel.declare_exchange(
                self._exchange_name,
                aio_pika.ExchangeType.TOPIC,
                durable=True,
            )
            logger.info("RabbitMQ publisher connected exchange=%s", self._exchange_name)
        except Exception:
            logger.exception("RabbitMQ publisher connect failed; will continue without broker")
            await self.close()

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
        self._exchange = None

    async def publish(self, *, event_type: str, routing_key: str, payload: dict[str, Any]) -> bool:
        if not self._enabled:
            return False
        if self._exchange is None:
            await self.start()
        if self._exchange is None:
            logger.warning("Skip publish because exchange is not initialized: %s", event_type)
            return False

        event = {
            "event_id": str(uuid4()),
            "event_type": event_type,
            "source": "sale-service",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "version": 1,
            "payload": payload,
        }

        message = aio_pika.Message(
            body=json.dumps(event, ensure_ascii=False, default=str).encode("utf-8"),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            content_type="application/json",
        )

        try:
            await self._exchange.publish(message, routing_key=routing_key)
            return True
        except Exception:
            logger.exception("Failed to publish event event_type=%s routing_key=%s", event_type, routing_key)
            return False


_publisher: RabbitEventPublisher | None = None


async def init_event_publisher(*, enabled: bool, url: str, exchange_name: str) -> None:
    global _publisher
    publisher = RabbitEventPublisher(enabled=enabled, url=url, exchange_name=exchange_name)
    await publisher.start()
    _publisher = publisher


async def close_event_publisher() -> None:
    global _publisher
    if _publisher is None:
        return
    await _publisher.close()
    _publisher = None


async def publish_sale_event(*, event_type: str, routing_key: str, payload: dict[str, Any]) -> bool:
    if _publisher is None:
        return False
    return await _publisher.publish(event_type=event_type, routing_key=routing_key, payload=payload)
