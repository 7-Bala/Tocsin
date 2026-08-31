'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { IncidentState } from '@/types/incident';
import { createIncident, fetchIncident, fetchIncidents } from '@/hooks/useIncidentApi';
import { useIncidentWebSocket } from '@/hooks/useIncidentWebSocket';
import { IncidentHeader } from '@/components/IncidentHeader';
import { MetricsOverview } from '@/components/MetricsOverview';
import { ActionApprovalQueue } from '@/components/ActionApprovalQueue';
import { HypothesesPanel } from '@/components/HypothesesPanel';
import { TimelineFeed } from '@/components/TimelineFeed';
import { VoiceHUD } from '@/components/VoiceHUD';
import { IntelligencePanel } from '@/components/IntelligencePanel';
import { DemoModeControl } from '@/components/DemoModeControl';

export default function IncidentCommandDashboard() {
  const [incidentsList, setIncidentsList] = useState<IncidentState[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Lazily-initialized (not `new Date()` inline): evaluating a timestamp during the
  // initializer runs it once on the server during SSR and again on the client during
  // hydration, producing two different values for the same render and triggering a
  // React hydration mismatch (errors #418/#425). Starting null and setting the real
  // value in the mount effect keeps the very first client render identical to the
  // server-rendered HTML.
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // WebSocket real-time subscription
  const { incidentState: wsIncident, status: wsStatus, setIncidentState } =
    useIncidentWebSocket(selectedIncidentId);

  // Initialize incidents on mount
  useEffect(() => {
    async function initIncidents() {
      try {
        setIsLoading(true);
        let list = await fetchIncidents();
        const identityIncident = list.find((incident) => incident.incident_id === 'inc-demo-identity-outage');
        if (!identityIncident) {
          // Initialize default identity outage incident for immediate demo readiness
          const defaultInc = await createIncident({
            title: 'Customer Login and Identity Outage',
            event_type: 'TECHNICAL_INCIDENT',
            incident_id: 'inc-demo-identity-outage',
            initial_symptoms: [
              'HTTP 503 error surge on /api/v1/login across multiple regions',
              'Customer login success rate dropped to 60%',
            ],
          });
          list = [defaultInc, ...list];
        }
        setIncidentsList(list);
        const selected = list.find((incident) => incident.incident_id === 'inc-demo-identity-outage') || list[0];
        setSelectedIncidentId(selected.incident_id);
        setIncidentState(() => selected);
      } catch {
        // Fallback demo state if backend connection fails on initial render
        const fallback: IncidentState = {
          incident_id: 'inc-demo-identity-outage',
          title: 'Customer Login and Identity Outage',
          event_type: 'TECHNICAL_INCIDENT',
          status: 'IDLE',
          severity: 'HIGH',
          metrics: {
            severity_score: 55,
            water_safety_index: 45,
            flood_depth_meters: 0,
            affected_population: 8500,
            infrastructure_integrity_pct: 70,
          },
          symptoms: [
            {
              id: 'sym-1',
              description: 'Initial alert: 503 errors on login API',
              severity: 'HIGH',
              reported_at: new Date().toISOString(),
            },
          ],
          timeline: [
            {
              timestamp: new Date().toISOString(),
              event_type: 'INCIDENT_INITIALIZED',
              description: 'Identity outage incident initialized in standby mode.',
              actor: 'SYSTEM',
            },
          ],
          hypotheses: [],
          proposed_actions: [],
          actions_taken: [],
          participants: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setIncidentsList([fallback]);
        setSelectedIncidentId(fallback.incident_id);
        setIncidentState(() => fallback);
      } finally {
        setIsLoading(false);
        setLastUpdated(new Date().toISOString());
      }
    }

    initIncidents();
  }, [setIncidentState]);

  const activeIncident = wsIncident || incidentsList.find((i) => i.incident_id === selectedIncidentId) || null;

  const handleIncidentUpdated = useCallback(
    (updated: IncidentState) => {
      setIncidentState(() => updated);
      setLastUpdated(new Date().toISOString());
      setIncidentsList((prev) => {
        const idx = prev.findIndex((i) => i.incident_id === updated.incident_id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [updated, ...prev];
      });
    },
    [setIncidentState]
  );

  // Resolving an evidence item mutates server-side state; refetch so the panels
  // reflect the new open/settled split even if the WebSocket update is delayed.
  const refreshActiveIncident = useCallback(async () => {
    if (!selectedIncidentId) return;
    try {
      const fresh = await fetchIncident(selectedIncidentId);
      handleIncidentUpdated(fresh);
    } catch {
      // Non-fatal: the WebSocket broadcast is the primary update path.
    }
  }, [selectedIncidentId, handleIncidentUpdated]);

  const handleSelectIncident = (id: string) => {
    setSelectedIncidentId(id);
    const target = incidentsList.find((i) => i.incident_id === id);
    if (target) {
      setIncidentState(() => target);
    }
  };

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
