'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { IncidentState } from '@/types/incident';
import {
  EntityNode,
  GraphEdge,
  HypothesisNode,
  deriveIncidentGraph,
} from '@/lib/deriveIncidentGraph';

/**
 * The incident, drawn as it is spoken.
 *
 * Renders the evidence record as a live map — which systems are involved, what state
 * each is reported to be in, which causes people have proposed, and which systems
 * those causes implicate — and redraws itself as new observations arrive over the
 * WebSocket. No refresh, no manual arranging.
 *
 * Everything visible here traces to something a human actually said (see
 * deriveIncidentGraph.ts for the rules). The visual grammar is built to keep the
 * difference between *reported* and *established* legible at a glance, because a
 * diagram that renders a guess the same way it renders a confirmed fact is worse
 * than no diagram:
 *
 *   - Solid node border  → a claim was made about this system.
 *   - Dashed purple node → a proposed cause. Someone's hypothesis, not a finding.
 *   - Dashed edge + "?"  → this cause names this system. Proposed, never asserted.
 *   - Struck-through     → a cause the room ruled out. Kept, because ruling something
 *                          out is a real result.
 *   - ⚠ split node       → two sources contradict each other about this system.
 *   - ◇ dotted outline   → extracted by the keyword fallback, not the LLM.
 *
 * Geometry only. All structural decisions live in the pure derivation module so they
 * stay testable without a DOM.
 */

const VIEW_W = 1000;
const NODE_W = 220;
const NODE_GAP = 20;
const PER_ROW = 4;
const ENTITY_H = 82;
const HYP_H = 66;
const HYP_Y = 34;
const ROW_GAP = 30;
const SIDE_MARGIN = (VIEW_W - (PER_ROW * NODE_W + (PER_ROW - 1) * NODE_GAP)) / 2;

interface Placed<T> {
  node: T;
  x: number;
  y: number;
}

function layoutRow<T>(nodes: T[], y: number, startIndex = 0): Placed<T>[] {
  return nodes.map((node, i) => {
    const col = (startIndex + i) % PER_ROW;
    const rowCount = Math.min(PER_ROW, nodes.length);
    // Center a partial row rather than left-aligning it, so a two-node map reads
    // as deliberate instead of broken.
    const usedW = rowCount * NODE_W + (rowCount - 1) * NODE_GAP;
    const offset = nodes.length < PER_ROW ? (VIEW_W - usedW) / 2 : SIDE_MARGIN;
    return { node, x: offset + col * (NODE_W + NODE_GAP), y };
  });
}

export type MapTheme = 'light' | 'dark';

/**
 * Two palettes rather than one set of CSS variables, because the two surfaces this
 * renders on are deliberately different designs: `/voice-test` is the light voice
 * room, `/` is the dark intelligence dashboard. The *semantics* (red = reported
 * failing, amber = sources disagree, purple = proposed) are identical in both — only
 * the surface values change, so the map means the same thing wherever it appears.
 */
const PALETTE = {
  light: {
    surface: '#ffffff',
    surfaceBorder: '#ececec',
    heading: '#6b6b6b',
    muted: '#a1a1aa',
    faint: '#b4b4b4',
    rule: '#f4f4f5',
    bodyText: '#3f3f46',
    entity: {
      unhealthy: { bg: '#fef2f2', border: '#dc2626', text: '#991b1b', dot: '#dc2626' },
      healthy: { bg: '#f0fdf4', border: '#16a34a', text: '#166534', dot: '#16a34a' },
      unknown: { bg: '#f8fafc', border: '#cbd5e1', text: '#475569', dot: '#94a3b8' },
    },
    conflict: { bg: '#fffbeb', border: '#d97706', text: '#92400e', dot: '#d97706' },
    hypothesis: { bg: '#faf5ff', border: '#c084fc', borderStrong: '#7c3aed', text: '#6b21a8' },
    ruledOut: { bg: '#fafafa', border: '#a1a1aa', text: '#71717a' },
    edge: '#c084fc',
    edgeMuted: '#d4d4d8',
    edgeBadgeBg: '#faf5ff',
  },
  dark: {
    surface: '#18181b',
    surfaceBorder: '#27272a',
    heading: '#a1a1aa',
    muted: '#71717a',
    faint: '#52525b',
    rule: '#27272a',
    bodyText: '#d4d4d8',
    entity: {
      unhealthy: { bg: '#2a1215', border: '#ef4444', text: '#fca5a5', dot: '#ef4444' },
      healthy: { bg: '#0f2417', border: '#22c55e', text: '#86efac', dot: '#22c55e' },
      unknown: { bg: '#1f1f23', border: '#3f3f46', text: '#a1a1aa', dot: '#52525b' },
    },
    conflict: { bg: '#2a1f0d', border: '#f59e0b', text: '#fcd34d', dot: '#f59e0b' },
    hypothesis: { bg: '#1e1533', border: '#a855f7', borderStrong: '#c084fc', text: '#d8b4fe' },
    ruledOut: { bg: '#1c1c1f', border: '#52525b', text: '#71717a' },
    edge: '#a855f7',
    edgeMuted: '#3f3f46',
    edgeBadgeBg: '#1e1533',
  },
} as const;

