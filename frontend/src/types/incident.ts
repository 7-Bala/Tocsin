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
  | 'STRUCTURAL_HAZARD';

export type HypothesisStatus = 'PROPOSED' | 'CONFIRMED' | 'DISPROVEN';

export type ActionApprovalStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'VERIFIED'
  | 'FAILED';

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
  role: string;
  language: string;
  last_active: string;
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
