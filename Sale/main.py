import json
from datetime import datetime, timezone

import httpx
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis


class Settings(BaseSettings):
    APP_NAME: str = "Sale Service"
    APP_PORT: int = 8003

    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    REDIS_URL: str = "redis://redis:6379/0"

    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


class SaleItem(BaseModel):
    sku: str = Field(min_length=1, max_length=64)
    quantity: int = Field(gt=0)
    unit_price: float = Field(gt=0)


class CheckoutRequest(BaseModel):
    sale_id: str = Field(min_length=1, max_length=64)
    customer_id: str | None = Field(default=None, max_length=64)
    items: list[SaleItem] = Field(min_length=1)


class ReserveItemRequest(BaseModel):
    sku: str
    quantity: int


class ReserveRequest(BaseModel):
    sale_id: str
    items: list[ReserveItemRequest]


settings = Settings()
app = FastAPI(title=settings.APP_NAME, version="0.1.0")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_current_subject(token: str) -> str:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    subject = payload.get("sub")
    if subject is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return str(subject)


@app.on_event("startup")
async def startup_event() -> None:
    app.state.http_client = httpx.AsyncClient(timeout=20.0)
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await app.state.http_client.aclose()
    await app.state.redis.aclose()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"service": "sale", "status": "ok"}


@app.post("/api/v1/sale/checkout")
async def checkout(payload: CheckoutRequest, token: str = Depends(oauth2_scheme)) -> dict[str, object]:
    user_id = get_current_subject(token)

    reserve_payload = ReserveRequest(
        sale_id=payload.sale_id,
        items=[ReserveItemRequest(sku=item.sku, quantity=item.quantity) for item in payload.items],
    )
    reserve_response = await app.state.http_client.post(
        f"{settings.INVENTORY_SERVICE_URL}/api/v1/inventory/reserve",
        json=reserve_payload.model_dump(),
        headers={"Authorization": f"Bearer {token}"},
    )
    if reserve_response.status_code >= 400:
        try:
            detail = reserve_response.json().get("detail", "Inventory reservation failed")
        except ValueError:
            detail = reserve_response.text or "Inventory reservation failed"
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)

    total_amount = round(sum(item.quantity * item.unit_price for item in payload.items), 2)
    event_payload = {
        "event_type": "sale.created",
        "sale_id": payload.sale_id,
        "user_id": user_id,
        "customer_id": payload.customer_id or "",
        "total_amount": total_amount,
        "items": [item.model_dump() for item in payload.items],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await app.state.redis.publish("sale.created", json.dumps(event_payload))

    return {
        "message": "Checkout completed",
        "sale_id": payload.sale_id,
        "total_amount": total_amount,
        "event_published": "sale.created",
    }
