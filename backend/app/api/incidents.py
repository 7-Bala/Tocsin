"""
Incident State API Endpoints
REST routes for managing and interacting with live disaster simulations.
"""

import logging
import os
from typing import Annotated, Any
from pydantic import BaseModel, Field

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


def _get_configured_commander_key() -> str | None:
    """Return the configured commander key, or None if not set."""
    key = os.getenv("TOCSIN_COMMANDER_KEY", "").strip()
    return key if key else None


def verify_commander_authorization(
    x_tocsin_auth: Annotated[str | None, Header(alias="X-Tocsin-Auth")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> str:
    """
    Ensure caller possesses commander-level authorization to approve/reject emergency operations.

    Reads TOCSIN_COMMANDER_KEY from environment. If the env var is not set,
    returns HTTP 503 — the service is not safely configured for approval operations.
    There is no hardcoded fallback key.
    """
    configured_key = _get_configured_commander_key()
    if configured_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "TOCSIN_COMMANDER_KEY is not configured on the server. "
                "Set this environment variable before approval operations can be authorized."
            ),
        )

    token = x_tocsin_auth or (
        authorization.replace("Bearer ", "").strip() if authorization else None
    )
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization required. Provide 'X-Tocsin-Auth' or 'Authorization: Bearer' header.",
        )

    if token != configured_key:
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
    Transitions action to APPROVED → EXECUTING and triggers progressive recovery simulation.
    Requires commander authorization header.
    """
    verify_commander_authorization(x_tocsin_auth, authorization)
    try:
        return await simulator.approve_action(incident_id, action_id, request)
    except LookupError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )
    except PermissionError as err:
        # Idempotency conflict or invalid state transition
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(err),
        )
    except ValueError as err:
        err_msg = str(err)
        sc = (
            status.HTTP_404_NOT_FOUND
            if "does not exist" in err_msg
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=sc, detail=err_msg)


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
    Rejection is terminal — a rejected action cannot be re-approved.
    Requires commander authorization header.
    """
    verify_commander_authorization(x_tocsin_auth, authorization)
    try:
        return await simulator.reject_action(incident_id, action_id, request)
    except LookupError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )
    except PermissionError as err:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(err),
        )
    except ValueError as err:
        err_msg = str(err)
        sc = (
            status.HTTP_404_NOT_FOUND
            if "does not exist" in err_msg
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=sc, detail=err_msg)


@router.post(
    "/{incident_id}/resolve",
    response_model=IncidentState,
    summary="Trigger a resolution action (Commander Sign-Off Required)",
)
async def trigger_resolution(
    incident_id: str,
    request: TriggerResolutionRequest,
    x_tocsin_auth: Annotated[str | None, Header(alias="X-Tocsin-Auth")] = None,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> IncidentState:
    """
    Trigger an emergency resolution action. Commander authorization is required.
    Transitions incident to RESOLVING and recovers metrics back to nominal.
    This endpoint bypasses the propose/approve workflow — use sparingly.
    """
    verify_commander_authorization(x_tocsin_auth, authorization)
    try:
        return await simulator.trigger_resolution(incident_id, request)
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(err),
        )


class CompleteActionItemRequest(BaseModel):
    evidence: str = Field(default="Completed via verification check")


@router.post(
    "/{incident_id}/check-reminders",
    summary="Scan and emit reminders for overdue action items",
)
async def check_incident_reminders(incident_id: str) -> dict[str, Any]:
    """
    Manually triggers scan for overdue action items, broadcasts FOLLOWUP_REMINDER events,
    and returns emitted reminders.
    """
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Incident with ID '{incident_id}' not found.",
        )
    reminders = await simulator.check_and_remind_overdue_actions(incident_id)
    return {
        "incident_id": incident_id,
        "overdue_reminders_emitted": len(reminders),
        "reminders": reminders,
    }


@router.post(
    "/{incident_id}/action-items/{item_id}/complete",
    summary="Mark an action item as completed",
)
async def complete_action_item(
    incident_id: str,
    item_id: str,
    request: CompleteActionItemRequest,
) -> dict[str, Any]:
    """
    Mark an assigned action item as COMPLETE with verification evidence.
    """
    completed = await simulator.complete_action_item(
        incident_id, item_id, completion_evidence=request.evidence
    )
    if not completed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Action item '{item_id}' not found in incident '{incident_id}'.",
        )
    return {
        "status": "success",
        "action_item": completed.model_dump(),
    }
