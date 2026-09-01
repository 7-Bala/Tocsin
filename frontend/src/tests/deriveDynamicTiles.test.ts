import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { deriveDynamicTiles, MAX_TILES } from '../lib/deriveDynamicTiles';
import { Claim, ConflictRecord, ActionItem, IncidentState } from '../types/incident';

function makeClaim(overrides: Partial<Claim> & { entity: string; value: string }): Claim {
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

describe('deriveDynamicTiles — fail-proof requirements (plan §5)', () => {
  test('backend unreachable / no incident loaded: isDisconnected, not fabricated data', () => {
    const result = deriveDynamicTiles(null);
    assert.equal(result.isDisconnected, true);
    assert.equal(result.isEmpty, false);
    assert.deepEqual(result.tiles, []);
  });

  test('undefined incident (same as null) also reports disconnected, never throws', () => {
    assert.doesNotThrow(() => deriveDynamicTiles(undefined));
    const result = deriveDynamicTiles(undefined);
    assert.equal(result.isDisconnected, true);
  });

  test('new incident with zero claims: isEmpty, not fabricated placeholder values', () => {
    const state = makeState({ claims: [] });
    const result = deriveDynamicTiles(state);
    assert.equal(result.isDisconnected, false);
    assert.equal(result.isEmpty, true);
    assert.deepEqual(result.tiles, []);
  });

  test('heuristic fallback claim renders but is flagged, never silently equal to LLM output', () => {
    const state = makeState({
      claims: [
        makeClaim({ entity: 'login api', value: 'down', extraction_method: 'heuristic_fallback' }),
      ],
    });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles.length, 1);
    assert.equal(result.tiles[0].isUnverifiedExtraction, true);
    assert.match(result.tiles[0].subLabel, /Unverified/);
  });

  test('malformed claim (missing entity/value) is skipped, never throws, other claims still render', () => {
    const state = makeState({
      claims: [
        // @ts-expect-error deliberately malformed for the test
        { id: 'clm-bad', status: 'REPORTED' },
        makeClaim({ entity: 'auth service', value: 'healthy' }),
      ],
    });
    assert.doesNotThrow(() => deriveDynamicTiles(state));
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles.length, 1);
    assert.equal(result.tiles[0].entity, 'auth service');
  });

  test('more than MAX_TILES salient entities: shows exactly MAX_TILES + reports overflow count', () => {
    const claims = Array.from({ length: 10 }, (_, i) =>
      makeClaim({ entity: `entity-${i}`, value: 'healthy', timestamp: new Date(Date.now() - i * 1000).toISOString() })
    );
    const state = makeState({ claims });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles.length, MAX_TILES);
    assert.equal(result.overflowCount, 10 - MAX_TILES);
  });

  test('conflicted entity always sorts first regardless of recency', () => {
    const oldConflicted = makeClaim({
      entity: 'authentication database',
      value: 'overloaded',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    const recentHealthy = makeClaim({
      entity: 'login api',
      value: 'healthy',
      timestamp: new Date().toISOString(),
    });
    const conflict: ConflictRecord = {
      id: 'cfl-1',
      incident_id: 'inc-1',
      claim_a_id: 'x',
      claim_b_id: oldConflicted.id,
      entity: 'authentication database',
      value_a: 'healthy',
      value_b: 'overloaded',
      source_a: 'a',
      source_b: 'b',
      status: 'OPEN',
      created_at: new Date().toISOString(),
    };
    const state = makeState({ claims: [oldConflicted, recentHealthy], conflicts: [conflict] });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles[0].entity, 'authentication database');
    assert.equal(result.tiles[0].isConflicted, true);
    assert.equal(result.tiles[0].tone, 'conflicted');
  });

  test('resolved conflict does not force top priority or conflicted tone', () => {
    const claim = makeClaim({ entity: 'authentication database', value: 'overloaded' });
    const resolvedConflict: ConflictRecord = {
      id: 'cfl-1',
      incident_id: 'inc-1',
      claim_a_id: 'x',
      claim_b_id: claim.id,
      entity: 'authentication database',
      value_a: 'healthy',
      value_b: 'overloaded',
      source_a: 'a',
      source_b: 'b',
      status: 'RESOLVED',
      created_at: new Date().toISOString(),
    };
    const state = makeState({ claims: [claim], conflicts: [resolvedConflict] });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles[0].isConflicted, false);
    assert.notEqual(result.tiles[0].tone, 'conflicted');
  });

  test('stale entity (no update in 5+ minutes) is flagged', () => {
    const staleClaim = makeClaim({
      entity: 'old entity',
      value: 'healthy',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const result = deriveDynamicTiles(makeState({ claims: [staleClaim] }));
    assert.equal(result.tiles[0].isStale, true);
    assert.match(result.tiles[0].subLabel, /No recent update/);
  });

  test('fresh entity is not flagged stale', () => {
    const freshClaim = makeClaim({ entity: 'new entity', value: 'healthy', timestamp: new Date().toISOString() });
    const result = deriveDynamicTiles(makeState({ claims: [freshClaim] }));
    assert.equal(result.tiles[0].isStale, false);
  });
});

