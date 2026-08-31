'use client';

import React from 'react';
import { useIncidentState } from '@/hooks/useIncidentState';
import { IncidentHeader } from '@/components/IncidentHeader';
import { MetricsOverview } from '@/components/MetricsOverview';
import { ActionApprovalQueue } from '@/components/ActionApprovalQueue';
import { HypothesesPanel } from '@/components/HypothesesPanel';
import { TimelineFeed } from '@/components/TimelineFeed';
import { VoiceHUD } from '@/components/VoiceHUD';
import { IntelligencePanel } from '@/components/IntelligencePanel';
import { DemoModeControl } from '@/components/DemoModeControl';

export default function IncidentCommandDashboard() {
  const {
    activeIncident,
    incidentsList,
    lastUpdated,
    wsStatus,
    handleIncidentUpdated,
    refreshActiveIncident,
    handleSelectIncident,
  } = useIncidentState();

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        backgroundColor: 'var(--bg)',
        padding: '1.25rem 1.5rem 2.5rem 1.5rem',
        maxWidth: '1500px',
        margin: '0 auto',
        gap: '1.25rem',
      }}
    >
      {/* Top Banner Navigation & Status */}
      <IncidentHeader
        currentIncident={activeIncident}
        allIncidents={incidentsList}
        wsStatus={wsStatus}
        onSelectIncident={handleSelectIncident}
        onIncidentUpdated={handleIncidentUpdated}
      />

      {/* Demo Mode Control & Scenario Runner */}
      <DemoModeControl
        activeIncidentId={activeIncident?.incident_id || null}
        onIncidentUpdated={handleIncidentUpdated}
      />

      {/* Human Confirmation Security Notice Banner */}
      <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 flex items-center justify-between gap-3 text-xs text-amber-200">
        <div className="flex items-center gap-2">
          <span>🛡️</span>
          <span>
            <b>Human Confirmation Mandate:</b> Critical recovery operations require explicit Incident Commander sign-off (via <code>TOCSIN_COMMANDER_KEY</code>). AI proposals cannot execute autonomously.
          </span>
        </div>
        <span className="text-[11px] font-mono text-zinc-400 whitespace-nowrap">
          Last Synced: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}
        </span>
      </div>

      {/* Live Telemetry Gauges */}
      <MetricsOverview
        metrics={activeIncident?.metrics}
        status={activeIncident?.status}
      />

      {/* Shared Intelligence Record */}
      <IntelligencePanel
        incident={activeIncident}
        onEvidenceResolved={refreshActiveIncident}
      />

      {/* 2-Column Responsive Operation Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
          gap: '1.25rem',
          alignItems: 'start',
        }}
      >
        {/* Left Column: Approvals & Hypotheses */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <ActionApprovalQueue
            incident={activeIncident}
            onActionProcessed={handleIncidentUpdated}
          />
          <HypothesesPanel
            hypotheses={activeIncident?.hypotheses}
            symptoms={activeIncident?.symptoms}
          />
        </div>

        {/* Right Column: Voice AI Radio HUD & Operational Timeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <VoiceHUD
          channelName={activeIncident?.incident_id || 'inc-demo-identity-outage'}
            incidentId={activeIncident?.incident_id}
          />
          <TimelineFeed
            timeline={activeIncident?.timeline}
          />
        </div>
      </div>

      {/* Footer System Info */}
      <footer
        style={{
          marginTop: 'auto',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
        }}
      >
        <span>
          🚨 <b>TOCSIN Crisis Coordination Engine</b> • Multi-Party Voice AI & Incident Intelligence
        </span>
        <span>
          Active Incident: <code>{activeIncident?.incident_id || '---'}</code> • Status: <b>{activeIncident?.status || 'IDLE'}</b> • Severity: <b>{activeIncident?.severity || 'LOW'}</b>
        </span>
      </footer>
    </main>
  );
}
