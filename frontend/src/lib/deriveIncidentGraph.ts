import {
  Claim,
  ConflictRecord,
  Hypothesis,
  HypothesisStatus,
  IncidentState,
} from '@/types/incident';
import {
  normalizeEntityKey,
  normalizePolarity,
  toTitleCase,
} from '@/lib/deriveDynamicTiles';

/**
 * Derives a live incident *map* — systems, proposed causes, and the links between
 * them — from the evidence record, so the room can see the shape of the incident
 * being drawn as people talk instead of reading it out of a list.
 *
 * Why a graph and not just more panels: an incident is a structure (this service is
 * broken, someone thinks that deploy caused it, two people disagree about the
 * database), and structure is the one thing a scrolling list of claims cannot show.
 *
 * The honesty rules that make this different from an LLM "draw me a diagram" toy,
 * and that every function here is built around:
 *
 *   - A node exists only because someone made a claim about that entity. Nothing is
 *     added to round out the picture, and no service appears just because it would
 *     be architecturally plausible.
 *   - An edge exists only because a human's own hypothesis sentence names that
 *     entity. Tocsin never infers "A probably caused B" on its own — the causal
 *     claim has to have been spoken by a person, and the edge carries who said it.
 *   - Edges are always rendered as proposed, never as established fact, because a
 *     hypothesis is a hypothesis even when it sounds confident.
 *   - A DISPROVEN hypothesis keeps its node and its edges. Ruling something out is
 *     a real result, and hiding it would silently rewrite the room's history.
 *
 * Pure function: state in, structure out, no geometry and no side effects. Layout
 * lives in the renderer (ExcalidrawIncidentMap.tsx) so this whole ruleset stays testable
 * without a DOM.
 */

export type NodeHealth = 'healthy' | 'unhealthy' | 'unknown';

export interface ConflictDetail {
  valueA: string;
  valueB: string;
  sourceA: string;
  sourceB: string;
  speakerA?: string | null;
  speakerB?: string | null;
}

export interface EntityNode {
  kind: 'entity';
  /** Stable across re-derivation so the renderer animates instead of remounting. */
  id: string;
  /** Normalized grouping key — the same one the situation tiles group on. */
  key: string;
  label: string;
  health: NodeHealth;
  /** The latest reported value for this entity, verbatim. */
  value: string;
  speaker: string | null;
  timestamp: string;
  /** CONFIRMED / REPORTED / ASSUMED / ... — the claim's own evidence status. */
  evidenceStatus: string;
  isConflicted: boolean;
  conflict?: ConflictDetail;
  /** True when the latest claim came from the keyword fallback, not the LLM. */
  isUnverifiedExtraction: boolean;
  /** How many claims have been made about this entity in total. */
  claimCount: number;
}

export interface HypothesisNode {
  kind: 'hypothesis';
  id: string;
  label: string;
  /** Full untruncated text, for the title/tooltip. */
  fullText: string;
  confidence: number;
  status: HypothesisStatus;
}

export interface DecisionNode {
  kind: 'decision';
  id: string;
  /** The decision itself, verbatim (truncated for display). */
  label: string;
  fullText: string;
  /** Why it was decided, if the decider gave a reason. */
  rationale: string | null;
  decidedBy: string | null;
  timestamp: string;
  /**
   * A superseded decision is drawn struck-through rather than removed. "We
   * decided X, then reversed it" is the single most important thing to hand to
   * the next shift, and deleting the reversed call loses exactly that.
   */
  isSuperseded: boolean;
  supersedesId: string | null;
}

export interface GraphEdge {
  id: string;
  /** Source node id (hypothesis, or decision for 'cites'/'supersedes'). */
  from: string;
  /** Target node id (entity, or the superseded decision). */
  to: string;
  /**
   * Every edge kind here traces to something a human actually said. There is
   * still no inferred-causation edge type, because Tocsin does not infer
   * causation:
   *  - 'implicates'  a hypothesis's own words named this system.
   *  - 'cites'       a decision's own stated rationale named this system. NOT
   *                  "this evidence caused this decision" -- only "the person
   *                  who decided it cited this". A decision whose rationale
   *                  names nothing gets no edge at all rather than being wired
   *                  to whatever happened to precede it in time.
   *  - 'supersedes'  one decision explicitly reversed another, per the
   *                  supersedes_id the backend already records.
   */
  kind: 'implicates' | 'cites' | 'supersedes';
  /** Carried through so the renderer can dim edges from a ruled-out hypothesis. */
  hypothesisStatus: HypothesisStatus;
}

