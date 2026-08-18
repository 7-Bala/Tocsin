"""
Tocsin Backend - FastAPI Application
Real-time incident state engine & disaster coordination service.
"""

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Authoritatively load environment variables from backend/.env or project root .env
_backend_env = Path(__file__).resolve().parent.parent / ".env"
_root_env = Path(__file__).resolve().parent.parent.parent / ".env"
if _backend_env.exists():
    load_dotenv(dotenv_path=_backend_env)
elif _root_env.exists():
    load_dotenv(dotenv_path=_root_env)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware

from app.api.agora import router as agora_router
from app.api.incidents import router as incidents_router
from app.engine.connection_manager import ws_manager
from app.engine.simulator import simulator

# Configure structured logging
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger: logging.Logger = logging.getLogger("tocsin.backend")

# Parse allowed CORS origins from environment (strict explicit origins, no wildcard)
raw_cors_origins: str = os.getenv(
    "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
)
ALLOWED_ORIGINS: list[str] = [
    origin.strip() for origin in raw_cors_origins.split(",") if origin.strip()
]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan manager for clean startup and shutdown."""
    logger.info("Tocsin backend service starting up...")
    logger.info(f"CORS allowed origins: {ALLOWED_ORIGINS}")
    yield
    logger.info("Tocsin backend service shutting down...")
    await simulator.shutdown()


app = FastAPI(
    title="Tocsin Backend",
    description="Real-time voice AI disaster-coordination platform backend",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Register REST routers
app.include_router(incidents_router)
app.include_router(agora_router)


@app.get("/", tags=["General"])
async def root() -> dict[str, Any]:
    return {
        "service": "Tocsin Backend",
        "status": "online",
        "version": "0.2.0",
    }


@app.get("/health", tags=["General"])
async def health_check() -> dict[str, Any]:
    db_configured: bool = bool(os.getenv("DATABASE_URL"))
    redis_configured: bool = bool(os.getenv("REDIS_URL"))
    agora_configured: bool = bool(os.getenv("AGORA_APP_ID") and os.getenv("AGORA_APP_CERTIFICATE"))
    logger.debug(
        f"Health check invoked. Database: {db_configured}, Redis: {redis_configured}, Agora: {agora_configured}"
    )
    return {
        "status": "ok",
        "service": "tocsin-backend",
        "database": db_configured,
        "redis": redis_configured,
        "agora": agora_configured,
    }


@app.websocket("/ws/incidents/{incident_id}")
async def websocket_incident_endpoint(
    websocket: WebSocket, incident_id: str
) -> None:
    """
    WebSocket endpoint for real-time live incident state synchronization.
    Pushes live degradation, jitter, and resolution recovery state streams.
    """
    await ws_manager.connect(incident_id, websocket)

    # Immediately push current incident snapshot if it exists
    state = await simulator.get_incident(incident_id)
    if state:
        await websocket.send_json(
            {
                "type": "INCIDENT_SNAPSHOT",
                "incident_id": incident_id,
                "state": state.model_dump(),
            }
        )
    else:
        await websocket.send_json(
            {
                "type": "CONNECTION_ESTABLISHED",
                "incident_id": incident_id,
                "message": f"Listening for incident '{incident_id}' (not yet initialized)",
            }
        )

    try:
        while True:
            data = await websocket.receive_text()
            logger.debug(f"Received WS payload on {incident_id}: {data}")
            await websocket.send_json(
                {
                    "type": "ACK",
                    "incident_id": incident_id,
                    "payload": data,
                }
            )
    except WebSocketDisconnect:
        await ws_manager.disconnect(incident_id, websocket)
    except (RuntimeError, ValueError) as err:
        logger.error(f"WebSocket communication error on {incident_id}: {err}")
        await ws_manager.disconnect(incident_id, websocket)
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
