"""Background worker that periodically checks inventory for expired / expiring-soon
batches and creates notification records (+ optional email alerts)."""

import asyncio
import logging
from datetime import datetime, timezone

import httpx

from .core.config import get_settings
from .db.models import AlertRule, Notification
from .db.session import SessionLocal
from .email_sender import send_email

from sqlalchemy import select

logger = logging.getLogger("expiry_checker")
settings = get_settings()

# Track which batches have already been notified to avoid duplicates
_notified_batch_ids: set[str] = set()


async def _fetch_inventory_alerts() -> dict | None:
    """Call Inventory Service /api/v1/inventory/alerts endpoint."""
    url = f"{settings.INVENTORY_SERVICE_URL}/api/v1/inventory/alerts"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()
    except Exception:
        logger.exception("Failed to fetch inventory alerts from %s", url)
        return None


async def _get_alert_rule(code: str) -> AlertRule | None:
    async with SessionLocal() as db:
        result = await db.execute(select(AlertRule).where(AlertRule.code == code))
        return result.scalar_one_or_none()


async def _create_notification(title: str, body: str, category: str) -> None:
    async with SessionLocal() as db:
        notification = Notification(
            title=title,
            body=body,
            category=category,
            is_read=False,
            email_sent=False,
        )
        db.add(notification)
        await db.commit()


async def _check_and_notify() -> None:
    """Single check cycle: fetch alerts, create notifications for new expired/expiring batches."""
    alerts_data = await _fetch_inventory_alerts()
    if alerts_data is None:
        return

    # Check expiry_warning rule
    expiry_rule = await _get_alert_rule("expiry_warning")
    if expiry_rule is None or not expiry_rule.is_active:
        return

    expired_entries = alerts_data.get("expired", [])
    expiring_entries = alerts_data.get("expiring_soon", [])

    new_expired = []
    new_expiring = []

    for entry in expired_entries:
        batch = entry.get("batch", {})
        batch_id = batch.get("id", "")
        if batch_id and batch_id not in _notified_batch_ids:
            new_expired.append(entry)
            _notified_batch_ids.add(batch_id)

    for entry in expiring_entries:
        batch = entry.get("batch", {})
        batch_id = batch.get("id", "")
        if batch_id and batch_id not in _notified_batch_ids:
            new_expiring.append(entry)
            _notified_batch_ids.add(batch_id)

    if not new_expired and not new_expiring:
        return

    # Create notification
    parts = []
    if new_expired:
        parts.append(f"{len(new_expired)} lô đã hết hạn")
    if new_expiring:
        parts.append(f"{len(new_expiring)} lô sắp hết hạn")

    title = "Cảnh báo hạn sử dụng thuốc"
    body_lines = [f"Phát hiện {', '.join(parts)}:"]

    for entry in new_expired[:5]:
        batch = entry.get("batch", {})
        body_lines.append(f"  - [HẾT HẠN] {batch.get('drug_name', '?')} (lô {batch.get('batch_code', '?')}), tồn: {batch.get('qty_remaining', 0)}")

    for entry in new_expiring[:5]:
        batch = entry.get("batch", {})
        days = entry.get("days_to_expiry", 0)
        body_lines.append(f"  - [SẮP HẾT HẠN] {batch.get('drug_name', '?')} (lô {batch.get('batch_code', '?')}), còn {days} ngày")

    total = len(new_expired) + len(new_expiring)
    if total > 10:
        body_lines.append(f"  ... và {total - 10} lô khác")

    body = "\n".join(body_lines)
    await _create_notification(title, body, "expiry_warning")

    # Send email if enabled
    if expiry_rule.send_email:
        try:
            await send_email(
                subject=title,
                body=body,
            )
        except Exception:
            logger.exception("Failed to send expiry alert email")

    logger.info("Created expiry notification: %d expired, %d expiring soon", len(new_expired), len(new_expiring))


async def start_expiry_checker(stop_event: asyncio.Event) -> None:
    """Run the expiry check loop. Runs every EXPIRY_CHECK_INTERVAL_HOURS."""
    interval_seconds = settings.EXPIRY_CHECK_INTERVAL_HOURS * 3600
    logger.info("Expiry checker started, interval=%dh", settings.EXPIRY_CHECK_INTERVAL_HOURS)

    # Wait a bit before first check to let services start
    await asyncio.sleep(30)

    while not stop_event.is_set():
        try:
            await _check_and_notify()
        except Exception:
            logger.exception("Expiry check cycle failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
            break
        except asyncio.TimeoutError:
            pass

    logger.info("Expiry checker stopped")
