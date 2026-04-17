from fastapi import APIRouter, Depends

from Source.db.models import Notification
from Source.dependencies import DbSession, require_internal_api_key
from Source.schemas.notification import NotificationCreateRequest, NotificationResponse

router = APIRouter(
    prefix="/notification/internal",
    tags=["notification-internal"],
    dependencies=[Depends(require_internal_api_key)],
)


@router.post("/send", response_model=NotificationResponse)
async def internal_send_notification(
    db: DbSession,
    payload: NotificationCreateRequest,
):
    """Internal endpoint for other services to create notifications."""
    notification = Notification(
        title=payload.title,
        body=payload.body,
        category=payload.category,
    )

    if payload.send_email:
        from Source.email_sender import send_email

        sent = await send_email(db, "", payload.title, payload.body)
        notification.email_sent = sent

    db.add(notification)
    await db.commit()
    await db.refresh(notification)
    return NotificationResponse.model_validate(notification)


@router.post("/restock/refresh")
async def restock_refresh() -> dict[str, str]:
    """Silent restock state refresh — call after nhập hàng.

    Clears recovered drugs from the low-stock notification cache so they
    can trigger a new alert if stock drops again later.
    """
    from Source.expiry_checker import refresh_low_stock_state

    await refresh_low_stock_state()
    return {"status": "ok"}
