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
    APP_NAME: str = "Catalog Service"
    APP_ENV: str = "development"
    APP_PORT: int = 8006

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5434/pharmar_catalog"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"

    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    SALE_SERVICE_URL: str = "http://sale-service:8003"

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

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

