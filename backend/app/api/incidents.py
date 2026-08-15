"""
Incident State API Endpoints
REST routes for managing and interacting with live disaster simulations.
"""

import logging

from fastapi import APIRouter, HTTPException, status

from app.engine.simulator import simulator
from app.models.incident import (
    CreateIncidentRequest,
    IncidentState,
    TriggerEventRequest,
    TriggerResolutionRequest,
)

logger = logging.getLogger("tocsin.api.incidents")

router = APIRouter(prefix="/api/incidents", tags=["Incidents"])


@router.post(
    "",
    response_model=IncidentState,
    status_code=status.HTTP_201_CREATED,
    summary="Create or initialize an incident",
)
async def create_incident(request: CreateIncidentRequest) -> IncidentState:
    """Create a new disaster incident state in IDLE status."""
    return await simulator.create_incident(
        title=request.title,
        event_type=request.event_type,
        incident_id=request.incident_id,
        initial_symptoms=request.initial_symptoms,
    )


@router.get(
    "",
    response_model=list[IncidentState],
    summary="List all incidents",
)
async def list_incidents() -> list[IncidentState]:
    """Retrieve all tracked incidents."""
    return await simulator.list_incidents()


@router.get(
    "/{incident_id}",
    response_model=IncidentState,
    summary="Get current incident state",
)
async def get_incident(incident_id: str) -> IncidentState:
    """Fetch real-time snapshot of an incident state."""
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Incident with ID '{incident_id}' not found.",
        )
    return state


@router.post(
    "/{incident_id}/trigger",
    response_model=IncidentState,
    summary="Trigger a disaster event (starts degradation loop)",
)
async def trigger_event(
    incident_id: str, request: TriggerEventRequest
) -> IncidentState:
    """
    Trigger a crisis event (e.g., Flood Surge, Water Contamination).
    Initiates live, jittered metric degradation in the background.
    """
    try:
        return await simulator.trigger_event(incident_id, request)
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )


@router.post(
    "/{incident_id}/resolve",
    response_model=IncidentState,
    summary="Trigger a resolution action (starts recovery loop)",
)
async def trigger_resolution(
    incident_id: str, request: TriggerResolutionRequest
) -> IncidentState:
    """
    Trigger an emergency resolution tool action.
    Transitions incident state to RESOLVING and recovers metrics back to nominal.
    """
    try:
        return await simulator.trigger_resolution(incident_id, request)
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )
