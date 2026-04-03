import asyncio
import json
import logging
from decimal import Decimal, InvalidOperation

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

PAYMENT_METHOD_LABELS: dict[str, str] = {
    "cash": "Tiền mặt",
    "card": "Thẻ ngân hàng",
    "bank_transfer": "Chuyển khoản",
    "momo": "MoMo",
    "zalopay": "ZaloPay",
    "vnpay": "VNPay",
    "debt": "Mua nợ",
    "points": "Điểm thưởng",
}


def _fmt_money(amount) -> str:
    try:
        value = int(Decimal(str(amount)))
        return f"{value:,}đ".replace(",", ".")
    except (InvalidOperation, TypeError, ValueError):
        return str(amount)


def _build_body_text(routing_key: str, payload: dict) -> str:
    if routing_key == "sale.invoice.created":
        code = payload.get("invoice_code", "")
        amount = _fmt_money(payload.get("total_amount", 0))
        payment_key = payload.get("payment_method", "")
        payment = PAYMENT_METHOD_LABELS.get(payment_key, payment_key)
        cashier = payload.get("created_by_name") or ""
        customer_name = payload.get("customer_name")
        customer_phone = payload.get("customer_phone")

        parts = [f"Hóa đơn {code} trị giá {amount} — Thanh toán: {payment}."]
        if cashier:
            parts.append(f"Thu ngân: {cashier}.")
        if customer_name:
            customer_info = customer_name
            if customer_phone:
                customer_info += f" ({customer_phone})"
            parts.append(f"Khách hàng: {customer_info}.")
        return " ".join(parts)

    if routing_key == "sale.invoice.cancelled":
        code = payload.get("invoice_code", "")
        amount = _fmt_money(payload.get("total_amount", 0))
        reason = payload.get("cancel_reason") or ""
        parts = [f"Hóa đơn {code} ({amount}) đã bị hủy."]
        if reason:
            parts.append(f"Lý do: {reason}.")
        return " ".join(parts)

    if routing_key == "sale.return.approved":
        return_code = payload.get("return_code", "")
        invoice_code = payload.get("invoice_code", "")
        refund = _fmt_money(payload.get("refund_amount", 0))
        customer_name = payload.get("customer_name")

        parts = [f"Phiếu trả hàng {return_code} (từ hóa đơn {invoice_code}) đã được duyệt."]
        parts.append(f"Số tiền hoàn trả: {refund}.")
        if customer_name:
            parts.append(f"Khách hàng: {customer_name}.")
        return " ".join(parts)

    if routing_key == "inventory.low_stock":
        drug_name = payload.get("drug_name") or "Không xác định"
        current_qty = payload.get("current_quantity", 0)
        min_qty = payload.get("min_quantity", 0)
        unit = payload.get("unit", "")
        unit_suffix = f" {unit}" if unit else ""
        return (
            f"Sản phẩm '{drug_name}' còn {current_qty}{unit_suffix} "
            f"(ngưỡng tối thiểu: {min_qty}{unit_suffix})."
        )

    # Fallback for unknown routing keys
    return json.dumps(payload, ensure_ascii=False, default=str)


def _build_email_html(title: str, body_text: str) -> str:
    return f"""
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:8px">
        <div style="background:#fff;border-radius:6px;padding:20px 24px;border:1px solid #e5e7eb">
            <h2 style="color:#111827;margin:0 0 12px;font-size:18px">{title}</h2>
            <p style="color:#374151;margin:0;font-size:15px;line-height:1.6">{body_text}</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;margin:12px 0 0;text-align:center">
            Email tự động từ hệ thống Pharmar. Vui lòng không trả lời email này.
        </p>
    </div>
    """


async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    async with message.process():
        try:
            routing_key = message.routing_key or ""
            body = json.loads(message.body.decode())

            category = ROUTING_KEY_CATEGORY.get(routing_key, "system")
            title = ROUTING_KEY_TITLE.get(routing_key, f"Sự kiện: {routing_key}")

            payload = body.get("payload", {})
            body_text = _build_body_text(routing_key, payload)

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

                # Skip only when both channels are disabled
                if not rule.send_web and not rule.send_email:
                    return

                notification = Notification(
                    title=title,
                    body=body_text,
                    category=category,
                )

                if rule.send_email:
                    from .email_sender import send_email

                    sent = await send_email(
                        db,
                        subject=f"[Pharmar] {title}",
                        body_html=_build_email_html(title, body_text),
                    )
                    notification.email_sent = sent

                # Only persist a web notification when send_web is enabled
                if not rule.send_web:
                    return

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
