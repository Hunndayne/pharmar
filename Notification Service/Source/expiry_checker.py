"""Background worker: periodically checks inventory alerts and creates notifications.

Handles three alert types in a single poll cycle:
  - expiry_warning : expired + expiring_soon (< 30 d) + warning (30-60 d) batches
  - low_stock      : drugs below reorder threshold
  - system         : inventory service unreachable after N consecutive failures
"""

import asyncio
import logging

import httpx

from .core.config import get_settings
from .db.models import AlertRule, Notification
from .db.session import SessionLocal
from .email_sender import send_email

from sqlalchemy import select

logger = logging.getLogger("expiry_checker")
settings = get_settings()

# ── dedup state (in-memory, resets on restart) ────────────────────────────────
_notified_expiry_batch_ids: set[str] = set()
_notified_low_stock_drug_ids: set[str] = set()
_inventory_fail_count: int = 0
_system_alert_sent: bool = False


# ── helpers ───────────────────────────────────────────────────────────────────

async def _fetch_inventory_alerts() -> dict | None:
    url = f"{settings.INVENTORY_SERVICE_URL}/api/v1/inventory/alerts"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()
    except Exception:
        logger.exception("Failed to fetch inventory alerts from %s", url)
        return None


async def _get_rule(code: str) -> AlertRule | None:
    async with SessionLocal() as db:
        result = await db.execute(select(AlertRule).where(AlertRule.code == code))
        return result.scalar_one_or_none()


def _to_html(body: str) -> str:
    lines = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<pre style=\"font-family:sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap\">{lines}</pre>"


async def _create_notification(title: str, body: str, category: str, rule: AlertRule) -> None:
    async with SessionLocal() as db:
        notification = Notification(
            title=title,
            body=body,
            category=category,
            is_read=False,
            email_sent=False,
        )
        if rule.send_email:
            try:
                sent = await send_email(db, "", title, _to_html(body))
                notification.email_sent = sent
            except Exception:
                logger.exception("Failed to send %s alert email", category)

        if rule.send_web:
            db.add(notification)
            await db.commit()


# ── expiry check ──────────────────────────────────────────────────────────────

async def _handle_expiry(alerts_data: dict) -> None:
    global _notified_expiry_batch_ids

    rule = await _get_rule("expiry_warning")
    if rule is None or not rule.is_active:
        return

    new_expired = []
    new_expiring_soon = []
    new_warning = []

    for entry in alerts_data.get("expired", []):
        bid = entry.get("batch", {}).get("id", "")
        if bid and bid not in _notified_expiry_batch_ids:
            new_expired.append(entry)
            _notified_expiry_batch_ids.add(bid)

    for entry in alerts_data.get("expiring_soon", []):
        bid = entry.get("batch", {}).get("id", "")
        if bid and bid not in _notified_expiry_batch_ids:
            new_expiring_soon.append(entry)
            _notified_expiry_batch_ids.add(bid)

    for entry in alerts_data.get("warning", []):
        bid = entry.get("batch", {}).get("id", "")
        if bid and bid not in _notified_expiry_batch_ids:
            new_warning.append(entry)
            _notified_expiry_batch_ids.add(bid)

    if not new_expired and not new_expiring_soon and not new_warning:
        return

    # Build notification body
    parts = []
    if new_expired:
        parts.append(f"{len(new_expired)} lô đã hết hạn")
    if new_expiring_soon:
        parts.append(f"{len(new_expiring_soon)} lô sắp hết hạn (< 30 ngày)")
    if new_warning:
        parts.append(f"{len(new_warning)} lô cảnh báo (30–60 ngày)")

    title = "Cảnh báo hạn sử dụng thuốc"
    lines = [f"Phát hiện {', '.join(parts)}:"]

    for entry in new_expired[:4]:
        b = entry.get("batch", {})
        lines.append(f"  • [HẾT HẠN] {b.get('drug_name', '?')} — lô {b.get('batch_code', '?')}, tồn: {b.get('qty_remaining', 0)}")

    for entry in new_expiring_soon[:3]:
        b = entry.get("batch", {})
        days = entry.get("days_to_expiry", 0)
        lines.append(f"  • [SẮP HẾT] {b.get('drug_name', '?')} — lô {b.get('batch_code', '?')}, còn {days} ngày")

    for entry in new_warning[:3]:
        b = entry.get("batch", {})
        days = entry.get("days_to_expiry", 0)
        lines.append(f"  • [CẢNH BÁO] {b.get('drug_name', '?')} — lô {b.get('batch_code', '?')}, còn {days} ngày")

    total = len(new_expired) + len(new_expiring_soon) + len(new_warning)
    shown = min(total, 10)
    if total > shown:
        lines.append(f"  ... và {total - shown} lô khác")

    await _create_notification(title, "\n".join(lines), "expiry_warning", rule)
    logger.info(
        "Expiry notification: %d expired, %d expiring soon, %d warning",
        len(new_expired), len(new_expiring_soon), len(new_warning),
    )


