from contextlib import asynccontextmanager

from fastapi import FastAPI

from Routers.Inventory import get_state_persistence_status
from Routers.Inventory import recovery_router as inventory_recovery_router
from Routers.Inventory import router as inventory_router
from Routers.Inventory import shutdown_event as shutdown_inventory_state
from Routers.Inventory import startup_event as startup_inventory_state

from .core.config import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    await startup_inventory_state()
    yield
    await shutdown_inventory_state()


app = FastAPI(
    title=settings.APP_NAME,
    version="0.2.0",
    lifespan=lifespan,
)

app.include_router(inventory_router)
app.include_router(inventory_recovery_router)


@app.get("/health")
async def health() -> dict[str, str]:
    # Top-level "status" stays "ok" so the gateway's up/down check is unaffected;
    # state_persistence surfaces whether the last runtime-state save succeeded.
    return {
        "service": "inventory",
        "status": "ok",
        "state_persistence": get_state_persistence_status(),
    }
