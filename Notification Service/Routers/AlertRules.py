from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from Source.db.models import AlertRule
from Source.dependencies import (
    DbSession,
    ROLE_MANAGER,
    ROLE_OWNER,
    TokenUser,
    get_current_user,
    require_roles,
)
from Source.schemas.notification import AlertRuleResponse, AlertRuleUpdateRequest

router = APIRouter(prefix="/notification/alert-rules", tags=["notification-alert-rules"])

AnyUser = Annotated[TokenUser, Depends(get_current_user)]
ManagerOrOwner = Annotated[TokenUser, Depends(require_roles(ROLE_OWNER, ROLE_MANAGER))]


@router.get("", response_model=list[AlertRuleResponse])
async def list_alert_rules(_: AnyUser, db: DbSession):
    result = await db.execute(select(AlertRule).order_by(AlertRule.id))
    return [AlertRuleResponse.model_validate(r) for r in result.scalars().all()]


@router.put("/{rule_id}", response_model=AlertRuleResponse)
async def update_alert_rule(
    _: ManagerOrOwner,
    db: DbSession,
    rule_id: int,
    payload: AlertRuleUpdateRequest,
):
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if rule is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy quy tắc cảnh báo")

    if payload.is_active is not None:
        rule.is_active = payload.is_active
    if payload.send_email is not None:
        rule.send_email = payload.send_email
    if payload.send_web is not None:
        rule.send_web = payload.send_web

    await db.commit()
    await db.refresh(rule)
    return AlertRuleResponse.model_validate(rule)
