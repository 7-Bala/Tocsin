import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  deriveIncidentGraph,
  MAX_ENTITY_NODES,
  MAX_HYPOTHESIS_NODES,
} from '../lib/deriveIncidentGraph';
import {
  Claim,
  ConflictRecord,
  Hypothesis,
  IncidentState,
} from '../types/incident';

function makeClaim(
  overrides: Partial<Claim> & { entity: string; value: string }
): Claim {
  return {
    id: `clm-${Math.random().toString(36).slice(2)}`,
    observation_id: 'obs-1',
    incident_id: 'inc-1',
    claim_type: 'system_health',
    speaker: 'Test Speaker',
    source: 'voice_transcript',
    timestamp: new Date().toISOString(),
    confidence: 0.8,
    status: 'REPORTED',
    extraction_method: 'llm',
    ...overrides,
  };
}

function makeHypothesis(overrides: Partial<Hypothesis> & { title: string }): Hypothesis {
  return {
    id: `hyp-${Math.random().toString(36).slice(2)}`,
    description: overrides.title,
    confidence: 0.6,
    status: 'PROPOSED',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeConflict(
  overrides: Partial<ConflictRecord> & { entity: string }
): ConflictRecord {
  return {
    id: `cf-${Math.random().toString(36).slice(2)}`,
    incident_id: 'inc-1',
    claim_a_id: 'a',
    claim_b_id: 'b',
    value_a: 'healthy',
    value_b: 'overloaded',
    source_a: 'voice_transcript',
    source_b: 'voice_transcript',
    status: 'OPEN',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<IncidentState> = {}): IncidentState {
  return {
    incident_id: 'inc-1',
    title: 'Test Incident',
    event_type: 'TECHNICAL_INCIDENT',
    status: 'DEGRADING',
    severity: 'HIGH',
    symptoms: [],
    timeline: [],
    hypotheses: [],
    proposed_actions: [],
    actions_taken: [],
    participants: [],
    claims: [],
    conflicts: [],
    action_items: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as IncidentState;
}

describe('deriveIncidentGraph — nothing is drawn that nobody said', () => {
  test('no incident at all reports disconnected, never a placeholder diagram', () => {
    const g = deriveIncidentGraph(null);
    assert.equal(g.isDisconnected, true);
    assert.deepEqual(g.entities, []);
    assert.deepEqual(g.edges, []);
  });

  test('undefined behaves like null and never throws', () => {
    assert.doesNotThrow(() => deriveIncidentGraph(undefined));
    assert.equal(deriveIncidentGraph(undefined).isDisconnected, true);
  });

  test('a loaded but silent incident is empty, not a fabricated topology', () => {
    const g = deriveIncidentGraph(makeState());
    assert.equal(g.isEmpty, true);
    assert.equal(g.isDisconnected, false);
    assert.deepEqual(g.entities, []);
  });

  test('an entity node appears only because a claim named it', () => {
    const g = deriveIncidentGraph(
      makeState({ claims: [makeClaim({ entity: 'login api', value: 'down' })] })
    );
    assert.equal(g.entities.length, 1);
    assert.equal(g.entities[0].label, 'Login Api');
    assert.equal(g.entities[0].health, 'unhealthy');
  });
});

describe('deriveIncidentGraph — entity nodes', () => {
  test('the latest claim wins, so a recovered service stops rendering as broken', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [
          makeClaim({
            entity: 'payments',
            value: 'down',
            timestamp: '2026-09-03T10:00:00Z',
          }),
          makeClaim({
            entity: 'payments',
            value: 'healthy',
            timestamp: '2026-09-03T11:00:00Z',
          }),
        ],
      })
    );
    assert.equal(g.entities.length, 1, 'both claims are about one service');
    assert.equal(g.entities[0].health, 'healthy');
    assert.equal(g.entities[0].claimCount, 2, 'history is still counted');
  });

  test('predicate text is trimmed so one service is one node, not two', () => {
    // Live-observed 2026-09-02: the extractor emitted both "login api" and
    // "login api is returning http 503" as separate entities.
    const g = deriveIncidentGraph(
      makeState({
        claims: [
          makeClaim({ entity: 'login api', value: 'degraded' }),
          makeClaim({ entity: 'login api is returning http 503', value: 'down' }),
        ],
      })
    );
    assert.equal(g.entities.length, 1);
  });

  test('a contradicted system outranks a merely broken one', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [
          makeClaim({ entity: 'cdn', value: 'down' }),
          makeClaim({ entity: 'auth database', value: 'healthy' }),
        ],
        conflicts: [makeConflict({ entity: 'auth database' })],
      })
    );
    assert.equal(
      g.entities[0].key,
      'auth database',
      'disagreement is more urgent than an agreed outage'
    );
    assert.equal(g.entities[0].isConflicted, true);
    assert.equal(g.entities[0].conflict?.valueB, 'overloaded');
  });

  test('a resolved conflict no longer marks the node', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'auth database', value: 'healthy' })],
        conflicts: [makeConflict({ entity: 'auth database', status: 'RESOLVED' })],
      })
    );
    assert.equal(g.entities[0].isConflicted, false);
  });

  test('heuristic-extracted claims are flagged, never shown as equal to LLM output', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [
          makeClaim({
            entity: 'kafka',
            value: 'crashed',
            extraction_method: 'heuristic_fallback',
          }),
        ],
      })
    );
    assert.equal(g.entities[0].isUnverifiedExtraction, true);
  });

  test('entities beyond the cap are counted, not silently dropped', () => {
    const claims = Array.from({ length: MAX_ENTITY_NODES + 3 }, (_, i) =>
      makeClaim({ entity: `service ${i}`, value: 'down' })
    );
    const g = deriveIncidentGraph(makeState({ claims }));
    assert.equal(g.entities.length, MAX_ENTITY_NODES);
    assert.equal(g.entityOverflow, 3);
  });

  test('node ids are stable across re-derivation so the map animates, not remounts', () => {
    const state = makeState({
      claims: [makeClaim({ entity: 'login api', value: 'down' })],
    });
    const first = deriveIncidentGraph(state);
    const second = deriveIncidentGraph(state);
    assert.equal(first.entities[0].id, second.entities[0].id);
  });
});

