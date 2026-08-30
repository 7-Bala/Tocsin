"""
Tocsin Observation Ingestion API
POST /api/incidents/{incident_id}/observations

This is the canonical pipeline entry point for the real-time incident intelligence system.
All transcript utterances (from Agora callbacks or frontend relay) are POSTed here.

Pipeline:
  raw_utterance → structured extraction → claim comparison → conflict detection
  → PostgreSQL persistence → IncidentState update → WebSocket broadcast
"""

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.engine.conflict_detector import detect_conflicts
from app.engine.connection_manager import ws_manager
from app.engine.database import new_id
from app.engine.extraction import extract_intelligence
from app.engine.repositories import (
    action_item_repo,
    claim_repo,
    conflict_repo,
    incident_repo,
    missing_info_repo,
    observation_repo,
    participant_repo,
    risk_repo,
)
from app.engine.simulator import simulator
from app.models.incident import (
    ActionItem,
    Claim,
    ClaimType,
    ConflictRecord,
    EvidenceStatus,
    ExtractionMethod,
    IngestObservationRequest,
    MissingInfo,
    Observation,
    ObservationCategory,
    TimelineEntry,
    UnresolvedRisk,
    get_utc_now,
)

logger = logging.getLogger("tocsin.api.observations")
router = APIRouter(prefix="/api/incidents", tags=["Observations"])

# In-memory deduplication window (incident_id → {hash: timestamp})
_dedup_cache: dict[str, dict[str, datetime]] = {}
_DEDUP_WINDOW_SECONDS = 30


def _utterance_hash(incident_id: str, raw_utterance: str, speaker: str | None) -> str:
    key = f"{incident_id}:{raw_utterance}:{speaker or ''}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _is_duplicate(incident_id: str, content_hash: str) -> bool:
    now = datetime.now(timezone.utc)
    cache = _dedup_cache.setdefault(incident_id, {})
    # Prune expired entries
    expired = [h for h, ts in cache.items() if (now - ts).total_seconds() > _DEDUP_WINDOW_SECONDS]
    for h in expired:
        del cache[h]
    if content_hash in cache:
        return True
    cache[content_hash] = now
    return False


def _resolve_speaker_from_uid(
    state_participants: list, agora_uid: str | None, speaker: str | None
) -> tuple[str | None, str | None]:
    """
    Resolve speaker name and participant_id from Agora UID.
    Returns (resolved_speaker, participant_id).
    """
    if agora_uid:
        for p in state_participants:
            if hasattr(p, "agora_uid") and p.agora_uid == agora_uid:
                return p.name, p.id
    return speaker, None


