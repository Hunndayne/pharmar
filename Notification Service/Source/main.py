import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text

from Routers.AlertRules import router as alert_rules_router
from Routers.Internal import router as internal_router
from Routers.Notifications import router as notifications_router
from Routers.SmtpSettings import router as smtp_router

from .core.config import get_settings
from .db import models  # noqa: F401
from .db.base import Base
from .db.models import SCHEMA_NAME, AlertRule
from .db.session import SessionLocal, engine
from .rabbitmq_consumer import start_consumer


settings = get_settings()


DEFAULT_ALERT_RULES = [
    {"code": "sale", "name": "Sự kiện bán hàng", "description": "Thông báo khi có hóa đơn mới, hủy hóa đơn, trả hàng"},
    {"code": "low_stock", "name": "Tồn kho thấp", "description": "Cảnh báo khi sản phẩm dưới mức tồn kho tối thiểu"},
    {"code": "expiry_warning", "name": "Thuốc sắp hết hạn", "description": "Cảnh báo thuốc gần hết hạn sử dụng"},
    {"code": "system", "name": "Hệ thống", "description": "Thông báo từ hệ thống (backup, cập nhật, lỗi)"},
    {"code": "general", "name": "Chung", "description": "Thông báo chung khác"},
]


async def _ensure_default_alert_rules() -> None:
    async with SessionLocal() as db:
        for rule_data in DEFAULT_ALERT_RULES:
            result = await db.execute(select(AlertRule).where(AlertRule.code == rule_data["code"]))
            if result.scalar_one_or_none() is None:
                db.add(AlertRule(**rule_data))
        await db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate_secrets()

    async with engine.begin() as connection:
        await connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA_NAME}"))
        await connection.run_sync(Base.metadata.create_all)

        # Auto-migrate: add columns that create_all won't add to existing tables
        await connection.execute(text(
            f"ALTER TABLE {SCHEMA_NAME}.smtp_config "
            f"ADD COLUMN IF NOT EXISTS to_email VARCHAR(255) NOT NULL DEFAULT ''"
        ))

    await _ensure_default_alert_rules()

    # Start RabbitMQ consumer in background
    stop_event = asyncio.Event()
    consumer_task: asyncio.Task | None = None
    if settings.RABBITMQ_ENABLED:
        consumer_task = asyncio.create_task(start_consumer(stop_event))

    yield

    if consumer_task is not None:
        stop_event.set()
        consumer_task.cancel()
        with suppress(asyncio.CancelledError):
            await consumer_task
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)

app.include_router(notifications_router, prefix="/api/v1")
app.include_router(smtp_router, prefix="/api/v1")
app.include_router(alert_rules_router, prefix="/api/v1")
app.include_router(internal_router, prefix="/api/v1")


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    return {"service": "notification", "status": "running"}


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"service": "notification", "status": "ok"}