export interface IncidentGraph {
  entities: EntityNode[];
  hypotheses: HypothesisNode[];
  decisions: DecisionNode[];
  edges: GraphEdge[];
  decisionOverflow: number;
  /** Entities beyond MAX_ENTITY_NODES, counted but not drawn. */
  entityOverflow: number;
  hypothesisOverflow: number;
  /** An incident is loaded but nobody has said anything with a claim in it yet. */
  isEmpty: boolean;
  /** No incident at all — distinct from "loaded but empty". */
  isDisconnected: boolean;
}

export const MAX_ENTITY_NODES = 8;
export const MAX_HYPOTHESIS_NODES = 4;
export const MAX_DECISION_NODES = 4;
const MAX_DECISION_LABEL = 60;

/**
 * Below this length a token is too generic to match inside free text without
 * producing nonsense links ("db" would match "add", "api" would match "rapidly").
 * A missed edge is a much cheaper error here than a fabricated one.
 */
const MIN_MATCHABLE_TOKEN_LENGTH = 4;

/**
 * How many of an entity's distinctive words a hypothesis must actually contain
 * before a link is drawn.
 *
 * Live-observed 2026-09-03: requiring the entity's *full* key as a substring drew
 * zero edges against real extractor output, because the two sides name the same
 * thing at different lengths — the extractor produced the entity "kafka event
 * broker cluster" while the engineer said "the kafka broker ran out of disk
 * space". Two shared distinctive words is the smallest threshold that connects
 * those without connecting unrelated systems that merely share one generic word
 * ("database", "service").
 */
const MIN_TOKEN_OVERLAP = 2;

const MAX_HYPOTHESIS_LABEL = 84;

function healthOf(value: string): NodeHealth {
  return normalizePolarity(value) ?? 'unknown';
}

/**
 * Rank for drawing order: what the room most needs to look at goes first.
 *
 * Contradictions outrank outages deliberately — an outage everyone agrees on is
 * tractable, while two people reporting opposite things about the same system is
 * the state most likely to send responders down a wrong path.
 */
function entityRank(node: EntityNode): number {
  if (node.isConflicted) return 0;
  if (node.health === 'unhealthy') return 1;
  if (node.health === 'unknown') return 2;
  return 3; // healthy
}

/**
 * Does this hypothesis's own wording name this entity?
 *
 * Matches when the hypothesis contains the entity's whole key, or at least
 * MIN_TOKEN_OVERLAP of its distinctive words. Deliberately literal word matching:
 * no stemming, no synonyms, no embeddings, no asking a model whether two things
 * "seem related".
 *
 * The line this holds: someone saying "the deploy broke auth" is never connected to
 * a "login api" node, because deciding those name the same system is a judgement
 * about the world. Matching "kafka broker" to "kafka event broker cluster" is a
 * judgement about *words*, which is all this does.
 *
 * Known limit, stated rather than hidden: two genuinely different systems sharing
 * two words ("payment gateway" / "payment gateway sandbox") can link to the same
 * cause. That is why every edge renders as proposed and carries a "?" — an edge
 * here is a prompt to check, never an assertion.
 */
function hypothesisNames(hypothesisText: string, entityKey: string): boolean {
  if (hypothesisText.includes(entityKey) && entityKey.length >= MIN_MATCHABLE_TOKEN_LENGTH) {
    return true;
  }
  const distinctive = entityKey
    .split(/\s+/)
    .filter((t) => t.length >= MIN_MATCHABLE_TOKEN_LENGTH);
  if (distinctive.length === 0) return false;

  const hit = distinctive.filter((t) => hypothesisText.includes(t)).length;
  // A single-word entity is only ever matched by its whole (distinctive) word.
  const required = Math.min(MIN_TOKEN_OVERLAP, distinctive.length);
  return hit >= required;
}

