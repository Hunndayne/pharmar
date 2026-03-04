from datetime import datetime
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field


T = TypeVar("T")

NotificationCategory = Literal["general", "low_stock", "expiry_warning", "sale", "system"]


class PageResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    size: int
    pages: int


# ── SMTP Config ──────────────────────────────────────────────────────────────

class SmtpConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    host: str
    port: int
    username: str
    use_tls: bool
    from_email: str
    from_name: str
    is_active: bool
    updated_at: datetime


class SmtpConfigUpdateRequest(BaseModel):
    host: str = Field(max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(max_length=255)
    password: str = Field(max_length=500)
    use_tls: bool = True
    from_email: str = Field(max_length=255)
    from_name: str = Field(max_length=255, default="Pharmar")
    is_active: bool = True


class SmtpTestRequest(BaseModel):
    to_email: str = Field(max_length=255)


# ── Alert Rules ──────────────────────────────────────────────────────────────

class AlertRuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    description: str | None
    is_active: bool
    send_email: bool
    send_web: bool
    created_at: datetime
    updated_at: datetime


class AlertRuleUpdateRequest(BaseModel):
    is_active: bool | None = None
    send_email: bool | None = None
    send_web: bool | None = None


# ── Notifications ────────────────────────────────────────────────────────────

class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    body: str
    category: str
    is_read: bool
    email_sent: bool
    created_at: datetime


class NotificationCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=5000)
    category: NotificationCategory = "general"
    send_email: bool = False


class MarkReadRequest(BaseModel):
    notification_ids: list[str] = Field(min_length=1, max_length=100)
