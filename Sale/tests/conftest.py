"""Test bootstrap for the Sale service's pure-logic unit tests.

Sale/Source/sale.py is imported for real (never modified by these tests).
Two things need to be arranged before that import happens:

1. `Sale/` must be on sys.path, because sale.py's relative imports
   (`from .core.config import ...`, `from .db.models import ...`) only
   resolve correctly if it is loaded as part of the `Source` package.

2. `Sale/Source/__init__.py` does `from .main import app`, which eagerly
   builds the entire FastAPI app: it imports every router, which in turn
   import JWT auth (python-jose), RabbitMQ (aio-pika), and other optional
   runtime dependencies that aren't installed (and aren't needed) just to
   exercise the pure helper functions in sale.py. To avoid pulling that
   whole graph in, we pre-register a stand-in "Source" module in
   sys.modules whose __path__ points at the real Source/ directory. Python
   then finds and executes the real Source/sale.py (and the small, cheap
   `Source.core` / `Source.db` subpackages it needs) without ever running
   Source/__init__.py.
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

SALE_DIR = Path(__file__).resolve().parents[1]
SOURCE_DIR = SALE_DIR / "Source"

if str(SALE_DIR) not in sys.path:
    sys.path.insert(0, str(SALE_DIR))

# Safe, deterministic defaults so pydantic Settings() never depends on the
# real .env file or a reachable database/broker. Only set if the caller
# hasn't already provided a value.
os.environ.setdefault("JWT_SECRET_KEY", "test-only-secret-key-0123456789abcdef")
os.environ.setdefault("CUSTOMER_INTERNAL_API_KEY", "test-only-internal-key-0123456789ab")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("RABBITMQ_ENABLED", "false")

if "Source" not in sys.modules:
    source_pkg = types.ModuleType("Source")
    source_pkg.__path__ = [str(SOURCE_DIR)]
    sys.modules["Source"] = source_pkg
