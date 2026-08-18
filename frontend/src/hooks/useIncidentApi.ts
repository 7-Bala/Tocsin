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
