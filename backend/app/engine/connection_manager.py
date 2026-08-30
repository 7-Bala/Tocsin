"""
WebSocket Connection Manager
Manages real-time incident state broadcast streams.
"""

import asyncio
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("tocsin.engine.connection_manager")


class ConnectionManager:
    """
    Tracks and broadcasts state payloads to WebSockets grouped by incident_id.
    """

    def __init__(self) -> None:
        self._incident_connections: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, incident_id: str, websocket: WebSocket) -> None:
        """Register a new active WebSocket connection for an incident."""
        await websocket.accept()
        async with self._lock:
            if incident_id not in self._incident_connections:
                self._incident_connections[incident_id] = set()
            self._incident_connections[incident_id].add(websocket)
        logger.info(
            f"WebSocket connected. Total subscribers for incident '{incident_id}': "
            f"{len(self._incident_connections[incident_id])}"
        )

    async def disconnect(self, incident_id: str, websocket: WebSocket) -> None:
        """Unregister a disconnected WebSocket."""
        async with self._lock:
            if incident_id in self._incident_connections:
                self._incident_connections[incident_id].discard(websocket)
                if not self._incident_connections[incident_id]:
                    del self._incident_connections[incident_id]
        logger.info(f"WebSocket removed from incident '{incident_id}'")

    async def broadcast_state(self, incident_id: str, payload: dict[str, Any]) -> None:
        """
        Broadcast state dictionary to all subscribers of a specific incident.
        Automatically prunes dead sockets.
        """
        async with self._lock:
            subscribers = set(self._incident_connections.get(incident_id, set()))

        if not subscribers:
            return

        dead_sockets = set()
        for ws in subscribers:
            try:
                await ws.send_json(payload)
            except (WebSocketDisconnect, RuntimeError, OSError, ValueError) as exc:
                logger.debug(f"Failed to send WS update to client on {incident_id}: {exc}")
                dead_sockets.add(ws)

        if dead_sockets:
            async with self._lock:
                if incident_id in self._incident_connections:
                    for dead_ws in dead_sockets:
                        self._incident_connections[incident_id].discard(dead_ws)
                    if not self._incident_connections[incident_id]:
                        del self._incident_connections[incident_id]

    async def broadcast_json(self, incident_id: str, payload: dict[str, Any]) -> None:
        """
        Broadcast an arbitrary JSON payload (not necessarily a state snapshot)
        to all subscribers of a specific incident.
        Used for typed events: OBSERVATION_INGESTED, CONFLICT_DETECTED, etc.
        """
        await self.broadcast_state(incident_id, payload)


# Global shared instance
ws_manager = ConnectionManager()
