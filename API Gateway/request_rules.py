"""Pure request-classification helpers for the gateway (no I/O, easy to test)."""

import posixpath

DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB for ordinary JSON API calls

# (service, first path segment) pairs that legitimately carry large bodies.
# "*" matches any first segment of that service.
_LARGE_BODY_ROUTES: set[tuple[str, str]] = {
    ("file", "upload"),
    ("file", "presign"),
    ("ai", "*"),
    ("store", "backup"),
}


# Exact (service, normalized resource) pairs: /api/v1/{service}/{resource}.
# The Catalog routers are mounted at /catalog inside the catalog service, hence
# the doubled "catalog/catalog" in the public URL.
_LARGE_BODY_EXACT: set[tuple[str, str]] = {
    ("catalog", "catalog/products/import"),
    ("catalog", "catalog/manufacturers/import"),
    ("catalog", "catalog/suppliers/import"),
    ("store", "info/logo"),
}


def normalize_resource_path(resource_path: str) -> str:
    """Collapse dot-segments / duplicate slashes the way the upstream URL will be built."""
    return posixpath.normpath("/" + resource_path).lstrip("/")


def first_segment(normalized_resource: str) -> str:
    return normalized_resource.split("/", 1)[0].lower()


def is_login_endpoint(service: str, normalized_resource: str) -> bool:
    return service in {"auth", "users"} and first_segment(normalized_resource) == "login"


def max_body_size_for(service: str, normalized_resource: str, large_limit: int) -> int:
    """Body cap for a request: the large limit for the first-segment routes and
    exact paths above (upstream handlers enforce their own per-file caps),
    DEFAULT_MAX_BODY_BYTES for everything else."""
    segment = first_segment(normalized_resource)
    if (
        (service, segment) in _LARGE_BODY_ROUTES
        or (service, "*") in _LARGE_BODY_ROUTES
        or (service, normalized_resource) in _LARGE_BODY_EXACT
    ):
        return large_limit
    return min(DEFAULT_MAX_BODY_BYTES, large_limit)