type Palette = (typeof PALETTE)[MapTheme];

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function EntityBox({
  node,
  x,
  y,
  isNew,
  p,
}: Placed<EntityNode> & { isNew: boolean; p: Palette }) {
  const tone = node.isConflicted ? p.conflict : p.entity[node.health];
  const title = node.isConflicted
    ? `${node.label} — CONTRADICTED\n"${node.conflict?.valueA}" (${node.conflict?.speakerA ?? node.conflict?.sourceA})\nvs "${node.conflict?.valueB}" (${node.conflict?.speakerB ?? node.conflict?.sourceB})`
    : `${node.label}\nReported: ${node.value}\nBy: ${node.speaker ?? 'unknown'}\nEvidence: ${node.evidenceStatus}${
        node.isUnverifiedExtraction ? '\nExtracted by keyword fallback, not the LLM' : ''
      }`;

  return (
    <g
      className={`tim-node ${isNew ? 'tim-enter' : ''}`}
      transform={`translate(${x}, ${y})`}
    >
      <title>{title}</title>
      <rect
        width={NODE_W}
        height={ENTITY_H}
        rx={10}
        fill={tone.bg}
        stroke={tone.border}
        strokeWidth={node.isConflicted ? 2 : 1.5}
        strokeDasharray={node.isUnverifiedExtraction ? '5 3' : undefined}
      />
      <circle cx={16} cy={19} r={4.5} fill={tone.dot} />
      <text x={30} y={23} fontSize={13} fontWeight={650} fill={tone.text}>
        {truncate(node.label, 22)}
      </text>

      {node.isConflicted ? (
        <>
          <g transform="translate(14, 37)" stroke={p.conflict.text} strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 0.5 L9 8.5 L0 8.5 Z" />
            <line x1="4.5" y1="3.2" x2="4.5" y2="5.6" />
            <circle cx="4.5" cy="7.1" r="0.15" fill={p.conflict.text} stroke="none" />
          </g>
          <text x={26} y={45} fontSize={11} fontWeight={600} fill={p.conflict.text}>
            Sources disagree
          </text>
          <text x={14} y={61} fontSize={10.5} fill={p.muted}>
            {truncate(`"${node.conflict?.valueA}"`, 18)}
          </text>
          <text x={14} y={74} fontSize={10.5} fill={p.muted}>
            vs {truncate(`"${node.conflict?.valueB}"`, 16)}
          </text>
        </>
      ) : (
        <>
          <text x={14} y={46} fontSize={12} fill={p.bodyText}>
            {truncate(node.value, 26)}
          </text>
          <text x={14} y={64} fontSize={10} fill={p.muted}>
            {truncate(node.speaker ?? 'unattributed', 16)} · {node.evidenceStatus}
          </text>
        </>
      )}

      {node.isUnverifiedExtraction && (
        <>
          <rect
            x={NODE_W - 62}
            y={13}
            width={7}
            height={7}
            transform={`rotate(45 ${NODE_W - 58.5} 16.5)`}
            fill="none"
            stroke={p.conflict.border}
            strokeWidth={1.2}
          />
          <text x={NODE_W - 12} y={20} fontSize={10} textAnchor="end" fill={p.conflict.border}>
            heuristic
          </text>
        </>
      )}
      {node.claimCount > 1 && !node.isConflicted && (
        <text x={NODE_W - 12} y={72} fontSize={9.5} textAnchor="end" fill={p.muted}>
          {node.claimCount} reports
        </text>
      )}
    </g>
  );
}

