"""Scheduled daily restock suggestion email.

Runs once per day at RESTOCK_EMAIL_TIME (HH:MM local time).
Fetches restock items from Report Service using a short-lived service JWT,
then sends an email notification if actionable items exist.
"""

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import logging

import httpx
from sqlalchemy import select

from .core.config import get_settings
from .db.models import AlertRule, Notification
from .db.session import SessionLocal
from .email_sender import send_email
from .email_templates import build_restock_email

logger = logging.getLogger("restock_checker")
settings = get_settings()


# ── JWT helper ────────────────────────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _create_service_token() -> str:
    """Short-lived JWT signed with the shared JWT_SECRET_KEY for service calls."""
    now = datetime.datetime.now(datetime.timezone.utc)
    exp = now + datetime.timedelta(minutes=10)
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": "notification-service",
        "username": "notification-service",
        "role": "owner",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    enc_h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    enc_p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig_input = f"{enc_h}.{enc_p}".encode("ascii")
    sig = hmac.new(settings.JWT_SECRET_KEY.encode(), sig_input, hashlib.sha256).digest()
    return f"{enc_h}.{enc_p}.{_b64url(sig)}"


# ── scheduling ────────────────────────────────────────────────────────────────

def _seconds_until_next(time_str: str) -> float:
    """Seconds until the next occurrence of HH:MM in server local time."""
    h, m = (int(x) for x in time_str.strip().split(":"))
    now = datetime.datetime.now()
    target = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return (target - now).total_seconds()


# ── data fetch ────────────────────────────────────────────────────────────────

async def _fetch_restock_data() -> dict | None:
    """Call Report Service restock items endpoint."""
    url = f"{settings.REPORT_SERVICE_URL}/api/v1/report/restock/items"
    try:
        token = _create_service_token()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                url,
                params={"size": 100, "urgency": "all"},
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
            return response.json()
    except Exception:
        logger.exception("Failed to fetch restock data from %s", url)
        return None


# ── notification ──────────────────────────────────────────────────────────────

async def _get_restock_rule() -> AlertRule | None:
    async with SessionLocal() as db:
        result = await db.execute(select(AlertRule).where(AlertRule.code == "restock"))
        return result.scalar_one_or_none()


async def _send_restock_notification(data: dict) -> None:
    total_actionable = data.get("total_actionable", 0)
    if total_actionable == 0:
        logger.info("No actionable restock items — skipping email")
        return

    rule = await _get_restock_rule()
    if rule is None or not rule.is_active:
        logger.info("Restock alert rule inactive or missing — skipping")
        return

    critical_count = data.get("critical_count", 0)
    high_count = data.get("high_count", 0)
    items = data.get("items", []) if isinstance(data.get("items"), list) else []
    sales_window_days = int(data.get("sales_window_days") or 60)
    target_cover_days = int(data.get("target_cover_days") or 14)

    parts = []
    if critical_count:
        parts.append(f"{critical_count} khẩn cấp")
    if high_count:
        parts.append(f"{high_count} mức cao")
    normal = max(0, total_actionable - critical_count - high_count)
    if normal:
        parts.append(f"{normal} bình thường")

    title = "Gợi ý nhập hàng hôm nay"
    body_text = (
        f"Có {total_actionable} mặt hàng cần nhập: {', '.join(parts)}."
        if parts else f"Có {total_actionable} mặt hàng cần nhập."
    )
    email_html = build_restock_email(
        items, total_actionable, critical_count, high_count,
        sales_window_days, target_cover_days, settings.FRONTEND_URL,
    )

    async with SessionLocal() as db:
        notification = Notification(
            title=title,
            body=body_text,
            category="restock",
            is_read=False,
            email_sent=False,
        )

        if rule.send_email and email_html:
            try:
                sent = await send_email(db, "", title, email_html)
                notification.email_sent = sent
            except Exception:
                logger.exception("Failed to send restock email")

        if rule.send_web:
            db.add(notification)
            await db.commit()

    logger.info(
        "Restock notification: total=%d critical=%d high=%d",
        total_actionable, critical_count, high_count,
    )


# ── main loop ─────────────────────────────────────────────────────────────────

async def start_restock_checker(stop_event: asyncio.Event) -> None:
    """Run once per day at RESTOCK_EMAIL_TIME. Waits 30 s before first calculation."""
    if not settings.RESTOCK_EMAIL_ENABLED:
        logger.info("Restock email scheduler disabled")
        return

    logger.info("Restock scheduler started — daily at %s", settings.RESTOCK_EMAIL_TIME)
    await asyncio.sleep(30)  # let services stabilise on startup

    while not stop_event.is_set():
        wait_secs = _seconds_until_next(settings.RESTOCK_EMAIL_TIME)
        logger.info("Next restock email check in %.0f s (at %s)", wait_secs, settings.RESTOCK_EMAIL_TIME)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_secs)
            break  # stop requested
        except asyncio.TimeoutError:
            pass

        if stop_event.is_set():
            break

        try:
            data = await _fetch_restock_data()
            if data is not None:
                await _send_restock_notification(data)
        except Exception:
            logger.exception("Restock check cycle failed")

    logger.info("Restock scheduler stopped")
