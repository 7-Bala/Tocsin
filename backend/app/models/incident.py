"""
Tocsin Incident State Models
Comprehensive schemas for real-time disaster incident command.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


def get_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Core Incident Status ────────────────────────────────────────────────────

class IncidentStatus(str, Enum):
    IDLE = "IDLE"
    DEGRADING = "DEGRADING"
    RESOLVING = "RESOLVING"
    STABILIZED = "STABILIZED"
    CLOSED = "CLOSED"


class SeverityLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class EventType(str, Enum):
    WATER_CONTAMINATION = "WATER_CONTAMINATION"
    FLOOD_SURGE = "FLOOD_SURGE"
    STRANDED_GROUP = "STRANDED_GROUP"
    POWER_FAILURE = "POWER_FAILURE"
    STRUCTURAL_HAZARD = "STRUCTURAL_HAZARD"
    TECHNICAL_INCIDENT = "TECHNICAL_INCIDENT"
    PAYMENT_OUTAGE = "PAYMENT_OUTAGE"


# ─── Action Approval State Machine ──────────────────────────────────────────
# Legal transitions:
#   PROPOSED → PENDING_APPROVAL (any authenticated propose call)
#   PENDING_APPROVAL → APPROVED  (commander auth)
#   APPROVED → EXECUTING          (automatic after approval)
#   EXECUTING → VERIFIED          (automatic after recovery)
#   EXECUTING → FAILED            (on error)
#   PENDING_APPROVAL → REJECTED   (commander auth) — TERMINAL, no outbound transitions

class ActionApprovalStatus(str, Enum):
    PROPOSED = "PROPOSED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"        # Terminal — no re-approval allowed
    EXECUTING = "EXECUTING"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"


# States from which approval is permitted
APPROVABLE_STATES = frozenset({ActionApprovalStatus.PENDING_APPROVAL})

# States from which rejection is permitted
REJECTABLE_STATES = frozenset({ActionApprovalStatus.PENDING_APPROVAL})


# ─── Intelligence Evidence Ontology ─────────────────────────────────────────

class EvidenceStatus(str, Enum):
    CONFIRMED = "CONFIRMED"
    REPORTED = "REPORTED"
    ASSUMED = "ASSUMED"
    UNVERIFIED = "UNVERIFIED"
    CONFLICTED = "CONFLICTED"
    RESOLVED = "RESOLVED"
    OPEN = "OPEN"


class ObservationCategory(str, Enum):
    FACT = "FACT"
    REPORT = "REPORT"
    ASSUMPTION = "ASSUMPTION"
    HYPOTHESIS = "HYPOTHESIS"
    DECISION = "DECISION"
    ACTION_ITEM = "ACTION_ITEM"
    CONFLICT = "CONFLICT"
    MISSING_INFO = "MISSING_INFO"
    RISK = "RISK"
    UNCLASSIFIED = "UNCLASSIFIED"


class ClaimType(str, Enum):
    SYSTEM_HEALTH = "system_health"
    ERROR_RATE = "error_rate"
    RESOURCE_STATUS = "resource_status"
    USER_IMPACT = "user_impact"
    METRIC_VALUE = "metric_value"
    TIMELINE_EVENT = "timeline_event"
    CAUSAL_ATTRIBUTION = "causal_attribution"
    MITIGATION_ACTION = "mitigation_action"
    DECISION = "decision"
    ESCALATION = "escalation"
    OTHER = "other"


class ExtractionMethod(str, Enum):
    LLM = "llm"
    HEURISTIC_FALLBACK = "heuristic_fallback"
    MANUAL = "manual"


# ─── Participant ─────────────────────────────────────────────────────────────

class ParticipantRole(str, Enum):
    INCIDENT_COMMANDER = "INCIDENT_COMMANDER"
    ENGINEER = "ENGINEER"
    SUPPORT = "SUPPORT"
    BUSINESS_LEADERSHIP = "BUSINESS_LEADERSHIP"
    FIELD_RESPONDER = "FIELD_RESPONDER"
    AI_AGENT = "AI_AGENT"
    UNKNOWN = "UNKNOWN"


class RoleSource(str, Enum):
    DECLARED = "declared"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


class Participant(BaseModel):
    id: str
    name: str
    role: ParticipantRole = ParticipantRole.UNKNOWN
    role_source: RoleSource = RoleSource.UNKNOWN
    role_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    language: str = "en"
    agora_uid: str | None = None
    joined_at: str = Field(default_factory=get_utc_now)
    last_active: str = Field(default_factory=get_utc_now)


# ─── Intelligence Records ─────────────────────────────────────────────────────

class Claim(BaseModel):
    """Structured extracted claim from a single observation."""
    id: str
    observation_id: str
    incident_id: str
    claim_type: ClaimType = ClaimType.OTHER
    entity: str
    value: str
    speaker: str | None = None
    source: str = "voice_transcript"
    timestamp: str = Field(default_factory=get_utc_now)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    status: EvidenceStatus = EvidenceStatus.UNVERIFIED
    extraction_method: ExtractionMethod = ExtractionMethod.LLM


class Observation(BaseModel):
    """A single ingested utterance, classified and extracted."""
    id: str
    incident_id: str
    raw_utterance: str
    speaker: str | None = None
    participant_id: str | None = None
    source: str = "voice_transcript"
    category: ObservationCategory = ObservationCategory.UNCLASSIFIED
    status: EvidenceStatus = EvidenceStatus.UNVERIFIED
    content: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence_refs: list[str] = Field(default_factory=list)
    timestamp: str = Field(default_factory=get_utc_now)
    extraction_method: ExtractionMethod = ExtractionMethod.LLM
    claims: list[Claim] = Field(default_factory=list)


class ConflictRecord(BaseModel):
    """A detected conflict between two claims about the same entity."""
    id: str
    incident_id: str
    claim_a_id: str
    claim_b_id: str
    entity: str
    value_a: str
    value_b: str
    source_a: str
    source_b: str
    speaker_a: str | None = None
    speaker_b: str | None = None
    status: EvidenceStatus = EvidenceStatus.OPEN
    recommended_action: str | None = None
    created_at: str = Field(default_factory=get_utc_now)
    resolved_at: str | None = None
    resolution_notes: str | None = None


class MissingInfo(BaseModel):
    """A tracked information gap requiring follow-up."""
    id: str
    incident_id: str
    description: str
    recommended_action: str | None = None
    status: EvidenceStatus = EvidenceStatus.OPEN
    created_at: str = Field(default_factory=get_utc_now)


class UnresolvedRisk(BaseModel):
    """A forward-looking risk requiring attention."""
    id: str
    incident_id: str
    description: str
    severity: SeverityLevel = SeverityLevel.MEDIUM
    status: EvidenceStatus = EvidenceStatus.OPEN
    created_at: str = Field(default_factory=get_utc_now)


class ActionItem(BaseModel):
    """A durable tracked task with owner and follow-up."""
    id: str
    incident_id: str
    description: str
    owner_name: str | None = None
    owner_participant_id: str | None = None
    status: str = "OPEN"   # OPEN | IN_PROGRESS | COMPLETE | OVERDUE | BLOCKED
    created_at: str = Field(default_factory=get_utc_now)
    due_at: str | None = None
    follow_up_at: str | None = None
    source_utterance: str | None = None
    blocking_reason: str | None = None
    last_reminder_at: str | None = None
    completion_evidence: str | None = None


# ─── Legacy / Operational Models ─────────────────────────────────────────────

class HypothesisStatus(str, Enum):
    PROPOSED = "PROPOSED"
    CONFIRMED = "CONFIRMED"
    DISPROVEN = "DISPROVEN"


class Symptom(BaseModel):
    id: str
    description: str
    severity: SeverityLevel
    reported_at: str = Field(default_factory=get_utc_now)
    source: str | None = None


class TimelineEntry(BaseModel):
    timestamp: str = Field(default_factory=get_utc_now)
    event_type: str
    description: str
    actor: str = "SYSTEM"
    metadata: dict[str, Any] = Field(default_factory=dict)


class Hypothesis(BaseModel):
    id: str
    title: str
    description: str
    confidence: float = Field(ge=0.0, le=1.0)
    status: HypothesisStatus = HypothesisStatus.PROPOSED
    updated_at: str = Field(default_factory=get_utc_now)


class ProposedAction(BaseModel):
    action_id: str
    tool_name: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    rationale: str
    proposed_by: str = "VoiceAI"
    status: ActionApprovalStatus = ActionApprovalStatus.PROPOSED  # Default: PROPOSED
    created_at: str = Field(default_factory=get_utc_now)
    pending_at: str | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    approval_notes: str | None = None
    rejection_reason: str | None = None
    rejected_by: str | None = None
    rejected_at: str | None = None
    executed_at: str | None = None
    verified_at: str | None = None
    recovery_duration_seconds: float = 5.0
    verified: bool = False
    verification_result: str | None = None
    failed_at: str | None = None
    failure_reason: str | None = None
    idempotency_key: str | None = None


class ActionTaken(BaseModel):
    action_id: str
    tool_name: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    executed_at: str = Field(default_factory=get_utc_now)
    result_summary: str
    verified: bool = False


class IncidentMetrics(BaseModel):
    severity_score: float = Field(default=10.0, ge=0.0, le=100.0)
    water_safety_index: float = Field(default=95.0, ge=0.0, le=100.0)
    flood_depth_meters: float = Field(default=0.0, ge=0.0)
    affected_population: int = Field(default=0, ge=0)
    infrastructure_integrity_pct: float = Field(default=100.0, ge=0.0, le=100.0)


# ─── Main Incident State ──────────────────────────────────────────────────────

class IncidentState(BaseModel):
    incident_id: str
    title: str
    event_type: EventType
    status: IncidentStatus = IncidentStatus.IDLE
    severity: SeverityLevel = SeverityLevel.LOW
    metrics: IncidentMetrics = Field(default_factory=IncidentMetrics)

    # Operational fields
    symptoms: list[Symptom] = Field(default_factory=list)
    timeline: list[TimelineEntry] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    proposed_actions: list[ProposedAction] = Field(default_factory=list)
    actions_taken: list[ActionTaken] = Field(default_factory=list)
    participants: list[Participant] = Field(default_factory=list)

    # Intelligence record
    observations: list[Observation] = Field(default_factory=list)
    claims: list[Claim] = Field(default_factory=list)
    conflicts: list[ConflictRecord] = Field(default_factory=list)
    missing_info: list[MissingInfo] = Field(default_factory=list)
    unresolved_risks: list[UnresolvedRisk] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    final_summary: str | None = None

    created_at: str = Field(default_factory=get_utc_now)
    updated_at: str = Field(default_factory=get_utc_now)


# ─── Request Schemas ──────────────────────────────────────────────────────────

class CreateIncidentRequest(BaseModel):
    incident_id: str | None = None
    title: str = Field(min_length=3, max_length=100)
    event_type: EventType = EventType.FLOOD_SURGE
    initial_symptoms: list[str] | None = None


class TriggerEventRequest(BaseModel):
    event_type: EventType
    intensity: float = Field(default=1.0, ge=0.1, le=5.0)
    description: str | None = None
    caller_id: str | None = "Caller-Alpha"
    caller_language: str | None = "en"


class ProposeActionRequest(BaseModel):
    tool_name: str = Field(min_length=2, max_length=64)
    rationale: str = Field(min_length=3, max_length=512)
    parameters: dict[str, Any] = Field(default_factory=dict)
    recovery_duration_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    proposed_by: str = "AgoraVoiceAgent"


class ApproveActionRequest(BaseModel):
    commander_id: str = Field(default="IncidentCommander-1", min_length=2, max_length=64)
    override_parameters: dict[str, Any] | None = None
    notes: str | None = None
    idempotency_key: str | None = None


class RejectActionRequest(BaseModel):
    commander_id: str = Field(default="IncidentCommander-1", min_length=2, max_length=64)
    reason: str = Field(min_length=3, max_length=512)


class TriggerResolutionRequest(BaseModel):
    tool_name: str = Field(min_length=2, max_length=64)
    action_description: str = Field(min_length=3, max_length=256)
    recovery_duration_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    parameters: dict[str, Any] = Field(default_factory=dict)
    actor: str = "AgoraVoiceAgent"


class IngestObservationRequest(BaseModel):
    """Request to ingest a raw transcript utterance into the incident intelligence record."""
    raw_utterance: str = Field(min_length=1, max_length=2048)
    speaker: str | None = None
    participant_id: str | None = None
    source: str = "voice_transcript"
    agora_uid: str | None = None


class ParticipantRegisterRequest(BaseModel):
    """Request to register or update a participant in an incident."""
    name: str = Field(min_length=1, max_length=64)
    role: ParticipantRole = ParticipantRole.UNKNOWN
    role_source: RoleSource = RoleSource.DECLARED
    agora_uid: str | None = None
    language: str = "en"
    participant_id: str | None = None


class CompleteActionItemRequest(BaseModel):
    completion_evidence: str | None = None
    completed_by: str | None = None
