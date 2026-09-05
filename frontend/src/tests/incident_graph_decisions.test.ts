/**
 * Decision nodes + fork edges on the incident whiteboard.
 *
 * The honesty rule these tests exist to pin: a decision links to evidence ONLY
 * when the decider's own rationale names it. "Came after" is not "because of",
 * and this project does not infer causation -- so a decision with no rationale,
 * or one naming nothing on the board, must get NO edge rather than being wired
 * to whatever claim happened to precede it in time.
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { deriveIncidentGraph } from '../lib/deriveIncidentGraph';

const ts = '2026-09-05T13:06:00.000Z';

function claim(over: Record<string, unknown>) {
  return {
    id: 'c1', observation_id: 'o1', incident_id: 'i1', claim_type: 'status',
    entity: 'login api', value: 'returning 503 errors', speaker: 'Dave',
    source: 'voice_transcript', timestamp: ts, confidence: 0.9,
    status: 'REPORTED', extraction_method: 'llm', ...over,
  };
}

function state(claims: unknown[]) {
  return { incident_id: 'i1', claims, hypotheses: [], conflicts: [] } as never;
}

describe('whiteboard decision nodes', () => {
  test('a decision becomes a decision node, not an entity node', () => {
    const g = deriveIncidentGraph(state([
      claim({}),
      claim({ id: 'd1', claim_type: 'decision', entity: 'rollback',
              value: 'Hold the rollback', decided_by: 'Sarah' }),
    ]));
    assert.strictEqual(g.decisions.length, 1);
    assert.strictEqual(g.decisions[0].decidedBy, 'Sarah');
    // The decision's `entity` must NOT leak in as a phantom system.
    assert.ok(!g.entities.some((e) => e.label.toLowerCase().includes('rollback')));
  });

  test('a decision citing an entity in its rationale gets a cites edge', () => {
    const g = deriveIncidentGraph(state([
      claim({}),
      claim({ id: 'd1', claim_type: 'decision', entity: 'rollback',
              value: 'Hold the rollback',
              rationale: 'login api error rate is the only confirmed signal' }),
    ]));
    const cites = g.edges.filter((e) => e.kind === 'cites');
    assert.strictEqual(cites.length, 1);
    assert.ok(cites[0].to.includes('login api'));
  });

  test('a decision with NO rationale gets no edge, even though a claim preceded it', () => {
    const g = deriveIncidentGraph(state([
      claim({}),
      claim({ id: 'd1', claim_type: 'decision', entity: 'rollback',
              value: 'Hold the rollback', rationale: null }),
    ]));
    assert.strictEqual(g.edges.filter((e) => e.kind === 'cites').length, 0);
  });

  test('a rationale naming nothing on the board gets no edge', () => {
    const g = deriveIncidentGraph(state([
      claim({}),
      claim({ id: 'd1', claim_type: 'decision', entity: 'rollback',
              value: 'Hold', rationale: 'waiting on the vendor to call back' }),
    ]));
    assert.strictEqual(g.edges.filter((e) => e.kind === 'cites').length, 0);
  });

  test('a superseded decision is kept and marked, never dropped', () => {
    const g = deriveIncidentGraph(state([
      claim({ id: 'd1', claim_type: 'decision', entity: 'rollback',
              value: 'Roll back now', superseded_by_id: 'd2' }),
      claim({ id: 'd2', claim_type: 'decision', entity: 'rollback',
              value: 'Hold the rollback', supersedes_id: 'd1' }),
    ]));
    assert.strictEqual(g.decisions.length, 2);
    const old = g.decisions.find((d) => d.fullText === 'Roll back now');
    assert.strictEqual(old?.isSuperseded, true);
    const sup = g.edges.filter((e) => e.kind === 'supersedes');
    assert.strictEqual(sup.length, 1);
  });

  test('entity nodes carry a timestamp for the flowchart caption', () => {
    const g = deriveIncidentGraph(state([claim({})]));
    assert.strictEqual(g.entities[0].timestamp, ts);
  });
});
