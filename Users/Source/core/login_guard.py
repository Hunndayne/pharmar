"""Brute-force guard for /auth/login, backed by Redis.

Lockout is keyed on (username, client IP): someone elsewhere on the internet
who types the owner's username wrong five times only locks out *their own* IP,
not the owner at the shop. A distributed attacker spreading guesses over many
IPs is slowed by a looser per-username counter that adds a growing delay
(never a hard lock) once failures pile up across all IPs.

Redis is a hardening layer, not a source of truth for auth — every function
below fails open (treats Redis outages as "not locked / no-op") so the login
flow never breaks because the cache is unavailable.
"""

import logging

import redis.asyncio as redis

from .config import get_settings


logger = logging.getLogger("users.login_guard")
settings = get_settings()

_redis_client: redis.Redis | None = None

_FAIL_KEY_PREFIX = "auth:lockout:fail:"
_LOCKED_KEY_PREFIX = "auth:lockout:locked:"
_GLOBAL_FAIL_KEY_PREFIX = "auth:lockout:gfail:"

# Failures across all IPs before the per-username delay kicks in, and the
# delay added per extra failure (capped).
_GLOBAL_DELAY_THRESHOLD = 20
_GLOBAL_DELAY_STEP_SECONDS = 0.25
_GLOBAL_DELAY_MAX_SECONDS = 5.0


def _get_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def _normalize(username: str) -> str:
    return username.strip().lower()


def _scoped(username: str, ip: str | None) -> str:
    return f"{_normalize(username)}|{ip or 'unknown'}"


async def close_redis_client() -> None:
    """Close the lazily-created client; safe to call even if never created."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.close()
        _redis_client = None


async def is_locked(username: str, ip: str | None = None) -> int | None:
    """Return remaining lockout seconds for this (username, ip), or None."""
    key = _LOCKED_KEY_PREFIX + _scoped(username, ip)
    try:
        client = _get_client()
        ttl = await client.ttl(key)
        return ttl if ttl and ttl > 0 else None
    except Exception:
        logger.warning("Redis unavailable while checking lockout for %s; failing open", username, exc_info=True)
        return None


async def throttle_delay_seconds(username: str) -> float:
    """Extra delay to apply before checking credentials for a heavily-attacked username."""
    try:
        client = _get_client()
        raw = await client.get(_GLOBAL_FAIL_KEY_PREFIX + _normalize(username))
        count = int(raw) if raw else 0
    except Exception:
        logger.warning("Redis unavailable while reading throttle for %s; failing open", username, exc_info=True)
        return 0.0
    excess = count - _GLOBAL_DELAY_THRESHOLD
    if excess <= 0:
        return 0.0
    return min(excess * _GLOBAL_DELAY_STEP_SECONDS, _GLOBAL_DELAY_MAX_SECONDS)


async def record_failure(username: str, ip: str | None = None) -> None:
    """Count a failure for (username, ip); lock that pair at the threshold."""
    normalized = _scoped(username, ip)
    fail_key = _FAIL_KEY_PREFIX + normalized
    locked_key = _LOCKED_KEY_PREFIX + normalized
    global_key = _GLOBAL_FAIL_KEY_PREFIX + _normalize(username)
    lockout_seconds = settings.LOGIN_LOCKOUT_MINUTES * 60
    try:
        client = _get_client()
        count = await client.incr(fail_key)
        if count == 1:
            await client.expire(fail_key, lockout_seconds)
        if count >= settings.LOGIN_MAX_FAILED_ATTEMPTS:
            await client.set(locked_key, "1", ex=lockout_seconds)
        global_count = await client.incr(global_key)
        if global_count == 1:
            await client.expire(global_key, lockout_seconds)
    except Exception:
        logger.warning("Redis unavailable while recording login failure for %s; skipping", username, exc_info=True)


async def clear_failures(username: str, ip: str | None = None) -> None:
    """Reset lockout state after a successful login."""
    scoped = _scoped(username, ip)
    try:
        client = _get_client()
        await client.delete(
            _FAIL_KEY_PREFIX + scoped,
            _LOCKED_KEY_PREFIX + scoped,
            _GLOBAL_FAIL_KEY_PREFIX + _normalize(username),
        )
    except Exception:
        logger.warning("Redis unavailable while clearing login failures for %s; skipping", username, exc_info=True)
