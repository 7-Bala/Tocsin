import { Claim, ConflictRecord, IncidentState } from '@/types/incident';

/**
 * Derives a dynamic "situation tile" set from a live IncidentState, per the design in
 * docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md §6.
 *
 * This replaces `/voice-test`'s old `extractIncidentInfo()` — a client-side regex
 * simulator with hardcoded flood/fire/earthquake patterns and exactly 4 fixed tile
 * slots — with tiles computed from whatever claims actually exist for the current
 * incident. A flood incident produces flood-shaped tiles; an identity outage produces
 * identity-shaped tiles; nothing is pattern-matched against a fixed disaster taxonomy.
 *
 * Pure function: no side effects, no fetch. This is deliberate — every branch here is
 * meant to be exhaustively unit-testable without a browser or a backend, per the
 * fail-proof requirements table in the plan (§5).
 */

export type TileShape = 'numeric' | 'status' | 'text';
export type TileTone = 'healthy' | 'unhealthy' | 'neutral' | 'conflicted';

export interface DynamicTile {
  entity: string;
  /** Human-readable label, Title Cased from the raw entity string. */
  label: string;
  shape: TileShape;
  /** Rendered value, e.g. "40%" or "Overloaded" or the raw claim value. */
  value: string;
  subLabel: string;
  tone: TileTone;
  /** True when this claim came from the keyword heuristic fallback, not the LLM. */
  isUnverifiedExtraction: boolean;
  /** True when this entity has an OPEN (unresolved) conflict. */
  isConflicted: boolean;
  /** True when the most recent claim for this entity is older than STALE_AFTER_MS. */
  isStale: boolean;
  updatedAt: string;
}

export interface DeriveTilesResult {
  tiles: DynamicTile[];
  /** Count of additional salient entities beyond MAX_TILES, not shown. */
  overflowCount: number;
  /** True when there is no incident loaded at all (distinct from "loaded but empty"). */
  isDisconnected: boolean;
  /** True when an incident is loaded but has no claims yet. */
  isEmpty: boolean;
}

export const MAX_TILES = 6;
export const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

// Mirrors backend/app/engine/extraction.py's HEALTHY_VALUES / UNHEALTHY_VALUES
// exactly, so a claim classifies identically whether it's compared server-side (for
// conflict detection) or client-side (for tile tone). Keep these two lists in sync by
// hand if the backend list ever changes — there is no shared source of truth between
// the Python and TypeScript runtimes to enforce it automatically.
const HEALTHY_VALUES = [
  'healthy', 'up', 'operational', 'running', 'ok', 'working', 'stable', 'normal',
  'resolved', 'fixed', 'online', 'available', 'green',
];
const UNHEALTHY_VALUES = [
  'down', 'failing', 'failed', 'error', 'unavailable', 'offline', 'broken',
  'degraded', 'unresponsive', 'critical', 'red', 'dead', 'crashed',
];

// Mirrors backend/app/engine/conflict_detector.py's _MEASUREMENT_RE intent: a number
// is a MEASUREMENT only when it stands alone as a quantity, optionally with a unit —
// not when it's welded into an identifier like "us-east-1" or "v2". Deliberately a
// simpler port (the backend's is the source of truth for conflict detection itself;
// this only needs to decide tile shape, so false negatives here just mean a claim
// renders as a text tile instead of a numeric one, which is a harmless degradation).
const MEASUREMENT_RE = /(?<![\w./-])(\d+(?:\.\d+)?)\s*(%|percent|ms|s\b|sec|secs|seconds|min|mins|minutes|rps|qps|gb|mb|kb|connections?|requests?|errors?|users?|nodes?|pods?|replicas?)?(?![\w.-]*[a-z])/i;

function normalizePolarity(value: string): 'healthy' | 'unhealthy' | null {
  const v = value.toLowerCase().trim();
  if (HEALTHY_VALUES.some((h) => v.includes(h))) return 'healthy';
  if (UNHEALTHY_VALUES.some((u) => v.includes(u))) return 'unhealthy';
  return null;
}

