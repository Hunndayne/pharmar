import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("JWT_SECRET_KEY", "test-only-secret-key-0123456789abcdef")
os.environ.setdefault("INTERNAL_API_KEY", "test-only-internal-key-0123456789ab")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("APP_ENV", "test")
