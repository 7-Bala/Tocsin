'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IncidentState } from '@/types/incident';
import { EntityNode, deriveIncidentGraph } from '@/lib/deriveIncidentGraph';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElementSkeleton as ImportedSkeleton } from '@excalidraw/excalidraw/data/transform';

/**
 * The incident, drawn on an actual whiteboard.
 *
 * Replaces the hand-rolled SVG map (formerly LiveIncidentMap.tsx, deleted --
 * its layout constants and palette are ported into this file, and its actual
 * evidence logic always lived in deriveIncidentGraph.ts, untouched) with the
 * real open-source Excalidraw canvas (github.com/excalidraw/excalidraw, MIT).
 * The room gets a genuine hand-drawn-style whiteboard -- pan, zoom, its own
 * toolbar -- rather than a look-alike.
 *
 * "Real time according to the speech detected": this component does no
 * polling and owns no socket of its own. `incident` is the same live
 * WebSocket-driven state (useIncidentState / useIncidentWebSocket) the rest
 * of the room already renders from -- every time a voice observation lands
 * and the backend pushes an update, `incident` changes, the graph is
 * re-derived, and the effect below pushes a fresh scene onto the canvas via
 * excalidrawAPI.updateScene(). There is no manual "refresh the board" step.
 *
 * Evidence discipline is unchanged: deriveIncidentGraph.ts is the single
 * source of truth for what is allowed to appear (a node exists only because
 * someone made a claim; an edge exists only because a hypothesis's own words
 * name that entity). This file only turns that already-vetted structure into
 * Excalidraw elements -- it adds nothing to the picture.
 *
 * Because the scene is regenerated from the evidence record on every update,
 * this is a system-managed live diagram, not a persistent freeform canvas: an
 * operator's own manual edits (dragging a box, adding a note) will be
 * overwritten on the next observation. That trade-off is the explicit ask --
 * a whiteboard that redraws itself live as people talk.
 */

const Excalidraw = dynamic(
  () => import('@excalidraw/excalidraw').then((mod) => mod.Excalidraw),
  {
    ssr: false,
    loading: () => (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#a1a1aa', fontSize: 12 }}>
        Loading whiteboard…
      </div>
    ),
  }
);

export type MapTheme = 'light' | 'dark';

const PALETTE = {
  light: {
    surface: '#ffffff',
    surfaceBorder: '#ececec',
    heading: '#6b6b6b',
    muted: '#a1a1aa',
    faint: '#b4b4b4',
    rule: '#f4f4f5',
    canvasBg: '#ffffff',
    entity: {
      unhealthy: { bg: '#fef2f2' as const, stroke: '#dc2626' },
      healthy: { bg: '#f0fdf4' as const, stroke: '#16a34a' },
      unknown: { bg: '#f8fafc' as const, stroke: '#94a3b8' },
    },
    conflict: { bg: '#fffbeb' as const, stroke: '#d97706' },
    hypothesis: { bg: '#faf5ff' as const, stroke: '#7c3aed' },
    ruledOut: { bg: '#fafafa' as const, stroke: '#a1a1aa' },
    decision: { bg: '#eff6ff' as const, stroke: '#2563eb' },
    decisionSuperseded: { bg: '#fafafa' as const, stroke: '#a1a1aa' },
    edge: '#8b5cf6',
    citesEdge: '#2563eb',
  },
  dark: {
    surface: '#18181b',
    surfaceBorder: '#27272a',
    heading: '#a1a1aa',
    muted: '#71717a',
    faint: '#52525b',
    rule: '#27272a',
    canvasBg: '#18181b',
    entity: {
      unhealthy: { bg: '#2a1215' as const, stroke: '#ef4444' },
      healthy: { bg: '#0f2417' as const, stroke: '#22c55e' },
      unknown: { bg: '#1f1f23' as const, stroke: '#71717a' },
    },
    conflict: { bg: '#2a1f0d' as const, stroke: '#f59e0b' },
    hypothesis: { bg: '#1e1533' as const, stroke: '#c084fc' },
    decision: { bg: '#0f1e3d' as const, stroke: '#60a5fa' },
    decisionSuperseded: { bg: '#1c1c1f' as const, stroke: '#52525b' },
    citesEdge: '#60a5fa',
    ruledOut: { bg: '#1c1c1f' as const, stroke: '#71717a' },
    edge: '#a855f7',
  },
} as const;

