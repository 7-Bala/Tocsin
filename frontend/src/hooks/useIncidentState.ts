import { useCallback, useEffect, useState } from 'react';
import { IncidentState } from '@/types/incident';
import { createIncident, fetchIncident, fetchIncidents } from '@/hooks/useIncidentApi';
import { useIncidentWebSocket, WsConnectionStatus } from '@/hooks/useIncidentWebSocket';

const DEMO_INCIDENT_ID = 'inc-demo-identity-outage';

/**
 * Single source of truth for "the current incident and its live state," shared by
 * every page that needs it. Extracted from `/` (page.tsx) verbatim — no behavior
 * change — specifically so `/voice-test` can consume the exact same incident data the
 * dashboard does instead of maintaining a second, independent implementation that can
 * silently drift out of sync (see docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md).
 *
 * Behavior preserved from the original inline implementation:
 * - On mount, fetch the incident list; if the canonical identity-outage demo incident
 *   doesn't exist yet, create it so the app is immediately demo-ready.
 * - Select the demo incident by default (or the first incident if it's absent for
 *   some other reason).
 * - Subscribe to that incident's WebSocket for live updates.
 * - If the initial fetch fails entirely (backend unreachable), fall back to a
 *   hardcoded standby IncidentState so the page still renders something coherent
 *   rather than a blank screen.
 */
export function useIncidentState() {
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

  const { incidentState: wsIncident, status: wsStatus, setIncidentState } =
    useIncidentWebSocket(selectedIncidentId);

  useEffect(() => {
    async function initIncidents() {
      try {
        setIsLoading(true);
        let list = await fetchIncidents();
        const identityIncident = list.find((incident) => incident.incident_id === DEMO_INCIDENT_ID);
        if (!identityIncident) {
          // Initialize default identity outage incident for immediate demo readiness
          const defaultInc = await createIncident({
            title: 'Customer Login and Identity Outage',
            event_type: 'TECHNICAL_INCIDENT',
            incident_id: DEMO_INCIDENT_ID,
            initial_symptoms: [
              'HTTP 503 error surge on /api/v1/login across multiple regions',
              'Customer login success rate dropped to 60%',
            ],
          });
          list = [defaultInc, ...list];
        }
        setIncidentsList(list);
        const selected = list.find((incident) => incident.incident_id === DEMO_INCIDENT_ID) || list[0];
        setSelectedIncidentId(selected.incident_id);
        setIncidentState(() => selected);
      } catch {
        // Fallback demo state if backend connection fails on initial render
        const fallback: IncidentState = {
          incident_id: DEMO_INCIDENT_ID,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSelectIncident = useCallback(
    (id: string) => {
      setSelectedIncidentId(id);
      const target = incidentsList.find((i) => i.incident_id === id);
      if (target) {
        setIncidentState(() => target);
      }
    },
    [incidentsList, setIncidentState]
  );

  return {
    activeIncident,
    incidentsList,
    selectedIncidentId,
    isLoading,
    lastUpdated,
    wsStatus: wsStatus as WsConnectionStatus,
    handleIncidentUpdated,
    refreshActiveIncident,
    handleSelectIncident,
  };
}
