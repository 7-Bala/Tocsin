import {
  ApproveActionRequest,
  CreateIncidentRequest,
  IncidentState,
  ProposeActionRequest,
  RejectActionRequest,
  TriggerEventRequest,
  TriggerResolutionRequest,
} from '@/types/incident';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
export const DEFAULT_COMMANDER_KEY = 'tocsin-commander-key';

export async function ingestObservation(
  incidentId: string,
  payload: { raw_utterance: string; speaker?: string; agora_uid?: string; source?: string }
): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/observations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to ingest observation (HTTP ${res.status})`);
  }
  return res.json();
}

export async function fetchIncidents(): Promise<IncidentState[]> {
  const res = await fetch(`${API_BASE_URL}/api/incidents`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to list incidents (HTTP ${res.status})`);
  }
  return res.json();
}

export async function fetchIncident(
  incidentId: string
): Promise<IncidentState> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch incident ${incidentId} (HTTP ${res.status})`);
  }
  return res.json();
}

export async function createIncident(
  payload: {
    title: string;
    event_type: string;
    incident_id?: string;
    initial_symptoms?: string[];
  }
): Promise<IncidentState> {
  const res = await fetch(`${API_BASE_URL}/api/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to create incident (HTTP ${res.status})`);
  }
  return res.json();
}

export async function triggerIncidentEvent(
  incidentId: string,
  payload: {
    event_type: string;
    intensity?: number;
    description?: string;
    caller_id?: string;
  }
): Promise<IncidentState> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to trigger event (HTTP ${res.status})`);
  }
  return res.json();
}

export async function proposeIncidentAction(
  incidentId: string,
  payload: {
    tool_name: string;
    rationale: string;
    parameters?: Record<string, any>;
    recovery_duration_seconds?: number;
    proposed_by?: string;
  }
): Promise<IncidentState> {
  const res = await fetch(
    `${API_BASE_URL}/api/incidents/${incidentId}/actions/propose`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to propose action (HTTP ${res.status})`);
  }
  return res.json();
}

export async function approveIncidentAction(
  incidentId: string,
  actionId: string,
  payload: {
    commander_id?: string;
    override_parameters?: Record<string, any>;
    notes?: string;
  },
  authKey: string = DEFAULT_COMMANDER_KEY
): Promise<IncidentState> {
  const res = await fetch(
    `${API_BASE_URL}/api/incidents/${incidentId}/actions/${actionId}/approve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tocsin-Auth': authKey,
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to approve action (HTTP ${res.status})`);
  }
  return res.json();
}

export async function rejectIncidentAction(
  incidentId: string,
  actionId: string,
  payload: {
    commander_id?: string;
    reason: string;
  },
  authKey: string = DEFAULT_COMMANDER_KEY
): Promise<IncidentState> {
  const res = await fetch(
    `${API_BASE_URL}/api/incidents/${incidentId}/actions/${actionId}/reject`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tocsin-Auth': authKey,
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to reject action (HTTP ${res.status})`);
  }
  return res.json();
}

export async function registerParticipant(
  incidentId: string,
  payload: { name: string; role?: string; role_source?: string; agora_uid?: string; language?: string }
): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to register participant (HTTP ${res.status})`);
  }
  return res.json();
}

export async function requestSpokenSummary(incidentId: string): Promise<{ content: string; summary_type: string }> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/summary/spoken`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to generate spoken summary (HTTP ${res.status})`);
  }
  return res.json();
}

export async function getFinalSummary(incidentId: string): Promise<{ content: string; summary_type: string }> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/summary/final`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to fetch final summary (HTTP ${res.status})`);
  }
  return res.json();
}

export async function runIdentityOutageDemo(): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/demo/identity-outage/run-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to run demo scenario (HTTP ${res.status})`);
  }
  return res.json();
}

export async function simulateTranscript(
  incidentId: string,
  payload: { speaker: string; speaker_role?: string; raw_utterance: string; source?: string }
): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/demo/simulate-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      incident_id: incidentId,
      speaker: payload.speaker,
      speaker_role: payload.speaker_role || 'ENGINEER',
      raw_utterance: payload.raw_utterance,
      source: payload.source || 'demo_transcript_simulation',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to simulate transcript (HTTP ${res.status})`);
  }
  return res.json();
}

export async function checkIncidentReminders(incidentId: string): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/check-reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to check reminders (HTTP ${res.status})`);
  }
  return res.json();
}

export async function completeActionItem(
  incidentId: string,
  itemId: string,
  evidence: string = 'Task completed and verified'
): Promise<any> {
  const res = await fetch(`${API_BASE_URL}/api/incidents/${incidentId}/action-items/${itemId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ evidence }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to complete action item (HTTP ${res.status})`);
  }
  return res.json();
}
