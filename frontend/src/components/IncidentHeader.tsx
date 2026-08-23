'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { EventType, IncidentState, IncidentStatus, SeverityLevel } from '@/types/incident';
import { createIncident, triggerIncidentEvent } from '@/hooks/useIncidentApi';

interface IncidentHeaderProps {
  currentIncident: IncidentState | null;
  allIncidents: IncidentState[];
  wsStatus: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  onSelectIncident: (id: string) => void;
  onIncidentUpdated: (updated: IncidentState) => void;
}

export const IncidentHeader: React.FC<IncidentHeaderProps> = ({
  currentIncident,
  allIncidents,
  wsStatus,
  onSelectIncident,
  onIncidentUpdated,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTriggerModal, setShowTriggerModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form states
  const [newTitle, setNewTitle] = useState('');
  const [newEventType, setNewEventType] = useState<EventType>('FLOOD_SURGE');
  const [newSymptom, setNewSymptom] = useState('');

  const [triggerIntensity, setTriggerIntensity] = useState(1.5);
  const [triggerDesc, setTriggerDesc] = useState('');
  const [triggerCaller, setTriggerCaller] = useState('Unit-Dispatch-Alpha');

  const getStatusBadge = (status?: IncidentStatus) => {
    switch (status) {
      case 'DEGRADING':
        return {
          label: 'CRISIS ESCALATING',
          bg: 'rgba(248, 81, 73, 0.2)',
          border: '#f85149',
          color: '#f85149',
          pulse: true,
        };
      case 'RESOLVING':
        return {
          label: 'RECOVERY IN PROGRESS',
          bg: 'rgba(88, 166, 255, 0.2)',
          border: '#58a6ff',
          color: '#58a6ff',
          pulse: true,
        };
      case 'STABILIZED':
        return {
          label: 'STABILIZED / NOMINAL',
          bg: 'rgba(63, 185, 80, 0.2)',
          border: '#3fb950',
          color: '#3fb950',
          pulse: false,
        };
      default:
        return {
          label: status || 'IDLE',
          bg: 'rgba(110, 118, 129, 0.2)',
          border: '#6e7681',
          color: '#adbac7',
          pulse: false,
        };
    }
  };

  const getSeverityColor = (sev?: SeverityLevel) => {
    switch (sev) {
      case 'CRITICAL':
        return '#f85149';
      case 'HIGH':
        return '#e3b341';
      case 'MEDIUM':
        return '#d29922';
      default:
        return '#3fb950';
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const created = await createIncident({
        title: newTitle.trim(),
        event_type: newEventType,
        initial_symptoms: newSymptom.trim() ? [newSymptom.trim()] : undefined,
      });
      onIncidentUpdated(created);
      onSelectIncident(created.incident_id);
      setShowCreateModal(false);
      setNewTitle('');
      setNewSymptom('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to create incident');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentIncident) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const updated = await triggerIncidentEvent(currentIncident.incident_id, {
        event_type: currentIncident.event_type,
        intensity: triggerIntensity,
        description: triggerDesc.trim() || undefined,
        caller_id: triggerCaller.trim() || undefined,
      });
      onIncidentUpdated(updated);
      setShowTriggerModal(false);
      setTriggerDesc('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to trigger event');
    } finally {
      setIsSubmitting(false);
    }
  };

  const badge = getStatusBadge(currentIncident?.status);

  return (
    <header
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem',
        padding: '1.25rem 1.5rem',
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
      }}
    >
      {/* Title & Info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
            {currentIncident?.title || 'No Incident Selected'}
          </h1>
          {currentIncident && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.2rem 0.65rem',
                borderRadius: '999px',
                backgroundColor: badge.bg,
                border: `1px solid ${badge.border}`,
                color: badge.color,
              }}
            >
              {badge.pulse && (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: badge.color,
                    display: 'inline-block',
                  }}
                />
              )}
              {badge.label}
            </span>
          )}
          {currentIncident && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.2rem 0.6rem',
                borderRadius: '6px',
                border: `1px solid ${getSeverityColor(currentIncident.severity)}`,
                color: getSeverityColor(currentIncident.severity),
              }}
            >
              SEV: {currentIncident.severity}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.825rem', color: 'var(--text-secondary)' }}>
          <span>ID: <code>{currentIncident?.incident_id || '---'}</code></span>
          <span>Type: <b>{currentIncident?.event_type.replace('_', ' ') || '---'}</b></span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            Telemetry:{' '}
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor:
                  wsStatus === 'CONNECTED'
                    ? '#3fb950'
                    : wsStatus === 'CONNECTING'
                    ? '#e3b341'
                    : '#f85149',
              }}
            />
            {wsStatus}
          </span>
        </div>
      </div>

      {/* Action Controls & Incident Selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <select
          value={currentIncident?.incident_id || ''}
          onChange={(e) => onSelectIncident(e.target.value)}
          aria-label="Select Active Incident"
          style={{
            padding: '0.55rem 0.85rem',
            backgroundColor: '#0d1117',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {allIncidents.map((inc) => (
            <option key={inc.incident_id} value={inc.incident_id}>
              {inc.title} ({inc.status})
            </option>
          ))}
        </select>

        <button
          onClick={() => setShowTriggerModal(true)}
          disabled={!currentIncident}
          style={{
            padding: '0.55rem 1rem',
            borderRadius: '8px',
            border: '1px solid #f85149',
            backgroundColor: 'rgba(248, 81, 73, 0.15)',
            color: '#f85149',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: currentIncident ? 'pointer' : 'not-allowed',
            opacity: currentIncident ? 1 : 0.5,
          }}
        >
          ⚡ Trigger Crisis Spike
        </button>

        <button
          onClick={() => setShowCreateModal(true)}
          style={{
            padding: '0.55rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--accent-blue)',
            backgroundColor: 'var(--accent-blue)',
            color: '#ffffff',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + New Incident
        </button>

        <Link
          href="/voice-test"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.55rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            fontWeight: 600,
            textDecoration: 'none',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          }}
        >
          🎙️ Voice Test
        </Link>
      </div>

      {/* New Incident Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '480px',
            }}
          >
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>
              Create Disaster Incident
            </h2>
            {errorMsg && (
              <p style={{ color: '#f85149', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                {errorMsg}
              </p>
            )}
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Incident Title
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sector 4 Industrial Flash Flood"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Disaster Type
                </label>
                <select
                  value={newEventType}
                  onChange={(e) => setNewEventType(e.target.value as EventType)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                >
                  <option value="FLOOD_SURGE">Flood Surge</option>
                  <option value="WATER_CONTAMINATION">Water Contamination</option>
                  <option value="STRANDED_GROUP">Stranded Group Rescue</option>
                  <option value="POWER_FAILURE">Power Grid Failure</option>
                  <option value="STRUCTURAL_HAZARD">Structural Hazard</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Initial Sensor / Dispatch Symptom (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Rapid rising water at river crossing"
                  value={newSymptom}
                  onChange={(e) => setNewSymptom(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: '0.5rem 1.25rem',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--accent-blue)',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {isSubmitting ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Trigger Spike Modal */}
      {showTriggerModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '460px',
            }}
          >
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem', color: '#f85149' }}>
              ⚡ Trigger Crisis Degradation Event
            </h2>
            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Injects a crisis surge into the live simulation engine, triggering progressive metric degradation.
            </p>
            {errorMsg && (
              <p style={{ color: '#f85149', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                {errorMsg}
              </p>
            )}
            <form onSubmit={handleTrigger} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Intensity Multiplier ({triggerIntensity}x)
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="4.0"
                  step="0.25"
                  value={triggerIntensity}
                  onChange={(e) => setTriggerIntensity(parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Description / Event Log
                </label>
                <input
                  type="text"
                  placeholder="e.g. Surge breach detected at main embankment"
                  value={triggerDesc}
                  onChange={(e) => setTriggerDesc(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.825rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                  Reporting Caller ID
                </label>
                <input
                  type="text"
                  value={triggerCaller}
                  onChange={(e) => setTriggerCaller(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: '#0d1117',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: '#fff',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowTriggerModal(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: '0.5rem 1.25rem',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: '#f85149',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {isSubmitting ? 'Triggering...' : 'Trigger Surge'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
};
