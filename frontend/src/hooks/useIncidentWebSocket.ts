import { useCallback, useEffect, useRef, useState } from 'react';
import { IncidentState } from '@/types/incident';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function getWebSocketUrl(incidentId: string): string {
  const base = API_BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${base}/ws/incidents/${incidentId}`;
}

export type WsConnectionStatus =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'ERROR';

export function useIncidentWebSocket(incidentId: string | null) {
  const [incidentState, setIncidentState] = useState<IncidentState | null>(null);
  const [status, setStatus] = useState<WsConnectionStatus>('DISCONNECTED');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef<boolean>(true);

  const connect = useCallback(() => {
    if (!incidentId) return;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      setStatus('CONNECTING');
      const url = getWebSocketUrl(incidentId);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('CONNECTED');
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'INCIDENT_SNAPSHOT' && payload.state) {
            setIncidentState(payload.state);
            setLastUpdated(new Date());
          } else if (payload.incident_id === incidentId && payload.metrics) {
            // Live broadcast tick
            setIncidentState(payload);
            setLastUpdated(new Date());
          }
        } catch {
          // Ignore non-JSON ping/ack messages
        }
      };

      ws.onerror = () => {
        setStatus('ERROR');
      };

      ws.onclose = () => {
        setStatus('DISCONNECTED');
        if (shouldReconnectRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 2000);
        }
      };
    } catch {
      setStatus('ERROR');
    }
  }, [incidentId]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    if (incidentId) {
      connect();
    } else {
      setIncidentState(null);
      setStatus('DISCONNECTED');
    }

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [incidentId, connect]);

  const updateLocalState = useCallback((updater: (prev: IncidentState | null) => IncidentState | null) => {
    setIncidentState((prev) => updater(prev));
    setLastUpdated(new Date());
  }, []);

  return {
    incidentState,
    status,
    lastUpdated,
    setIncidentState: updateLocalState,
    reconnect: connect,
  };
}
