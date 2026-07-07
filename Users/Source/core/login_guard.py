"""Per-username brute-force lockout guard, backed by Redis.

Complements slowapi's per-IP rate limit on /auth/login: a distributed attacker
spreading requests across many IPs can still hammer a single account, so we
also track failed attempts per-username. Redis is a hardening layer, not a
source of truth for auth — every function below fails open (treats Redis
outages as "not locked / no-op") so the login flow never breaks because the
cache is unavailable.
"""

import logging

import redis.asyncio as redis

from .config import get_settings


logger = logging.getLogger("users.login_guard")
settings = get_settings()

_redis_client: redis.Redis | None = None

_FAIL_KEY_PREFIX = "auth:lockout:fail:"
_LOCKED_KEY_PREFIX = "auth:lockout:locked:"


def _get_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def _normalize(username: str) -> str:
    return username.strip().lower()


async def close_redis_client() -> None:
    """Close the lazily-created client; safe to call even if never created."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.close()
        _redis_client = None


async def is_locked(username: str) -> int | None:
    """Return remaining lockout seconds, or None if the account isn't locked."""
    key = _LOCKED_KEY_PREFIX + _normalize(username)
    try:
        client = _get_client()
        ttl = await client.ttl(key)
        return ttl if ttl and ttl > 0 else None
    except Exception:
        logger.warning("Redis unavailable while checking lockout for %s; failing open", username, exc_info=True)
        return None


async def record_failure(username: str) -> None:
    """Increment the failure counter and lock the account once the threshold is hit."""
    normalized = _normalize(username)
    fail_key = _FAIL_KEY_PREFIX + normalized
    locked_key = _LOCKED_KEY_PREFIX + normalized
    lockout_seconds = settings.LOGIN_LOCKOUT_MINUTES * 60
    try:
        client = _get_client()
        count = await client.incr(fail_key)
        if count == 1:
            await client.expire(fail_key, lockout_seconds)
        if count >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
            await client.set(locked_key, "1", ex=lockout_seconds)
    except Exception:
        logger.warning("Redis unavailable while recording login failure for %s; skipping", username, exc_info=True)


async def clear_failures(username: str) -> None:
    """Reset lockout state after a successful login."""
    normalized = _normalize(username)
    try:
        client = _get_client()
        await client.delete(_FAIL_KEY_PREFIX + normalized, _LOCKED_KEY_PREFIX + normalized)
    except Exception:
        logger.warning("Redis unavailable while clearing login failures for %s; skipping", username, exc_info=True)
