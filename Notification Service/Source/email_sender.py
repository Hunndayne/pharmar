import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db.models import SmtpConfig

logger = logging.getLogger("notification.email")


async def _get_smtp_config(db: AsyncSession) -> SmtpConfig | None:
    result = await db.execute(select(SmtpConfig).where(SmtpConfig.id == 1))
    return result.scalar_one_or_none()


async def send_email(
    db: AsyncSession,
    to_email: str = "",
    subject: str = "",
    body_html: str = "",
) -> bool:
    """Send an email using the SMTP config stored in DB. Returns True on success.

    If *to_email* is empty the value stored in SmtpConfig.to_email is used as
    the fallback recipient.
    """
    config = await _get_smtp_config(db)
    if config is None or not config.is_active or not config.host:
        logger.info("SMTP not configured or disabled — skipping email to %s", to_email)
        return False

    # Resolve recipient: caller-supplied value takes priority, fall back to stored config
    resolved_to = to_email or config.to_email
    if not resolved_to:
        logger.warning(
            "No recipient email configured — cannot send email (subject=%s). "
            "Set a 'To Email' in SMTP settings.",
            subject,
        )
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{config.from_name} <{config.from_email}>"
    msg["To"] = resolved_to
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        # SMTP mode:
        # - Port 465: implicit SSL/TLS (use_tls=True, start_tls=False)
        # - Port 587/25: plain connect then STARTTLS (use_tls=False, start_tls=True)
        # Checkbox `use_tls` means "use encrypted transport when possible".
        implicit_tls = bool(config.use_tls and config.port == 465)
        start_tls = bool(config.use_tls and config.port != 465)

        await aiosmtplib.send(
            msg,
            hostname=config.host,
            port=config.port,
            username=config.username,
            password=config.password,
            use_tls=implicit_tls,
            start_tls=start_tls,
            timeout=15,
        )
        logger.info("Email sent to %s (subject=%s)", resolved_to, subject)
        return True
    except Exception:
        logger.exception("Failed to send email to %s", resolved_to)
        return False


async def send_test_email(db: AsyncSession, to_email: str) -> bool:
    """Send a test email to verify SMTP settings."""
    return await send_email(
        db,
        to_email=to_email,
        subject="[Pharmar] Test email - Kiểm tra cấu hình SMTP",
        body_html="""
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#1a1a1a">Kiểm tra SMTP thành công!</h2>
            <p style="color:#555">
                Email này xác nhận rằng cấu hình SMTP của bạn trong hệ thống
                <strong>Pharmar</strong> đã hoạt động đúng.
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
            <p style="color:#999;font-size:12px">
                Đây là email tự động từ hệ thống quản lý nhà thuốc Pharmar.
            </p>
        </div>
        """,
    )
