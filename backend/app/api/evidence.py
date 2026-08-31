"""
Tocsin Evidence Lifecycle API

Closes the loop on the shared incident record. Detection alone is a demo; an evidence
record only becomes trustworthy when open items can be *settled by a named human with
stated reasoning*, and when any displayed claim can be traced back to the exact thing
somebody said.

Three capabilities live here:

1. **Resolution** — conflicts, information gaps, and risks become closable, with
   attribution. Tocsin detects contradictions; it never decides which side was right.

2. **Provenance** — "why do we believe this?" answered as a chain from claim back to
   the raw utterance, the speaker, how that speaker's role was determined, and how the
   claim was extracted (LLM vs labeled heuristic fallback).

3. **Handoff** — a dual-channel shift-handoff brief. Incident-management practice
   documents that a handoff must be both read onto the bridge *and* written into the
   incident document, because verbal alone is lost and written alone may not be
   acknowledged. See docs/strategy/COMPETITIVE_ANALYSIS.md §2.4.

Authorization note: resolution requires *attribution*, not the commander key. The
commander key gates operations that change the world (executing a rollback); annotating
the shared record is something any participant in the room legitimately does, and
gating it would slow the room down for no safety gain. What must never be anonymous is
*who* settled an item and *on what basis* — both are required fields.
"""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status

from app.engine.connection_manager import ws_manager
from app.engine.repositories import (
    conflict_repo,
    incident_repo,
    missing_info_repo,
    risk_repo,
)
from app.engine.simulator import simulator
from app.models.incident import (
    EvidenceStatus,
    ResolveEvidenceRequest,
    TimelineEntry,
    get_utc_now,
)

logger = logging.getLogger("tocsin.api.evidence")
router = APIRouter(prefix="/api/incidents", tags=["Evidence Lifecycle"])


async def _load_incident(incident_id: str):
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Incident '{incident_id}' not found.",
        )
    return state


async def _commit_and_broadcast(
    incident_id: str, state, event_type: str, description: str, actor: str, metadata: dict
) -> None:
    """Append a timeline entry, persist the incident, and broadcast the new state."""
    state.timeline.append(
        TimelineEntry(
            timestamp=get_utc_now(),
            event_type=event_type,
            description=description,
            actor=actor,
            metadata=metadata,
        )
    )
    state.updated_at = get_utc_now()
    try:
        await incident_repo.upsert(state)
    except Exception as e:  # persistence failure must be visible, not silent
        logger.warning(f"Failed to persist incident {incident_id} after {event_type}: {e}")

    dump = state.model_dump()
    await ws_manager.broadcast_state(incident_id, dump)
    await ws_manager.broadcast_json(
        incident_id, {"type": event_type, "incident_id": incident_id, **metadata}
    )


# ─── Conflict resolution ─────────────────────────────────────────────────────


@router.post(
    "/{incident_id}/conflicts/{conflict_id}/resolve",
    summary="Resolve a detected contradiction with human attribution",
)
async def resolve_conflict(
    incident_id: str, conflict_id: str, request: ResolveEvidenceRequest
) -> dict[str, Any]:
    """
    Close an open conflict. RESOLVED is terminal — re-resolving returns 409, matching
    the terminal-state discipline already applied to rejected actions.

    Tocsin does not record which claim "won". It records that a named human settled the
    contradiction and what evidence they cited. Deciding the truth is the commander's
    job; preserving who decided and why is Tocsin's.
    """
    state = await _load_incident(incident_id)

    conflict = next((c for c in (state.conflicts or []) if c.id == conflict_id), None)
    if conflict is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Conflict '{conflict_id}' not found in incident '{incident_id}'.",
        )

    if conflict.status == EvidenceStatus.RESOLVED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Conflict '{conflict_id}' was already resolved by "
                f"'{conflict.resolved_by or 'unknown'}' at {conflict.resolved_at}. "
                "Resolution is terminal."
            ),
        )

    now = get_utc_now()
    conflict.status = EvidenceStatus.RESOLVED
    conflict.resolved_by = request.resolved_by
    conflict.resolution_notes = request.resolution_notes
    conflict.resolved_at = now

    try:
        await conflict_repo.resolve(conflict_id, request.resolved_by, request.resolution_notes, now)
    except Exception as e:
        logger.error(f"Failed to persist conflict resolution {conflict_id}: {e}")

    await _commit_and_broadcast(
        incident_id,
        state,
        event_type="CONFLICT_RESOLVED",
        description=(
            f"Conflict on '{conflict.entity}' resolved by {request.resolved_by}: "
            f"{request.resolution_notes}"
        ),
        actor=request.resolved_by,
        metadata={
            "conflict_id": conflict_id,
            "entity": conflict.entity,
            "resolved_by": request.resolved_by,
        },
    )

    return {
        "conflict_id": conflict_id,
        "incident_id": incident_id,
        "status": conflict.status.value,
        "resolved_by": conflict.resolved_by,
        "resolved_at": conflict.resolved_at,
        "resolution_notes": conflict.resolution_notes,
        "entity": conflict.entity,
        "note": (
            "Tocsin recorded that a human settled this contradiction. It did not "
            "determine which claim was correct."
        ),
    }


