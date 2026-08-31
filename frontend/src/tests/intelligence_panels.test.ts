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
  assert.match(html, /No active conflicts detected/);
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
  assert.match(html, /Conflicting Information/);
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

test('DemoModeControl renders demo banner, scenario trigger, and transcript simulator', () => {
  const html = renderToStaticMarkup(
    React.createElement(DemoModeControl, {
      activeIncidentId: 'inc-demo-payment-outage',
      onIncidentUpdated: () => {},
    })
  );
  assert.match(html, /DEMO MODE/);
  assert.match(html, /Run Identity Outage Scenario/);
  assert.match(html, /Scan Overdue Action Reminders/);
  assert.match(html, /Simulate Utterance:/);
  assert.match(html, /Dave Miller/);
});
