"""
Tocsin Incident State Models
Comprehensive schemas for real-time disaster coordination.
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


def get_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


class ActionTaken(BaseModel):
    action_id: str
    tool_name: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    executed_at: str = Field(default_factory=get_utc_now)
    result_summary: str
    verified: bool = False


class Participant(BaseModel):
    id: str
    name: str
    role: str
    language: str = "en"
    last_active: str = Field(default_factory=get_utc_now)


class IncidentMetrics(BaseModel):
    severity_score: float = Field(default=10.0, ge=0.0, le=100.0)
    water_safety_index: float = Field(default=95.0, ge=0.0, le=100.0)
    flood_depth_meters: float = Field(default=0.0, ge=0.0)
    affected_population: int = Field(default=0, ge=0)
    infrastructure_integrity_pct: float = Field(default=100.0, ge=0.0, le=100.0)


class IncidentState(BaseModel):
    incident_id: str
    title: str
    event_type: EventType
    status: IncidentStatus = IncidentStatus.IDLE
    severity: SeverityLevel = SeverityLevel.LOW
    metrics: IncidentMetrics = Field(default_factory=IncidentMetrics)
    symptoms: list[Symptom] = Field(default_factory=list)
    timeline: list[TimelineEntry] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    actions_taken: list[ActionTaken] = Field(default_factory=list)
    participants: list[Participant] = Field(default_factory=list)
    created_at: str = Field(default_factory=get_utc_now)
    updated_at: str = Field(default_factory=get_utc_now)


# Request schemas
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


class TriggerResolutionRequest(BaseModel):
    tool_name: str = Field(min_length=2, max_length=64)
    action_description: str = Field(min_length=3, max_length=256)
    recovery_duration_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    parameters: dict[str, Any] = Field(default_factory=dict)
    actor: str = "AgoraVoiceAgent"
