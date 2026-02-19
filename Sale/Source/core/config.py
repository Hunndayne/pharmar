from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[2]


_WEAK_SECRETS: frozenset[str] = frozenset({
    "change-this-secret",
    "change-this-internal-key",
    "secret",
    "password",
    "changeme",
    "",
})


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

    CORS_ALLOWED_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    def validate_secrets(self) -> None:
        import logging
        logger = logging.getLogger(self.APP_NAME)
        if self.JWT_SECRET_KEY in _WEAK_SECRETS or len(self.JWT_SECRET_KEY) < 16:
            if self.APP_ENV == "production":
                raise RuntimeError(
                    "JWT_SECRET_KEY is a weak or default value. "
                    "Set a strong secret (>=32 chars) before running in production."
                )
            logger.warning("WARNING: JWT_SECRET_KEY is using a weak/default value. Change before production deploy.")
        if self.CUSTOMER_INTERNAL_API_KEY in _WEAK_SECRETS or len(self.CUSTOMER_INTERNAL_API_KEY) < 16:
            if self.APP_ENV == "production":
                raise RuntimeError(
                    "CUSTOMER_INTERNAL_API_KEY is a weak or default value. "
                    "Set a strong key before running in production."
                )
            logger.warning("WARNING: CUSTOMER_INTERNAL_API_KEY is using a weak/default value. Change before production deploy.")

    HELD_ORDER_EXPIRE_MINUTES: int = 30
    ENABLE_HELD_ORDER_CLEANUP_JOB: bool = True
    HELD_ORDER_CLEANUP_INTERVAL_MINUTES: int = 5

    REQUIRE_SHIFT_FOR_SALE: bool = False  # Shifts feature disabled; enable after re-activating the Shifts router

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
