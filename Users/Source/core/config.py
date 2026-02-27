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
    APP_NAME: str = "Users Service"
    APP_ENV: str = "development"
    APP_PORT: int = 8001

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/pharmar_auth"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    DEFAULT_OWNER_USERNAME: str = "admin"
    DEFAULT_OWNER_PASSWORD: str = "admin"
    DEFAULT_OWNER_FULL_NAME: str = "System Owner"

    CORS_ALLOWED_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    def validate_secrets(self) -> None:
        """Raise RuntimeError in production if weak/default secrets are detected."""
        import logging
        logger = logging.getLogger(self.APP_NAME)
        if self.JWT_SECRET_KEY in _WEAK_SECRETS or len(self.JWT_SECRET_KEY) < 16:
            if self.APP_ENV == "production":
                raise RuntimeError(
                    "JWT_SECRET_KEY is a weak or default value. "
                    "Set a strong secret (>=32 chars) before running in production."
                )
            logger.warning("WARNING: JWT_SECRET_KEY is using a weak/default value. Change before production deploy.")
        _default_passwords = _WEAK_SECRETS | {"admin", "123456", "admin123"}
        if self.DEFAULT_OWNER_PASSWORD in _default_passwords or len(self.DEFAULT_OWNER_PASSWORD) < 8:
            if self.APP_ENV == "production":
                raise RuntimeError(
                    "DEFAULT_OWNER_PASSWORD is using a weak or default value. "
                    "Set a strong password via DEFAULT_OWNER_PASSWORD env variable before production."
                )
            logger.warning(
                "WARNING: DEFAULT_OWNER_PASSWORD is weak or default. "
                "Change before production deploy."
            )

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
