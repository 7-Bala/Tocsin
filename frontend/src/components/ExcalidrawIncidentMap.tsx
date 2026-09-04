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
    edge: '#8b5cf6',
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
    ruledOut: { bg: '#1c1c1f' as const, stroke: '#71717a' },
    edge: '#a855f7',
  },
} as const;

// ── Layout: ported from LiveIncidentMap.tsx so the two renderers agree on
// where things sit even though only one is mounted at a time. ──────────────
const NODE_W = 220;
const ENTITY_H = 90;
const HYP_W = 240;
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

  const hypRow = useMemo(() => layoutRow(graph.hypotheses, HYP_Y, HYP_W), [graph.hypotheses]);
  const entityStartY = graph.hypotheses.length > 0 ? HYP_Y + HYP_H + 90 : HYP_Y + 20;
  const entityRow = useMemo(
    () => layoutRow(graph.entities, entityStartY, NODE_W),
    [graph.entities, entityStartY]
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
        const lines = [
          node.label,
          truncate(node.value, 34),
          node.speaker ? `— ${node.speaker}` : '',
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

      for (const edge of graph.edges) {
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

      const elements = restoreElements(convertToExcalidrawElements(skeletons), null);
      excalidrawApiRef.current!.updateScene({
        elements,
        appState: { viewBackgroundColor: p.canvasBg },
      });
      excalidrawApiRef.current!.scrollToContent(elements, { fitToContent: true, animate: false });
    })();
  }, [ready, graph, entityRow, hypRow, p]);

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
          <div className="xim-sub">Excalidraw canvas, redrawn from the evidence record as people speak</div>
        </div>
        {!graph.isDisconnected && !graph.isEmpty && (
          <div className="xim-counts">
            {conflictCount > 0 && <span style={{ color: p.conflict.stroke }}><b>{conflictCount}</b> contradicted</span>}
            <span style={{ color: unhealthyCount > 0 ? p.entity.unhealthy.stroke : p.muted }}><b>{unhealthyCount}</b> failing</span>
            <span><b>{graph.entities.length}</b> systems</span>
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
        <div className="xim-canvas">
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