# ─── Missing information resolution ──────────────────────────────────────────


@router.post(
    "/{incident_id}/missing-info/{info_id}/resolve",
    summary="Answer a tracked information gap",
)
async def resolve_missing_info(
    incident_id: str, info_id: str, request: ResolveEvidenceRequest
) -> dict[str, Any]:
    """Close an information gap by supplying the answer and who supplied it."""
    state = await _load_incident(incident_id)

    item = next((m for m in (state.missing_info or []) if m.id == info_id), None)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Missing-information item '{info_id}' not found in incident '{incident_id}'.",
        )

    if item.status == EvidenceStatus.RESOLVED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Information gap '{info_id}' was already answered by '{item.resolved_by or 'unknown'}'.",
        )

    now = get_utc_now()
    item.status = EvidenceStatus.RESOLVED
    item.resolved_by = request.resolved_by
    item.resolution_notes = request.resolution_notes
    item.resolved_at = now

    try:
        await missing_info_repo.resolve(info_id, request.resolved_by, request.resolution_notes, now)
    except Exception as e:
        logger.error(f"Failed to persist missing-info resolution {info_id}: {e}")

    await _commit_and_broadcast(
        incident_id,
        state,
        event_type="MISSING_INFO_RESOLVED",
        description=f"Information gap answered by {request.resolved_by}: {request.resolution_notes}",
        actor=request.resolved_by,
        metadata={"missing_info_id": info_id, "resolved_by": request.resolved_by},
    )

    return {
        "missing_info_id": info_id,
        "incident_id": incident_id,
        "status": item.status.value,
        "resolved_by": item.resolved_by,
        "resolved_at": item.resolved_at,
        "resolution_notes": item.resolution_notes,
        "description": item.description,
    }


# ─── Risk resolution ─────────────────────────────────────────────────────────


@router.post(
    "/{incident_id}/risks/{risk_id}/resolve",
    summary="Retire an unresolved risk",
)
async def resolve_risk(
    incident_id: str, risk_id: str, request: ResolveEvidenceRequest
) -> dict[str, Any]:
    """Close a risk with the mitigation or reasoning that retired it."""
    state = await _load_incident(incident_id)

    item = next((r for r in (state.unresolved_risks or []) if r.id == risk_id), None)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Risk '{risk_id}' not found in incident '{incident_id}'.",
        )

    if item.status == EvidenceStatus.RESOLVED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Risk '{risk_id}' was already retired by '{item.resolved_by or 'unknown'}'.",
        )

    now = get_utc_now()
    item.status = EvidenceStatus.RESOLVED
    item.resolved_by = request.resolved_by
    item.resolution_notes = request.resolution_notes
    item.resolved_at = now

    try:
        await risk_repo.resolve(risk_id, request.resolved_by, request.resolution_notes, now)
    except Exception as e:
        logger.error(f"Failed to persist risk resolution {risk_id}: {e}")

    await _commit_and_broadcast(
        incident_id,
        state,
        event_type="RISK_RESOLVED",
        description=f"Risk retired by {request.resolved_by}: {request.resolution_notes}",
        actor=request.resolved_by,
        metadata={"risk_id": risk_id, "resolved_by": request.resolved_by},
    )

    return {
        "risk_id": risk_id,
        "incident_id": incident_id,
        "status": item.status.value,
        "resolved_by": item.resolved_by,
        "resolved_at": item.resolved_at,
        "resolution_notes": item.resolution_notes,
        "description": item.description,
    }


