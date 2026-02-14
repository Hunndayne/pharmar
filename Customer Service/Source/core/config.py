from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    APP_NAME: str = "Customer Service"
    APP_ENV: str = "development"
    APP_PORT: int = 8007

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/pharmar_customer"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"

    INTERNAL_API_KEY: str = "change-this-internal-key"
    STORE_SERVICE_URL: str = "http://store-service:8005"

    ENABLE_POINTS_EXPIRY_JOB: bool = True
    POINTS_EXPIRY_JOB_INTERVAL_HOURS: int = 24

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

