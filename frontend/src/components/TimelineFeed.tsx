'use client';

import React from 'react';
import { TimelineEntry } from '@/types/incident';

interface TimelineFeedProps {
  timeline?: TimelineEntry[];
}

export const TimelineFeed: React.FC<TimelineFeedProps> = ({ timeline = [] }) => {
  const getEventIcon = (type: string) => {
    if (type.includes('PROPOSED')) return '📋';
    if (type.includes('APPROVED')) return '✓';
    if (type.includes('REJECTED')) return '✕';
    if (type.includes('EVENT') || type.includes('BREACH')) return '⚠️';
    if (type.includes('RESOLUTION') || type.includes('STABILIZED')) return '🛡️';
    if (type.includes('VOICE')) return '🎙️';
    return '📌';
  };

  const getEventColor = (type: string) => {
    if (type.includes('APPROVED') || type.includes('STABILIZED')) return '#3fb950';
    if (type.includes('REJECTED') || type.includes('EVENT')) return '#f85149';
    if (type.includes('PROPOSED')) return '#e3b341';
    return '#58a6ff';
  };

  const reversed = [...timeline].reverse();

  return (
    <section
      aria-label="Live Incident Event Timeline"
      style={{
        padding: '1.25rem',
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span>📜 Operational Event Timeline</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>({timeline.length} events)</span>
        </h2>
      </div>

      {reversed.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No timeline events recorded yet.</p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            maxHeight: '380px',
            overflowY: 'auto',
            paddingRight: '0.25rem',
          }}
        >
          {reversed.map((entry, idx) => (
            <div
              key={`${entry.timestamp}-${idx}`}
              style={{
                display: 'flex',
                gap: '0.75rem',
                padding: '0.65rem 0.85rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                backgroundColor: 'rgba(0, 0, 0, 0.25)',
                fontSize: '0.825rem',
              }}
            >
              <span
                style={{
                  fontSize: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  flexShrink: 0,
                }}
              >
                {getEventIcon(entry.event_type)}
              </span>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, color: getEventColor(entry.event_type) }}>
                    {entry.event_type}
                  </span>
                  <span style={{ fontSize: '0.725rem', color: 'var(--text-secondary)' }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>

                <p style={{ color: 'var(--text-primary)', lineHeight: 1.4 }}>{entry.description}</p>

                <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.725rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                  <span>Actor: <b>{entry.actor}</b></span>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <span>Meta: <code>{JSON.stringify(entry.metadata)}</code></span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