describe('deriveIncidentGraph — edges are spoken, never inferred', () => {
  test("an edge is drawn when a human's own hypothesis names the system", () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'auth database', value: 'down' })],
        hypotheses: [
          makeHypothesis({ title: 'I suspect the auth database is overloaded' }),
        ],
      })
    );
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0].to, 'entity:auth database');
    assert.equal(g.edges[0].kind, 'implicates');
  });

  test('no edge is invented between a cause and a system nobody connected', () => {
    // "the deploy broke things" does not name the CDN. Tocsin must not decide that
    // it meant the CDN — that judgement belongs to the humans in the room.
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'cdn edge network', value: 'offline' })],
        hypotheses: [makeHypothesis({ title: 'I think the deploy broke things' })],
      })
    );
    assert.equal(g.edges.length, 0);
    assert.equal(g.hypotheses.length, 1, 'the hypothesis is still shown, just unlinked');
  });

  test('the same system named at different lengths still links', () => {
    // Live-observed 2026-09-03 against real extractor output: the extractor emitted
    // the entity "kafka event broker cluster" while the engineer said "the kafka
    // broker ran out of disk space". Requiring the whole key drew zero edges on real
    // data — a graph that never draws an edge is not a graph.
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'kafka event broker cluster', value: 'crashed' })],
        hypotheses: [
          makeHypothesis({
            title: 'the SRE suspects the kafka broker ran out of disk space',
          }),
        ],
      })
    );
    assert.equal(g.edges.length, 1);
  });

  test('one shared generic word is not enough to link two unrelated systems', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'database connections', value: 'exhausted' })],
        hypotheses: [
          makeHypothesis({ title: 'the authentication database may be overloaded' }),
        ],
      })
    );
    assert.equal(
      g.edges.length,
      0,
      'sharing only "database" must not imply these are the same system'
    );
  });

  test('a single-word entity still needs its own whole word present', () => {
    const linked = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'kafka', value: 'down' })],
        hypotheses: [makeHypothesis({ title: 'kafka ran out of disk' })],
      })
    );
    assert.equal(linked.edges.length, 1);

    const unlinked = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'kafka', value: 'down' })],
        hypotheses: [makeHypothesis({ title: 'the deploy broke something' })],
      })
    );
    assert.equal(unlinked.edges.length, 0);
  });

  test('very short entity keys never match, so no nonsense links appear', () => {
    // "db" inside "..." would otherwise match words like "add".
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'db', value: 'down' })],
        hypotheses: [makeHypothesis({ title: 'We should add more capacity' })],
      })
    );
    assert.equal(g.edges.length, 0);
  });

  test('one hypothesis can implicate several systems it actually names', () => {
    const g = deriveIncidentGraph(
      makeState({
        claims: [
          makeClaim({ entity: 'login api', value: 'down' }),
          makeClaim({ entity: 'auth database', value: 'degraded' }),
        ],
        hypotheses: [
          makeHypothesis({
            title: 'the auth database saturation is what broke the login api',
          }),
        ],
      })
    );
    assert.equal(g.edges.length, 2);
  });

  test('a disproven hypothesis keeps its node and edges, marked, never hidden', () => {
    // Ruling something out is a real result the room paid for.
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'auth database', value: 'healthy' })],
        hypotheses: [
          makeHypothesis({
            title: 'the auth database was overloaded',
            status: 'DISPROVEN',
          }),
        ],
      })
    );
    assert.equal(g.hypotheses.length, 1);
    assert.equal(g.hypotheses[0].status, 'DISPROVEN');
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0].hypothesisStatus, 'DISPROVEN');
  });

  test('hypotheses beyond the cap are counted, and never produce hidden edges', () => {
    const hypotheses = Array.from({ length: MAX_HYPOTHESIS_NODES + 2 }, (_, i) =>
      makeHypothesis({ title: `cause ${i} involves the login api` })
    );
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'login api', value: 'down' })],
        hypotheses,
      })
    );
    assert.equal(g.hypotheses.length, MAX_HYPOTHESIS_NODES);
    assert.equal(g.hypothesisOverflow, 2);
    assert.equal(
      g.edges.length,
      MAX_HYPOTHESIS_NODES,
      'edges only reference hypotheses that are actually drawn'
    );
    const drawnIds = new Set(g.hypotheses.map((h) => h.id));
    assert.ok(g.edges.every((e) => drawnIds.has(e.from)));
  });

  test('long hypothesis text is truncated for the label but kept in full', () => {
    const long = `the ${'very '.repeat(30)}long theory about the login api`;
    const g = deriveIncidentGraph(
      makeState({
        claims: [makeClaim({ entity: 'login api', value: 'down' })],
        hypotheses: [makeHypothesis({ title: long })],
      })
    );
    assert.ok(g.hypotheses[0].label.length < long.length);
    assert.equal(g.hypotheses[0].fullText, long);
    assert.equal(g.edges.length, 1, 'matching uses the full text, not the truncation');
  });
});

describe('deriveIncidentGraph — a hypothesis alone is still a map', () => {
  test('hypotheses render even before any claim exists', () => {
    const g = deriveIncidentGraph(
      makeState({ hypotheses: [makeHypothesis({ title: 'maybe it is dns' })] })
    );
    assert.equal(g.isEmpty, false);
    assert.equal(g.hypotheses.length, 1);
    assert.equal(g.entities.length, 0);
    assert.deepEqual(g.edges, []);
  });
});
