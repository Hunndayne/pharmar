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
    """
    Internal endpoint for other services to create notifications.
    Requires X-Internal-API-Key header.
    """
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
