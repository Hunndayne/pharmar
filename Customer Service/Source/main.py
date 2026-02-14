import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from Routers.Customers import router as customers_router
from Routers.Internal import router as internal_router
from Routers.Promotions import router as promotions_router
from Routers.Tiers import router as tiers_router

from .core.config import get_settings
from .customer import ensure_default_tiers, expire_due_points
from .db import models  # noqa: F401
from .db.base import Base
from .db.models import SCHEMA_NAME
from .db.session import SessionLocal, engine


settings = get_settings()


async def _points_expiry_worker(stop_event: asyncio.Event) -> None:
    interval_seconds = max(settings.POINTS_EXPIRY_JOB_INTERVAL_HOURS, 1) * 3600
    while not stop_event.is_set():
        try:
            async with SessionLocal() as session:
                await expire_due_points(session)
        except Exception:
            pass

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            continue


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as connection:
        await connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA_NAME}"))
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS idx_customers_name
                ON {SCHEMA_NAME}.customers USING gin(to_tsvector('simple', name))
                """
            )
        )
        await connection.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS idx_promotions_active
                ON {SCHEMA_NAME}.promotions(is_active)
                WHERE is_active = true
                """
            )
        )

    async with SessionLocal() as session:
        await ensure_default_tiers(session)

    stop_event = asyncio.Event()
    worker_task: asyncio.Task | None = None
    if settings.ENABLE_POINTS_EXPIRY_JOB:
        worker_task = asyncio.create_task(_points_expiry_worker(stop_event))

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

app.include_router(customers_router, prefix="/api/v1")
app.include_router(tiers_router, prefix="/api/v1")
app.include_router(promotions_router, prefix="/api/v1")
app.include_router(internal_router, prefix="/api/v1")


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    return {"service": "customer", "status": "running"}


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"service": "customer", "status": "ok"}
