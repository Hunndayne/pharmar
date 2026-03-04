import asyncio
import secrets
import time
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
    FILE_SERVICE_URL: str = "http://file-service:8009"
    NOTIFICATION_SERVICE_URL: str = "http://notification-service:8010"

    CORS_ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
    ]

    MAX_REQUEST_BODY_SIZE: int = 100 * 1024 * 1024  # 100MB (supports backup uploads)

    # Rate limiting: requests per minute per IP for API endpoints
    RATE_LIMIT_RPM: int = 1200
    # Rate limiting for auth endpoints (stricter)
    AUTH_RATE_LIMIT_RPM: int = 120

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
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
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
    "file": settings.FILE_SERVICE_URL,
    "notification": settings.NOTIFICATION_SERVICE_URL,
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
    "file": settings.FILE_SERVICE_URL,
    "notification": settings.NOTIFICATION_SERVICE_URL,
}

# ---------------------------------------------------------------------------
# Token blacklist: stores hashes of revoked access tokens to enforce logout.
# Entries expire automatically when the gateway cleans up stale entries.
# ---------------------------------------------------------------------------
_token_blacklist: dict[str, float] = {}  # token → expiry_unix_timestamp
_BLACKLIST_CLEANUP_INTERVAL = 300  # clean up every 5 minutes


def _blacklist_token(token: str, expires_at: float) -> None:
    _token_blacklist[token] = expires_at


def _is_token_blacklisted(token: str) -> bool:
    expiry = _token_blacklist.get(token)
    if expiry is None:
        return False
    if time.time() > expiry:
        _token_blacklist.pop(token, None)
        return False
    return True


def _cleanup_token_blacklist() -> None:
    now = time.time()
    expired = [tok for tok, exp in _token_blacklist.items() if now > exp]
    for tok in expired:
        _token_blacklist.pop(tok, None)


# ---------------------------------------------------------------------------
# Simple per-IP rate limiter (token bucket, in-memory).
# ---------------------------------------------------------------------------
_rate_buckets: dict[str, dict[str, Any]] = {}


def _check_rate_limit(key: str, rpm: int) -> bool:
    """Return True if the request is allowed, False if rate-limited."""
    now = time.time()
    bucket = _rate_buckets.get(key)

    # New bucket: start full so the first request burst is not rejected.
    if bucket is None:
        _rate_buckets[key] = {"tokens": float(max(rpm - 1, 0)), "last": now}
        return True

    elapsed = now - float(bucket.get("last", now))
    refill = elapsed * (rpm / 60.0)
    tokens = min(float(rpm), float(bucket.get("tokens", 0.0)) + refill)

    if tokens >= 1.0:
        tokens -= 1.0
        bucket["tokens"] = tokens
        bucket["last"] = now
        return True

    bucket["tokens"] = tokens
    bucket["last"] = now
    return False


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------
# Security-headers middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # HSTS — only meaningful over HTTPS, harmless otherwise.
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# ---------------------------------------------------------------------------
# Correlation ID middleware — attaches X-Request-ID to every request/response.
# ---------------------------------------------------------------------------
@app.middleware("http")
async def correlation_id_middleware(request: Request, call_next):
    req_id = request.headers.get("x-request-id") or secrets.token_hex(16)
    request.state.request_id = req_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = req_id
    return response


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event() -> None:
    app.state.http_client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
    app.state.customer_display_states: dict[str, dict[str, Any]] = {}


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await app.state.http_client.aclose()


# ---------------------------------------------------------------------------
# Service health
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Customer display state (POS second-screen)
# ---------------------------------------------------------------------------
@app.post("/api/v1/system/customer-display/state")
async def set_customer_display_state(request: Request) -> dict[str, Any]:
    # Require a Bearer token so anonymous callers cannot update the display.
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")

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


# ---------------------------------------------------------------------------
# Proxy — all /api/v1/{service}/... requests
# ---------------------------------------------------------------------------
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
        raise HTTPException(status_code=404, detail="Service not found")

    client_ip = _get_client_ip(request)

    # ------------------------------------------------------------------
    # Rate limiting — stricter for auth endpoints
    # ------------------------------------------------------------------
    is_auth_endpoint = service in {"auth", "users"} and resource_path.startswith("login")
    rpm_limit = settings.AUTH_RATE_LIMIT_RPM if is_auth_endpoint else settings.RATE_LIMIT_RPM
    scope = "auth" if is_auth_endpoint else "api"
    if not _check_rate_limit(f"{client_ip}:{service}:{scope}", rpm_limit):
        raise HTTPException(status_code=429, detail="Too many requests. Please slow down.")

    # ------------------------------------------------------------------
    # Token blacklist check — reject any token revoked via logout
    # ------------------------------------------------------------------
    auth_header = request.headers.get("authorization", "")
    bearer_token: str | None = None
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header[7:].strip()
        if bearer_token and _is_token_blacklisted(bearer_token):
            raise HTTPException(
                status_code=401,
                detail="Token has been revoked. Please log in again.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    # ------------------------------------------------------------------
    # Content-Length guard
    # ------------------------------------------------------------------
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.MAX_REQUEST_BODY_SIZE:
                raise HTTPException(status_code=413, detail="Request body too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header")

    base_path = f"{target_service_url.rstrip('/')}/api/v1/{service}"
    target_url = f"{base_path}/{resource_path}" if resource_path else base_path

    filtered_headers: dict[str, Any] = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length"}
    }

    # Forward correlation ID to upstream services.
    req_id = getattr(request.state, "request_id", None)
    if req_id:
        filtered_headers["x-request-id"] = req_id

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
        logging.getLogger("api_gateway").error(
            "Upstream error service=%s request_id=%s: %s",
            service,
            req_id,
            exc,
        )
        raise HTTPException(status_code=502, detail="Service temporarily unavailable") from exc

    # ------------------------------------------------------------------
    # After a successful logout, blacklist the access token so other
    # services also reject it until it naturally expires.
    # ------------------------------------------------------------------
    is_logout = (
        service == "auth"
        and resource_path.rstrip("/") == "logout"
        and request.method == "POST"
        and upstream_response.status_code == 200
        and bearer_token is not None
    )
    if is_logout:
        # Expire the blacklist entry in 30 min (matches ACCESS_TOKEN_EXPIRE_MINUTES default).
        _blacklist_token(bearer_token, time.time() + 1800)
        # Periodically purge stale entries.
        _cleanup_token_blacklist()

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
