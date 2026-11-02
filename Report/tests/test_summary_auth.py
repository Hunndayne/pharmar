"""/report/summary và /report/events tự phục vụ dữ liệu từ Redis nên phải tự xác thực JWT."""

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException

import main

SECRET = "test-secret-key-0123456789abcdef"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _mint(payload=None, secret=SECRET, header=None, sign=True) -> str:
    header = header or {"alg": "HS256", "typ": "JWT"}
    payload = payload if payload is not None else {"sub": "u1", "type": "access", "exp": int(time.time()) + 300}
    h = _b64(json.dumps(header).encode())
    p = _b64(json.dumps(payload).encode())
    sig = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest() if sign else b""
    return f"{h}.{p}.{_b64(sig)}"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(main.settings, "JWT_SECRET_KEY", SECRET)
    monkeypatch.setattr(main.settings, "JWT_ALGORITHM", "HS256")


def _assert_401(authorization):
    with pytest.raises(HTTPException) as exc:
        main._verify_access_token(authorization)
    assert exc.value.status_code == 401


def test_valid_token_returns_payload():
    payload = main._verify_access_token(f"Bearer {_mint()}")
    assert payload["sub"] == "u1"


def test_internal_service_token_is_accepted():
    payload = main._verify_access_token(main._internal_authorization_header())
    assert payload["sub"] == "report-service"


def test_token_without_type_is_accepted():
    token = _mint({"sub": "u1", "exp": int(time.time()) + 300})
    assert main._verify_access_token(f"Bearer {token}")["sub"] == "u1"


def test_wrong_secret_rejected():
    _assert_401(f"Bearer {_mint(secret='another-secret-0123456789abcdef')}")


def test_expired_rejected():
    _assert_401(f"Bearer {_mint({'sub': 'u1', 'type': 'access', 'exp': int(time.time()) - 10})}")


def test_missing_exp_rejected():
    _assert_401(f"Bearer {_mint({'sub': 'u1', 'type': 'access'})}")


def test_refresh_type_rejected():
    _assert_401(f"Bearer {_mint({'sub': 'u1', 'type': 'refresh', 'exp': int(time.time()) + 300})}")


def test_alg_none_rejected():
    token = _mint(header={"alg": "none", "typ": "JWT"}, sign=False)
    _assert_401(f"Bearer {token}")
    # Kể cả khi kẻ tấn công vẫn gắn chữ ký HS256 hợp lệ nhưng khai alg=none.
    _assert_401(f"Bearer {_mint(header={'alg': 'none', 'typ': 'JWT'})}")


@pytest.mark.parametrize("authorization", [None, "", "Bearer", "Bearer a.b", "Bearer a.b.c", "Basic abc", "Bearer !!!.@@@.###"])
def test_missing_or_malformed_header_rejected(authorization):
    _assert_401(authorization)
