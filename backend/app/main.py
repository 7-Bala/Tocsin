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

import asyncio
from app.api.agora import router as agora_router
from app.api.demo import router as demo_router
from app.api.evidence import router as evidence_router
from app.api.incidents import router as incidents_router
from app.api.observations import router as observations_router
from app.api.participants import router as participants_router
from app.api.summaries import router as summaries_router
from app.engine.connection_manager import ws_manager
from app.engine.database import close_db, get_db_type, init_db, is_db_connected
from app.engine.repositories import incident_repo
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
    """Application lifespan manager: initialize DB, load state, start background reminder loop."""
    logger.info("Tocsin backend service starting up...")
    logger.info(f"CORS allowed origins: {ALLOWED_ORIGINS}")

    # Initialize database (PostgreSQL primary, SQLite fallback if configured)
    try:
        await init_db()
        logger.info(f"Database initialized: {get_db_type()}")
    except RuntimeError as e:
        logger.error(f"Database initialization failed: {e}")
        raise

    # Load persisted incidents into in-memory simulator
    try:
        persisted = await incident_repo.list_all()
        for state in persisted:
            simulator._incidents[state.incident_id] = state
        logger.info(f"Loaded {len(persisted)} persisted incidents from database.")
    except Exception as e:
        logger.warning(f"Could not load persisted incidents: {e}")

    # Background task for checking overdue action item reminders
    async def _reminder_background_worker():
        while True:
            try:
                await asyncio.sleep(5)
                for inc_id in list(simulator._incidents.keys()):
                    await simulator.check_and_remind_overdue_actions(inc_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Reminder background loop error: {e}")

    reminder_task = asyncio.create_task(_reminder_background_worker())

    yield

    logger.info("Tocsin backend service shutting down...")
    reminder_task.cancel()
    try:
        await reminder_task
    except asyncio.CancelledError:
        pass

    await simulator.shutdown()
    await close_db()


app = FastAPI(
    title="Tocsin Backend",
    description="Real-time voice AI incident command platform backend",
    version="0.3.0",
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
app.include_router(demo_router)
app.include_router(agora_router)
app.include_router(observations_router)
app.include_router(participants_router)
app.include_router(summaries_router)
app.include_router(evidence_router)


@app.get("/", tags=["General"])
async def root() -> dict[str, Any]:
    return {
        "service": "Tocsin Backend",
        "status": "online",
        "version": "0.3.0",
    }


@app.get("/health", tags=["General"])
async def health_check() -> dict[str, Any]:
    """
    Health check endpoint.
    Reports actual database connectivity — not just whether env vars are set.
    """
    db_connected = is_db_connected()
    db_type = get_db_type()
    agora_configured: bool = bool(
        os.getenv("AGORA_APP_ID") and os.getenv("AGORA_APP_CERTIFICATE")
    )
    gemini_configured: bool = bool(os.getenv("GEMINI_API_KEY"))
    commander_key_configured: bool = bool(os.getenv("TOCSIN_COMMANDER_KEY", "").strip())

    overall_status = "ok" if db_connected else "degraded"

    logger.debug(
        f"Health check: db={db_connected}/{db_type}, agora={agora_configured}, "
        f"gemini={gemini_configured}, commander_key={commander_key_configured}"
    )
    return {
        "status": overall_status,
        "service": "tocsin-backend",
        "version": "0.3.0",
        "database": {
            "connected": db_connected,
            "type": db_type,
            "configured": bool(os.getenv("DATABASE_URL") or os.getenv("USE_SQLITE_FALLBACK")),
        },
        "agora": {"configured": agora_configured},
        "gemini_extraction": {"configured": gemini_configured},
        "approval_workflow": {"commander_key_configured": commander_key_configured},
    }


@app.websocket("/ws/incidents/{incident_id}")
async def websocket_incident_endpoint(
    websocket: WebSocket, incident_id: str
) -> None:
    """
    WebSocket endpoint for real-time live incident state synchronization.
    Pushes live degradation, jitter, and resolution recovery state streams.
    Also delivers OBSERVATION_INGESTED, CONFLICT_DETECTED, and FOLLOWUP_REMINDER events.
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
