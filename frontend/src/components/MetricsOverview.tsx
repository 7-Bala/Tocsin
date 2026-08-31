'use client';

import React from 'react';
import { IncidentMetrics, IncidentStatus } from '@/types/incident';

interface MetricsOverviewProps {
  metrics?: IncidentMetrics;
  status?: IncidentStatus;
}

export const MetricsOverview: React.FC<MetricsOverviewProps> = ({
  metrics = {
    severity_score: 10,
    water_safety_index: 95,
    flood_depth_meters: 0,
    affected_population: 0,
    infrastructure_integrity_pct: 100,
  },
  status = 'IDLE',
}) => {
  const getSeverityColor = (score: number) => {
    if (score >= 80) return '#f85149';
    if (score >= 55) return '#e3b341';
    if (score >= 30) return '#d29922';
    return '#3fb950';
  };

  const getWaterSafetyColor = (index: number) => {
    if (index >= 80) return '#3fb950';
    if (index >= 50) return '#e3b341';
    return '#f85149';
  };

  const getIntegrityColor = (integrity: number) => {
    if (integrity >= 75) return '#3fb950';
    if (integrity >= 40) return '#e3b341';
    return '#f85149';
  };

  return (
    <section
      aria-label="Incident Live Telemetry Metrics"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '1rem',
      }}
    >
      {/* 1. Overall Severity Score */}
      <article
        style={{
          padding: '1.25rem',
          backgroundColor: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
            SEVERITY SCORE
          </span>
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              padding: '0.15rem 0.4rem',
              borderRadius: '4px',
              backgroundColor: status === 'DEGRADING' ? 'rgba(248, 81, 73, 0.2)' : 'rgba(88, 166, 255, 0.2)',
              color: status === 'DEGRADING' ? '#f85149' : '#58a6ff',
            }}
          >
            {status === 'DEGRADING' ? '▲ RISING' : status === 'RESOLVING' ? '▼ RECOVERING' : '● NOMINAL'}
          </span>
        </div>
        <div style={{ margin: '0.75rem 0' }}>
          <span style={{ fontSize: '2.25rem', fontWeight: 800, color: getSeverityColor(metrics.severity_score) }}>
            {metrics.severity_score.toFixed(1)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>/ 100</span>
        </div>
        <div style={{ width: '100%', height: '6px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(100, Math.max(0, metrics.severity_score))}%`,
              height: '100%',
              backgroundColor: getSeverityColor(metrics.severity_score),
              transition: 'width 0.4s ease-out',
            }}
          />
        </div>
      </article>

      {/* 2. Login Error Rate */}
      <article
        style={{
          padding: '1.25rem',
          backgroundColor: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          LOGIN ERROR RATE
        </span>
        <div style={{ margin: '0.75rem 0' }}>
          <span style={{ fontSize: '2.25rem', fontWeight: 800, color: metrics.flood_depth_meters > 0.5 ? '#f85149' : '#58a6ff' }}>
            {Math.max(0, 100 - metrics.water_safety_index).toFixed(1)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>%</span>
        </div>
        <div style={{ width: '100%', height: '6px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(100, Math.max(0, 100 - metrics.water_safety_index))}%`,
              height: '100%',
              backgroundColor: '#f85149',
              transition: 'width 0.4s ease-out',
            }}
          />
        </div>
      </article>

      {/* 3. Service Signal */}
      <article
        style={{
          padding: '1.25rem',
          backgroundColor: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          IDENTITY SERVICE SIGNAL
        </span>
        <div style={{ margin: '0.75rem 0' }}>
          <span style={{ fontSize: '2.25rem', fontWeight: 800, color: getWaterSafetyColor(metrics.water_safety_index) }}>
            {metrics.infrastructure_integrity_pct.toFixed(1)}%
          </span>
        </div>
        <div style={{ width: '100%', height: '6px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(100, Math.max(0, metrics.infrastructure_integrity_pct))}%`,
              height: '100%',
              backgroundColor: getIntegrityColor(metrics.infrastructure_integrity_pct),
              transition: 'width 0.4s ease-out',
            }}
          />
        </div>
      </article>

      {/* 4. Affected Population */}
      <article
        style={{
          padding: '1.25rem',
          backgroundColor: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          CUSTOMERS AFFECTED
        </span>
        <div style={{ margin: '0.75rem 0' }}>
          <span style={{ fontSize: '2.25rem', fontWeight: 800, color: metrics.affected_population > 0 ? '#e3b341' : '#3fb950' }}>
            {metrics.affected_population.toLocaleString()}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>customers</span>
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {metrics.affected_population > 0 ? 'Impact estimate' : 'No impact reported'}
        </div>
      </article>

      {/* 5. Infrastructure Integrity */}
      <article
        style={{
          padding: '1.25rem',
          backgroundColor: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
          IDENTITY SERVICE HEALTH
        </span>
        <div style={{ margin: '0.75rem 0' }}>
          <span style={{ fontSize: '2.25rem', fontWeight: 800, color: getIntegrityColor(metrics.infrastructure_integrity_pct) }}>
            {metrics.infrastructure_integrity_pct.toFixed(1)}%
          </span>
        </div>
        <div style={{ width: '100%', height: '6px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(100, Math.max(0, metrics.infrastructure_integrity_pct))}%`,
              height: '100%',
              backgroundColor: getIntegrityColor(metrics.infrastructure_integrity_pct),
              transition: 'width 0.4s ease-out',
            }}
          />
        </div>
      </article>
    </section>
  );
};