function HypothesisBox({
  node,
  x,
  y,
  isNew,
  p,
}: Placed<HypothesisNode> & { isNew: boolean; p: Palette }) {
  const disproven = node.status === 'DISPROVEN';
  const confirmed = node.status === 'CONFIRMED';
  const border = disproven
    ? p.ruledOut.border
    : confirmed
      ? p.hypothesis.borderStrong
      : p.hypothesis.border;
  const bg = disproven ? p.ruledOut.bg : p.hypothesis.bg;
  const text = disproven ? p.ruledOut.text : p.hypothesis.text;

  return (
    <g
      className={`tim-node ${isNew ? 'tim-enter' : ''}`}
      transform={`translate(${x}, ${y})`}
      opacity={disproven ? 0.62 : 1}
    >
      <title>
        {`Proposed cause — ${node.status}\n"${node.fullText}"\nExtractor confidence: ${Math.round(
          node.confidence * 100
        )}% (the extractor's own score for this utterance, not a probability that the cause is correct)`}
      </title>
      <rect
        width={NODE_W}
        height={HYP_H}
        rx={10}
        fill={bg}
        stroke={border}
        strokeWidth={1.5}
        strokeDasharray={confirmed ? undefined : '6 4'}
      />
      <text x={14} y={19} fontSize={9.5} fontWeight={700} fill={text} letterSpacing={0.6}>
        {disproven ? 'RULED OUT' : confirmed ? 'CONFIRMED CAUSE' : 'PROPOSED CAUSE'}
      </text>
      <text
        x={14}
        y={38}
        fontSize={11.5}
        fill={disproven ? p.ruledOut.text : p.bodyText}
        style={disproven ? { textDecoration: 'line-through' } : undefined}
      >
        {truncate(node.label, 30)}
      </text>
      <text x={14} y={54} fontSize={10.5} fill={p.muted}>
        {truncate(node.label.slice(30), 30) || ' '}
      </text>
    </g>
  );
}

function EdgePath({
  edge,
  from,
  to,
  isNew,
  p,
  theme,
}: {
  edge: GraphEdge;
  from: { x: number; y: number };
  to: { x: number; y: number };
  isNew: boolean;
  p: Palette;
  theme: MapTheme;
}) {
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + HYP_H;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y;
  const mid = (y1 + y2) / 2;
  const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  const disproven = edge.hypothesisStatus === 'DISPROVEN';

  return (
    <g className={isNew ? 'tim-edge-enter' : undefined}>
      <title>
        {disproven
          ? 'This cause named this system, but the room ruled the cause out.'
          : 'A person proposed this cause and their own words named this system. Proposed link — not an established one.'}
      </title>
      <path
        d={d}
        fill="none"
        stroke={disproven ? p.edgeMuted : p.edge}
        strokeWidth={1.6}
        strokeDasharray="5 4"
        opacity={disproven ? 0.5 : 0.9}
        markerEnd={disproven ? undefined : `url(#tim-arrow-${theme})`}
      />
      <circle
        cx={(x1 + x2) / 2}
        cy={mid}
        r={7}
        fill={p.edgeBadgeBg}
        stroke={disproven ? p.edgeMuted : p.edge}
        strokeWidth={1}
      />
      <text
        x={(x1 + x2) / 2}
        y={mid + 3.5}
        fontSize={9}
        textAnchor="middle"
        fill={disproven ? p.muted : p.hypothesis.text}
        fontWeight={700}
      >
        ?
      </text>
    </g>
  );
}

