from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    APP_NAME: str = "Catalog Service"
    APP_ENV: str = "development"
    APP_PORT: int = 8006

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5434/pharmar_catalog"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"

    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

