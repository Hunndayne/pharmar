import asyncio
import json

from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis


class Settings(BaseSettings):
    APP_NAME: str = "Report Service"
    APP_PORT: int = 8004

    REDIS_URL: str = "redis://redis:6379/0"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
app = FastAPI(title=settings.APP_NAME, version="0.1.0")


async def consume_sale_events() -> None:
    while True:
        pubsub = None
        try:
            pubsub = app.state.redis.pubsub()
            await pubsub.subscribe("sale.created")
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message.get("type") == "message":
                    payload = json.loads(message["data"])
                    total_amount = float(payload.get("total_amount", 0))
                    app.state.summary["total_sales"] += 1
                    app.state.summary["total_revenue"] = round(
                        app.state.summary["total_revenue"] + total_amount, 2
                    )
                    app.state.events.append(payload)
                    app.state.events = app.state.events[-100:]
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(1)
        finally:
            if pubsub is not None:
                await pubsub.close()


@app.on_event("startup")
async def startup_event() -> None:
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.summary = {"total_sales": 0, "total_revenue": 0.0}
    app.state.events = []
    app.state.consumer_task = asyncio.create_task(consume_sale_events())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    app.state.consumer_task.cancel()
    await asyncio.gather(app.state.consumer_task, return_exceptions=True)
    await app.state.redis.aclose()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"service": "report", "status": "ok"}


@app.get("/api/v1/report/summary")
async def summary() -> dict[str, float | int]:
    return app.state.summary


@app.get("/api/v1/report/events")
async def events() -> list[dict[str, object]]:
    return app.state.events