function toTitleCase(entity: string): string {
  return entity
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Verb phrases that mark where a subject ends and a predicate begins.
 *
 * Mirrors _PREDICATE_MARKERS / _canonical_entity in
 * backend/app/engine/incident_derivation.py -- kept in sync by hand, as there is no
 * shared source of truth across the Python and TypeScript runtimes (same caveat as
 * the UNHEALTHY vocabulary).
 *
 * Live-observed 2026-09-02: the extractor emitted "cdn edge network" AND "cdn edge
 * network is fully" as separate entities, and "login api" alongside "login api is
 * returning http 503". Keying tiles on the raw string rendered one real service as
 * two tiles, and a recovery claim never superseded the outage claim it was reporting
 * on -- so a tile could go red but never green again.
 */
const PREDICATE_MARKERS = [
  ' is ', ' are ', ' was ', ' were ', ' has ', ' have ', ' had ',
  ' returns ', ' returning ', ' went ', ' goes ', ' became ', ' keeps ',
];

/**
 * Reduce an extractor-supplied entity to the subject it names, so the same real
 * service collapses to one tile across turns.
 *
 * Deliberately conservative: trims only at an explicit predicate marker. It does not
 * attempt semantic aliasing -- "kafka broker" and "kafka event broker cluster" stay
 * distinct, because deciding those name one service is a judgement about the world,
 * and merging two genuinely different failures would hide one of them.
 */
function normalizeEntityKey(entity: string): string {
  let text = entity.toLowerCase().trim();
  for (const marker of PREDICATE_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx > 0) {
      text = text.slice(0, idx);
      break;
    }
  }
  return text.split(/\s+/).join(' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
}

type Priority = 0 | 1 | 2 | 3 | 4;

/** Lower number = shown first. Matches the priority order in the design plan §6.1. */
function priorityFor(
  hasOpenConflict: boolean,
  hasOverdueAction: boolean,
  latestClaim: Claim
): Priority {
  if (hasOpenConflict) return 0;
  if (hasOverdueAction) return 1;
  if (latestClaim.status === 'CONFIRMED') return 2;
  if (latestClaim.status === 'REPORTED' || latestClaim.status === 'UNVERIFIED') return 3;
  return 4; // ASSUMED, or anything else
}

export function deriveDynamicTiles(
  state: IncidentState | null | undefined,
  now: Date = new Date()
): DeriveTilesResult {
  if (!state) {
    return { tiles: [], overflowCount: 0, isDisconnected: true, isEmpty: false };
  }

  const claims = (state.claims || []).filter(
    (c): c is Claim => !!c && typeof c.entity === 'string' && typeof c.value === 'string'
  );

  if (claims.length === 0) {
    return { tiles: [], overflowCount: 0, isDisconnected: false, isEmpty: true };
  }

  const openConflictEntities = new Set(
    (state.conflicts || [])
      .filter((c): c is ConflictRecord => !!c && c.status !== 'RESOLVED')
      .map((c) => normalizeEntityKey(c.entity))
  );

  const overdueEntities = new Set(
    (state.action_items || [])
      .filter((a) => a && a.status === 'OVERDUE' && a.description)
      // Action items don't carry a structured entity reference — approximate by
      // substring match against known entity keys once those are known, done below.
      .map((a) => a!.description!.toLowerCase())
  );

  // Group claims by normalized entity, keeping the most recent claim per group as the
  // group's representative value.
  const groups = new Map<string, { latest: Claim; original: string }>();
  for (const claim of claims) {
    const key = normalizeEntityKey(claim.entity);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing || new Date(claim.timestamp).getTime() > new Date(existing.latest.timestamp).getTime()) {
      // Label from the canonical key, not the raw string: when the extractor leaks
      // predicate text into the subject, `claim.entity` renders as "Login Api Is
      // Returning Http 503" while the key it grouped under is "login api".
      groups.set(key, { latest: claim, original: key });
    }
  }

  const scored = Array.from(groups.entries()).map(([key, { latest, original }]) => {
    const hasOpenConflict = openConflictEntities.has(key);
    const hasOverdueAction = Array.from(overdueEntities).some((desc) => desc.includes(key));
    const priority = priorityFor(hasOpenConflict, hasOverdueAction, latest);
    const ageMs = now.getTime() - new Date(latest.timestamp).getTime();
    const isStale = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;
    // Conflicts and overdue actions stay pinned regardless of age -- they are
    // open, actionable work, not merely "recent news". Everything else competes
    // on freshness first (see the sort below).
    const isPinned = priority <= 1;
    return { key, original, latest, hasOpenConflict, priority, isStale, isPinned };
  });

  // Ordering fix (2026-09-02): previously this sorted by `priority` before recency,
  // which meant a *stale* CONFIRMED claim (priority 2) permanently outranked a
  // *brand-new* REPORTED one (priority 3). On the seeded demo incident -- whose
  // original claims are CONFIRMED and conflicted -- that pinned the seed data to the
  // top of the panel forever, so freshly-spoken observations were pushed to the
  // bottom or into overflow. The tiles were genuinely live-updating the whole time,
  // but looked frozen on old data, which is indistinguishable from "hardcoded" to
  // anyone watching. Staleness was already *displayed* ("No recent update") but was
  // not weighted in the ordering at all.
  //
  // Now: pinned items (open conflict / overdue action) first, then fresh before
  // stale, then evidence-status priority, then newest first.
  scored.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned && b.isPinned && a.priority !== b.priority) return a.priority - b.priority;
    if (a.isStale !== b.isStale) return a.isStale ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(b.latest.timestamp).getTime() - new Date(a.latest.timestamp).getTime();
  });

  const shown = scored.slice(0, MAX_TILES);
  const overflowCount = Math.max(0, scored.length - MAX_TILES);

  const tiles: DynamicTile[] = shown.map(({ original, latest, hasOpenConflict, isStale }) => {
    const measurementMatch = MEASUREMENT_RE.exec(latest.value);
    const polarity = normalizePolarity(latest.value);

    let shape: TileShape;
    let value: string;
    if (measurementMatch) {
      shape = 'numeric';
      value = measurementMatch[0].trim();
    } else if (polarity) {
      shape = 'status';
      value = toTitleCase(latest.value);
    } else {
      shape = 'text';
      value = latest.value;
    }

    let tone: TileTone;
    if (hasOpenConflict) {
      tone = 'conflicted';
    } else if (polarity === 'healthy') {
      tone = 'healthy';
    } else if (polarity === 'unhealthy') {
      tone = 'unhealthy';
    } else {
      tone = 'neutral';
    }

    const isUnverifiedExtraction = latest.extraction_method === 'heuristic_fallback';
    // isStale is computed once, above, and reused here -- so the value that drives
    // the ordering can never disagree with the "No recent update" badge shown.

    const subLabelParts: string[] = [];
    if (hasOpenConflict) subLabelParts.push('Contradicted — needs resolution');
    if (isUnverifiedExtraction) subLabelParts.push('Unverified (heuristic)');
    if (isStale) subLabelParts.push('No recent update');
    if (subLabelParts.length === 0) subLabelParts.push(latest.status || 'REPORTED');

    return {
      entity: original,
      label: toTitleCase(original),
      shape,
      value,
      subLabel: subLabelParts.join(' · '),
      tone,
      isUnverifiedExtraction,
      isConflicted: hasOpenConflict,
      isStale,
      updatedAt: latest.timestamp,
    };
  });

  return { tiles, overflowCount, isDisconnected: false, isEmpty: false };
}
