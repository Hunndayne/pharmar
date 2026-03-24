from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from Source.db.models import SmtpConfig
from Source.dependencies import (
    DbSession,
    ROLE_OWNER,
    TokenUser,
    require_roles,
)
from Source.email_sender import send_test_email
from Source.schemas.notification import (
    SmtpConfigResponse,
    SmtpConfigUpdateRequest,
    SmtpTestRequest,
)

router = APIRouter(prefix="/notification/smtp", tags=["notification-smtp"])

OwnerOnly = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER))]


@router.get("", response_model=SmtpConfigResponse)
async def get_smtp_config(_: OwnerOnly, db: DbSession):
    result = await db.execute(select(SmtpConfig).where(SmtpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None:
        config = SmtpConfig(id=1)
        db.add(config)
        await db.commit()
        await db.refresh(config)
    return SmtpConfigResponse.model_validate(config)


@router.put("", response_model=SmtpConfigResponse)
async def update_smtp_config(
    _: OwnerOnly,
    db: DbSession,
    payload: SmtpConfigUpdateRequest,
):
    result = await db.execute(select(SmtpConfig).where(SmtpConfig.id == 1))
    config = result.scalar_one_or_none()

    if config is None:
        config = SmtpConfig(id=1)
        db.add(config)

    config.host = payload.host
    config.port = payload.port
    config.username = payload.username
    config.password = payload.password
    config.use_tls = payload.use_tls
    config.from_email = payload.from_email
    config.from_name = payload.from_name
    config.to_email = payload.to_email
    config.is_active = payload.is_active

    await db.commit()
    await db.refresh(config)
    return SmtpConfigResponse.model_validate(config)


@router.post("/test")
async def test_smtp(_: OwnerOnly, db: DbSession, payload: SmtpTestRequest):
    result = await db.execute(select(SmtpConfig).where(SmtpConfig.id == 1))
    config = result.scalar_one_or_none()
    if config is None or not config.host:
        raise HTTPException(status_code=400, detail="Chưa cấu hình SMTP. Hãy lưu cấu hình trước.")

    success = await send_test_email(db, payload.to_email)
    if not success:
        raise HTTPException(status_code=500, detail="Gửi email thất bại. Kiểm tra lại cấu hình SMTP.")
    return {"message": f"Email test đã gửi thành công đến {payload.to_email}"}
