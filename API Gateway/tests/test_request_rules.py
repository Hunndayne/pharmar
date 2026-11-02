import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from request_rules import (  # noqa: E402
    DEFAULT_MAX_BODY_BYTES,
    is_login_endpoint,
    max_body_size_for,
    normalize_resource_path,
)

BIG = 100 * 1024 * 1024


def test_login_detection_survives_path_tricks():
    for raw in ["login", "login/", "./login", "/login", "x/../login", "Login"]:
        assert is_login_endpoint("auth", normalize_resource_path(raw)), raw
    assert not is_login_endpoint("auth", normalize_resource_path("me"))
    assert not is_login_endpoint("sale", normalize_resource_path("login"))
    assert not is_login_endpoint("auth", normalize_resource_path("logout"))


def test_body_limits():
    assert max_body_size_for("sale", "orders", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("auth", "login", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("file", "upload/multiple", BIG) == BIG
    assert max_body_size_for("file", "presign/upload", BIG) == BIG
    assert max_body_size_for("file", "files", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("ai", "purchase-invoices/extract", BIG) == BIG
    assert max_body_size_for("store", "backup/upload", BIG) == BIG
    assert max_body_size_for("store", "backup/receive", BIG) == BIG
    assert max_body_size_for("store", "settings", BIG) == DEFAULT_MAX_BODY_BYTES


def test_dot_segments_cannot_smuggle_large_route():
    assert max_body_size_for("sale", normalize_resource_path("../x"), BIG) == DEFAULT_MAX_BODY_BYTES


def test_exact_path_allowlist():
    for svc, res in [
        ("catalog", "catalog/products/import"),
        ("catalog", "catalog/manufacturers/import"),
        ("catalog", "catalog/suppliers/import"),
        ("store", "info/logo"),
    ]:
        assert max_body_size_for(svc, normalize_resource_path(res + "/"), BIG) == BIG, res
        assert max_body_size_for(svc, normalize_resource_path("x/../" + res), BIG) == BIG, res
    # no wholesale widening of the neighbouring prefixes
    assert max_body_size_for("catalog", "catalog/products", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("catalog", "catalog/products/import/extra", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("catalog", "products/import", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("store", "info", BIG) == DEFAULT_MAX_BODY_BYTES
    assert max_body_size_for("sale", "info/logo", BIG) == DEFAULT_MAX_BODY_BYTES

