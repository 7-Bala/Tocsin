import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IntelligencePanel } from '../components/IntelligencePanel';
import { ConflictsPanel } from '../components/ConflictsPanel';
import { ActionItemsPanel } from '../components/ActionItemsPanel';
import { ParticipantsPanel } from '../components/ParticipantsPanel';
import { FinalSummaryPanel } from '../components/FinalSummaryPanel';
import { IncidentState, ConflictRecord, ActionItem, Participant } from '../types/incident';

test('ConflictsPanel renders empty state when no conflicts exist', () => {
  const html = renderToStaticMarkup(React.createElement(ConflictsPanel, { conflicts: [] }));
  assert.match(html, /No contradictions detected/);
});

test('ConflictsPanel renders active conflicts with opposing claims and recommendations', () => {
  const mockConflicts: ConflictRecord[] = [
    {
      id: 'cfl-1',
      incident_id: 'inc-1',
      claim_a_id: 'cl-1',
      claim_b_id: 'cl-2',
      entity: 'identity service',
      value_a: 'down',
      value_b: 'healthy',
      source_a: 'frontend_team',
      source_b: 'database_team',
      speaker_a: 'Alice',
      speaker_b: 'Bob',
      status: 'OPEN',
      recommended_action: 'Check monitoring telemetry',
      created_at: new Date().toISOString(),
    },
  ];
  const html = renderToStaticMarkup(React.createElement(ConflictsPanel, { conflicts: mockConflicts }));
  assert.match(html, /Contradictions/);
  assert.match(html, /identity service/);
  assert.match(html, /down/);
  assert.match(html, /healthy/);
  assert.match(html, /Recommended:/);
  assert.match(html, /Check monitoring telemetry/);
});

test('ActionItemsPanel renders overdue tasks and assigned owner', () => {
  const mockTasks: ActionItem[] = [
    {
      id: 'act-1',
      incident_id: 'inc-1',
      description: 'Verify database replica connectivity',
      owner_name: 'Dave',
      status: 'OVERDUE',
      created_at: new Date().toISOString(),
      due_at: new Date().toISOString(),
    },
  ];
  const html = renderToStaticMarkup(React.createElement(ActionItemsPanel, { actionItems: mockTasks }));
  assert.match(html, /Verify database replica connectivity/);
  assert.match(html, /Dave/);
  assert.match(html, /OVERDUE/);
});

test('ActionItemsPanel flags an unowned open item distinctly, not as plain "Unassigned"', () => {
  const mockTasks: ActionItem[] = [
    {
      id: 'act-unowned-1',
      incident_id: 'inc-1',
      description: 'Confirm auth DB connection pool size',
      owner_name: null,
      status: 'OPEN',
      created_at: new Date().toISOString(),
    },
  ];
  const html = renderToStaticMarkup(React.createElement(ActionItemsPanel, { actionItems: mockTasks }));
  assert.match(html, /Confirm auth DB connection pool size/);
  // Must be visually flagged (a warning marker), not the old plain "Unassigned" text.
  assert.match(html, /⚠ Unassigned/);
});

test('ActionItemsPanel does not flag a COMPLETE item with no recorded owner as an accountability gap', () => {
  const mockTasks: ActionItem[] = [
    {
      id: 'act-complete-unowned-1',
      incident_id: 'inc-1',
      description: 'Old task nobody claimed, later completed',
      owner_name: null,
      status: 'COMPLETE',
      created_at: new Date().toISOString(),
    },
  ];
  const html = renderToStaticMarkup(React.createElement(ActionItemsPanel, { actionItems: mockTasks }));
  // Completed work isn't an open accountability gap — plain "Unassigned", no warning icon.
  assert.match(html, /Unassigned/);
  assert.doesNotMatch(html, /⚠ Unassigned/);
});

test('ParticipantsPanel renders declared vs inferred role metrics', () => {
  const mockParticipants: Participant[] = [
    {
      id: 'p-1',
      name: 'Sarah Chen',
      role: 'INCIDENT_COMMANDER',
      role_source: 'declared',
      role_confidence: 1.0,
      agora_uid: '1001',
      language: 'en',
      last_active: new Date().toISOString(),
    },
    {
      id: 'p-2',
      name: 'Ravi Kumar',
      role: 'ENGINEER',
      role_source: 'inferred',
      role_confidence: 0.85,
      agora_uid: '1002',
      language: 'en',
      last_active: new Date().toISOString(),
    },
  ];
  const html = renderToStaticMarkup(React.createElement(ParticipantsPanel, { participants: mockParticipants }));
  assert.match(html, /Sarah Chen/);
  assert.match(html, /INCIDENT_COMMANDER/);
  assert.match(html, /Declared/);
  assert.match(html, /Ravi Kumar/);
  assert.match(html, /Inferred \(85%\)/);
});

