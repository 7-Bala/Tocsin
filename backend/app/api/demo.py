"""
Tocsin Deterministic Demo Scenario Router
Provides reliable, judge-verifiable demonstration workflows that run without external API dependencies.
Scenario: 'Payment system outage'
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

DEMO_INCIDENT_ID = "inc-demo-payment-outage"


class SimulateTranscriptRequest(BaseModel):
    incident_id: str = Field(default=DEMO_INCIDENT_ID)
    speaker: str = Field(default="Dave Miller")
    speaker_role: ParticipantRole = Field(default=ParticipantRole.ENGINEER)
    raw_utterance: str = Field(..., min_length=3)
    source: str = Field(default="demo_transcript_simulation")


@router.post("/payment-outage/run-all", summary="Run complete Payment Outage Demo Scenario end-to-end")
async def run_complete_payment_outage_scenario() -> dict[str, Any]:
    """
    Executes the full 11-step Payment System Outage demonstration scenario deterministically:
    1. Incident creation (CRITICAL Payment Outage)
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
    # ── Step 1: Create or Reset Incident ──────────────────────────────────
    state = await simulator.create_incident(
        title="Major Payment Processing & Checkout Outage",
        event_type=EventType.PAYMENT_OUTAGE,
        incident_id=DEMO_INCIDENT_ID,
        initial_symptoms=[
            "HTTP 500 error surge on /api/v1/checkout across US-East",
            "Customer transaction success rate dropped from 99.8% to 54.2%",
        ],
    )
    state.status = IncidentStatus.DEGRADING
    state.severity = SeverityLevel.CRITICAL
    state.metrics = IncidentMetrics(
        severity_score=88.0,
        water_safety_index=12.0,  # Used as general system health index
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
            raw_utterance="We are seeing a massive spike in 500 errors on /api/v1/checkout. 45% of incoming customer payments are failing across US-East.",
            speaker="Dave Miller",
            participant_id="part-eng-1",
            source="demo_voice_stream",
            category=ObservationCategory.REPORT,
            status=EvidenceStatus.CONFIRMED,
            content="Checkout payment failure rate at 45%",
            confidence=0.95,
            timestamp=t0,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-2",
            incident_id=state.incident_id,
            raw_utterance="Database connection pool on postgres-primary is completely exhausted at 100% capacity with 800 queued queries.",
            speaker="Dave Miller",
            participant_id="part-eng-1",
            source="demo_voice_stream",
            category=ObservationCategory.HYPOTHESIS,
            status=EvidenceStatus.CONFLICTED,
            content="PostgreSQL pool exhausted at 100%",
            confidence=0.85,
            timestamp=t1,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-3",
            incident_id=state.incident_id,
            raw_utterance="Support is flooded with tickets, but our Datadog metrics show RDS CPU at 22% and connections look normal and healthy at 35 connections.",
            speaker="Priya Sharma",
            participant_id="part-sup-1",
            source="demo_voice_stream",
            category=ObservationCategory.REPORT,
            status=EvidenceStatus.CONFLICTED,
            content="RDS metrics show database connections normal at 22% CPU",
            confidence=0.90,
            timestamp=t2,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-4",
            incident_id=state.incident_id,
            raw_utterance="Decision: Route 100% of new checkout transactions to the secondary Stripe backup gateway immediately.",
            speaker="Commander Sarah Chen",
            participant_id="part-ic-1",
            source="demo_voice_stream",
            category=ObservationCategory.DECISION,
            status=EvidenceStatus.CONFIRMED,
            content="Decision: Failover payment routing to secondary Stripe gateway",
            confidence=1.0,
            timestamp=t3,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-5",
            incident_id=state.incident_id,
            raw_utterance="Action item: Dave, inspect pgbouncer pool socket limits and restart proxy workers within 5 minutes.",
            speaker="Commander Sarah Chen",
            participant_id="part-ic-1",
            source="demo_voice_stream",
            category=ObservationCategory.ACTION_ITEM,
            status=EvidenceStatus.REPORTED,
            content="Inspect pgbouncer pool socket limits and restart proxy workers",
            confidence=0.95,
            timestamp=t4,
            extraction_method=ExtractionMethod.MANUAL,
        ),
        Observation(
            id="obs-demo-6",
            incident_id=state.incident_id,
            raw_utterance="Unresolved risk: Customer checkout abandonment rate is causing an estimated $15,000 revenue loss per minute during flash sale.",
            speaker="Marcus Vance",
            participant_id="part-biz-1",
            source="demo_voice_stream",
            category=ObservationCategory.RISK,
            status=EvidenceStatus.REPORTED,
            content="Estimated $15,000/min revenue loss during active flash sale",
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
        entity="checkout payment api",
        value="45% failure rate",
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
        value="exhausted at 100%",
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
        value="normal and healthy (22% CPU)",
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
        entity="payment gateway routing",
        value="Route 100% traffic to secondary Stripe backup gateway",
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
        recommended_action="Query pgbouncer proxy telemetry to isolate proxy socket limits vs database engine load.",
        created_at=t2,
    )
    state.conflicts = [conflict]
    await conflict_repo.insert(conflict)

    # ── Step 6: Missing Information ─────────────────────────────────────────
    missing = MissingInfo(
        id="mi-demo-1",
        incident_id=state.incident_id,
        description="PgBouncer connection pooler socket saturation and worker process metrics.",
        recommended_action="Inspect pgbouncer admin console `SHOW POOLS;` and check connection backlog.",
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
        description="Inspect pgbouncer pool socket limits and restart proxy workers",
        owner_name="Dave Miller",
        owner_participant_id="part-eng-1",
        status="OPEN",
        created_at=t4,
        due_at=due_time,
        source_utterance="Action item: Dave, inspect pgbouncer pool socket limits and restart proxy workers within 5 minutes.",
    )
    state.action_items = [action_item]
    await action_item_repo.insert(action_item)

    # ── Step 8: Unresolved Risk ─────────────────────────────────────────────
    risk = UnresolvedRisk(
        id="risk-demo-1",
        incident_id=state.incident_id,
        description="Customer checkout dropoff causing ongoing $15,000/min brand and revenue loss during flash sale.",
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
            title="PgBouncer Connection Starvation",
            description="Application connection pooler exhaustion rather than database hardware bottleneck.",
            confidence=0.88,
            status=HypothesisStatus.PROPOSED,
            updated_at=t2,
        )
    ]

    # ── Step 9: Propose Safe Action & Approve ────────────────────────────────
    action_safe = ProposedAction(
        action_id="act-safe-failover-01",
        tool_name="failover_payment_gateway",
        parameters={"provider": "stripe_secondary", "traffic_percentage": 100},
        rationale="Reroute transactions to healthy backup payment provider to stop customer 500 errors immediately.",
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
            tool_name="failover_payment_gateway",
            parameters={"provider": "stripe_secondary", "traffic_percentage": 100},
            executed_at=t4,
            result_summary="Payment traffic successfully rerouted to secondary gateway. 500 error rate dropped to 0.1%.",
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
            description="Critical payment processing outage initialized with 4 participant roles.",
            actor="SYSTEM",
        ),
        TimelineEntry(
            timestamp=t1,
            event_type="OBSERVATION_INGESTED",
            description="Dave Miller reported 45% checkout error rate and suspected DB pool exhaustion.",
            actor="Dave Miller",
        ),
        TimelineEntry(
            timestamp=t2,
            event_type="CONFLICT_DETECTED",
            description="Conflict detected: Dave Miller (100% pool exhaustion) vs Priya Sharma (22% normal RDS metrics).",
            actor="SYSTEM_DETECTOR",
        ),
        TimelineEntry(
            timestamp=t3,
            event_type="DECISION_RECORDED",
            description="Decision: Failover 100% payment routing to secondary Stripe gateway.",
            actor="Commander Sarah Chen",
        ),
        TimelineEntry(
            timestamp=t4,
            event_type="ACTION_APPROVED",
            description="Commander Sarah Chen approved safe action 'failover_payment_gateway'.",
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
            description="Action 'failover_payment_gateway' verified successful: Checkout error rate normalized to 0.1%.",
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
        "Incident: Major Payment Processing & Checkout Outage (Status: RESOLVING, Severity: CRITICAL)\n\n"
        "Confirmed Facts: Checkout API 500 error spike at 45% failure rate in US-East; Payment traffic rerouted to secondary gateway; Error rate reduced to 0.1%.\n\n"
        "Reported / Unverified Intelligence: PgBouncer proxy socket pool saturated; RDS hardware CPU normal at 22%.\n\n"
        "Decisions Made: Route 100% of payment traffic to secondary Stripe backup gateway immediately.\n\n"
        "Completed Actions: failover_payment_gateway (Approved by Commander Sarah Chen, verified recovery).\n\n"
        "Rejected Dangerous Actions: flush_all_production_databases (Blocked by Commander due to data loss hazard).\n\n"
        "Open Action Items: Inspect pgbouncer pool socket limits and restart proxy workers (owner: Dave Miller, status: OPEN, due in 5m).\n\n"
        "Open Conflicts Requiring Verification: database connections: 'exhausted at 100%' vs 'normal and healthy (22% CPU)' (action: Query pgbouncer proxy telemetry to isolate proxy vs database engine).\n\n"
        "Unresolved Risks: Ongoing brand impact and transaction backlog during active flash sale.\n\n"
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
        "scenario": "Payment system outage",
        "incident_id": state.incident_id,
        "demonstrated_capabilities": [
            "Incident creation (CRITICAL payment outage)",
            "4 Participant roles (Commander, Backend Eng, Support Lead, Biz Lead)",
            "Ingestion and separation into Confirmed Facts, Hypotheses, Decisions, Actions, Risks",
            "Contradictory claim conflict detection (DB Exhausted vs Normal Metrics)",
            "Missing information identification (PgBouncer proxy socket telemetry)",
            "Action item assignment with due timestamp and owner (Dave Miller)",
            "Real-time operational timeline",
            "Human confirmation and execution of safe action (Failover gateway)",
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
