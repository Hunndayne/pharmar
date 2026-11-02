"""Các route GET /batches* phải yêu cầu JWT hợp lệ (trước đây mở cho mọi người gọi không cần đăng nhập)."""

import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from Routers import Inventory as inv

BASE = "/api/v1/inventory"


@pytest.fixture
def client(monkeypatch):
    state = SimpleNamespace(
        drugs={},
        batches={},
        movements=[],
        suppliers={},
        counters={},
    )
    monkeypatch.setattr(inv, "runtime_state", state)

    async def fake_settings():
        return {}

    monkeypatch.setattr(inv, "fetch_inventory_settings", fake_settings)
    app = FastAPI()
    app.include_router(inv.router)
    return TestClient(app)


def _valid_header():
    token = jwt.encode(
        {"sub": "u1", "username": "u1", "role": "owner", "type": "access", "exp": int(time.time()) + 300},
        inv.settings.JWT_SECRET_KEY,
        algorithm=inv.settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


PATHS = [
    "/batches",
    "/batches/paged",
    "/batches/suggest-issue?quantity=1",
    "/batches/qr/x",
    "/batches/some-id",
]


@pytest.mark.parametrize("path", PATHS)
def test_rejects_missing_token(client, path):
    assert client.get(BASE + path).status_code == 401


@pytest.mark.parametrize("path", PATHS)
def test_rejects_garbage_token(client, path):
    response = client.get(BASE + path, headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401


@pytest.mark.parametrize("path", PATHS)
def test_rejects_token_signed_with_wrong_secret(client, path):
    token = jwt.encode(
        {"sub": "u1", "type": "access", "exp": int(time.time()) + 300},
        "some-other-secret-0123456789",
        algorithm=inv.settings.JWT_ALGORITHM,
    )
    assert client.get(BASE + path, headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_list_batches_with_valid_token(client):
    response = client.get(BASE + "/batches", headers=_valid_header())
    assert response.status_code == 200
    assert response.json() == []


def test_list_batches_paged_with_valid_token(client):
    response = client.get(BASE + "/batches/paged", headers=_valid_header())
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == [] and body["total"] == 0


def test_suggest_issue_accepts_valid_token(client):
    # Qua được auth thì mới tới bước kiểm tra tham số: thiếu drug_id/drug_code -> 400.
    response = client.get(BASE + "/batches/suggest-issue?quantity=1", headers=_valid_header())
    assert response.status_code == 400


def test_batch_by_qr_accepts_valid_token(client):
    assert client.get(BASE + "/batches/qr/x", headers=_valid_header()).status_code == 404


def test_batch_detail_accepts_valid_token(client):
    assert client.get(BASE + "/batches/some-id", headers=_valid_header()).status_code == 404
