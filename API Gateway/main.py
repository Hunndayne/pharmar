import asyncio
import base64
import hashlib
import ipaddress
import json
import logging
import re
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
from jose import JWTError, jwt
from pydantic_settings import BaseSettings, SettingsConfigDict

from request_rules import (
    is_login_endpoint,
    max_body_size_for,
    normalize_resource_path,
)

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
    AI_SERVICE_URL: str = "http://ai-service:8011"

    REDIS_URL: str = "redis://redis:6379/0"

    CORS_ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
    ]

    # Ceiling for routes that legitimately carry big bodies (file upload, AI
    # invoice, Store backup). Every other route is capped much lower, see
    # request_rules.max_body_size_for().
    MAX_REQUEST_BODY_SIZE: int = 100 * 1024 * 1024

    # Shared with the Users service; needed to verify access tokens on the few
    # gateway-local endpoints (customer display, detailed health). Empty means
    # those endpoints fail closed (503).
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"

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


# AI extraction can take ~90s upstream (vision model + agent loop).
AI_PROXY_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

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
    "ai": settings.AI_SERVICE_URL,
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
    "ai": settings.AI_SERVICE_URL,
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
# Local JWT verification for gateway-owned endpoints (everything else is
# authenticated by the upstream services).
# ---------------------------------------------------------------------------
async def _verify_access_token(request: Request) -> dict[str, Any]:
    """Return verified JWT claims or raise 401/503."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not settings.JWT_SECRET_KEY:
        logger.error("JWT_SECRET_KEY is not configured on the gateway; refusing token-protected endpoint")
        raise HTTPException(status_code=503, detail="Authentication is not configured")
    try:
        claims = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    if claims.get("type") not in (None, "access"):
        raise HTTPException(status_code=401, detail="Invalid token type")
    if await _is_token_blacklisted(token):
        raise HTTPException(status_code=401, detail="Token has been revoked. Please log in again.")
    return claims


async def _read_body_capped(request: Request, limit: int) -> bytes:
    """Read the request body, aborting with 413 as soon as `limit` is exceeded.

    Checks Content-Length up front (nothing is read if it already exceeds the
    cap) and also enforces the cap while streaming, so chunked uploads without
    a Content-Length cannot buffer unbounded data.
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared = int(content_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header")
        if declared > limit:
            raise HTTPException(status_code=413, detail="Request body too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="Request body too large")
        chunks.append(chunk)
    return b"".join(chunks)


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


def _valid_ip_or_none(value: str) -> str | None:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


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
async def services_health(request: Request) -> dict[str, Any]:
    # Anonymous callers only learn the coarse status: the detailed payload
    # exposes internal service URLs and upstream exception text.
    detailed = False
    if request.headers.get("authorization", "").lower().startswith("bearer "):
        try:
            claims = await _verify_access_token(request)
            detailed = str(claims.get("role", "")).lower() in {"owner", "manager"}
        except HTTPException:
            detailed = False

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

    if not detailed:
        return {"status": "ok" if overall == "up" else "degraded"}

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


_SCREEN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_DISPLAY_MAX_BODY_BYTES = 1024 * 1024


def _validated_screen_id(raw: Any) -> str:
    """The screen id is the display's only read credential, so it must be unguessable."""
    screen_id = str(raw or "").strip()
    if screen_id == "default" or not _SCREEN_ID_RE.fullmatch(screen_id):
        raise HTTPException(
            status_code=400,
            detail="screen_id must be 16-64 characters of A-Z a-z 0-9 _ - and not 'default'",
        )
    return screen_id


@app.post("/api/v1/system/customer-display/state")
async def set_customer_display_state(request: Request) -> dict[str, Any]:
    await _verify_access_token(request)

    raw_body = await _read_body_capped(request, _DISPLAY_MAX_BODY_BYTES)
    try:
        payload = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid payload")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")

    screen_id = _validated_screen_id(payload.get("screen_id"))

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
async def get_customer_display_state(screen_id: str = "") -> dict[str, Any]:
    # No JWT here: the display runs on a second screen without a login, so the
    # unguessable screen_id is the credential.
    normalized = _validated_screen_id(screen_id)
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
    normalized_resource = normalize_resource_path(resource_path)
    first_segment = normalized_resource.split("/", 1)[0]
    if first_segment.lower() == "internal":
        raise HTTPException(status_code=404, detail="Not found")

    # ------------------------------------------------------------------
    # Rate limiting — stricter for auth endpoints and public lookup endpoints
    # ------------------------------------------------------------------
    is_auth_endpoint = is_login_endpoint(service, normalized_resource)
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
    # Body-size guard — checked before anything is buffered. Only upload-style
    # routes get the large ceiling; see request_rules.max_body_size_for().
    # ------------------------------------------------------------------
    body_limit = max_body_size_for(service, normalized_resource, settings.MAX_REQUEST_BODY_SIZE)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > body_limit:
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
        if key.lower() not in {"host", "content-length", "x-internal-api-key", "x-client-ip"}
    }

    # Clients cannot choose their own X-Client-IP (stripped above); the Users
    # service keys its login rate limit / lockout on this trusted value.
    trusted_client_ip = _valid_ip_or_none(client_ip)
    if trusted_client_ip:
        filtered_headers["x-client-ip"] = trusted_client_ip

    # Forward correlation ID to upstream services.
    req_id = getattr(request.state, "request_id", None)
    if req_id:
        filtered_headers["x-request-id"] = req_id

    request_body = await _read_body_capped(request, body_limit)

    try:
        upstream_response = await app.state.http_client.request(
            method=request.method,
            url=target_url,
            params=request.query_params,
            content=request_body,
            headers=filtered_headers,
            timeout=AI_PROXY_TIMEOUT if service == "ai" else httpx.USE_CLIENT_DEFAULT,
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
