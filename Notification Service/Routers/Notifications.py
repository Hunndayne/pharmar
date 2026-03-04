from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, select, update

from Source.db.models import Notification
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.notification import (
    MarkReadRequest,
    NotificationCreateRequest,
    NotificationResponse,
    PageResponse,
)

router = APIRouter(prefix="/notification", tags=["notification"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


@router.get("/notifications", response_model=PageResponse[NotificationResponse])
async def list_notifications(
    _: AnyUser,
    db: DbSession,
    is_read: bool | None = Query(default=None),
    category: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
):
    base = select(Notification)
    count_base = select(func.count()).select_from(Notification)

    if is_read is not None:
        base = base.where(Notification.is_read == is_read)
        count_base = count_base.where(Notification.is_read == is_read)
    if category:
        base = base.where(Notification.category == category)
        count_base = count_base.where(Notification.category == category)

    total = (await db.execute(count_base)).scalar() or 0
    rows = (
        await db.execute(
            base.order_by(Notification.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()

    return PageResponse(
        items=[NotificationResponse.model_validate(r) for r in rows],
        total=total,
        page=page,
        size=size,
        pages=max(1, (total + size - 1) // size),
    )


@router.get("/notifications/unread-count")
async def unread_count(_: AnyUser, db: DbSession):
    total = (
        await db.execute(
            select(func.count()).select_from(Notification).where(Notification.is_read == False)  # noqa: E712
        )
    ).scalar() or 0
    return {"unread_count": total}


@router.post("/notifications", response_model=NotificationResponse, status_code=status.HTTP_201_CREATED)
async def create_notification(
    user: ManagerOrOwner,
    db: DbSession,
    payload: NotificationCreateRequest,
):
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


@router.patch("/notifications/mark-read")
async def mark_notifications_read(
    _: AnyUser,
    db: DbSession,
    payload: MarkReadRequest,
):
    await db.execute(
        update(Notification)
        .where(Notification.id.in_(payload.notification_ids))
        .values(is_read=True)
    )
    await db.commit()
    return {"message": "Đã đánh dấu đã đọc", "count": len(payload.notification_ids)}


@router.patch("/notifications/mark-all-read")
async def mark_all_read(_: AnyUser, db: DbSession):
    result = await db.execute(
        update(Notification)
        .where(Notification.is_read == False)  # noqa: E712
        .values(is_read=True)
    )
    await db.commit()
    return {"message": "Đã đánh dấu tất cả đã đọc", "count": result.rowcount}


@router.delete("/notifications/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_notification(
    _: ManagerOrOwner,
    db: DbSession,
    notification_id: str,
):
    result = await db.execute(delete(Notification).where(Notification.id == notification_id))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Không tìm thấy thông báo")
    await db.commit()


@router.delete("/notifications", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_read_notifications(_: ManagerOrOwner, db: DbSession):
    await db.execute(delete(Notification).where(Notification.is_read == True))  # noqa: E712
    await db.commit()
