'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { IncidentState } from '@/types/incident';
import { createIncident, fetchIncidents } from '@/hooks/useIncidentApi';
import { useIncidentWebSocket } from '@/hooks/useIncidentWebSocket';
import { IncidentHeader } from '@/components/IncidentHeader';
import { MetricsOverview } from '@/components/MetricsOverview';
import { ActionApprovalQueue } from '@/components/ActionApprovalQueue';
import { HypothesesPanel } from '@/components/HypothesesPanel';
import { TimelineFeed } from '@/components/TimelineFeed';
import { VoiceHUD } from '@/components/VoiceHUD';

export default function IncidentCommandDashboard() {
  const [incidentsList, setIncidentsList] = useState<IncidentState[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // WebSocket real-time subscription
  const { incidentState: wsIncident, status: wsStatus, setIncidentState } =
    useIncidentWebSocket(selectedIncidentId);

  // Initialize incidents on mount
  useEffect(() => {
    async function initIncidents() {
      try {
        setIsLoading(true);
        let list = await fetchIncidents();
        if (list.length === 0) {
          // Initialize default crisis incident for immediate demo readiness
          const defaultInc = await createIncident({
            title: 'Downtown Coastal Flash Flood Surge',
            event_type: 'FLOOD_SURGE',
            incident_id: 'inc-demo-flood-01',
            initial_symptoms: [
              'Rapid overflow detected at River Embankment Sector 4',
              'Multiple vehicles stranded near Low-lying Viaduct',
            ],
          });
          list = [defaultInc];
        }
        setIncidentsList(list);
        setSelectedIncidentId(list[0].incident_id);
        setIncidentState(() => list[0]);
      } catch {
        // Fallback demo state if backend connection fails on initial render
        const fallback: IncidentState = {
          incident_id: 'inc-demo-flood-01',
          title: 'Downtown Coastal Flash Flood Surge',
          event_type: 'FLOOD_SURGE',
          status: 'IDLE',
          severity: 'LOW',
          metrics: {
            severity_score: 10,
            water_safety_index: 95,
            flood_depth_meters: 0,
            affected_population: 0,
            infrastructure_integrity_pct: 100,
          },
          symptoms: [
            {
              id: 'sym-1',
              description: 'Initial sensor alert: rapid water runoff',
              severity: 'LOW',
              reported_at: new Date().toISOString(),
            },
          ],
          timeline: [
            {
              timestamp: new Date().toISOString(),
              event_type: 'INCIDENT_INITIALIZED',
              description: 'Incident initialized in standby mode.',
              actor: 'SYSTEM',
            },
          ],
          hypotheses: [
            {
              id: 'hypo-1',
              title: 'Flash Flood & Culvert Breach Hazard',
              description: 'Sensor data indicates runoff accumulation pending voice confirmation.',
              confidence: 0.4,
              status: 'PROPOSED',
              updated_at: new Date().toISOString(),
            },
          ],
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
      }
    }

    initIncidents();
  }, [setIncidentState]);

  const activeIncident = wsIncident || incidentsList.find((i) => i.incident_id === selectedIncidentId) || null;

  const handleIncidentUpdated = useCallback(
    (updated: IncidentState) => {
      setIncidentState(() => updated);
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

      {/* Live Telemetry Gauges */}
      <MetricsOverview
        metrics={activeIncident?.metrics}
        status={activeIncident?.status}
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
        {/* Left Column: Approvals & AI Understanding */}
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
            channelName={activeIncident?.incident_id || 'tocsin-emergency-room'}
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
          🚨 <b>TOCSIN Crisis Coordination Engine</b> • Multi-Party Voice AI & Emergency MCP
        </span>
        <span>
          Active Incident: <code>{activeIncident?.incident_id || '---'}</code> • Status: <b>{activeIncident?.status || 'IDLE'}</b>
        </span>
      </footer>
    </main>
  );
}
