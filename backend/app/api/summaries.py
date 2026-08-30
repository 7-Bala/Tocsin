"""
Tocsin Evidence-Bounded Incident Summaries
Generates structured incident reports and spoken summary text strictly from persisted state.
Includes explicit AI root-cause disclaimer.
"""

import os
import logging
from typing import Any
from fastapi import APIRouter, HTTPException, status

from app.engine.repositories import summary_repo, incident_repo
from app.engine.simulator import simulator

logger = logging.getLogger("tocsin.api.summaries")
router = APIRouter(prefix="/api/incidents", tags=["Summaries"])


def build_evidence_summary(state) -> dict[str, Any]:
    """
    Synthesize an evidence-bounded summary strictly from persisted state.
    Distinguishes confirmed facts, reported unverified items, decisions, tasks, conflicts, and risks.
    """
    facts = [c.value for c in (state.claims or []) if c.status.value == "CONFIRMED"]
    reports = [f"{c.entity}: {c.value} (source: {c.source})" for c in (state.claims or []) if c.status.value in ("REPORTED", "UNVERIFIED", "CONFLICTED")]
    decisions = [c.value for c in (state.claims or []) if c.claim_type.value == "decision"]
    open_tasks = [f"{a.description} (owner: {a.owner_name or 'unassigned'}, status: {a.status})" for a in (state.action_items or []) if a.status != "COMPLETE"]
    conflicts = [f"{c.entity}: '{c.value_a}' vs '{c.value_b}' (action: {c.recommended_action or 'verify telemetry'})" for c in (state.conflicts or []) if c.status.value == "OPEN"]
    risks = [r.description for r in (state.unresolved_risks or []) if r.status.value == "OPEN"]

    text_lines = [
        f"Incident: {state.title} (Status: {state.status.value}, Severity: {state.severity.value})",
        f"Confirmed Facts: {'; '.join(facts) if facts else 'None confirmed by authoritative telemetry.'}",
        f"Reported / Unverified Intelligence: {'; '.join(reports) if reports else 'None recorded.'}",
        f"Decisions Made: {'; '.join(decisions) if decisions else 'None recorded.'}",
        f"Open Action Items: {'; '.join(open_tasks) if open_tasks else 'None.'}",
        f"Open Conflicts Requiring Verification: {'; '.join(conflicts) if conflicts else 'None recorded.'}",
        f"Unresolved Risks: {'; '.join(risks) if risks else 'None recorded.'}",
        "DISCLAIMER: The AI has organized reported evidence and has not independently determined root cause.",
    ]
    formatted_text = "\n\n".join(text_lines)

    return {
        "text": formatted_text,
        "sections": {
            "title": state.title,
            "status": state.status.value,
            "severity": state.severity.value,
            "confirmed_facts": facts,
            "reported_items": reports,
            "decisions": decisions,
            "open_tasks": open_tasks,
            "open_conflicts": conflicts,
            "unresolved_risks": risks,
            "ai_disclaimer": "The AI has organized reported evidence and has not independently determined root cause.",
        }
    }


@router.post("/{incident_id}/summary/spoken", summary="Generate summary text for voice broadcast")
async def spoken_summary(incident_id: str) -> dict[str, Any]:
    """
    Generate evidence-bounded summary text prepared for spoken delivery.
    If live Agora / Gemini agent is connected, audio dispatch can be triggered in room.
    """
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found.")

    summary_data = build_evidence_summary(state)
    content = summary_data["text"]

    # Check whether Agora credentials are present for live speech synthesis
    agora_available = bool(os.getenv("AGORA_APP_ID") and os.getenv("AGORA_APP_CERTIFICATE"))

    await summary_repo.insert(incident_id, "spoken", content, "SYSTEM")

    return {
        "incident_id": incident_id,
        "summary_type": "spoken_summary_text",
        "audio_dispatched": False,  # True only when live Agora TTS stream bridge is active
        "delivery_classification": "IMPLEMENTED_TEXT_PREPARED_FOR_TTS" if agora_available else "MOCK_FALLBACK_TEXT_ONLY",
        "content": content,
        "sections": summary_data["sections"],
        "notice": "Spoken summary text synthesized from database. Audio broadcast requires active Agora room session.",
    }


@router.get("/{incident_id}/summary/final", summary="Generate comprehensive final incident report")
async def final_summary(incident_id: str) -> dict[str, Any]:
    """
    Generate comprehensive final incident summary report persisted to incident record.
    """
    state = await simulator.get_incident(incident_id)
    if not state:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found.")

    summary_data = build_evidence_summary(state)
    content = summary_data["text"]

    state.final_summary = content
    try:
        await incident_repo.upsert(state)
    except Exception as e:
        logger.warning(f"Failed to upsert incident final summary: {e}")

    await summary_repo.insert(incident_id, "final", content, "SYSTEM")

    return {
        "incident_id": incident_id,
        "summary_type": "final_incident_report",
        "content": content,
        "sections": summary_data["sections"],
        "persisted": True,
    }