export default function LiveIncidentMap({
  incident,
  theme = 'light',
}: {
  incident: IncidentState | null | undefined;
  theme?: MapTheme;
}) {
  const graph = useMemo(() => deriveIncidentGraph(incident), [incident]);
  const p = PALETTE[theme];
  // Scoped per theme so the light and dark instances can coexist on one page
  // without the later <style> block winning over the earlier one.
  const cls = `tim-${theme}`;

  // Track which nodes are new since the last render so only those animate in. Without
  // this every node re-animates on every WebSocket update, which reads as noise
  // rather than as "something just changed".
  const seenRef = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = [
      ...graph.entities.map((e) => e.id),
      ...graph.hypotheses.map((h) => h.id),
      ...graph.edges.map((e) => e.id),
    ];
    const fresh = currentIds.filter((id) => !seenRef.current.has(id));
    if (fresh.length > 0) {
      setNewIds(new Set(fresh));
      currentIds.forEach((id) => seenRef.current.add(id));
      const t = setTimeout(() => setNewIds(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [graph]);

  const hypRow = useMemo(() => layoutRow(graph.hypotheses, HYP_Y), [graph.hypotheses]);

  const entityStartY = graph.hypotheses.length > 0 ? HYP_Y + HYP_H + 92 : HYP_Y + 10;
  const entityRows = useMemo(() => {
    const first = graph.entities.slice(0, PER_ROW);
    const second = graph.entities.slice(PER_ROW);
    return [
      ...layoutRow(first, entityStartY),
      ...layoutRow(second, entityStartY + ENTITY_H + ROW_GAP),
    ];
  }, [graph.entities, entityStartY]);

  const positionsById = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    hypRow.forEach((p) => m.set(p.node.id, { x: p.x, y: p.y }));
    entityRows.forEach((p) => m.set(p.node.id, { x: p.x, y: p.y }));
    return m;
  }, [hypRow, entityRows]);

  const lastRowY =
    entityRows.length > 0
      ? Math.max(...entityRows.map((placed) => placed.y)) + ENTITY_H
      : entityStartY;
  const viewH = Math.max(240, lastRowY + 28);

  const unhealthyCount = graph.entities.filter((e) => e.health === 'unhealthy').length;
  const conflictCount = graph.entities.filter((e) => e.isConflicted).length;

  return (
    <div className={`tim-wrap ${cls}`}>
      <style>{`
        .${cls} {
          background: ${p.surface};
          border: 1px solid ${p.surfaceBorder};
          border-radius: 14px;
          padding: 14px 16px 12px;
          width: 100%;
        }
        .${cls} .tim-head {
          display: flex; align-items: baseline; justify-content: space-between;
          gap: 10px; margin-bottom: 2px;
        }
        .${cls} .tim-title {
          font-size: 10px; font-weight: 700; letter-spacing: 1.1px;
          text-transform: uppercase; color: ${p.heading};
        }
        .${cls} .tim-sub { font-size: 9.5px; color: ${p.faint}; letter-spacing: 0.2px; }
        .${cls} .tim-counts { display: flex; gap: 10px; font-size: 10px; color: ${p.muted}; }
        .${cls} .tim-counts b { font-weight: 700; }
        .${cls} .tim-svg { display: block; width: 100%; height: auto; overflow: visible; }
        .${cls} .tim-empty {
          padding: 26px 10px; text-align: center; color: ${p.faint};
          font-size: 11.5px; font-style: italic; line-height: 1.7;
        }
        .${cls} .tim-legend {
          display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px;
          padding-top: 9px; border-top: 1px solid ${p.rule};
          font-size: 9.5px; color: ${p.muted};
        }
        .${cls} .tim-legend span { display: inline-flex; align-items: center; gap: 4px; }
        .${cls} .tim-swatch {
          width: 9px; height: 9px; border-radius: 3px; display: inline-block;
        }
        .${cls} .tim-node { transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1); }
        .${cls} .tim-enter { animation: tim-pop 520ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes tim-pop {
          from { opacity: 0; transform: translateY(6px) scale(0.97); }
          to   { opacity: 1; }
        }
        .${cls} .tim-edge-enter path { animation: tim-draw 700ms ease-out both; }
        @keyframes tim-draw {
          from { opacity: 0; stroke-dashoffset: 34; }
          to   { opacity: 0.9; stroke-dashoffset: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .${cls} .tim-node, .${cls} .tim-enter, .${cls} .tim-edge-enter path {
            animation: none; transition: none;
          }
        }
      `}</style>

      <div className="tim-head">
        <div>
          <div className="tim-title">Live Incident Map</div>
          <div className="tim-sub">Drawn from the evidence record as people speak</div>
        </div>
        {!graph.isDisconnected && !graph.isEmpty && (
          <div className="tim-counts">
            {conflictCount > 0 && (
              <span style={{ color: p.conflict.text }}>
                <b>{conflictCount}</b> contradicted
              </span>
            )}
            <span style={{ color: unhealthyCount > 0 ? p.entity.unhealthy.text : p.muted }}>
              <b>{unhealthyCount}</b> failing
            </span>
            <span>
              <b>{graph.entities.length}</b> systems
            </span>
          </div>
        )}
      </div>

      {graph.isDisconnected ? (
        <div className="tim-empty">
          Not connected to an incident record.
          <br />
          Nothing is drawn without one.
        </div>
      ) : graph.isEmpty ? (
        <div className="tim-empty">
          Nothing has been reported yet.
          <br />
          Systems and proposed causes appear here as they are actually mentioned —
          nothing is drawn in advance.
        </div>
      ) : (
        <svg
          className="tim-svg"
          viewBox={`0 0 ${VIEW_W} ${viewH}`}
          role="img"
          aria-label={`Incident map: ${graph.entities.length} systems, ${graph.hypotheses.length} proposed causes, ${conflictCount} contradicted`}
        >
          <defs>
            <marker
              id={`tim-arrow-${theme}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={p.edge} />
            </marker>
          </defs>

          {/* Edges first so nodes paint over their endpoints. */}
          {graph.edges.map((edge) => {
            const from = positionsById.get(edge.from);
            const to = positionsById.get(edge.to);
            if (!from || !to) return null;
            return (
              <EdgePath
                key={edge.id}
                edge={edge}
                from={from}
                to={to}
                isNew={newIds.has(edge.id)}
                p={p}
                theme={theme}
              />
            );
          })}

          {hypRow.map((placed) => (
            <HypothesisBox
              key={placed.node.id}
              node={placed.node}
              x={placed.x}
              y={placed.y}
              isNew={newIds.has(placed.node.id)}
              p={p}
            />
          ))}

          {entityRows.map((placed) => (
            <EntityBox
              key={placed.node.id}
              node={placed.node}
              x={placed.x}
              y={placed.y}
              isNew={newIds.has(placed.node.id)}
              p={p}
            />
          ))}

          {(graph.entityOverflow > 0 || graph.hypothesisOverflow > 0) && (
            <text x={VIEW_W / 2} y={viewH - 6} fontSize={10} textAnchor="middle" fill={p.muted}>
              {[
                graph.entityOverflow > 0 ? `+${graph.entityOverflow} more systems tracked` : '',
                graph.hypothesisOverflow > 0
                  ? `+${graph.hypothesisOverflow} more proposed causes`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </text>
          )}
        </svg>
      )}

      {!graph.isDisconnected && !graph.isEmpty && (
        <div className="tim-legend">
          <span>
            <i className="tim-swatch" style={{ background: p.entity.unhealthy.bg, border: `1px solid ${p.entity.unhealthy.border}` }} />
            reported failing
          </span>
          <span>
            <i className="tim-swatch" style={{ background: p.entity.healthy.bg, border: `1px solid ${p.entity.healthy.border}` }} />
            reported healthy
          </span>
          <span>
            <i className="tim-swatch" style={{ background: p.conflict.bg, border: `1px solid ${p.conflict.border}` }} />
            sources disagree
          </span>
          <span>
            <i className="tim-swatch" style={{ background: p.hypothesis.bg, border: `1px dashed ${p.hypothesis.border}` }} />
            proposed cause
          </span>
          <span style={{ color: p.edge, fontWeight: 700 }}>?</span>
          <span style={{ marginLeft: -8 }}>proposed link, not established</span>
        </div>
      )}
    </div>
  );
}