describe('deriveDynamicTiles — tile shape classification (plan §6.2)', () => {
  test('numeric measurement value renders as a numeric tile', () => {
    // The regex takes the first standalone measurement it finds, left to right — here
    // that's "503 errors", not the later "40%". Shape classification only needs "is
    // there a measurement at all", so this is correct, not a partial match.
    const claim = makeClaim({ entity: 'login api', value: 'returning 503 errors for 40% of requests' });
    const result = deriveDynamicTiles(makeState({ claims: [claim] }));
    assert.equal(result.tiles[0].shape, 'numeric');
    assert.match(result.tiles[0].value, /503 errors/);
  });

  test('numeric measurement picks the percentage when it is the only measurement present', () => {
    const claim = makeClaim({ entity: 'login api', value: '40% error rate' });
    const result = deriveDynamicTiles(makeState({ claims: [claim] }));
    assert.equal(result.tiles[0].shape, 'numeric');
    assert.match(result.tiles[0].value, /40%/);
  });

  test('health-polarity value renders as a status tile with healthy tone', () => {
    const claim = makeClaim({ entity: 'identity service', value: 'up and running' });
    const result = deriveDynamicTiles(makeState({ claims: [claim] }));
    assert.equal(result.tiles[0].shape, 'status');
    assert.equal(result.tiles[0].tone, 'healthy');
  });

  test('unhealthy-polarity value renders as a status tile with unhealthy tone', () => {
    const claim = makeClaim({ entity: 'identity service', value: 'down and unresponsive' });
    const result = deriveDynamicTiles(makeState({ claims: [claim] }));
    assert.equal(result.tiles[0].shape, 'status');
    assert.equal(result.tiles[0].tone, 'unhealthy');
  });

  test('free-text value (no measurement, no polarity keyword) renders as a text tile with neutral tone', () => {
    const claim = makeClaim({ entity: 'deployment region', value: 'us-east-1' });
    const result = deriveDynamicTiles(makeState({ claims: [claim] }));
    assert.equal(result.tiles[0].shape, 'text');
    assert.equal(result.tiles[0].tone, 'neutral');
    // Regression guard: an identifier like "us-east-1" must not be misread as numeric.
    assert.equal(result.tiles[0].value, 'us-east-1');
  });

  test('identity-outage scenario produces identity-shaped tiles, not flood-shaped ones', () => {
    const state = makeState({
      claims: [
        makeClaim({ entity: 'login api', value: 'returning 503 errors for 40% of requests' }),
        makeClaim({ entity: 'authentication database', value: 'healthy, connections normal' }),
      ],
    });
    const result = deriveDynamicTiles(state);
    const labels = result.tiles.map((t) => t.label);
    assert.ok(labels.some((l) => /Login Api/i.test(l) || /login api/i.test(l)));
    assert.ok(labels.some((l) => /Authentication Database/i.test(l)));
    // The whole point: nothing here is a hardcoded "Customers Affected" / "Gateway
    // Error Rate" / "Water Level" label — every label is derived from the entity text.
    assert.ok(!labels.includes('Customers Affected'));
    assert.ok(!labels.includes('Water Level'));
  });

  test('a flood-scenario incident (if one ever exists again) would produce flood-shaped tiles from the same code path', () => {
    // Not because flood patterns are special-cased — because nothing is. This is the
    // generality guarantee: whatever entities exist, tiles follow.
    const state = makeState({
      claims: [makeClaim({ entity: 'river water level', value: 'critical, above danger mark' })],
    });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles[0].label, 'River Water Level');
    // "critical" is in UNHEALTHY_VALUES (mirrors the backend's list exactly) — same
    // code path, same classification logic, whatever the entity or scenario is.
    assert.equal(result.tiles[0].tone, 'unhealthy');
    assert.equal(result.tiles[0].shape, 'status');
  });
});