// ── Layout: ported from LiveIncidentMap.tsx so the two renderers agree on
// where things sit even though only one is mounted at a time. ──────────────
const NODE_W = 220;
const ENTITY_H = 90;
const HYP_W = 240;
const DEC_W = 250;
const DEC_H = 88;
const HYP_H = 70;
const NODE_GAP = 30;
const ROW_GAP = 40;
const PER_ROW = 4;
const HYP_Y = 40;

interface Placed<T> {
  node: T;
  x: number;
  y: number;
}

function layoutRow<T>(nodes: T[], y: number, width: number): Placed<T>[] {
  return nodes.map((node, i) => {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    return { node, x: col * (width + NODE_GAP), y: y + row * (ENTITY_H + ROW_GAP) };
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * HH:MM for a node caption. The board is a chronological record now, so every
 * node states when it was said rather than making the reader cross-reference a
 * separate timeline panel.
 */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ExcalidrawIncidentMap({
  incident,
  theme = 'light',
}: {
  incident: IncidentState | null | undefined;
  theme?: MapTheme;
}) {
  const graph = useMemo(() => deriveIncidentGraph(incident), [incident]);
  const p = PALETTE[theme];
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [ready, setReady] = useState(false);

  // Ids of the elements this component generated on the previous render pass.
  // Everything else in the scene belongs to the user and must survive updates.
  const derivedIdsRef = useRef<Set<string>>(new Set());
  // Signature of the last layout we auto-fitted to, so the viewport is only
  // refitted when the drawing genuinely changes rather than on every update.
  const lastFitSignatureRef = useRef<string>('');
  // Once the user pans, zooms, or draws, the viewport is theirs -- stop
  // auto-fitting entirely rather than fighting them for control of the canvas.
  const userHasTakenControlRef = useRef(false);

  const hypRow = useMemo(() => layoutRow(graph.hypotheses, HYP_Y, HYP_W), [graph.hypotheses]);
  const entityStartY = graph.hypotheses.length > 0 ? HYP_Y + HYP_H + 90 : HYP_Y + 20;
  const entityRow = useMemo(
    () => layoutRow(graph.entities, entityStartY, NODE_W),
    [graph.entities, entityStartY]
  );

  // Decisions sit BELOW the evidence they were made from, so the board reads
  // top-to-bottom as: proposed causes -> systems -> what we decided about them.
  const entityRowCount = Math.max(1, Math.ceil(graph.entities.length / PER_ROW));
  const decisionStartY = entityStartY + entityRowCount * (ENTITY_H + ROW_GAP) + 50;
  const decisionRow = useMemo(
    () => layoutRow(graph.decisions, decisionStartY, DEC_W),
    [graph.decisions, decisionStartY]
  );

  const unhealthyCount = graph.entities.filter((e) => e.health === 'unhealthy').length;
  const conflictCount = graph.entities.filter((e) => e.isConflicted).length;

  // Push a fresh scene every time the derived graph changes -- this is the
  // "real time according to the speech detected" requirement. incident is
  // WebSocket-driven upstream, so no polling happens here.
  useEffect(() => {
    if (!ready || !excalidrawApiRef.current) return;

    (async () => {
      const { convertToExcalidrawElements, restoreElements } = await import('@excalidraw/excalidraw');

      const skeletons: ImportedSkeleton[] = [];

      const entityColorOf = (e: EntityNode) =>
        e.isConflicted ? p.conflict : p.entity[e.health];

      for (const { node, x, y } of entityRow) {
        const color = entityColorOf(node);
        const stamp = clockTime(node.timestamp);
        const lines = [
          node.label,
          truncate(node.value, 34),
          [node.speaker ? `— ${node.speaker}` : '', stamp].filter(Boolean).join('  ·  '),
        ].filter(Boolean);
        skeletons.push({
          type: 'rectangle',
          id: node.id,
          x,
          y,
          width: NODE_W,
          height: ENTITY_H,
          backgroundColor: color.bg,
          strokeColor: color.stroke,
          fillStyle: 'solid',
          strokeWidth: node.isConflicted ? 2.5 : 1.5,
          strokeStyle: node.isUnverifiedExtraction ? 'dotted' : 'solid',
          roundness: { type: 3 }, // ROUNDNESS.ADAPTIVE_RADIUS -- avoids a static top-level
          // import of the package (which touches window at eval time and breaks SSR).
          label: {
            text: lines.join('\n'),
            fontSize: 13,
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        } as ImportedSkeleton);
      }

      for (const { node, x, y } of hypRow) {
        const ruledOut = node.status === 'DISPROVEN';
        const color = ruledOut ? p.ruledOut : p.hypothesis;
        skeletons.push({
          type: 'rectangle',
          id: node.id,
          x,
          y,
          width: HYP_W,
          height: HYP_H,
          backgroundColor: color.bg,
          strokeColor: color.stroke,
          fillStyle: 'hachure',
          strokeWidth: 1.5,
          strokeStyle: 'dashed',
          roundness: { type: 3 },
          label: {
            text: `${ruledOut ? '(ruled out) ' : ''}${node.label}\n${Math.round(node.confidence * 100)}% confidence`,
            fontSize: 12,
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        } as ImportedSkeleton);
      }

      for (const { node, x, y } of decisionRow) {
        const color = node.isSuperseded ? p.decisionSuperseded : p.decision;
        const stamp = clockTime(node.timestamp);
        // A superseded decision is kept and marked, never removed -- "we decided
        // X then reversed it" is exactly what the next shift needs to inherit.
        const header = node.isSuperseded ? '(superseded) DECISION' : 'DECISION';
        const who = [node.decidedBy ? `— ${node.decidedBy}` : '', stamp]
          .filter(Boolean)
          .join('  ·  ');
        const lines = [
          header,
          truncate(node.fullText, 40),
          node.rationale ? `because: ${truncate(node.rationale, 34)}` : '',
          who,
        ].filter(Boolean);
        skeletons.push({
          type: 'rectangle',
          id: node.id,
          x,
          y,
          width: DEC_W,
          height: DEC_H,
          backgroundColor: color.bg,
          strokeColor: color.stroke,
          fillStyle: 'solid',
          strokeWidth: node.isSuperseded ? 1 : 2,
          strokeStyle: node.isSuperseded ? 'dotted' : 'solid',
          roundness: { type: 3 },
          label: {
            text: lines.join('\n'),
            fontSize: 12,
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        } as ImportedSkeleton);
      }

      // Decision fork edges: 'cites' (decider's own rationale named this system)
      // and 'supersedes' (one decision explicitly reversed another).
      for (const edge of graph.edges) {
        if (edge.kind === 'implicates') continue;
        const fromPos = decisionRow.find((d) => d.node.id === edge.from);
        const toPos =
          edge.kind === 'cites'
            ? entityRow.find((e) => e.node.id === edge.to)
            : decisionRow.find((d) => d.node.id === edge.to);
        if (!fromPos || !toPos) continue;
        skeletons.push({
          type: 'arrow',
          x: fromPos.x + DEC_W / 2,
          y: fromPos.y,
          strokeColor: edge.kind === 'supersedes' ? p.ruledOut.stroke : p.citesEdge,
          strokeStyle: edge.kind === 'supersedes' ? 'dotted' : 'solid',
          strokeWidth: 1.5,
          start: { id: edge.from },
          end: { id: edge.to },
          label: { text: edge.kind === 'supersedes' ? 'replaces' : 'cited', fontSize: 10 },
        } as ImportedSkeleton);
      }

      for (const edge of graph.edges) {
        if (edge.kind !== 'implicates') continue;
        const fromPos = hypRow.find((h) => h.node.id === edge.from);
        const toPos = entityRow.find((e) => e.node.id === edge.to);
        if (!fromPos || !toPos) continue;
        const ruledOut = edge.hypothesisStatus === 'DISPROVEN';
        skeletons.push({
          type: 'arrow',
          x: fromPos.x + HYP_W / 2,
          y: fromPos.y + HYP_H,
          strokeColor: ruledOut ? p.ruledOut.stroke : p.edge,
          strokeStyle: 'dashed',
          strokeWidth: 1.5,
          start: { id: edge.from },
          end: { id: edge.to },
          label: { text: '?', fontSize: 11 },
        } as ImportedSkeleton);
      }

      const derived = restoreElements(convertToExcalidrawElements(skeletons), null);
      const derivedIds = new Set(derived.map((el) => el.id));

      // Preserve anything the user drew themselves.
      //
      // This effect used to pass `elements: derived` straight to updateScene,
      // which replaces the ENTIRE scene. The canvas ships a full Excalidraw
      // toolbar, so it actively invites a commander to annotate -- and every
      // annotation was silently destroyed the moment the next claim arrived.
      // Reproduced live 2026-09-05: drew a rectangle, injected one observation,
      // rectangle gone.
      //
      // Derived elements are identified by the ids we generated on the previous
      // pass (kept in derivedIdsRef) rather than by tagging, so this does not
      // depend on customData surviving convertToExcalidrawElements. Anything not
      // in that set is the user's and is carried forward. Elements whose id is in
      // the NEW derived set are dropped from the carried-forward list because the
      // freshly built version replaces them (entity nodes keep stable ids).
      const previousDerivedIds = derivedIdsRef.current;
      const userElements = excalidrawApiRef
        .current!.getSceneElements()
        .filter((el) => !previousDerivedIds.has(el.id) && !derivedIds.has(el.id));
      derivedIdsRef.current = derivedIds;

      excalidrawApiRef.current!.updateScene({
        elements: [...userElements, ...derived],
        appState: { viewBackgroundColor: p.canvasBg },
      });

      // Only refit the viewport when the drawing actually changed shape, and
      // never once the user has taken manual control of the canvas.
      //
      // This used to run on EVERY update, so any manual pan/zoom was yanked back
      // the instant another utterance arrived. Reproduced live in the same test:
      // the view visibly re-zoomed when a fourth node appeared. In a demo, a
      // judge who pans in to read a node gets snapped away mid-sentence.
      const signature = [...derivedIds].sort().join('|');
      const shapeChanged = signature !== lastFitSignatureRef.current;
      if (shapeChanged && !userHasTakenControlRef.current) {
        excalidrawApiRef.current!.scrollToContent(derived, { fitToContent: true, animate: false });
      }
      lastFitSignatureRef.current = signature;
    })();
  }, [ready, graph, entityRow, hypRow, decisionRow, p]);

  const cls = `xim-${theme}`;

  return (
    <div className={`xim-wrap ${cls}`}>
      <style>{`
        .${cls} {
          background: ${p.surface};
          border: 1px solid ${p.surfaceBorder};
          border-radius: 14px;
          padding: 14px 16px 12px;
          width: 100%;
        }
        .${cls} .xim-head {
          display: flex; align-items: baseline; justify-content: space-between;
          gap: 10px; margin-bottom: 10px;
        }
        .${cls} .xim-title {
          font-size: 10px; font-weight: 700; letter-spacing: 1.1px;
          text-transform: uppercase; color: ${p.heading};
        }
        .${cls} .xim-sub { font-size: 9.5px; color: ${p.faint}; letter-spacing: 0.2px; }
        .${cls} .xim-counts { display: flex; gap: 10px; font-size: 10px; color: ${p.muted}; }
        .${cls} .xim-counts b { font-weight: 700; }
        .${cls} .xim-empty {
          padding: 26px 10px; text-align: center; color: ${p.faint};
          font-size: 11.5px; font-style: italic; line-height: 1.7;
        }
        .${cls} .xim-canvas {
          height: 460px;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid ${p.rule};
        }
      `}</style>

      <div className="xim-head">
        <div>
          <div className="xim-title">Live Incident Whiteboard</div>
          <div className="xim-sub">Flowchart with timestamps — redrawn from the evidence record as people speak</div>
        </div>
        {!graph.isDisconnected && !graph.isEmpty && (
          <div className="xim-counts">
            {conflictCount > 0 && <span style={{ color: p.conflict.stroke }}><b>{conflictCount}</b> contradicted</span>}
            <span style={{ color: unhealthyCount > 0 ? p.entity.unhealthy.stroke : p.muted }}><b>{unhealthyCount}</b> failing</span>
            <span><b>{graph.entities.length}</b> systems</span>
            {graph.decisions.length > 0 && (
              <span style={{ color: p.decision.stroke }}><b>{graph.decisions.length}</b> decisions</span>
            )}
          </div>
        )}
      </div>

      {graph.isDisconnected ? (
        <div className="xim-empty">
          Not connected to an incident record.
          <br />
          Nothing is drawn without one.
        </div>
      ) : graph.isEmpty ? (
        <div className="xim-empty">
          Nothing has been reported yet.
          <br />
          Systems and proposed causes appear here as they are actually mentioned.
        </div>
      ) : (
        <div
          className="xim-canvas"
          onPointerDownCapture={() => { userHasTakenControlRef.current = true; }}
          onWheelCapture={() => { userHasTakenControlRef.current = true; }}
        >
          <Excalidraw
            theme={theme}
            excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
              excalidrawApiRef.current = api;
              setReady(true);
            }}
            initialData={{ appState: { viewBackgroundColor: p.canvasBg } }}
          />
        </div>
      )}
    </div>
  );
}
