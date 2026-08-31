"""
Tocsin Deterministic Demo Scenario Router
Provides reliable, judge-verifiable demonstration workflows that run without external API dependencies.
Scenario: 'Customer login and identity outage'
Clearly marks all generated intelligence as [DEMO MODE - DETERMINISTIC SCENARIO].
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.engine.database import new_id, get_utc_now_str
from app.engine.repositories import (
    action_item_repo,
    claim_repo,
    conflict_repo,
    incident_repo,
    missing_info_repo,
    observation_repo,
    participant_repo,
    risk_repo,
    summary_repo,
)
from app.engine.simulator import simulator
from app.models.incident import (
    ActionApprovalStatus,
    ActionItem,
    ActionTaken,
    Claim,
    ClaimType,
    ConflictRecord,
    EventType,
    EvidenceStatus,
    ExtractionMethod,
    Hypothesis,
    HypothesisStatus,
    IncidentMetrics,
    IncidentState,
    IncidentStatus,
    MissingInfo,
    Observation,
    ObservationCategory,
    Participant,
    ParticipantRole,
    ProposedAction,
    RoleSource,
    SeverityLevel,
    TimelineEntry,
    UnresolvedRisk,
)

logger = logging.getLogger("tocsin.api.demo")
router = APIRouter(prefix="/api/demo", tags=["Demo Mode"])

DEMO_INCIDENT_ID = "inc-demo-identity-outage"


class SimulateTranscriptRequest(BaseModel):
    incident_id: str = Field(default=DEMO_INCIDENT_ID)
    speaker: str = Field(default="Dave Miller")
    speaker_role: ParticipantRole = Field(default=ParticipantRole.ENGINEER)
    raw_utterance: str = Field(..., min_length=3)
    source: str = Field(default="demo_transcript_simulation")


@router.post("/identity-outage/run-all", summary="Run complete Identity Outage Demo Scenario end-to-end")
async def run_complete_identity_outage_scenario() -> dict[str, Any]:
    """
    Executes the full identity-service outage demonstration scenario deterministically:
    1. Incident creation (CRITICAL Identity Outage)
    2. 4 Participants (Commander, Backend Eng, Support Lead, Biz Lead)
    3. Voice transcript ingestion
    4. Extraction into Facts, Hypotheses, Decisions, Action Items, Risks
    5. Conflicting claims detection (Database Exhausted vs Normal Metrics)
    6. Missing information detection (PgBouncer proxy telemetry)
    7. Action item assignment (Dave Miller, due in 5m)
    8. Real-time timeline logging
    9. Safe action approval (Failover gateway) -> VERIFIED
    10. Dangerous action rejection (Flush DB) -> REJECTED (terminal)
    11. Final summary with explicit AI disclaimer
    """
    # This endpoint fully overwrites the demo incident's state_json (any human
    # resolutions, live-test data, or accumulated conversation are discarded) — that is
    # its intended, documented behavior. Logged prominently at WARNING so a call that
    # wasn't expected (e.g. an accidental hit against the shared dev instance) leaves a
    # clear trace instead of silently discarding state. See TODO.md: a prior reset of
    # this exact incident could not be conclusively traced because the container whose
    # logs would have shown it had already been recreated by the time it was noticed.
    logger.warning(
        f"Identity-outage demo scenario RESET triggered for '{DEMO_INCIDENT_ID}' — "
        "this discards any existing conflicts/resolutions/timeline for that incident."
    )

    # ── Step 1: Create or Reset Incident ──────────────────────────────────
    state = await simulator.create_incident(
        title="Customer Login and Identity Outage",
        event_type=EventType.TECHNICAL_INCIDENT,
        incident_id=DEMO_INCIDENT_ID,
        initial_symptoms=[
            "HTTP 503 error surge on /api/v1/login across multiple regions",
            "Customer login success rate dropped to 60%",
        ],
    )
    state.status = IncidentStatus.DEGRADING
    state.severity = SeverityLevel.CRITICAL
    state.metrics = IncidentMetrics(
        severity_score=88.0,
        water_safety_index=12.0,  # Used as general service health index
        flood_depth_meters=0.0,
        affected_population=14500,
        infrastructure_integrity_pct=52.0,
    )

    # ── Step 2: Register 4 Participants with Roles ─────────────────────────
    participants = [
        Participant(
            id="part-ic-1",
            name="Commander Sarah Chen",
            role=ParticipantRole.INCIDENT_COMMANDER,
            role_source=RoleSource.DECLARED,
            role_confidence=1.0,
            agora_uid="1001",
        ),
        Participant(
            id="part-eng-1",
            name="Dave Miller",
            role=ParticipantRole.ENGINEER,
            role_source=RoleSource.DECLARED,
            role_confidence=1.0,
            agora_uid="1002",
        ),
        Participant(
            id="part-sup-1",
            name="Priya Sharma",
            role=ParticipantRole.SUPPORT,
            role_source=RoleSource.DECLARED,
            role_confidence=1.0,
            agora_uid="1003",
        ),
        Participant(
            id="part-biz-1",
            name="Marcus Vance",
            role=ParticipantRole.BUSINESS_LEADERSHIP,
            role_source=RoleSource.DECLARED,
            role_confidence=1.0,
            agora_uid="1004",
        ),
    ]
    state.participants = participants
    for p in participants:
        await participant_repo.upsert(p, state.incident_id)

    # ── Step 3 & 4: Ingest Observations & Extract Structured Intelligence ──
    now = datetime.now(timezone.utc)
    t0 = now.isoformat()
    t1 = (now + timedelta(seconds=10)).isoformat()
    t2 = (now + timedelta(seconds=20)).isoformat()
    t3 = (now + timedelta(seconds=30)).isoformat()
    t4 = (now + timedelta(seconds=40)).isoformat()
    t5 = (now + timedelta(seconds=50)).isoformat()

    obs_list = [
        Observation(
            id="obs-demo-1",
            incident_id=state.incident_id,
            raw_utterance="Customers are unable to log in across multiple regions. The login API is returning HTTP 503 errors for around 40% of requests.",
            speaker="Dave Miller",
            participant_id="part-eng-1",
            source="demo_voice_stream",
            category=ObservationCategory.REPORT,
            status=EvidenceStatus.CONFIRMED,
            content="Login API 503 failure rate at 40%",
            confidence=0.95,
            timestamp=t0,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-2",
            incident_id=state.incident_id,
            raw_utterance="I suspect the authentication database is overloaded and causing login failures.",
            speaker="Dave Miller",
            participant_id="part-eng-1",
            source="demo_voice_stream",
            category=ObservationCategory.HYPOTHESIS,
            status=EvidenceStatus.CONFLICTED,
            content="Authentication database may be overloaded",
            confidence=0.85,
            timestamp=t1,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-3",
            incident_id=state.incident_id,
            raw_utterance="SRE reports that database CPU and connection usage look normal and healthy.",
            speaker="Priya Sharma",
            participant_id="part-sup-1",
            source="demo_voice_stream",
            category=ObservationCategory.REPORT,
            status=EvidenceStatus.CONFLICTED,
            content="Database CPU and connections look normal",
            confidence=0.90,
            timestamp=t2,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-4",
            incident_id=state.incident_id,
            raw_utterance="Decision: Verify the recent identity-service deployment before rolling it back.",
            speaker="Commander Sarah Chen",
            participant_id="part-ic-1",
            source="demo_voice_stream",
            category=ObservationCategory.DECISION,
            status=EvidenceStatus.CONFIRMED,
            content="Decision: Verify deployment impact before rollback",
            confidence=1.0,
            timestamp=t3,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-5",
            incident_id=state.incident_id,
            raw_utterance="Action item: Dave, compare authentication error rates before and after the latest deployment within 5 minutes.",
            speaker="Commander Sarah Chen",
            participant_id="part-ic-1",
            source="demo_voice_stream",
            category=ObservationCategory.ACTION_ITEM,
            status=EvidenceStatus.REPORTED,
            content="Compare authentication error rates before and after deployment",
            confidence=0.95,
            timestamp=t4,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-6",
            incident_id=state.incident_id,
            raw_utterance="Unresolved risk: A rollback could invalidate active sessions and extend the outage if the deployment is not the cause.",
            speaker="Marcus Vance",
            participant_id="part-biz-1",
            source="demo_voice_stream",
            category=ObservationCategory.RISK,
            status=EvidenceStatus.REPORTED,
            content="Rollback may invalidate active sessions and extend the outage",
            confidence=0.90,
            timestamp=t5,
            extraction_method=ExtractionMethod.MANUAL,
        ),
    ]
    state.observations = obs_list
    for obs in obs_list:
        await observation_repo.insert(obs)

    # Claims
    claim_1 = Claim(
        id="cl-demo-1",
        observation_id="obs-demo-1",
        incident_id=state.incident_id,
        claim_type=ClaimType.ERROR_RATE,
        entity="login api",
        value="40% 503 failure rate",
        speaker="Dave Miller",
        status=EvidenceStatus.CONFIRMED,
        confidence=0.95,
        extraction_method=ExtractionMethod.MANUAL,
    )
    claim_2_eng = Claim(
        id="cl-demo-2-eng",
        observation_id="obs-demo-2",
        incident_id=state.incident_id,
        claim_type=ClaimType.RESOURCE_STATUS,
        entity="database connections",
        value="authentication database may be overloaded",
        speaker="Dave Miller",
        status=EvidenceStatus.CONFLICTED,
        confidence=0.85,
        extraction_method=ExtractionMethod.MANUAL,
    )
    claim_3_sup = Claim(
        id="cl-demo-3-sup",
        observation_id="obs-demo-3",
        incident_id=state.incident_id,
        claim_type=ClaimType.METRIC_VALUE,
        entity="database connections",
        value="normal and healthy",
        speaker="Priya Sharma",
        status=EvidenceStatus.CONFLICTED,
        confidence=0.90,
        extraction_method=ExtractionMethod.MANUAL,
    )
    claim_4_dec = Claim(
        id="cl-demo-4-dec",
        observation_id="obs-demo-4",
        incident_id=state.incident_id,
        claim_type=ClaimType.DECISION,
        entity="identity deployment rollback",
        value="Verify deployment impact before rollback",
        speaker="Commander Sarah Chen",
        status=EvidenceStatus.CONFIRMED,
        confidence=1.0,
        extraction_method=ExtractionMethod.MANUAL,
    )

    claims = [claim_1, claim_2_eng, claim_3_sup, claim_4_dec]
    state.claims = claims
    for cl in claims:
        await claim_repo.insert(cl)

    # ── Step 5: Conflict Detection ─────────────────────────────────────────
    conflict = ConflictRecord(
        id="cfl-demo-1",
        incident_id=state.incident_id,
        claim_a_id="cl-demo-2-eng",
        claim_b_id="cl-demo-3-sup",
        entity="database connections",
        value_a="exhausted at 100%",
        value_b="normal and healthy (22% CPU)",
        source_a="Dave Miller (Backend Engineer)",
        source_b="Priya Sharma (Support Lead)",
        speaker_a="Dave Miller",
        speaker_b="Priya Sharma",
        status=EvidenceStatus.OPEN if hasattr(EvidenceStatus, "OPEN") else EvidenceStatus.REPORTED,
        recommended_action="Compare deployment timestamps with identity-service error-rate telemetry.",
        created_at=t2,
    )
    state.conflicts = [conflict]
    await conflict_repo.insert(conflict)

    # ── Step 6: Missing Information ─────────────────────────────────────────
    missing = MissingInfo(
        id="mi-demo-1",
        incident_id=state.incident_id,
        description="Authentication error rates before and after the latest identity-service deployment.",
        recommended_action="Compare deployment timestamps with login failures and error-rate telemetry.",
        status=EvidenceStatus.OPEN if hasattr(EvidenceStatus, "OPEN") else EvidenceStatus.REPORTED,
        created_at=t2,
    )
    state.missing_info = [missing]
    await missing_info_repo.insert(missing)

    # ── Step 7: Action Item Assignment ──────────────────────────────────────
    due_time = (now + timedelta(minutes=5)).isoformat()
    action_item = ActionItem(
        id="act-item-demo-1",
        incident_id=state.incident_id,
        description="Compare authentication error rates before and after deployment",
        owner_name="Dave Miller",
        owner_participant_id="part-eng-1",
        status="OPEN",
        created_at=t4,
        due_at=due_time,
        source_utterance="Action item: Dave, compare authentication error rates before and after the latest deployment within 5 minutes.",
    )
    state.action_items = [action_item]
    await action_item_repo.insert(action_item)

    # ── Step 8: Unresolved Risk ─────────────────────────────────────────────
    risk = UnresolvedRisk(
        id="risk-demo-1",
        incident_id=state.incident_id,
        description="A rollback could invalidate active sessions and extend the outage if the deployment is not the cause.",
        severity=SeverityLevel.CRITICAL,
        status=EvidenceStatus.OPEN if hasattr(EvidenceStatus, "OPEN") else EvidenceStatus.REPORTED,
        created_at=t5,
    )
    state.unresolved_risks = [risk]
    await risk_repo.insert(risk)

    # Hypotheses
    state.hypotheses = [
        Hypothesis(
            id="hypo-demo-1",
            title="Identity-Service Deployment Regression",
            description="The latest identity-service deployment may have introduced the login failures.",
            confidence=0.88,
            status=HypothesisStatus.PROPOSED,
            updated_at=t2,
        )
    ]

    # ── Step 9: Propose Safe Action & Approve ────────────────────────────────
    action_safe = ProposedAction(
        action_id="act-safe-failover-01",
        tool_name="rollback_identity_deployment",
        parameters={"deployment": "identity-service-v2026.08.30", "environment": "production"},
        rationale="Rollback the latest identity deployment if telemetry confirms it caused the login failures.",
        recovery_duration_seconds=1.5,
        status=ActionApprovalStatus.APPROVED,
        confidence=0.98,
        risk_level=SeverityLevel.LOW,
        created_at=t3,
        approved_by="Commander Sarah Chen",
        approved_at=t4,
    )
    state.proposed_actions = [action_safe]
    state.actions_taken.append(
        ActionTaken(
            action_id="act-safe-failover-01",
            tool_name="rollback_identity_deployment",
            parameters={"deployment": "identity-service-v2026.08.30", "environment": "production"},
            executed_at=t4,
            result_summary="Identity deployment rollback verified. Login 503 error rate dropped to 0.2%.",
            verified=True,
        )
    )

    # ── Step 10: Propose Dangerous Action & Reject ──────────────────────────
    action_danger = ProposedAction(
        action_id="act-danger-flush-02",
        tool_name="flush_all_production_databases",
        parameters={"force": True, "drop_connections": True},
        rationale="[DANGEROUS] Drop all database client connections and truncate temporary cache tables.",
        recovery_duration_seconds=5.0,
        status=ActionApprovalStatus.REJECTED,
        confidence=0.20,
        risk_level=SeverityLevel.CRITICAL,
        created_at=t4,
        rejection_reason="REJECTED BY COMMANDER: Flushing production databases causes irreversible data loss and service downtime.",
    )
    state.proposed_actions.append(action_danger)

    # ── Step 11: Timeline Entries ───────────────────────────────────────────
    state.timeline = [
        TimelineEntry(
            timestamp=t0,
            event_type="INCIDENT_INITIALIZED",
            description="Critical identity-service outage initialized with 4 participant roles.",
            actor="SYSTEM",
        ),
        TimelineEntry(
            timestamp=t1,
            event_type="OBSERVATION_INGESTED",
            description="Dave Miller reported 40% login API 503 errors and suspected an identity-service issue.",
            actor="Dave Miller",
        ),
        TimelineEntry(
            timestamp=t2,
            event_type="CONFLICT_DETECTED",
            description="Conflict detected: authentication database overload hypothesis vs normal database telemetry.",
            actor="SYSTEM_DETECTOR",
        ),
        TimelineEntry(
            timestamp=t3,
            event_type="DECISION_RECORDED",
            description="Decision: Verify identity deployment impact before rollback.",
            actor="Commander Sarah Chen",
        ),
        TimelineEntry(
            timestamp=t4,
            event_type="ACTION_APPROVED",
            description="Commander Sarah Chen approved safe action 'rollback_identity_deployment'.",
            actor="Commander Sarah Chen",
        ),
        TimelineEntry(
            timestamp=t4,
            event_type="ACTION_REJECTED",
            description="Commander Sarah Chen rejected dangerous action 'flush_all_production_databases' (irreversible risk).",
            actor="Commander Sarah Chen",
        ),
        TimelineEntry(
            timestamp=t5,
            event_type="ACTION_VERIFIED",
            description="Action 'rollback_identity_deployment' verified successful: Login 503 error rate normalized to 0.2%.",
            actor="SYSTEM",
        ),
    ]

    # Metrics recovery after safe action
    state.metrics.severity_score = 25.0
    state.metrics.water_safety_index = 89.0
    state.metrics.infrastructure_integrity_pct = 95.0
    state.status = IncidentStatus.RESOLVING

    # ── Step 12: Final Summary ──────────────────────────────────────────────
    final_text = (
        "Incident: Customer Login and Identity Outage (Status: RESOLVING, Severity: CRITICAL)\n\n"
        "Confirmed Facts: Login API 503 error spike at 40% across multiple regions; Login error rate reduced to 0.2% after rollback.\n\n"
        "Reported / Unverified Intelligence: Authentication database may be overloaded; database CPU and connections appear normal; failures began after the latest identity deployment.\n\n"
        "Decisions Made: Verify identity deployment impact before rollback.\n\n"
        "Completed Actions: rollback_identity_deployment (Approved by Commander Sarah Chen, verified recovery).\n\n"
        "Rejected Dangerous Actions: flush_all_production_databases (Blocked by Commander due to irreversible data loss risk).\n\n"
        "Open Action Items: Compare authentication error rates before and after deployment (owner: Dave Miller, status: OPEN, due in 5m).\n\n"
        "Open Conflicts Requiring Verification: authentication database overload hypothesis vs normal database telemetry (action: compare deployment timestamps with identity metrics).\n\n"
        "Unresolved Risks: Rollback may invalidate active sessions and extend the outage if the deployment is not the cause.\n\n"
        "DISCLAIMER: The AI has organized reported evidence and has not independently determined root cause."
    )
    state.final_summary = final_text
    await summary_repo.insert(state.incident_id, "final", final_text, "SYSTEM")

    # Persist complete state
    await incident_repo.upsert(state)
    simulator._incidents[state.incident_id] = state

    from app.engine.connection_manager import ws_manager
    await ws_manager.broadcast_state(
        state.incident_id,
        {"type": "INCIDENT_SNAPSHOT", "incident_id": state.incident_id, "state": state.model_dump()},
    )

    return {
        "status": "success",
        "demo_mode": True,
        "scenario": "Customer login and identity outage",
        "incident_id": state.incident_id,
        "demonstrated_capabilities": [
            "Incident creation (CRITICAL identity outage)",
            "4 Participant roles (Commander, Backend Eng, Support Lead, Biz Lead)",
            "Ingestion and separation into Confirmed Facts, Hypotheses, Decisions, Actions, Risks",
            "Contradictory claim conflict detection (DB Exhausted vs Normal Metrics)",
            "Missing information identification (PgBouncer proxy socket telemetry)",
            "Action item assignment with due timestamp and owner (Dave Miller)",
            "Real-time operational timeline",
            "Human confirmation and execution of safe action (Identity deployment rollback)",
            "Human rejection of dangerous action (Flush production databases)",
            "Evidence-bounded final summary with explicit AI disclaimer",
        ],
        "state": state.model_dump(),
    }


@router.post("/simulate-transcript", summary="Inject simulated transcript into incident for demonstration")
async def simulate_transcript_injection(request: SimulateTranscriptRequest) -> dict[str, Any]:
    """
    Injects a simulated voice transcript segment into the canonical backend ingestion pipeline.
    Clearly tags the resulting observation as 'demo_transcript_simulation'.
    """
    from app.api.observations import ingest_observation
    from app.models.incident import IngestObservationRequest

    res = await ingest_observation(
        request.incident_id,
        IngestObservationRequest(
            raw_utterance=request.raw_utterance,
            speaker=request.speaker,
            source=request.source,
        ),
    )

    return {
        "status": "ingested",
        "demo_mode": True,
        "incident_id": request.incident_id,
        "observation": res,
        "notice": "[DEMO MODE] Observation injected into canonical backend pipeline.",
    }
