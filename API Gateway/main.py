import asyncio
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "API Gateway"
    APP_PORT: int = 8000

    AUTH_SERVICE_URL: str = "http://users-service:8001"
    SALE_SERVICE_URL: str = "http://sale-service:8003"
    INVENTORY_SERVICE_URL: str = "http://inventory-service:8002"
    REPORT_SERVICE_URL: str = "http://report-service:8004"
    STORE_SERVICE_URL: str = "http://store-service:8005"
    CATALOG_SERVICE_URL: str = "http://catalog-service:8006"
    CUSTOMER_SERVICE_URL: str = "http://customer-service:8007"
    PAYMENT_QR_SERVICE_URL: str = "http://payment-qr-service:8008"

    CORS_ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
    ]

    MAX_REQUEST_BODY_SIZE: int = 20 * 1024 * 1024  # 20MB

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
app = FastAPI(title=settings.APP_NAME, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)


SERVICE_URLS: dict[str, str] = {
    "auth": settings.AUTH_SERVICE_URL,
    "users": settings.AUTH_SERVICE_URL,
    "sale": settings.SALE_SERVICE_URL,
    "inventory": settings.INVENTORY_SERVICE_URL,
    "report": settings.REPORT_SERVICE_URL,
    "store": settings.STORE_SERVICE_URL,
    "catalog": settings.CATALOG_SERVICE_URL,
    "customer": settings.CUSTOMER_SERVICE_URL,
    "payment-qr": settings.PAYMENT_QR_SERVICE_URL,
}

HEALTH_TARGETS: dict[str, str] = {
    "users": settings.AUTH_SERVICE_URL,
    "inventory": settings.INVENTORY_SERVICE_URL,
    "sale": settings.SALE_SERVICE_URL,
    "report": settings.REPORT_SERVICE_URL,
    "store": settings.STORE_SERVICE_URL,
    "catalog": settings.CATALOG_SERVICE_URL,
    "customer": settings.CUSTOMER_SERVICE_URL,
    "payment-qr": settings.PAYMENT_QR_SERVICE_URL,
}


@app.on_event("startup")
async def startup_event() -> None:
    app.state.http_client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
    app.state.customer_display_states: dict[str, dict[str, Any]] = {}


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await app.state.http_client.aclose()


async def _check_service_health(name: str, base_url: str) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/health"
    started_at = perf_counter()

    try:
        response = await app.state.http_client.get(url)
        latency_ms = round((perf_counter() - started_at) * 1000, 2)
        payload: dict[str, Any] = {}
        try:
            payload = response.json()
        except ValueError:
            payload = {}

        upstream_status = str(payload.get("status", "")).lower()
        is_up = response.status_code == 200 and upstream_status in {"ok", "running"}
        return {
            "name": name,
            "url": url,
            "status": "up" if is_up else "degraded",
            "http_status": response.status_code,
            "latency_ms": latency_ms,
            "detail": None if is_up else (payload.get("detail") or payload.get("message") or "Unexpected response"),
            "upstream": payload or None,
        }
    except httpx.RequestError as exc:
        latency_ms = round((perf_counter() - started_at) * 1000, 2)
        return {
            "name": name,
            "url": url,
            "status": "down",
            "http_status": None,
            "latency_ms": latency_ms,
            "detail": str(exc),
            "upstream": None,
        }


@app.get("/api/v1/system/health")
async def services_health() -> dict[str, Any]:
    checks = await asyncio.gather(
        *[_check_service_health(name, service_url) for name, service_url in HEALTH_TARGETS.items()]
    )
    down_count = sum(1 for item in checks if item["status"] == "down")
    degraded_count = sum(1 for item in checks if item["status"] == "degraded")

    overall = "up"
    if down_count:
        overall = "down"
    elif degraded_count:
        overall = "degraded"

    return {
        "status": overall,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "services": checks,
        "summary": {
            "total": len(checks),
            "up": sum(1 for item in checks if item["status"] == "up"),
            "degraded": degraded_count,
            "down": down_count,
        },
    }


@app.post("/api/v1/system/customer-display/state")
async def set_customer_display_state(request: Request) -> dict[str, Any]:
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    screen_id = str(payload.get("screen_id", "default")).strip() or "default"
    if len(screen_id) > 64:
        raise HTTPException(status_code=400, detail="screen_id is too long")

    state = payload.get("state")
    if not isinstance(state, dict):
        raise HTTPException(status_code=400, detail="state must be an object")

    updated_at = datetime.now(timezone.utc).isoformat()
    app.state.customer_display_states[screen_id] = {
        "screen_id": screen_id,
        "updated_at": updated_at,
        "state": state,
    }
    return {
        "message": "customer display state updated",
        "screen_id": screen_id,
        "updated_at": updated_at,
    }


@app.get("/api/v1/system/customer-display/state")
async def get_customer_display_state(screen_id: str = "default") -> dict[str, Any]:
    normalized = screen_id.strip() or "default"
    current = app.state.customer_display_states.get(normalized)
    if current:
        return current
    return {
        "screen_id": normalized,
        "updated_at": None,
        "state": None,
    }


@app.api_route(
    "/api/v1/{service}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
@app.api_route(
    "/api/v1/{service}/{resource_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(service: str, request: Request, resource_path: str = "") -> Response:
    target_service_url = SERVICE_URLS.get(service)
    if target_service_url is None:
        raise HTTPException(status_code=404, detail=f"Unknown service '{service}'")

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.MAX_REQUEST_BODY_SIZE:
        raise HTTPException(status_code=413, detail="Request body too large")

    base_path = f"{target_service_url.rstrip('/')}/api/v1/{service}"
    target_url = f"{base_path}/{resource_path}" if resource_path else base_path

    filtered_headers: dict[str, Any] = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length"}
    }

    request_body = await request.body()

    try:
        upstream_response = await app.state.http_client.request(
            method=request.method,
            url=target_url,
            params=request.query_params,
            content=request_body,
            headers=filtered_headers,
        )
    except httpx.RequestError as exc:
        import logging
        logging.getLogger("api_gateway").error("Upstream error for service=%s: %s", service, exc)
        raise HTTPException(status_code=502, detail="Service temporarily unavailable") from exc

    response_headers = {
        key: value
        for key, value in upstream_response.headers.items()
        if key.lower() not in {"content-encoding", "transfer-encoding", "connection"}
    }

    return Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
        headers=response_headers,
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"service": "api-gateway", "status": "ok"}
