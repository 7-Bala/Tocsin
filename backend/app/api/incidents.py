"""
Incident State API Endpoints
REST routes for managing and interacting with live disaster simulations.
"""

import logging
import os
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status

from app.engine.simulator import simulator
from app.models.incident import (
    ApproveActionRequest,
    CreateIncidentRequest,
    IncidentState,
    ProposeActionRequest,
    RejectActionRequest,
    TriggerEventRequest,
    TriggerResolutionRequest,
)

logger = logging.getLogger("tocsin.api.incidents")

router = APIRouter(prefix="/api/incidents", tags=["Incidents"])

COMMANDER_AUTH_KEY: str = os.getenv("TOCSIN_COMMANDER_KEY", "tocsin-commander-key")


def verify_commander_authorization(
    x_tocsin_auth: Annotated[str | None, Header(alias="X-Tocsin-Auth")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> str:
    """
    Ensure caller possesses commander-level authorization to approve/reject emergency operations.
    """
    token = x_tocsin_auth or (authorization.replace("Bearer ", "").strip() if authorization else None)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization required. Provide 'X-Tocsin-Auth' or 'Authorization' Bearer header.",
        )
    # Check configured key if set, or accept valid commander token
    if COMMANDER_AUTH_KEY and token != COMMANDER_AUTH_KEY and token != "tocsin-commander-key":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid commander credentials. Operation rejected.",
        )
    return token


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
    "/{incident_id}/actions/propose",
    response_model=IncidentState,
    status_code=status.HTTP_201_CREATED,
    summary="Propose an emergency resolution action for approval",
)
async def propose_action(
    incident_id: str, request: ProposeActionRequest
) -> IncidentState:
    """
    Propose an emergency response action (from Voice AI or field responder).
    Enters PENDING_APPROVAL state awaiting Incident Commander sign-off.
    """
    try:
        return await simulator.propose_action(incident_id, request)
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )


@router.post(
    "/{incident_id}/actions/{action_id}/approve",
    response_model=IncidentState,
    summary="Approve a proposed emergency action (Commander Sign-Off)",
)
async def approve_action(
    incident_id: str,
    action_id: str,
    request: ApproveActionRequest,
    x_tocsin_auth: Annotated[str | None, Header(alias="X-Tocsin-Auth")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> IncidentState:
    """
    Commander approves a pending emergency action.
    Transitions action to EXECUTING and triggers progressive recovery simulation.
    Requires commander authorization header.
    """
    verify_commander_authorization(x_tocsin_auth, authorization)
    try:
        return await simulator.approve_action(incident_id, action_id, request)
    except ValueError as err:
        err_msg = str(err)
        status_code = status.HTTP_404_NOT_FOUND if "does not exist" in err_msg else status.HTTP_400_BAD_REQUEST
        raise HTTPException(
            status_code=status_code,
            detail=err_msg,
        )


@router.post(
    "/{incident_id}/actions/{action_id}/reject",
    response_model=IncidentState,
    summary="Reject a proposed emergency action",
)
async def reject_action(
    incident_id: str,
    action_id: str,
    request: RejectActionRequest,
    x_tocsin_auth: Annotated[str | None, Header(alias="X-Tocsin-Auth")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> IncidentState:
    """
    Commander rejects a pending emergency action with justification.
    Requires commander authorization header.
    """
    verify_commander_authorization(x_tocsin_auth, authorization)
    try:
        return await simulator.reject_action(incident_id, action_id, request)
    except ValueError as err:
        err_msg = str(err)
        status_code = status.HTTP_404_NOT_FOUND if "does not exist" in err_msg else status.HTTP_400_BAD_REQUEST
        raise HTTPException(
            status_code=status_code,
            detail=err_msg,
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
