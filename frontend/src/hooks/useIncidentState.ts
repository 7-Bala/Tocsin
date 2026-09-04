import { useCallback, useEffect, useState } from 'react';
import { IncidentState } from '@/types/incident';
import { fetchIncident } from '@/hooks/useIncidentApi';
import { useIncidentWebSocket, WsConnectionStatus } from '@/hooks/useIncidentWebSocket';

/**
 * Live state for exactly one incident: the room you are currently in.
 *
 * Behavior:
 * - Pass the incident id of the joined room, or `null` when not in a room.
 * - `null` means genuinely nothing: no fetch, no incident, no placeholder. The UI
 *   is expected to render an explicit "not in a room" empty state rather than
 *   showing an incident shell with zeroed numbers, which reads as real data.
 * - When an id is given, fetch that incident once and then track it live over the
 *   incident WebSocket.
 *
 * History (2026-09-04): this hook used to own a hardcoded `inc-demo-identity-outage`
 * id, auto-create that incident on mount if it was missing, and expose a list plus a
 * selector so the user could switch between incidents. That made every fresh page
 * load open onto a pre-existing incident whose evidence had accumulated across
 * previous sessions -- indistinguishable, to anyone opening the app, from data the
 * product had fabricated. The incident is now created by joining a room and purged
 * by leaving it, so what you see in a room is only ever what that conversation
 * produced. Title, severity, status and hypotheses are still derived server-side
 * from real claims by app/engine/incident_derivation.py; nothing here writes them.
 */
export function useIncidentState(incidentId: string | null) {
  const [fetched, setFetched] = useState<IncidentState | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { incidentState: wsIncident, status: wsStatus, setIncidentState } =
    useIncidentWebSocket(incidentId);

  useEffect(() => {
    let cancelled = false;

    if (!incidentId) {
      // Leaving a room must clear both caches, or the panels keep rendering the
      // evidence of a room that no longer exists.
      setFetched(null);
      setIncidentState(() => null);
      setIsLoading(false);
      return;
    }

    async function loadIncident(id: string) {
      try {
        setIsLoading(true);
        const state = await fetchIncident(id);
        if (cancelled) return;
        setFetched(state);
        setIncidentState(() => state);
      } catch {
        // The room may not be persisted yet at the moment of the first fetch
        // (join creates it, and the WebSocket delivers state right behind this).
        // Staying null is correct: better an honest empty room than a fabricated
        // one.
        if (!cancelled) setFetched(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadIncident(incidentId);
    return () => { cancelled = true; };
  }, [incidentId, setIncidentState]);

  // The WebSocket copy wins when present: it is the one that receives every
  // observation, conflict and derivation as they land.
  const activeIncident = incidentId ? (wsIncident || fetched) : null;

  const handleIncidentUpdated = useCallback(
    (updated: IncidentState) => {
      setIncidentState(() => updated);
      setFetched(updated);
    },
    [setIncidentState]
  );

  // Resolving an evidence item mutates server-side state; refetch so the panels
  // reflect the new open/settled split even if the WebSocket update is delayed.
  const refreshActiveIncident = useCallback(async () => {
    if (!incidentId) return;
    try {
      const fresh = await fetchIncident(incidentId);
      handleIncidentUpdated(fresh);
    } catch {
      // Non-fatal: the WebSocket broadcast is the primary update path.
    }
  }, [incidentId, handleIncidentUpdated]);

  return {
    activeIncident,
    isLoading,
    wsStatus: wsStatus as WsConnectionStatus,
    handleIncidentUpdated,
    refreshActiveIncident,
  };
}
