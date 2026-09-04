'use client';

import React from 'react';
import { IncidentState } from '@/types/incident';
import { WsConnectionStatus } from '@/hooks/useIncidentWebSocket';
import { deriveDynamicTiles, DynamicTile } from '@/lib/deriveDynamicTiles';
import { AlertTriangleIcon } from '@/components/Icon';

/**
 * Replaces `/voice-test`'s old `extractIncidentInfo()` client-side regex simulator
 * with tiles derived live from the real backend evidence record — see
 * docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md for the full design.
 *
 * Takes the incident as a prop rather than calling `useIncidentState()` itself: the
 * parent page already subscribes once (via the same hook the root dashboard uses —
 * step 1 of the plan) and needs that same state for its header, timeline, and actions
 * sections too. A second internal subscription here would open a second WebSocket
 * connection to the same incident for no benefit.
 *
 * Note on scope (deliberate, not an oversight): the incident passed in is always
 * whatever `useIncidentState()` resolves to — the canonical demo incident by default,
 * same as `/`. This component does not know about or follow `/voice-test`'s free-text
 * "Voice Channel" field if a user types something else there — that field has always
 * been primarily an Agora RTC channel name, not an incident switcher.
 *
 * Visual output intentionally duplicates a handful of CSS rules from
 * `voice-test/page.tsx`'s scoped `<style jsx>` block rather than importing them,
 * because styled-jsx's scoping is per-component and does not cascade into a child
 * component's own rendered elements — the only way to get pixel-identical output from
 * a separate file is to declare the same rules again, scoped to this component.
 */

export interface DynamicSituationTilesProps {
  incident: IncidentState | null;
  wsStatus: WsConnectionStatus;
}

const TONE_ACCENT: Record<DynamicTile['tone'], { valueColor?: string; subClass: string }> = {
  healthy: { subClass: '' },
  unhealthy: { valueColor: '#dc2626', subClass: 'alert' },
  neutral: { subClass: '' },
  conflicted: { valueColor: '#dc2626', subClass: 'alert' },
};

function TileCard({ tile }: { tile: DynamicTile }) {
  const accent = TONE_ACCENT[tile.tone];
  const subClass = tile.isUnverifiedExtraction && accent.subClass !== 'alert' ? 'warn' : accent.subClass;
  return (
    <div className="vcc-metric-item" style={tile.isStale ? { opacity: 0.6 } : undefined}>
      <div className="vcc-metric-label">{tile.label}</div>
      <div
        className="vcc-metric-value"
        style={{
          color: accent.valueColor,
          fontSize: tile.value.length > 12 ? 14 : tile.value.length > 6 ? 16 : 20,
        }}
      >
        {tile.value}
      </div>
      <div className={`vcc-metric-sub ${subClass}`}>{tile.subLabel}</div>
    </div>
  );
}

function PlaceholderTile({ label }: { label: string }) {
  return (
    <div className="vcc-metric-item">
      <div className="vcc-metric-label">{label}</div>
      <div className="vcc-metric-value placeholder">—</div>
      <div className="vcc-metric-sub">Awaiting data</div>
    </div>
  );
}

export const DynamicSituationTiles: React.FC<DynamicSituationTilesProps> = ({ incident, wsStatus }) => {
  const result = deriveDynamicTiles(incident, new Date());

  return (
    <div className="vcc-section-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="vcc-section-label" style={{ margin: 0 }}>Live Situation</div>
        <span style={{ fontSize: 9.5, color: '#b0b0b0', fontStyle: 'italic' }}>
          {result.isDisconnected ? 'Disconnected' : 'Live from evidence record'}
        </span>
      </div>

      {result.isDisconnected && (
        <div
          style={{
            fontSize: 10.5,
            color: '#dc2626',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            padding: '6px 9px',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <AlertTriangleIcon /> Disconnected — showing last known state, not live data.
        </div>
      )}

      {result.isEmpty && !result.isDisconnected && (
        <div className="vcc-metric-grid">
          <PlaceholderTile label="Awaiting data" />
          <PlaceholderTile label="Awaiting data" />
        </div>
      )}

      {!result.isEmpty && (
        <div className="vcc-metric-grid">
          {result.tiles.map((tile) => (
            <TileCard key={tile.entity} tile={tile} />
          ))}
        </div>
      )}

      {result.overflowCount > 0 && (
        <div className="vcc-inferred-note" style={{ borderTop: 'none', paddingTop: 0, marginTop: 6 }}>
          +{result.overflowCount} more entit{result.overflowCount === 1 ? 'y' : 'ies'} tracked — see the full
          intelligence record on the main dashboard.
        </div>
      )}

      {wsStatus !== 'CONNECTED' && !result.isDisconnected && (
        <div className="vcc-inferred-note" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <AlertTriangleIcon /> Reconnecting to live updates ({wsStatus.toLowerCase()})… showing last known values.
        </div>
      )}

      <style jsx>{`
        .vcc-section-label {
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: #9b9b9b;
          margin-bottom: 8px;
          flex-shrink: 0;
        }
        .vcc-section-card {
          background: #fff;
          border: 1px solid #e8e8e8;
          border-radius: 10px;
          padding: 12px 14px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        }
        .vcc-metric-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .vcc-metric-item {
          background: #fafafa;
          border: 1px solid #ebebeb;
          border-radius: 8px;
          padding: 11px 13px;
          transition: background-color 0.2s ease, border-color 0.2s ease;
        }
        .vcc-metric-label {
          font-size: 10px;
          color: #9b9b9b;
          font-weight: 500;
          margin-bottom: 5px;
        }
        .vcc-metric-value {
          font-size: 20px;
          font-weight: 700;
          color: #1a1a1a;
          line-height: 1.1;
          transition: color 0.2s ease;
        }
        .vcc-metric-value.placeholder {
          color: #d0d0d0;
        }
        .vcc-metric-sub {
          font-size: 10px;
          color: #9b9b9b;
          margin-top: 3px;
        }
        .vcc-metric-sub.warn {
          color: #d97706;
          font-weight: 600;
        }
        .vcc-metric-sub.alert {
          color: #dc2626;
          font-weight: 600;
        }
        .vcc-inferred-note {
          font-size: 9.5px;
          color: #a0a0a0;
          font-style: italic;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid #f5f5f5;
        }
      `}</style>
    </div>
  );
};
