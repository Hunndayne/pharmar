import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from Routers.HeldOrders import router as held_orders_router
from Routers.Invoices import router as invoices_router
from Routers.PaymentMethods import router as payment_methods_router
from Routers.Returns import router as returns_router
from Routers.Stats import router as stats_router
# NOTE: Shift open/close feature is temporarily disabled.
# from Routers.Shifts import router as shifts_router

from .core.config import get_settings
from .db import models  # noqa: F401
from .db.base import Base
from .db.models import PaymentMethod, SCHEMA_NAME
from .db.session import SessionLocal, engine
from .sale import DEFAULT_PAYMENT_METHODS, cleanup_expired_held_orders


settings = get_settings()


async def _cleanup_worker(stop_event: asyncio.Event) -> None:
    interval_seconds = max(settings.HELD_ORDER_CLEANUP_INTERVAL_MINUTES, 1) * 60
    while not stop_event.is_set():
        try:
            async with SessionLocal() as session:
                await cleanup_expired_held_orders(session)
        except Exception:
            pass

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            continue


async def _seed_default_payment_methods() -> None:
    async with SessionLocal() as session:
        for item in DEFAULT_PAYMENT_METHODS:
            exists = await session.get(PaymentMethod, item["code"])
            if exists is None:
                session.add(
                    PaymentMethod(
                        code=item["code"],
                        name=item["name"],
                        display_order=item["display_order"],
                        requires_reference=item["requires_reference"],
                        is_active=True,
                    )
                )
        await session.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as connection:
        await connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA_NAME}"))
        await connection.run_sync(Base.metadata.create_all)

    await _seed_default_payment_methods()

    stop_event = asyncio.Event()
    worker_task: asyncio.Task | None = None
    if settings.ENABLE_HELD_ORDER_CLEANUP_JOB:
        worker_task = asyncio.create_task(_cleanup_worker(stop_event))

    yield

    if worker_task is not None:
        stop_event.set()
        worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_task

    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(payment_methods_router, prefix="/api/v1")
app.include_router(invoices_router, prefix="/api/v1")
app.include_router(held_orders_router, prefix="/api/v1")
app.include_router(returns_router, prefix="/api/v1")
# NOTE: Shift open/close feature is temporarily disabled.
# app.include_router(shifts_router, prefix="/api/v1")
app.include_router(stats_router, prefix="/api/v1")


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    return {"service": "sale", "status": "running"}


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"service": "sale", "status": "ok"}