export function deriveIncidentGraph(
  state: IncidentState | null | undefined
): IncidentGraph {
  const empty: IncidentGraph = {
    entities: [],
    hypotheses: [],
    decisions: [],
    edges: [],
    entityOverflow: 0,
    hypothesisOverflow: 0,
    decisionOverflow: 0,
    isEmpty: false,
    isDisconnected: false,
  };

  if (!state) return { ...empty, isDisconnected: true };

  const claims = (state.claims || []).filter(
    (c): c is Claim =>
      !!c && typeof c.entity === 'string' && typeof c.value === 'string'
  );

  // Decisions are claims too, but they are NOT systems. Without this split a
  // decision's `entity` ("rollback") was drawn as its own entity node, so the
  // board showed a phantom system nobody ever reported the health of, sitting
  // alongside the real ones. Decisions get their own node kind below.
  const isDecision = (c: Claim) => (c.claim_type || '').toLowerCase() === 'decision';
  const entityClaims = claims.filter((c) => !isDecision(c));

  const rawHypotheses = (state.hypotheses || []).filter(
    (h): h is Hypothesis => !!h && typeof h.title === 'string' && h.title.trim().length > 0
  );

  if (claims.length === 0 && rawHypotheses.length === 0) {
    return { ...empty, isEmpty: true };
  }

  // ── Conflicts, keyed the same way entities are, so a conflict and the entity it
  // is about reliably land on the same node.
  const conflictsByKey = new Map<string, ConflictRecord>();
  for (const c of state.conflicts || []) {
    if (!c || c.status === 'RESOLVED' || typeof c.entity !== 'string') continue;
    const key = normalizeEntityKey(c.entity);
    if (key && !conflictsByKey.has(key)) conflictsByKey.set(key, c);
  }

  // ── Entity nodes: latest claim wins per entity, so a recovered service stops
  // rendering as broken.
  const grouped = new Map<string, { latest: Claim; count: number }>();
  for (const claim of entityClaims) {
    const key = normalizeEntityKey(claim.entity);
    if (!key) continue;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { latest: claim, count: 1 });
      continue;
    }
    existing.count += 1;
    const isNewer =
      new Date(claim.timestamp).getTime() >
      new Date(existing.latest.timestamp).getTime();
    if (isNewer) existing.latest = claim;
  }

  const allEntities: EntityNode[] = Array.from(grouped.entries()).map(
    ([key, { latest, count }]) => {
      const conflict = conflictsByKey.get(key);
      return {
        kind: 'entity' as const,
        id: `entity:${key}`,
        key,
        label: toTitleCase(key),
        health: healthOf(latest.value),
        value: latest.value,
        speaker: latest.speaker ?? null,
        timestamp: latest.timestamp,
        evidenceStatus: String(latest.status || 'UNVERIFIED'),
        isConflicted: !!conflict,
        conflict: conflict
          ? {
              valueA: conflict.value_a,
              valueB: conflict.value_b,
              sourceA: conflict.source_a,
              sourceB: conflict.source_b,
              speakerA: conflict.speaker_a,
              speakerB: conflict.speaker_b,
            }
          : undefined,
        isUnverifiedExtraction: latest.extraction_method === 'heuristic_fallback',
        claimCount: count,
      };
    }
  );

  allEntities.sort((a, b) => {
    const rank = entityRank(a) - entityRank(b);
    if (rank !== 0) return rank;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const entities = allEntities.slice(0, MAX_ENTITY_NODES);
  const entityOverflow = Math.max(0, allEntities.length - entities.length);

  // ── Hypothesis nodes. A DISPROVEN hypothesis is kept and marked, never dropped:
  // "we checked and it wasn't the database" is a finding the room paid for.
  const allHypotheses: HypothesisNode[] = rawHypotheses.map((h) => {
    const text = h.title.trim();
    return {
      kind: 'hypothesis' as const,
      id: `hypothesis:${h.id}`,
      label:
        text.length <= MAX_HYPOTHESIS_LABEL
          ? text
          : `${text.slice(0, MAX_HYPOTHESIS_LABEL - 1).trimEnd()}…`,
      fullText: text,
      confidence: typeof h.confidence === 'number' ? h.confidence : 0,
      status: (h.status || 'PROPOSED') as HypothesisStatus,
    };
  });

  const hypotheses = allHypotheses.slice(0, MAX_HYPOTHESIS_NODES);
  const hypothesisOverflow = Math.max(0, allHypotheses.length - hypotheses.length);

  // ── Edges: only where a drawn hypothesis's own words name a drawn entity.
  const edges: GraphEdge[] = [];
  for (const h of hypotheses) {
    const haystack = h.fullText.toLowerCase();
    for (const e of entities) {
      if (!hypothesisNames(haystack, e.key)) continue;
      edges.push({
        id: `${h.id}->${e.id}`,
        from: h.id,
        to: e.id,
        kind: 'implicates',
        hypothesisStatus: h.status,
      });
    }
  }

  // ── Decision nodes. Decisions are not a separate collection: they are claims
  // with claim_type 'decision', carrying the rationale / decided_by /
  // supersedes chain the backend already records on Claim.
  const decisionClaims = claims
    .filter(isDecision)
    .sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

  const allDecisions: DecisionNode[] = decisionClaims.map((c) => {
    const text = (c.value || '').trim();
    return {
      kind: 'decision' as const,
      id: `decision:${c.id}`,
      label:
        text.length <= MAX_DECISION_LABEL
          ? text
          : `${text.slice(0, MAX_DECISION_LABEL - 1).trimEnd()}…`,
      fullText: text,
      rationale: c.rationale ?? null,
      decidedBy: c.decided_by ?? c.speaker ?? null,
      timestamp: c.timestamp,
      isSuperseded: Boolean(c.superseded_by_id),
      supersedesId: c.supersedes_id ? `decision:${c.supersedes_id}` : null,
    };
  });

  // Keep the MOST RECENT decisions when overflowing, the opposite of entities.
  // The current call matters more than the first one made.
  const decisions =
    allDecisions.length <= MAX_DECISION_NODES
      ? allDecisions
      : allDecisions.slice(allDecisions.length - MAX_DECISION_NODES);
  const decisionOverflow = Math.max(0, allDecisions.length - decisions.length);

  const drawnDecisionIds = new Set(decisions.map((d) => d.id));

  for (const d of decisions) {
    // 'cites': only when the decider's OWN stated rationale names a drawn
    // entity. A decision with no rationale, or one naming nothing on the board,
    // gets no edge -- it is NOT wired to whatever claim happened to precede it,
    // because "came after" is not "because of" and this project does not infer
    // causation.
    if (d.rationale) {
      const haystack = d.rationale.toLowerCase();
      for (const e of entities) {
        if (!hypothesisNames(haystack, e.key)) continue;
        edges.push({
          id: `${d.id}->cites->${e.id}`,
          from: d.id,
          to: e.id,
          kind: 'cites',
          hypothesisStatus: 'PROPOSED' as HypothesisStatus,
        });
      }
    }

    // 'supersedes': an explicit reversal the backend recorded. Only drawn when
    // both ends are on the board, so the arrow never points into empty space.
    if (d.supersedesId && drawnDecisionIds.has(d.supersedesId)) {
      edges.push({
        id: `${d.id}->supersedes->${d.supersedesId}`,
        from: d.id,
        to: d.supersedesId,
        kind: 'supersedes',
        hypothesisStatus: 'PROPOSED' as HypothesisStatus,
      });
    }
  }

  return {
    entities,
    hypotheses,
    decisions,
    edges,
    entityOverflow,
    hypothesisOverflow,
    decisionOverflow,
    isEmpty: entities.length === 0 && hypotheses.length === 0 && decisions.length === 0,
    isDisconnected: false,
  };
}
