from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from Routers.MasterData import router as master_data_router
from Routers.Products import router as products_router
from Routers.ReferenceDrugs import router as reference_drugs_router

from .catalog import backfill_product_unit_roles
from .core.config import get_settings
from .db import models  # noqa: F401
from .db.base import Base
from .db.models import SCHEMA_NAME
from .reference_drug import drug_reference_store
from .db.session import SessionLocal, engine


settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate_secrets()

    async with engine.begin() as connection:
        await connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA_NAME}"))
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.products
                ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0
                """
            )
        )
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.products
                ADD COLUMN IF NOT EXISTS other_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0
                """
            )
        )
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.products
                ADD COLUMN IF NOT EXISTS active_ingredient TEXT
                """
            )
        )
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.products
                ALTER COLUMN active_ingredient TYPE TEXT
                """
            )
        )
        await connection.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS idx_products_name
                ON {SCHEMA_NAME}.products USING gin(to_tsvector('simple', name))
                """
            )
        )
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.product_units
                ADD COLUMN IF NOT EXISTS unit_role VARCHAR(20)
                """
            )
        )
        await connection.execute(
            text(
                f"""
                ALTER TABLE {SCHEMA_NAME}.product_units
                DROP CONSTRAINT IF EXISTS uq_product_units_product_unit_name
                """
            )
        )
        await connection.execute(
            text(
                f"""
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'uq_product_units_product_unit_role'
                    ) THEN
                        ALTER TABLE {SCHEMA_NAME}.product_units
                        ADD CONSTRAINT uq_product_units_product_unit_role
                        UNIQUE (product_id, unit_role);
                    END IF;
                END
                $$;
                """
            )
        )

    async with SessionLocal() as session:
        await backfill_product_unit_roles(session)

    drug_reference_store.warmup()

    yield
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

app.include_router(master_data_router, prefix="/api/v1")
app.include_router(products_router, prefix="/api/v1")
app.include_router(reference_drugs_router, prefix="/api/v1")


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    return {"service": "catalog", "status": "running"}


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"service": "catalog", "status": "ok"}
