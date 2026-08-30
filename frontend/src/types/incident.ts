export type IncidentStatus =
  | 'IDLE'
  | 'DEGRADING'
  | 'RESOLVING'
  | 'STABILIZED'
  | 'CLOSED';

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type EventType =
  | 'WATER_CONTAMINATION'
  | 'FLOOD_SURGE'
  | 'STRANDED_GROUP'
  | 'POWER_FAILURE'
  | 'STRUCTURAL_HAZARD'
  | 'TECHNICAL_INCIDENT'
  | 'PAYMENT_OUTAGE';

export type HypothesisStatus = 'PROPOSED' | 'CONFIRMED' | 'DISPROVEN';

export type ActionApprovalStatus =
  | 'PROPOSED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'VERIFIED'
  | 'FAILED';

export type ParticipantRole =
  | 'INCIDENT_COMMANDER'
  | 'ENGINEER'
  | 'SUPPORT'
  | 'BUSINESS_LEADERSHIP'
  | 'FIELD_RESPONDER'
  | 'AI_AGENT'
  | 'UNKNOWN';

export type RoleSource = 'declared' | 'inferred' | 'unknown';

export type EvidenceStatus =
  | 'CONFIRMED'
  | 'REPORTED'
  | 'ASSUMED'
  | 'UNVERIFIED'
  | 'CONFLICTED'
  | 'RESOLVED'
  | 'OPEN';

export type ObservationCategory =
  | 'FACT'
  | 'REPORT'
  | 'ASSUMPTION'
  | 'HYPOTHESIS'
  | 'DECISION'
  | 'ACTION_ITEM'
  | 'CONFLICT'
  | 'MISSING_INFO'
  | 'RISK'
  | 'UNCLASSIFIED';

export interface Symptom {
  id: string;
  description: string;
  severity: SeverityLevel;
  reported_at: string;
  source?: string | null;
}

export interface TimelineEntry {
  timestamp: string;
  event_type: string;
  description: string;
  actor: string;
  metadata?: Record<string, any>;
}

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  confidence: number;
  status: HypothesisStatus;
  updated_at: string;
}

export interface ProposedAction {
  action_id: string;
  tool_name: string;
  parameters: Record<string, any>;
  rationale: string;
  proposed_by: string;
  status: ActionApprovalStatus;
  created_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  rejection_reason?: string | null;
  executed_at?: string | null;
  recovery_duration_seconds: number;
  verified: boolean;
  verification_result?: string | null;
}

export interface ActionTaken {
  action_id: string;
  tool_name: string;
  parameters: Record<string, any>;
  executed_at: string;
  result_summary: string;
  verified: boolean;
}

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole | string;
  role_source?: RoleSource | string;
  role_confidence?: number;
  agora_uid?: string | null;
  language: string;
  joined_at?: string;
  last_active: string;
}

export interface Claim {
  id: string;
  observation_id: string;
  incident_id: string;
  claim_type: string;
  entity: string;
  value: string;
  speaker?: string | null;
  source: string;
  timestamp: string;
  confidence: number;
  status: EvidenceStatus | string;
  extraction_method: 'llm' | 'heuristic_fallback' | 'manual' | string;
}

export interface Observation {
  id: string;
  incident_id: string;
  raw_utterance: string;
  speaker?: string | null;
  participant_id?: string | null;
  source: string;
  category: ObservationCategory | string;
  status: EvidenceStatus | string;
  content: string;
  confidence: number;
  evidence_refs?: string[];
  timestamp: string;
  extraction_method: 'llm' | 'heuristic_fallback' | 'manual' | string;
  claims?: Claim[];
}

export interface ActionItem {
  id: string;
  incident_id: string;
  description: string;
  owner_name?: string | null;
  owner_participant_id?: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETE' | 'OVERDUE' | 'BLOCKED' | string;
  created_at: string;
  due_at?: string | null;
  follow_up_at?: string | null;
  source_utterance?: string | null;
  completion_evidence?: string | null;
}

export interface ConflictRecord {
  id: string;
  incident_id: string;
  claim_a_id: string;
  claim_b_id: string;
  entity: string;
  value_a: string;
  value_b: string;
  source_a: string;
  source_b: string;
  speaker_a?: string | null;
  speaker_b?: string | null;
  status: EvidenceStatus | string;
  recommended_action?: string | null;
  created_at: string;
  resolved_at?: string | null;
  resolution_notes?: string | null;
}

export interface MissingInfo {
  id: string;
  incident_id: string;
  description: string;
  recommended_action?: string | null;
  status: EvidenceStatus | string;
  created_at: string;
}

export interface UnresolvedRisk {
  id: string;
  incident_id: string;
  description: string;
  severity?: SeverityLevel;
  status: EvidenceStatus | string;
  created_at: string;
}

export interface IncidentMetrics {
  severity_score: number;
  water_safety_index: number;
  flood_depth_meters: number;
  affected_population: number;
  infrastructure_integrity_pct: number;
}

export interface IncidentState {
  incident_id: string;
  title: string;
  event_type: EventType;
  status: IncidentStatus;
  severity: SeverityLevel;
  metrics: IncidentMetrics;
  symptoms: Symptom[];
  timeline: TimelineEntry[];
  hypotheses: Hypothesis[];
  proposed_actions: ProposedAction[];
  actions_taken: ActionTaken[];
  participants: Participant[];
  observations?: Observation[];
  claims?: Claim[];
  conflicts?: ConflictRecord[];
  missing_info?: MissingInfo[];
  unresolved_risks?: UnresolvedRisk[];
  action_items?: ActionItem[];
  final_summary?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateIncidentRequest {
  title: string;
  event_type: EventType;
  incident_id?: string;
  initial_symptoms?: string[];
}

export interface TriggerEventRequest {
  event_type: EventType;
  intensity?: number;
  description?: string;
  caller_id?: string;
  caller_language?: string;
}

export interface ProposeActionRequest {
  tool_name: string;
  rationale: string;
  parameters?: Record<string, any>;
  recovery_duration_seconds?: number;
  proposed_by?: string;
}

export interface ApproveActionRequest {
  commander_id?: string;
  override_parameters?: Record<string, any>;
  notes?: string;
}

export interface RejectActionRequest {
  commander_id?: string;
  reason: string;
}

export interface TriggerResolutionRequest {
  tool_name: string;
  action_description: string;
  recovery_duration_seconds?: number;
  parameters?: Record<string, any>;
  actor?: string;
}

export interface IngestObservationRequest {
  raw_utterance: string;
  speaker?: string | null;
  participant_id?: string | null;
  source?: string;
  agora_uid?: string | null;
}

export interface ParticipantRegisterRequest {
  name: string;
  role?: ParticipantRole | string;
  role_source?: RoleSource | string;
  agora_uid?: string | null;
  language?: string;
  participant_id?: string | null;
}
