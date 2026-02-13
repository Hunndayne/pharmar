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

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
app = FastAPI(title=settings.APP_NAME, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


SERVICE_URLS: dict[str, str] = {
    "auth": settings.AUTH_SERVICE_URL,
    "users": settings.AUTH_SERVICE_URL,
    "sale": settings.SALE_SERVICE_URL,
    "inventory": settings.INVENTORY_SERVICE_URL,
    "report": settings.REPORT_SERVICE_URL,
}


@app.on_event("startup")
async def startup_event() -> None:
    app.state.http_client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await app.state.http_client.aclose()


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
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {exc}") from exc

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