# ─── Provenance ──────────────────────────────────────────────────────────────


@router.get(
    "/{incident_id}/claims/{claim_id}/provenance",
    summary="Trace a claim back to the utterance that produced it",
)
async def claim_provenance(incident_id: str, claim_id: str) -> dict[str, Any]:
    """
    Answer "why do we believe this?" for a single claim.

    Returns the full chain: claim → originating observation → raw utterance → speaker →
    the speaker's role and whether that role was *declared* or *inferred* → extraction
    method → any conflicts this claim participates in.

    This exists because responders will not act on a conclusion they cannot verify.
    A prose summary cannot answer this question without re-reading the transcript;
    a structured record can answer it in one call.
    """
    state = await _load_incident(incident_id)

    claim = next((c for c in (state.claims or []) if c.id == claim_id), None)
    if claim is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Claim '{claim_id}' not found in incident '{incident_id}'.",
        )

    observation = next(
        (o for o in (state.observations or []) if o.id == claim.observation_id), None
    )

    participant = None
    if observation and observation.participant_id:
        participant = next(
            (p for p in (state.participants or []) if p.id == observation.participant_id), None
        )
    if participant is None and claim.speaker:
        participant = next(
            (p for p in (state.participants or []) if p.name == claim.speaker), None
        )

    related_conflicts = [
        {
            "conflict_id": c.id,
            "entity": c.entity,
            "status": c.status.value,
            "opposing_value": c.value_a if c.claim_b_id == claim_id else c.value_b,
            "opposing_speaker": c.speaker_a if c.claim_b_id == claim_id else c.speaker_b,
            "resolved_by": c.resolved_by,
            "resolution_notes": c.resolution_notes,
        }
        for c in (state.conflicts or [])
        if claim_id in (c.claim_a_id, c.claim_b_id)
    ]

    is_heuristic = claim.extraction_method.value == "heuristic_fallback"

    return {
        "claim": {
            "id": claim.id,
            "entity": claim.entity,
            "value": claim.value,
            "claim_type": claim.claim_type.value,
            "evidence_status": claim.status.value,
            "confidence": claim.confidence,
            "timestamp": claim.timestamp,
        },
        "origin": {
            "observation_id": claim.observation_id,
            "raw_utterance": observation.raw_utterance if observation else None,
            "observation_category": observation.category.value if observation else None,
            "source": claim.source,
            "ingested_at": observation.timestamp if observation else None,
        },
        "attribution": {
            "speaker": claim.speaker,
            "participant_id": participant.id if participant else None,
            "role": participant.role.value if participant else "UNKNOWN",
            "role_source": participant.role_source.value if participant else "unknown",
            "role_caveat": (
                "Role was inferred by Tocsin, not declared by the participant. "
                "Weight this attribution accordingly."
                if participant and participant.role_source.value == "inferred"
                else None
            ),
        },
        "extraction": {
            "method": claim.extraction_method.value,
            "caveat": (
                "Extracted by keyword heuristic fallback because LLM extraction was "
                "unavailable. This claim is UNVERIFIED and was never eligible for "
                "CONFIRMED status."
                if is_heuristic
                else "Extracted by LLM structured extraction against a JSON schema."
            ),
        },
        "conflicts": related_conflicts,
        "verification_note": (
            "Tocsin recorded what was said and by whom. It did not independently verify "
            "this claim against telemetry."
        ),
    }


# ─── Handoff brief ───────────────────────────────────────────────────────────