# ── low stock check ───────────────────────────────────────────────────────────

async def _handle_low_stock(alerts_data: dict) -> None:
    global _notified_low_stock_drug_ids

    rule = await _get_rule("low_stock")
    if rule is None or not rule.is_active:
        return

    low_stock_items = alerts_data.get("low_stock", [])
    new_items = []

    for item in low_stock_items:
        drug_id = item.get("drug_id", "")
        if drug_id and drug_id not in _notified_low_stock_drug_ids:
            new_items.append(item)
            _notified_low_stock_drug_ids.add(drug_id)

    # Also clear drugs that recovered (no longer in low_stock list)
    current_low_ids = {item.get("drug_id", "") for item in low_stock_items}
    _notified_low_stock_drug_ids &= current_low_ids

    if not new_items:
        return

    title = "Cảnh báo tồn kho thấp"
    lines = [f"Có {len(new_items)} sản phẩm dưới mức tồn kho tối thiểu:"]
    for item in new_items[:8]:
        name = item.get("drug_name", "?")
        qty = item.get("current_qty", 0)
        threshold = item.get("threshold", 0)
        lines.append(f"  • {name}: còn {qty} (ngưỡng {threshold})")
    if len(new_items) > 8:
        lines.append(f"  ... và {len(new_items) - 8} sản phẩm khác")

    await _create_notification(title, "\n".join(lines), "low_stock", rule)
    logger.info("Low stock notification: %d new items", len(new_items))


# ── system alert ──────────────────────────────────────────────────────────────

async def _handle_system_alert(fetch_ok: bool) -> None:
    global _inventory_fail_count, _system_alert_sent

    if fetch_ok:
        # Reset on success
        _inventory_fail_count = 0
        _system_alert_sent = False
        return

    _inventory_fail_count += 1
    threshold = settings.INVENTORY_FAIL_ALERT_THRESHOLD

    if _inventory_fail_count >= threshold and not _system_alert_sent:
        rule = await _get_rule("system")
        if rule and rule.is_active:
            title = "Lỗi kết nối dịch vụ kho"
            body = (
                f"Hệ thống không thể kết nối đến Inventory Service sau {_inventory_fail_count} lần thử liên tiếp.\n"
                "Vui lòng kiểm tra trạng thái dịch vụ kho hàng."
            )
            await _create_notification(title, body, "system", rule)
            _system_alert_sent = True
            logger.warning("System alert sent: inventory service unreachable after %d failures", _inventory_fail_count)


# ── main check cycle ──────────────────────────────────────────────────────────

async def _check_and_notify() -> None:
    alerts_data = await _fetch_inventory_alerts()

    await _handle_system_alert(fetch_ok=alerts_data is not None)

    if alerts_data is None:
        return

    await _handle_expiry(alerts_data)
    await _handle_low_stock(alerts_data)


async def start_expiry_checker(stop_event: asyncio.Event) -> None:
    """Run the inventory alert check loop. Interval controlled by EXPIRY_CHECK_INTERVAL_HOURS."""
    interval_seconds = settings.EXPIRY_CHECK_INTERVAL_HOURS * 3600
    logger.info("Inventory checker started, interval=%dh", settings.EXPIRY_CHECK_INTERVAL_HOURS)

    # Wait for services to start before first check
    await asyncio.sleep(30)

    while not stop_event.is_set():
        try:
            await _check_and_notify()
        except Exception:
            logger.exception("Inventory check cycle failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
            break
        except asyncio.TimeoutError:
            pass

    logger.info("Inventory checker stopped")
