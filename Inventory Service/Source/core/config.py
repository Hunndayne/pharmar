from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "Inventory Service"
    APP_PORT: int = 8002

    REDIS_URL: str = "redis://redis:6379/0"
    DATABASE_URL: str = "postgresql://postgres:postgres@postgres:5432/pharmar_inventory"
    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"
    FEFO_THRESHOLD_DAYS: int = 180
    CATALOG_SERVICE_URL: str = "http://catalog-service:8006"
    STORE_SERVICE_URL: str = "http://store-service:8005"
    CATALOG_SYNC_TTL_SECONDS: int = 60
    CATALOG_SYNC_PAGE_SIZE: int = 200
    CATALOG_SYNC_TIMEOUT_SECONDS: float = 8.0
    STORE_SETTINGS_TIMEOUT_SECONDS: float = 3.0
    STORE_SETTINGS_TTL_SECONDS: int = 30
    STATE_FILE_PATH: str = "/data/runtime_state.json"
    STATE_PERSISTENCE: str = "postgres"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