test('IntelligencePanel renders full state suite', () => {
  const mockIncident: IncidentState = {
    incident_id: 'inc-test-1',
    title: 'Flood Hazard Emergency',
    event_type: 'FLOOD_SURGE',
    status: 'DEGRADING',
    severity: 'HIGH',
    metrics: {
      severity_score: 65,
      water_safety_index: 80,
      flood_depth_meters: 1.2,
      affected_population: 45,
      infrastructure_integrity_pct: 75,
    },
    symptoms: [],
    timeline: [],
    hypotheses: [],
    proposed_actions: [],
    actions_taken: [],
    participants: [],
    observations: [
      {
        id: 'obs-1',
        incident_id: 'inc-test-1',
        raw_utterance: 'Water intake pump failing in Sector 4.',
        speaker: 'Field Lead',
        source: 'voice_transcript',
        category: 'REPORT',
        status: 'UNVERIFIED',
        content: 'Pump failing',
        confidence: 0.8,
        timestamp: new Date().toISOString(),
        extraction_method: 'llm',
      },
    ],
    claims: [],
    conflicts: [],
    action_items: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const html = renderToStaticMarkup(React.createElement(IntelligencePanel, { incident: mockIncident }));
  assert.match(html, /Shared Incident Intelligence Record/);
  assert.match(html, /Field Lead/);
  assert.match(html, /Water intake pump failing in Sector 4/);
  assert.match(html, /UNVERIFIED/);
});

import { DemoModeControl } from '../components/DemoModeControl';
import { HandoffPanel } from '../components/HandoffPanel';

test('DemoModeControl renders demo banner, scenario trigger, and transcript simulator', () => {
  const html = renderToStaticMarkup(
    React.createElement(DemoModeControl, {
      activeIncidentId: 'inc-demo-identity-outage',
      onIncidentUpdated: () => {},
    })
  );
  assert.match(html, /DEMO MODE/);
  assert.match(html, /Run Identity Outage Scenario/);
  assert.match(html, /Scan Overdue Action Reminders/);
  assert.match(html, /Simulate Utterance:/);
  assert.match(html, /Dave Miller/);
});


// ── Evidence lifecycle: resolution surface ───────────────────────────────────

test('ConflictsPanel offers a resolution affordance only when an incidentId is supplied', () => {
  const conflict: ConflictRecord = {
    id: 'cfl-res-1',
    incident_id: 'inc-1',
    claim_a_id: 'cl-1',
    claim_b_id: 'cl-2',
    entity: 'authentication database',
    value_a: 'overloaded',
    value_b: 'healthy',
    source_a: 'voice_dave',
    source_b: 'voice_priya',
    speaker_a: 'Dave Miller',
    speaker_b: 'Priya Sharma',
    status: 'OPEN',
    recommended_action: 'Check authoritative telemetry',
    created_at: new Date().toISOString(),
  };

  // Read-only render (no incidentId): no resolve control.
  const readOnly = renderToStaticMarkup(
    React.createElement(ConflictsPanel, { conflicts: [conflict] })
  );
  assert.doesNotMatch(readOnly, /Resolve this contradiction/);

  // Interactive render: resolve control present.
  const interactive = renderToStaticMarkup(
    React.createElement(ConflictsPanel, { conflicts: [conflict], incidentId: 'inc-1' })
  );
  assert.match(interactive, /Resolve this contradiction/);
  assert.match(interactive, /Needs human resolution/);
});

test('ConflictsPanel separates settled contradictions and shows who resolved them', () => {
  const settled: ConflictRecord = {
    id: 'cfl-settled-1',
    incident_id: 'inc-1',
    claim_a_id: 'cl-1',
    claim_b_id: 'cl-2',
    entity: 'authentication database',
    value_a: 'overloaded',
    value_b: 'healthy',
    source_a: 'voice_dave',
    source_b: 'voice_priya',
    speaker_a: 'Dave Miller',
    speaker_b: 'Priya Sharma',
    status: 'RESOLVED',
    created_at: new Date().toISOString(),
    resolved_by: 'Commander Sarah Chen',
    resolution_notes: 'Dashboard shows connection pool at 22%.',
  };

  const html = renderToStaticMarkup(
    React.createElement(ConflictsPanel, { conflicts: [settled], incidentId: 'inc-1' })
  );
  // Zero open, so the panel must say so rather than implying unresolved work.
  assert.match(html, /All detected contradictions have been resolved/);
  assert.match(html, /Settled contradictions \(1\)/);
  assert.match(html, /Commander Sarah Chen/);
  assert.match(html, /connection pool at 22%/);
});

test('HandoffPanel renders idle state without claiming an audio broadcast', () => {
  const html = renderToStaticMarkup(
    React.createElement(HandoffPanel, { incidentId: 'inc-1' })
  );
  assert.match(html, /Shift Handoff Brief/);
  assert.match(html, /Generate handoff/);
  // Honesty invariant: never imply audio was broadcast.
  assert.doesNotMatch(html, /broadcast(ing)? (the )?summary/i);
});
