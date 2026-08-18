'use client';

import React from 'react';
import { Hypothesis, Symptom } from '@/types/incident';

interface HypothesesPanelProps {
  hypotheses?: Hypothesis[];
  symptoms?: Symptom[];
}

export const HypothesesPanel: React.FC<HypothesesPanelProps> = ({
  hypotheses = [],
  symptoms = [],
}) => {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'CONFIRMED':
        return '#3fb950';
      case 'DISPROVEN':
        return '#f85149';
      default:
        return '#e3b341';
    }
  };

  return (
    <section
      aria-label="AI Incident Diagnosis & Symptoms"
      style={{
        padding: '1.25rem',
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      {/* Hypotheses */}
      <div>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span>🧠 Grounded Incident Hypotheses</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>({hypotheses.length})</span>
        </h2>

        {hypotheses.length === 0 ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>No diagnostic hypotheses formed yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {hypotheses.map((hypo) => {
              const confPct = Math.round(hypo.confidence * 100);
              return (
                <div
                  key={hypo.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'rgba(0, 0, 0, 0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                      {hypo.title}
                    </span>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '0.15rem 0.45rem',
                        borderRadius: '4px',
                        border: `1px solid ${getStatusColor(hypo.status)}`,
                        color: getStatusColor(hypo.status),
                      }}
                    >
                      {hypo.status} ({confPct}%)
                    </span>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {hypo.description}
                  </p>
                  <div style={{ width: '100%', height: '4px', backgroundColor: '#21262d', borderRadius: '2px', overflow: 'hidden', marginTop: '0.2rem' }}>
                    <div
                      style={{
                        width: `${confPct}%`,
                        height: '100%',
                        backgroundColor: getStatusColor(hypo.status),
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reported Symptoms */}
      <div>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          Active Symptoms & Triage Signals ({symptoms.length})
        </h3>
        {symptoms.length === 0 ? (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No active symptom signals reported.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {symptoms.map((sym) => (
              <span
                key={sym.id}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'rgba(248, 81, 73, 0.1)',
                  color: 'var(--text-primary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                }}
              >
                <span style={{ color: '#f85149' }}>●</span>
                {sym.description}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
