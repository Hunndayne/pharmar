import asyncio
import base64
import hashlib
import ipaddress
import json
import posixpath
import logging
import secrets
import time
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

import httpx
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("api_gateway")


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

    REDIS_URL: str = "redis://redis:6379/0"

    CORS_ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
    ]

    MAX_REQUEST_BODY_SIZE: int = 100 * 1024 * 1024  # 100MB (supports backup uploads)

    # Rate limiting: requests per minute per IP for API endpoints
    RATE_LIMIT_RPM: int = 1200
    # Rate limiting for auth endpoints (stricter)
    AUTH_RATE_LIMIT_RPM: int = 120
    # Rate limiting for unauthenticated public lookup endpoints (stricter still —
    # these are enumerable by phone/code and have no auth to slow down attackers).
    PUBLIC_RATE_LIMIT_RPM: int = 30

    # IPs/CIDR networks allowed to set X-Forwarded-For (e.g. the reverse proxy
    # in front of this gateway). Empty by default so XFF is never trusted from
    # an arbitrary client — fail secure against rate-limit bypass via spoofing.
    TRUSTED_PROXY_IPS: list[str] = []

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

# Parsed once at import time so we don't re-parse CIDR strings on every request.
# Invalid entries are logged and skipped rather than crashing startup.
_TRUSTED_PROXY_NETWORKS: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
for _entry in settings.TRUSTED_PROXY_IPS:
    try:
        _TRUSTED_PROXY_NETWORKS.append(ipaddress.ip_network(_entry, strict=False))
    except ValueError as _exc:
        logger.warning("Ignoring invalid TRUSTED_PROXY_IPS entry %r: %s", _entry, _exc)

app = FastAPI(title=settings.APP_NAME, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)
# Compresses responses (>=1KB) before they go out over the wire. Safe here
# because the proxy always returns fully-buffered upstream content with the
# upstream Content-Encoding header stripped (see `proxy()`), so there is no
# risk of double-compressing an already-encoded body.
app.add_middleware(GZipMiddleware, minimum_size=1024)


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
# Token blacklist: stores hashes of revoked access tokens in Redis so logout
# is enforced across gateway restarts and multiple replicas.
# ---------------------------------------------------------------------------
_FALLBACK_BLACKLIST_TTL = 1800  # used only if the token's exp claim can't be read


