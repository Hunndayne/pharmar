from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    APP_NAME: str = "Sale Service"
    APP_ENV: str = "development"
    APP_PORT: int = 8003

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/pharmar_sale"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"

    STORE_SERVICE_URL: str = "http://store-service:8005"
    CATALOG_SERVICE_URL: str = "http://catalog-service:8006"
    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    CUSTOMER_SERVICE_URL: str = "http://customer-service:8007"

    CUSTOMER_INTERNAL_API_KEY: str = "change-this-internal-key"

    HELD_ORDER_EXPIRE_MINUTES: int = 30
    ENABLE_HELD_ORDER_CLEANUP_JOB: bool = True
    HELD_ORDER_CLEANUP_INTERVAL_MINUTES: int = 5

    REQUIRE_SHIFT_FOR_SALE: bool = True

    DEFAULT_COMMISSION_RATE: float = 1.5

    INVOICE_PREFIX: str = "HD"
    RETURN_PREFIX: str = "TH"
    SHIFT_PREFIX: str = "CA"
    HELD_ORDER_PREFIX: str = "HOLD"

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
