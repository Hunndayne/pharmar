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


_BASE_EMAIL = """
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
  <tr><td align="center">
    <table width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%">

      <!-- Header -->
      <tr><td style="background:#111827;border-radius:12px 12px 0 0;padding:24px 32px;text-align:center">
        <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">Pharmar</span>
        <span style="display:block;font-size:11px;color:#9ca3af;margin-top:2px;letter-spacing:0.08em;text-transform:uppercase">Quản lý nhà thuốc</span>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#ffffff;padding:28px 32px">
        {BODY}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;padding:16px 32px;text-align:center">
        <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6">
          Email tự động từ hệ thống <strong>Pharmar</strong>. Vui lòng không trả lời email này.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>
"""

_ROW_STYLE = "padding:8px 0;border-bottom:1px solid #f3f4f6"
_LABEL_STYLE = "font-size:12px;color:#6b7280;width:140px;vertical-align:top;padding-right:12px"
_VALUE_STYLE = "font-size:13px;color:#111827;font-weight:500;vertical-align:top"


def _detail_row(label: str, value: str) -> str:
    return f"""<tr style="{_ROW_STYLE}">
      <td style="{_LABEL_STYLE}">{label}</td>
      <td style="{_VALUE_STYLE}">{value}</td>
    </tr>"""


def _cta_button(label: str, url: str, color: str = "#111827") -> str:
    return f"""
    <div style="text-align:center;margin-top:24px">
      <a href="{url}" target="_blank"
         style="display:inline-block;background:{color};color:#ffffff;font-size:14px;
                font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;
                letter-spacing:0.01em">
        {label}
      </a>
    </div>"""


def _build_email_html(title: str, body_text: str, cta_url: str | None = None, cta_label: str = "Xem chi tiết") -> str:
    """Generic email wrapper — used for non-invoice events."""
    cta = _cta_button(cta_label, cta_url) if cta_url else ""
    body = f"""
      <h2 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#111827">{title}</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;white-space:pre-line">{body_text}</p>
      {cta}
    """
    return _BASE_EMAIL.replace("{BODY}", body)


def _build_invoice_email(payload: dict, frontend_url: str) -> str:
    """Rich email template for new invoices."""
    code = payload.get("invoice_code", "")
    amount = _fmt_money(payload.get("total_amount", 0))
    payment_key = payload.get("payment_method", "")
    payment = PAYMENT_METHOD_LABELS.get(payment_key, payment_key)
    cashier = payload.get("created_by_name") or "—"
    customer_name = payload.get("customer_name") or "Khách lẻ"
    customer_phone = payload.get("customer_phone") or ""
    discount = payload.get("discount_amount", 0)
    subtotal = payload.get("subtotal", 0)

    rows = _detail_row("Mã hóa đơn", f"<span style='font-family:monospace;font-size:14px'>{code}</span>")
    if subtotal and discount:
        rows += _detail_row("Tạm tính", _fmt_money(subtotal))
        rows += _detail_row("Giảm giá", f"<span style='color:#ef4444'>-{_fmt_money(discount)}</span>")
    rows += _detail_row("Tổng tiền", f"<span style='font-size:16px;color:#111827;font-weight:700'>{amount}</span>")
    rows += _detail_row("Thanh toán", payment)
    rows += _detail_row("Thu ngân", cashier)
    customer_display = customer_name + (f" · {customer_phone}" if customer_phone else "")
    rows += _detail_row("Khách hàng", customer_display)

    lookup_url = f"{frontend_url}/tra-cuu-hoa-don?mode=code&code={code}"

    body = f"""
      <div style="margin-bottom:20px">
        <span style="display:inline-block;background:#f0fdf4;color:#16a34a;font-size:11px;
                     font-weight:600;padding:4px 10px;border-radius:20px;letter-spacing:0.06em;
                     text-transform:uppercase">Hóa đơn mới</span>
      </div>
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#111827">
        {code}
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        {rows}
      </table>
      {_cta_button("Xem chi tiết hóa đơn", lookup_url)}
      <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center">
        Liên kết có hiệu lực trong 30 ngày
      </p>
    """
    return _BASE_EMAIL.replace("{BODY}", body)


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

                    if routing_key == "sale.invoice.created":
                        email_html = _build_invoice_email(payload, settings.FRONTEND_URL)
                    else:
                        invoice_code = payload.get("invoice_code")
                        cta_url = (
                            f"{settings.FRONTEND_URL}/tra-cuu-hoa-don?mode=code&code={invoice_code}"
                            if invoice_code else None
                        )
                        email_html = _build_email_html(title, body_text, cta_url=cta_url)

                    sent = await send_email(
                        db,
                        subject=f"[Pharmar] {title}",
                        body_html=email_html,
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
