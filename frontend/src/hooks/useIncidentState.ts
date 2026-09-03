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
 * Behavior, current:
 * - On mount, fetch the incident list; if the canonical demo incident id doesn't
 *   exist yet, create it -- genuinely empty (no title story, no seeded symptoms, no
 *   claims). Live-reported 2026-09-03: this used to pre-populate a scripted
 *   "Customer Login and Identity Outage" scenario with two hardcoded symptoms on
 *   every fresh install, which looked indistinguishable from fabricated evidence to
 *   someone opening the app to test whether it derives things from real input. The
 *   incident's actual title, severity and status are meant to come from
 *   incident_derivation.py reacting to real claims, not from a value written here.
 * - Select the demo incident by default (or the first incident if it's absent for
 *   some other reason).
 * - Subscribe to that incident's WebSocket for live updates.
 * - If the initial fetch fails entirely (backend unreachable), fall back to a
 *   neutral standby IncidentState -- explicitly labeled as a disconnected
 *   placeholder, not a scenario -- so the page still renders something coherent
 *   rather than a blank screen, without parading fabricated severity or metrics.
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
          // Genuinely empty on creation -- no title story, no seeded symptoms. The
          // room's own evidence is what should ever populate this, via
          // incident_derivation.py reacting to real claims as they come in.
          const defaultInc = await createIncident({
            title: 'Untitled Incident — Awaiting Reports',
            event_type: 'TECHNICAL_INCIDENT',
            incident_id: DEMO_INCIDENT_ID,
          });
          list = [defaultInc, ...list];
        }
        setIncidentsList(list);
        const selected = list.find((incident) => incident.incident_id === DEMO_INCIDENT_ID) || list[0];
        setSelectedIncidentId(selected.incident_id);
        setIncidentState(() => selected);
      } catch {
        // Backend unreachable -- a neutral disconnected placeholder, not a scenario.
        // Severity/metrics read as "nothing wrong" (LOW, full health) rather than
        // fabricating an outage the app has no evidence for; the title says plainly
        // that this is standby state, not a derived or reported incident.
        const fallback: IncidentState = {
          incident_id: DEMO_INCIDENT_ID,
          title: 'No Incident Loaded (Backend Unreachable)',
          event_type: 'TECHNICAL_INCIDENT',
          status: 'IDLE',
          severity: 'LOW',
          metrics: {
            severity_score: 0,
            water_safety_index: 100,
            flood_depth_meters: 0,
            affected_population: 0,
            infrastructure_integrity_pct: 100,
          },
          symptoms: [],
          timeline: [
            {
              timestamp: new Date().toISOString(),
              event_type: 'BACKEND_UNREACHABLE',
              description: 'Could not reach the backend -- showing a local standby placeholder, not live evidence.',
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