def _build_handoff(state) -> dict[str, Any]:
    """
    Assemble a shift-handoff brief from the persisted evidence record.

    Ordered by what an incoming commander needs first: what is settled, what is only
    reported, what is actively contradicted, what nobody knows, who owes what, and what
    is still dangerous. Open items come before closed ones throughout — the incoming
    commander's job is the open set.
    """
    claims = state.claims or []
    confirmed = [c for c in claims if c.status == EvidenceStatus.CONFIRMED]
    reported = [
        c for c in claims
        if c.status in (EvidenceStatus.REPORTED, EvidenceStatus.UNVERIFIED, EvidenceStatus.ASSUMED)
    ]

    open_conflicts = [c for c in (state.conflicts or []) if c.status != EvidenceStatus.RESOLVED]
    settled_conflicts = [c for c in (state.conflicts or []) if c.status == EvidenceStatus.RESOLVED]
    open_gaps = [m for m in (state.missing_info or []) if m.status != EvidenceStatus.RESOLVED]
    open_risks = [r for r in (state.unresolved_risks or []) if r.status != EvidenceStatus.RESOLVED]

    open_actions = [a for a in (state.action_items or []) if a.status != "COMPLETE"]
    overdue_actions = [a for a in open_actions if a.status == "OVERDUE"]
    # An action item with no owner is a silent gap: nobody is accountable for it until
    # it happens to also go overdue, at which point the overdue line already mentions
    # "owned by nobody". Tracked separately here so a not-yet-overdue unowned item is
    # visible too, instead of only becoming visible once it's already late.
    unowned_actions = [a for a in open_actions if not a.owner_name]

    heuristic_claims = [c for c in claims if c.extraction_method.value == "heuristic_fallback"]

    sections = {
        "incident": {
            "id": state.incident_id,
            "title": state.title,
            "status": state.status.value,
            "severity": state.severity.value,
            "opened_at": state.created_at,
            "last_updated": state.updated_at,
        },
        "confirmed_facts": [
            {"entity": c.entity, "value": c.value, "speaker": c.speaker, "claim_id": c.id}
            for c in confirmed
        ],
        "reported_but_unconfirmed": [
            {
                "entity": c.entity,
                "value": c.value,
                "speaker": c.speaker,
                "evidence_status": c.status.value,
                "claim_id": c.id,
            }
            for c in reported
        ],
        "open_contradictions": [
            {
                "conflict_id": c.id,
                "entity": c.entity,
                "position_a": {"value": c.value_a, "speaker": c.speaker_a, "source": c.source_a},
                "position_b": {"value": c.value_b, "speaker": c.speaker_b, "source": c.source_b},
                "recommended_action": c.recommended_action,
            }
            for c in open_conflicts
        ],
        "settled_contradictions": [
            {
                "conflict_id": c.id,
                "entity": c.entity,
                "resolved_by": c.resolved_by,
                "resolution_notes": c.resolution_notes,
                "resolved_at": c.resolved_at,
            }
            for c in settled_conflicts
        ],
        "open_questions": [
            {"missing_info_id": m.id, "description": m.description, "recommended_action": m.recommended_action}
            for m in open_gaps
        ],
        "ownership": [
            {
                "action_item_id": a.id,
                "description": a.description,
                "owner": a.owner_name or "UNASSIGNED",
                "status": a.status,
                "due_at": a.due_at,
                "overdue": a.status == "OVERDUE",
                "unowned": not a.owner_name,
            }
            for a in open_actions
        ],
        "unresolved_risks": [
            {"risk_id": r.id, "description": r.description, "severity": r.severity.value}
            for r in open_risks
        ],
        "record_quality": {
            "total_claims": len(claims),
            "heuristic_fallback_claims": len(heuristic_claims),
            "caveat": (
                f"{len(heuristic_claims)} of {len(claims)} claims were extracted by "
                "keyword heuristic fallback rather than LLM extraction and are UNVERIFIED."
                if heuristic_claims
                else "All claims were extracted by LLM structured extraction."
            ),
        },
    }

    # Spoken form — deliberately terse. This is read onto a bridge, where long prose is
    # unusable. Leads with the open set, because that is what the incoming shift owns.
    spoken_lines = [
        f"Handoff for {state.title}. Current status {state.status.value}, severity {state.severity.value}.",
    ]
    if open_conflicts:
        spoken_lines.append(
            f"{len(open_conflicts)} unresolved contradiction"
            f"{'s' if len(open_conflicts) != 1 else ''} you need to settle: "
            + "; ".join(
                f"on {c.entity}, {c.speaker_a or 'one source'} says {c.value_a}, "
                f"{c.speaker_b or 'another'} says {c.value_b}"
                for c in open_conflicts[:3]
            )
            + "."
        )
    else:
        spoken_lines.append("No unresolved contradictions.")

    spoken_lines.append(
        f"Confirmed: {'; '.join(f'{c.entity} {c.value}' for c in confirmed[:4])}."
        if confirmed
        else "Nothing has been confirmed against authoritative telemetry yet."
    )
    if open_gaps:
        spoken_lines.append(
            f"{len(open_gaps)} open question{'s' if len(open_gaps) != 1 else ''}: "
            + "; ".join(m.description for m in open_gaps[:3]) + "."
        )
    if overdue_actions:
        spoken_lines.append(
            f"{len(overdue_actions)} overdue action"
            f"{'s' if len(overdue_actions) != 1 else ''}: "
            + "; ".join(f"{a.description}, owned by {a.owner_name or 'nobody'}" for a in overdue_actions[:3])
            + "."
        )
    elif open_actions:
        spoken_lines.append(
            f"{len(open_actions)} open action{'s' if len(open_actions) != 1 else ''}, none overdue."
        )
    # Unowned-but-not-yet-overdue items aren't covered by the overdue line above (which
    # already says "owned by nobody" for ones that are both overdue and unowned) — call
    # them out separately so an accountability gap doesn't stay invisible until it's
    # already late.
    not_yet_overdue_unowned = [a for a in unowned_actions if a.status != "OVERDUE"]
    if not_yet_overdue_unowned:
        spoken_lines.append(
            f"{len(not_yet_overdue_unowned)} open action"
            f"{'s have' if len(not_yet_overdue_unowned) != 1 else ' has'} no owner assigned: "
            + "; ".join(a.description for a in not_yet_overdue_unowned[:3])
            + "."
        )
    if open_risks:
        spoken_lines.append(
            f"Still at risk: {'; '.join(r.description for r in open_risks[:3])}."
        )
    spoken_lines.append(
        "Tocsin organized reported evidence and did not independently determine root cause. "
        "Verify anything you intend to act on."
    )

    return {
        "sections": sections,
        "spoken_brief": " ".join(spoken_lines),
        "open_item_counts": {
            "contradictions": len(open_conflicts),
            "questions": len(open_gaps),
            "actions": len(open_actions),
            "overdue_actions": len(overdue_actions),
            "unowned_actions": len(unowned_actions),
            "risks": len(open_risks),
        },
    }


