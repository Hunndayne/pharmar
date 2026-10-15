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
    # Chỉ có nghĩa khi STATE_PERSISTENCE=postgres. "blob" = công tắc rollback tức thì: quay về
    # đúng một row JSONB như trước, không đụng tới các bảng inventory_* mới.
    STATE_STORAGE_MODE: str = "relational"  # "relational" | "blob"
    # Giữ blob legacy luôn đồng bộ trong CÙNG transaction với bảng quan hệ để rollback không mất dữ liệu.
    STATE_LEGACY_BLOB_DUAL_WRITE: bool = True

    # Notification Service — trigger restock refresh after nhập hàng
    NOTIFICATION_SERVICE_URL: str = ""  # empty = disabled
    NOTIFICATION_INTERNAL_API_KEY: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