def _decode_jwt_payload(token: str) -> dict[str, Any] | None:
    """Best-effort decode of a JWT payload WITHOUT verifying the signature.

    The gateway does not hold the JWT signing secret, so this must never be
    used for authorization decisions — only to read the `exp` claim so the
    blacklist TTL matches the token's real remaining lifetime.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64 + padding)
        return json.loads(payload_bytes)
    except Exception:
        return None


def _token_ttl_seconds(token: str) -> int:
    payload = _decode_jwt_payload(token)
    if payload is None:
        return _FALLBACK_BLACKLIST_TTL
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return _FALLBACK_BLACKLIST_TTL
    return max(int(exp - time.time()), 60)


def _blacklist_key(token: str) -> str:
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return f"gw:blacklist:{digest}"


async def _blacklist_token(token: str) -> None:
    redis_client = getattr(app.state, "redis", None)
    if redis_client is None:
        return
    try:
        await redis_client.set(_blacklist_key(token), "1", ex=_token_ttl_seconds(token))
    except Exception as exc:
        logger.warning("Redis unreachable while blacklisting token, logout may not propagate: %s", exc)


async def _is_token_blacklisted(token: str) -> bool:
    redis_client = getattr(app.state, "redis", None)
    if redis_client is None:
        return False
    try:
        value = await redis_client.get(_blacklist_key(token))
        return value is not None
    except Exception as exc:
        logger.warning("Redis unreachable while checking token blacklist, failing open: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Per-IP rate limiter — Redis fixed-window counter (one window per minute).
# ---------------------------------------------------------------------------
async def _check_rate_limit(key: str, rpm: int) -> bool:
    """Return True if the request is allowed, False if rate-limited."""
    redis_client = getattr(app.state, "redis", None)
    if redis_client is None:
        return True

    unix_minute = int(time.time() // 60)
    redis_key = f"gw:rl:{key}:{unix_minute}"
    try:
        count = await redis_client.incr(redis_key)
        if count == 1:
            await redis_client.expire(redis_key, 90)
    except Exception as exc:
        logger.warning("Redis unreachable while rate limiting, failing open: %s", exc)
        return True

    return count <= rpm


def _get_client_ip(request: Request) -> str:
    direct_host = request.client.host if request.client else None

    # Only honor X-Forwarded-For when the immediate peer is a trusted proxy
    # (e.g. nginx/docker in front of this gateway) — otherwise any client can
    # spoof the header to bypass rate limiting.
    is_trusted_proxy = False
    if direct_host and _TRUSTED_PROXY_NETWORKS:
        try:
            direct_ip = ipaddress.ip_address(direct_host)
            is_trusted_proxy = any(direct_ip in network for network in _TRUSTED_PROXY_NETWORKS)
        except ValueError:
            is_trusted_proxy = False

    if is_trusted_proxy:
        # Behind Cloudflare (Tunnel/proxy) the verified client IP lives in
        # CF-Connecting-IP. X-Forwarded-For is NOT safe there: Cloudflare only
        # appends the real IP at the END, so the first entry remains whatever
        # the client sent. Prefer the CF header, fall back to XFF for plain
        # nginx setups.
        cf_ip = request.headers.get("cf-connecting-ip", "").strip()
        if cf_ip:
            return cf_ip
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()

    return direct_host or "unknown"


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
    # redis.asyncio connects lazily on first command, so a Redis outage at
    # startup does not block the gateway from coming up; per-call try/except
    # blocks around every Redis usage fail open if it's unreachable later.
    app.state.redis = redis.from_url(settings.REDIS_URL, decode_responses=True)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    await app.state.http_client.aclose()
    redis_client = getattr(app.state, "redis", None)
    if redis_client is not None:
        try:
            await redis_client.aclose()
        except Exception as exc:
            logger.warning("Error closing Redis client on shutdown: %s", exc)


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
# Customer display state (POS second-screen) — stored in Redis so it survives
# gateway restarts and is shared across worker processes/replicas. Stale
# display state has no value beyond a shift, hence the 6h TTL.
# ---------------------------------------------------------------------------
_DISPLAY_STATE_TTL = 6 * 60 * 60  # 6 hours


def _display_state_key(screen_id: str) -> str:
    return f"gw:display:{screen_id}"


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
    record = {
        "screen_id": screen_id,
        "updated_at": updated_at,
        "state": state,
    }

    redis_client = getattr(app.state, "redis", None)
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Display state store is unavailable")
    try:
        await redis_client.set(
            _display_state_key(screen_id),
            json.dumps(record),
            ex=_DISPLAY_STATE_TTL,
        )
    except Exception as exc:
        logger.warning("Redis unreachable while writing customer display state: %s", exc)
        raise HTTPException(status_code=503, detail="Display state store is unavailable") from exc

    return {
        "message": "customer display state updated",
        "screen_id": screen_id,
        "updated_at": updated_at,
    }


@app.get("/api/v1/system/customer-display/state")
async def get_customer_display_state(screen_id: str = "default") -> dict[str, Any]:
    normalized = screen_id.strip() or "default"
    empty_state = {
        "screen_id": normalized,
        "updated_at": None,
        "state": None,
    }

    redis_client = getattr(app.state, "redis", None)
    if redis_client is None:
        logger.warning("Redis unavailable while reading customer display state for screen_id=%s", normalized)
        return empty_state

    try:
        raw = await redis_client.get(_display_state_key(normalized))
    except Exception as exc:
        logger.warning("Redis unreachable while reading customer display state: %s", exc)
        return empty_state

    if raw is None:
        return empty_state

    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        logger.warning("Corrupt customer display state for screen_id=%s: %s", normalized, exc)
        return empty_state


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
    # Internal endpoints are service-to-service only (guarded upstream by
    # X-Internal-API-Key). The gateway must never let external clients reach
    # them — 404 rather than 403 so we don't even confirm they exist.
    # ------------------------------------------------------------------
    # Dot-segments must be collapsed BEFORE the check ("x/../internal/y" would
    # otherwise pass it, then httpx collapses them the same way when building
    # the upstream URL and the request lands on the internal endpoint anyway).
    normalized_resource = posixpath.normpath("/" + resource_path).lstrip("/")
    first_segment = normalized_resource.split("/", 1)[0]
    if first_segment.lower() == "internal":
        raise HTTPException(status_code=404, detail="Not found")

    # ------------------------------------------------------------------
    # Rate limiting — stricter for auth endpoints and public lookup endpoints
    # ------------------------------------------------------------------
    is_auth_endpoint = service in {"auth", "users"} and resource_path.startswith("login")
    is_public_endpoint = normalized_resource.startswith("public/")
    if is_auth_endpoint:
        rpm_limit = settings.AUTH_RATE_LIMIT_RPM
        scope = "auth"
    elif is_public_endpoint:
        rpm_limit = settings.PUBLIC_RATE_LIMIT_RPM
        scope = "public"
    else:
        rpm_limit = settings.RATE_LIMIT_RPM
        scope = "api"
    if not await _check_rate_limit(f"{client_ip}:{service}:{scope}", rpm_limit):
        raise HTTPException(status_code=429, detail="Too many requests. Please slow down.")

    # ------------------------------------------------------------------
    # Token blacklist check — reject any token revoked via logout
    # ------------------------------------------------------------------
    auth_header = request.headers.get("authorization", "")
    bearer_token: str | None = None
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header[7:].strip()
        if bearer_token and await _is_token_blacklisted(bearer_token):
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

    # x-internal-api-key guards service-to-service internal endpoints; services
    # call each other directly (not through this gateway), so external clients
    # must never be able to smuggle this header upstream. x-sync-api-key is
    # intentionally NOT stripped — Store backup sync legitimately goes
    # gateway-to-gateway with that header.
    filtered_headers: dict[str, Any] = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length", "x-internal-api-key"}
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
        logger.error(
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
        # TTL is derived from the token's own `exp` claim (see _token_ttl_seconds),
        # falling back to 1800s only if the token can't be parsed.
        await _blacklist_token(bearer_token)

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