@router.get(
    "/{incident_id}/handoff",
    summary="Generate a shift-handoff brief (written + spoken form)",
)
async def handoff_brief(incident_id: str) -> dict[str, Any]:
    """
    Produce a dual-channel handoff artifact for a shift change.

    Incident-management practice documents that a handoff brief must be read onto the
    bridge verbally AND written into the incident document — verbal alone is lost,
    written alone may not be acknowledged. This endpoint returns both forms from the
    same evidence record, so the two cannot drift apart.

    `spoken_brief` is prepared text. It is NOT broadcast into an Agora channel by this
    endpoint; live audio delivery requires an active credentialed room session and is
    not wired. See docs/agora/RESEARCH.md.
    """
    state = await _load_incident(incident_id)
    brief = _build_handoff(state)

    return {
        "incident_id": incident_id,
        "generated_at": get_utc_now(),
        "sections": brief["sections"],
        "spoken_brief": brief["spoken_brief"],
        "open_item_counts": brief["open_item_counts"],
        "audio_broadcast": False,
        "delivery_note": (
            "Text prepared for both the incident document and verbal readout. Audio "
            "broadcast into a live Agora channel is not wired in this build."
        ),
        "ai_disclaimer": (
            "Tocsin organized reported evidence and did not independently determine "
            "root cause."
        ),
    }
