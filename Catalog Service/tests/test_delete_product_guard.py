"""Xóa sản phẩm phải fail-closed khi không hỏi được Inventory (sự cố Arginine T0386, 10/2026).

Không cần Postgres: product/db là bản giả, Inventory giả lập ở tầng HTTP bằng MockTransport.
"""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from Routers import Products
from Source import catalog


class FakeDb:
    def __init__(self):
        self.deleted = []
        self.commits = 0

    async def delete(self, obj):
        self.deleted.append(obj)

    async def commit(self):
        self.commits += 1


@pytest.fixture
def env(monkeypatch):
    product = SimpleNamespace(id=uuid4(), is_active=True, units=[SimpleNamespace(is_active=True)])
    state = SimpleNamespace(product=product, db=FakeDb(), sale_used=False, requests=[])
    # Mặc định Inventory chưa từng biết thuốc này.
    state.respond = lambda request: httpx.Response(404, json={"detail": f"Drug not found for '{product.id}'"})

    def handler(request):
        state.requests.append(request)
        return state.respond(request)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        catalog.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )
    monkeypatch.setattr(catalog.settings, "INVENTORY_SERVICE_URL", "http://inventory-service:8002")

    async def fake_get_product(product_id, db):
        return product

    async def fake_sale_history(product_id, token):
        return state.sale_used

    monkeypatch.setattr(Products, "get_product_or_404", fake_get_product)
    monkeypatch.setattr(Products, "product_has_sale_history", fake_sale_history)
    return state


def _delete(env):
    return asyncio.run(Products.delete_product(product_id=env.product.id, _=None, token="t", db=env.db))


def _assert_untouched(env):
    assert env.db.deleted == [] and env.db.commits == 0
    assert env.product.is_active is True


def test_refuses_when_inventory_has_stock(env):
    env.respond = lambda request: httpx.Response(200, json=[{"id": "bt-1", "qty_remaining": 45}])
    with pytest.raises(HTTPException) as exc:
        _delete(env)
    assert exc.value.status_code == 409
    _assert_untouched(env)
    assert env.requests[0].url.params["drug"] == str(env.product.id)


@pytest.mark.parametrize(
    "respond",
    [
        pytest.param(lambda r: httpx.Response(503, json={"detail": "state unavailable"}), id="inventory-503"),
        pytest.param(lambda r: httpx.Response(500), id="inventory-500"),
        pytest.param(lambda r: httpx.Response(401, json={"detail": "Not authenticated"}), id="inventory-401"),
        # 404 không phải "Drug not found" (sai URL/route) không chứng minh được là không có lô.
        pytest.param(lambda r: httpx.Response(404, json={"detail": "Not Found"}), id="route-404"),
        pytest.param(lambda r: httpx.Response(404, text="<html>not found</html>"), id="html-404"),
        pytest.param(lambda r: httpx.Response(200, json={"items": []}), id="unexpected-shape"),
        pytest.param(lambda r: httpx.Response(200, text="oops"), id="not-json"),
    ],
)
def test_refuses_when_inventory_answer_is_not_conclusive(env, respond):
    env.respond = respond
    with pytest.raises(HTTPException) as exc:
        _delete(env)
    assert exc.value.status_code == 503
    _assert_untouched(env)


@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ReadTimeout])
def test_refuses_when_inventory_unreachable(env, error):
    def respond(request):
        raise error("inventory down", request=request)

    env.respond = respond
    with pytest.raises(HTTPException) as exc:
        _delete(env)
    assert exc.value.status_code == 503
    _assert_untouched(env)


def test_refuses_when_inventory_url_not_configured(env, monkeypatch):
    monkeypatch.setattr(catalog.settings, "INVENTORY_SERVICE_URL", "  ")
    with pytest.raises(HTTPException) as exc:
        _delete(env)
    assert exc.value.status_code == 503
    _assert_untouched(env)


def test_hard_deletes_product_unknown_to_inventory_without_sales(env):
    result = _delete(env)
    assert result == {"message": "Product permanently deleted"}
    assert env.db.deleted == [env.product]


def test_hard_deletes_when_inventory_has_no_batches(env):
    env.respond = lambda request: httpx.Response(200, json=[])
    assert _delete(env) == {"message": "Product permanently deleted"}


def test_soft_deletes_when_only_empty_batches_remain(env):
    env.respond = lambda request: httpx.Response(200, json=[{"id": "bt-1", "qty_remaining": 0}])
    assert _delete(env) == {"message": "Product deleted (soft delete)"}
    assert env.db.deleted == []
    assert env.product.is_active is False
    assert all(unit.is_active is False for unit in env.product.units)


def test_soft_deletes_when_sale_history_exists(env):
    env.sale_used = True
    assert _delete(env) == {"message": "Product deleted (soft delete)"}
    assert env.db.deleted == []