describe('deriveDynamicTiles — priority ordering (plan §6.1)', () => {
  test('overdue-action entity outranks a merely-confirmed entity', () => {
    const confirmed = makeClaim({ entity: 'confirmed thing', value: 'healthy', status: 'CONFIRMED' });
    const overdueRelated = makeClaim({ entity: 'overdue thing', value: 'reported', status: 'REPORTED' });
    const overdueAction: ActionItem = {
      id: 'ai-1',
      incident_id: 'inc-1',
      description: 'fix the overdue thing',
      status: 'OVERDUE',
      created_at: new Date().toISOString(),
    };
    const state = makeState({
      claims: [confirmed, overdueRelated],
      action_items: [overdueAction],
    });
    const result = deriveDynamicTiles(state);
    assert.equal(result.tiles[0].entity, 'overdue thing');
  });

  test('confirmed outranks reported/unverified, which outranks assumed', () => {
    const assumed = makeClaim({ entity: 'assumed thing', value: 'maybe fine', status: 'ASSUMED' });
    const reported = makeClaim({ entity: 'reported thing', value: 'reported value', status: 'REPORTED' });
    const confirmed = makeClaim({ entity: 'confirmed thing', value: 'healthy', status: 'CONFIRMED' });
    const state = makeState({ claims: [assumed, reported, confirmed] });
    const result = deriveDynamicTiles(state);
    const order = result.tiles.map((t) => t.entity);
    assert.deepEqual(order, ['confirmed thing', 'reported thing', 'assumed thing']);
  });

  test('a fresh claim outranks a STALE confirmed one (live-reported 2026-09-02)', () => {
    // Regression test for the real defect behind "the tiles are not updating, they
    // show old data": ordering weighted evidence status but ignored age entirely, so
    // the seeded demo incident's stale CONFIRMED claims permanently occupied the top
    // of the panel and freshly-spoken observations were pushed below them (or into
    // overflow). The tiles were live-updating the whole time; they just looked frozen.
    const now = new Date('2026-09-02T12:00:00Z');
    const staleConfirmed = makeClaim({
      entity: 'stale confirmed thing',
      value: 'healthy',
      status: 'CONFIRMED',
      timestamp: new Date('2026-09-02T11:00:00Z').toISOString(), // 1h old -> stale
    });
    const freshReported = makeClaim({
      entity: 'fresh reported thing',
      value: 'failing',
      status: 'REPORTED',
      timestamp: new Date('2026-09-02T11:59:30Z').toISOString(), // 30s old -> fresh
    });
    const state = makeState({ claims: [staleConfirmed, freshReported] });
    const result = deriveDynamicTiles(state, now);

    assert.equal(result.tiles[0].entity, 'fresh reported thing');
    assert.equal(result.tiles[0].isStale, false);
    assert.equal(result.tiles[1].entity, 'stale confirmed thing');
    assert.equal(result.tiles[1].isStale, true);
  });

  test('an open conflict stays pinned above a fresh claim even when the conflict is stale', () => {
    // The freshness demotion above must not bury genuinely open, actionable work.
    // A contradiction that nobody has resolved is still the most important thing on
    // screen, however old it is.
    const now = new Date('2026-09-02T12:00:00Z');
    const staleConflicted = makeClaim({
      entity: 'contested thing',
      value: 'normal',
      status: 'CONFLICTED',
      timestamp: new Date('2026-09-02T10:00:00Z').toISOString(), // 2h old -> stale
    });
    const freshReported = makeClaim({
      entity: 'fresh thing',
      value: 'failing',
      status: 'REPORTED',
      timestamp: new Date('2026-09-02T11:59:30Z').toISOString(),
    });
    const conflict: ConflictRecord = {
      id: 'cf-1',
      incident_id: 'inc-1',
      entity: 'contested thing',
      claim_a_id: 'a',
      claim_b_id: 'b',
      description: 'contradiction',
      status: 'OPEN',
      detected_at: new Date('2026-09-02T10:00:00Z').toISOString(),
    } as ConflictRecord;
    const state = makeState({ claims: [staleConflicted, freshReported], conflicts: [conflict] });
    const result = deriveDynamicTiles(state, now);

    assert.equal(result.tiles[0].entity, 'contested thing');
    assert.equal(result.tiles[0].isConflicted, true);
    assert.equal(result.tiles[1].entity, 'fresh thing');
  });
});
