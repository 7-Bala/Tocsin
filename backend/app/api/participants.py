"""Participant registration and role mapping endpoints."""

from fastapi import APIRouter, HTTPException, status

from app.engine.database import new_id
from app.engine.repositories import participant_repo
from app.engine.simulator import simulator
from app.models.incident import Participant, ParticipantRegisterRequest

router = APIRouter(prefix="/api/incidents", tags=["Participants"])


@router.post("/{incident_id}/participants", response_model=Participant, status_code=status.HTTP_201_CREATED)
async def register_participant(incident_id: str, request: ParticipantRegisterRequest) -> Participant:
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found.")
    async with (await simulator._get_lock(incident_id)):
        current = next((p for p in state.participants if request.participant_id and p.id == request.participant_id or request.agora_uid and p.agora_uid == request.agora_uid), None)
        if current is None:
            current = Participant(id=request.participant_id or new_id("part-"), name=request.name, role=request.role, role_source=request.role_source, role_confidence=1.0 if request.role_source.value == "declared" else 0.6, agora_uid=request.agora_uid, language=request.language)
            state.participants.append(current)
        else:
            current.name = request.name
            current.role = request.role
            current.role_source = request.role_source
            current.agora_uid = request.agora_uid or current.agora_uid
            current.language = request.language
        state.updated_at = current.last_active
        await participant_repo.upsert(current, incident_id)
    return current


@router.get("/{incident_id}/participants", response_model=list[Participant])
async def list_participants(incident_id: str) -> list[Participant]:
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found.")
    return state.participants