@router.post(
    "/{incident_id}/observations",
    summary="Ingest a transcript utterance into the incident intelligence record",
    status_code=status.HTTP_201_CREATED,
)
async def ingest_observation(
    incident_id: str,
    request: IngestObservationRequest,
) -> dict[str, Any]:
    """
    Ingest a raw transcript utterance and extract structured intelligence.

    This is the canonical pipeline endpoint for the real-time incident intelligence system.
    Every ingested utterance goes through structured claim extraction (Gemini primary,
    heuristic fallback), conflict detection, and persistence to PostgreSQL before
    broadcasting to the WebSocket dashboard.

    The extraction_method field in every response indicates whether LLM or
    heuristic_fallback was used — heuristic results are never marked CONFIRMED.
    """
    # 1. Validate incident exists
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Incident '{incident_id}' not found.",
        )

    # 2. Resolve speaker from Agora UID if provided
    speaker, participant_id = _resolve_speaker_from_uid(
        state.participants, request.agora_uid, request.speaker
    )
    # Update participant_id from request if not resolved from UID
    if not participant_id:
        participant_id = request.participant_id

    # 3. Deduplication check
    content_hash = _utterance_hash(incident_id, request.raw_utterance, speaker)
    if _is_duplicate(incident_id, content_hash):
        logger.debug(f"Duplicate utterance skipped for incident {incident_id}")
        return {
            "skipped": True,
            "reason": "duplicate_within_window",
            "incident_id": incident_id,
        }

    # 4. Build incident context for LLM
    incident_context = (
        f"Incident: {state.title} | Type: {state.event_type.value} | "
        f"Status: {state.status.value} | Severity: {state.severity.value}"
    )

    # 5. Extract structured intelligence (Gemini → heuristic fallback)
    claim_set = await extract_intelligence(
        utterance=request.raw_utterance,
        speaker=speaker,
        incident_context=incident_context,
    )

    # 6. Create Observation record
    now = get_utc_now()
    obs_id = new_id("obs-")

    # Map extraction_method string to enum
    try:
        extraction_method = ExtractionMethod(claim_set.extraction_method)
    except ValueError:
        extraction_method = ExtractionMethod.HEURISTIC_FALLBACK

    # Map category string to enum
    try:
        category = ObservationCategory(claim_set.category)
    except ValueError:
        category = ObservationCategory.UNCLASSIFIED

    # Map evidence_status string to enum (heuristic fallbacks always UNVERIFIED)
    if extraction_method == ExtractionMethod.HEURISTIC_FALLBACK:
        obs_status = EvidenceStatus.UNVERIFIED
    else:
        try:
            obs_status = EvidenceStatus(claim_set.evidence_status)
        except ValueError:
            obs_status = EvidenceStatus.UNVERIFIED

    obs = Observation(
        id=obs_id,
        incident_id=incident_id,
        raw_utterance=request.raw_utterance,
        speaker=speaker,
        participant_id=participant_id,
        source=request.source,
        category=category,
        status=obs_status,
        content=claim_set.content or request.raw_utterance[:300],
        confidence=claim_set.confidence,
        timestamp=now,
        extraction_method=extraction_method,
        claims=[],
    )

    # 7. Create Claim records and run conflict detection
    created_claims: list[Claim] = []
    detected_conflicts: list[ConflictRecord] = []

    for raw_claim in claim_set.claims:
        claim_id = new_id("clm-")
        try:
            claim_type = ClaimType(raw_claim.claim_type)
        except ValueError:
            claim_type = ClaimType.OTHER

        # Heuristic claims are always UNVERIFIED
        claim_status = (
            EvidenceStatus.UNVERIFIED
            if extraction_method == ExtractionMethod.HEURISTIC_FALLBACK
            else EvidenceStatus(claim_set.evidence_status)
        )

        claim = Claim(
            id=claim_id,
            observation_id=obs_id,
            incident_id=incident_id,
            claim_type=claim_type,
            entity=raw_claim.entity,
            value=raw_claim.value,
            speaker=speaker,
            source=request.source,
            timestamp=now,
            confidence=raw_claim.confidence,
            status=claim_status,
            extraction_method=extraction_method,
        )
        created_claims.append(claim)

        # Run conflict detection against existing claims for same entity
        existing = await claim_repo.find_by_entity(incident_id, raw_claim.entity)
        raw_conflicts = detect_conflicts(
            new_entity=raw_claim.entity,
            new_value=raw_claim.value,
            new_claim_id=claim_id,
            new_source=request.source,
            new_speaker=speaker,
            existing_claims=existing,
        )

        for rc in raw_conflicts:
            conflict_id = new_id("cfl-")
            conflict = ConflictRecord(
                id=conflict_id,
                incident_id=incident_id,
                claim_a_id=rc["claim_a_id"],
                claim_b_id=rc["claim_b_id"],
                entity=rc["entity"],
                value_a=rc["value_a"],
                value_b=rc["value_b"],
                source_a=rc["source_a"],
                source_b=rc["source_b"],
                speaker_a=rc.get("speaker_a"),
                speaker_b=rc.get("speaker_b"),
                status=EvidenceStatus.OPEN,
                recommended_action=rc.get("recommended_action"),
                created_at=now,
            )
            detected_conflicts.append(conflict)

            # Mark both claims as CONFLICTED
            claim.status = EvidenceStatus.CONFLICTED
            for existing_claim in existing:
                if existing_claim.get("id") == rc["claim_a_id"]:
                    try:
                        await claim_repo.update_status(rc["claim_a_id"], EvidenceStatus.CONFLICTED)
                    except Exception as e:
                        logger.warning(f"Failed to update conflicted claim status: {e}")

    obs.claims = created_claims

    # 8. Create ActionItem records
    created_action_items: list[ActionItem] = []
    for raw_ai in claim_set.action_items:
        if not raw_ai.description:
            continue
        ai_id = new_id("ai-")
        due_at = None
        if raw_ai.due_minutes:
            from datetime import datetime, timezone
            due_dt = datetime.now(timezone.utc) + timedelta(minutes=raw_ai.due_minutes)
            due_at = due_dt.isoformat()

        # Resolve owner participant_id
        owner_pid = None
        if raw_ai.owner_name:
            for p in state.participants:
                if hasattr(p, "name") and p.name.lower() == raw_ai.owner_name.lower():
                    owner_pid = p.id
                    break

        action_item = ActionItem(
            id=ai_id,
            incident_id=incident_id,
            description=raw_ai.description,
            owner_name=raw_ai.owner_name or speaker,
            owner_participant_id=owner_pid,
            status="OPEN",
            created_at=now,
            due_at=due_at,
            source_utterance=request.raw_utterance[:200],
        )
        created_action_items.append(action_item)

    # 9. Create MissingInfo records
    created_missing_info: list[MissingInfo] = []
    for mi_desc in claim_set.missing_info:
        mi_id = new_id("mi-")
        mi = MissingInfo(
            id=mi_id,
            incident_id=incident_id,
            description=mi_desc,
            recommended_action=f"Investigate: {mi_desc}",
            status=EvidenceStatus.OPEN,
            created_at=now,
        )
        created_missing_info.append(mi)

    # 10. Create UnresolvedRisk records
    created_risks: list[UnresolvedRisk] = []
    for risk_desc in claim_set.risks:
        risk_id = new_id("rsk-")
        risk = UnresolvedRisk(
            id=risk_id,
            incident_id=incident_id,
            description=risk_desc,
            status=EvidenceStatus.OPEN,
            created_at=now,
        )
        created_risks.append(risk)

    # 11. Persist everything to PostgreSQL
    persist_errors = []
    try:
        await observation_repo.insert(obs)
        for claim in created_claims:
            await claim_repo.insert(claim)
        for conflict in detected_conflicts:
            await conflict_repo.insert(conflict)
        for ai in created_action_items:
            await action_item_repo.insert(ai)
        for mi in created_missing_info:
            await missing_info_repo.insert(mi)
        for risk in created_risks:
            await risk_repo.insert(risk)
    except Exception as e:
        persist_errors.append(str(e))
        logger.error(f"DB persistence error for observation {obs_id}: {e}")

    # 12. Update in-memory state and persist via simulator's incident_repo
    async with (await simulator._get_lock(incident_id)):
        if incident_id in simulator._incidents:
            state = simulator._incidents[incident_id]
            state.observations.append(obs)
            state.claims.extend(created_claims)
            state.conflicts.extend(detected_conflicts)
            state.action_items.extend(created_action_items)
            state.missing_info.extend(created_missing_info)
            state.unresolved_risks.extend(created_risks)
            state.updated_at = now

            # Add timeline entry
            state.timeline.append(TimelineEntry(
                timestamp=now,
                event_type="OBSERVATION_INGESTED",
                description=f"Observation ingested from {speaker or 'unknown speaker'}: {category.value}",
                actor=speaker or "SYSTEM",
                metadata={
                    "observation_id": obs_id,
                    "category": category.value,
                    "extraction_method": extraction_method.value,
                    "conflicts_detected": len(detected_conflicts),
                    "action_items_created": len(created_action_items),
                },
            ))

            dump = state.model_dump()
    try:
        await incident_repo.upsert(state)
    except Exception as e:
        logger.warning(f"Failed to persist updated incident state after observation: {e}")

    # 13. WebSocket broadcast with specific event types
    ws_payload = {
        "type": "OBSERVATION_INGESTED",
        "incident_id": incident_id,
        "observation_id": obs_id,
        "category": category.value,
        "extraction_method": extraction_method.value,
        "speaker": speaker,
        "state": dump,
    }
    await ws_manager.broadcast_state(incident_id, dump)
    await ws_manager.broadcast_json(incident_id, ws_payload)

    if detected_conflicts:
        await ws_manager.broadcast_json(incident_id, {
            "type": "CONFLICT_DETECTED",
            "incident_id": incident_id,
            "conflicts": [c.model_dump() for c in detected_conflicts],
        })

    if created_action_items:
        await ws_manager.broadcast_json(incident_id, {
            "type": "ACTION_ITEM_CREATED",
            "incident_id": incident_id,
            "action_items": [ai.model_dump() for ai in created_action_items],
        })

    # 14. Build response
    return {
        "observation_id": obs_id,
        "incident_id": incident_id,
        "category": category.value,
        "extraction_method": extraction_method.value,
        "extraction_method_note": (
            "heuristic_fallback — results are UNVERIFIED; LLM extraction was unavailable"
            if extraction_method == ExtractionMethod.HEURISTIC_FALLBACK
            else "llm — structured extraction via Gemini API"
        ),
        "speaker": speaker,
        "evidence_status": obs_status.value,
        "confidence": claim_set.confidence,
        "content": obs.content,
        "claims_extracted": len(created_claims),
        "conflicts_detected": len(detected_conflicts),
        "action_items_created": len(created_action_items),
        "missing_info_identified": len(created_missing_info),
        "risks_identified": len(created_risks),
        "persist_errors": persist_errors,
        "observation": obs.model_dump(),
        "conflicts": [c.model_dump() for c in detected_conflicts],
        "action_items": [ai.model_dump() for ai in created_action_items],
    }
