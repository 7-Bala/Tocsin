'use client';

import React, { useState } from 'react';
import { IncidentState } from '@/types/incident';
import { ConflictsPanel } from './ConflictsPanel';
import { ActionItemsPanel } from './ActionItemsPanel';
import { ParticipantsPanel } from './ParticipantsPanel';
import { FinalSummaryPanel } from './FinalSummaryPanel';

export const IntelligencePanel: React.FC<{ incident: IncidentState | null }> = ({ incident }) => {
  const [activeTab, setActiveTab] = useState<'all' | 'conflicts' | 'actions' | 'facts' | 'summary'>('all');

  if (!incident) return null;

  const observations = incident.observations || [];
  const claims = incident.claims || [];
  const conflicts = incident.conflicts || [];
  const actionItems = incident.action_items || [];
  const participants = incident.participants || [];
  const missingInfo = incident.missing_info || [];
  const unresolvedRisks = incident.unresolved_risks || [];

  const confirmedFacts = claims.filter((c) => c.status === 'CONFIRMED' && c.claim_type !== 'decision');
  const decisions = claims.filter((c) => c.claim_type === 'decision');

  return (
    <section className="space-y-4" aria-label="Incident intelligence suite">
      {/* ── Evidence Ledger & Live Observation Stream ── */}
      <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
              <span>🧠</span> Shared Incident Intelligence Record
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Canonical evidence ingested from live voice discussion. Facts, hypotheses, and assumptions are rigorously separated.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-indigo-950/60 border border-indigo-500/30 text-indigo-300">
              {claims.length} Claims • {observations.length} Observations
            </span>
          </div>
        </div>

        {/* Observation stream summary */}
        {observations.length > 0 ? (
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {observations.slice(-6).reverse().map((obs) => {
              const isFallback = obs.extraction_method === 'heuristic_fallback';
              return (
                <div key={obs.id} className="p-2 rounded bg-zinc-950/60 border border-zinc-800/80 text-xs flex items-start justify-between gap-2">
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-300">{obs.speaker || 'Unknown Speaker'}</span>
                      <span className="text-[10px] text-zinc-500">
                        {new Date(obs.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300">
                        {obs.category}
                      </span>
                      {isFallback ? (
                        <span className="text-[9px] text-amber-400 bg-amber-950/40 px-1 rounded border border-amber-500/20" title="Extracted via heuristic fallback (unverified)">
                          Fallback
                        </span>
                      ) : (
                        <span className="text-[9px] text-indigo-400 bg-indigo-950/40 px-1 rounded border border-indigo-500/20" title="Extracted via Gemini LLM">
                          LLM
                        </span>
                      )}
                    </div>
                    <p className="text-zinc-300 truncate">{obs.raw_utterance}</p>
                  </div>
                  <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded ${
                    obs.status === 'CONFIRMED'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : obs.status === 'CONFLICTED'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}>
                    {obs.status}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-zinc-500 italic">No voice observations ingested yet.</p>
        )}
      </div>

      {/* ── Fast Navigation Filter Tabs ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-2">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            activeTab === 'all' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          All Panels ({conflicts.length + actionItems.length + participants.length + missingInfo.length + unresolvedRisks.length})
        </button>
        <button
          onClick={() => setActiveTab('facts')}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            activeTab === 'facts' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Facts & Decisions ({confirmedFacts.length + decisions.length})
        </button>
        <button
          onClick={() => setActiveTab('conflicts')}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            activeTab === 'conflicts' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Conflicts ({conflicts.length})
        </button>
        <button
          onClick={() => setActiveTab('actions')}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            activeTab === 'actions' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Action Items ({actionItems.length})
        </button>
        <button
          onClick={() => setActiveTab('summary')}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            activeTab === 'summary' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Final Summary Report
        </button>
      </div>

      {/* ── Key Facts & Decisions Highlights (when selected or on 'all') ── */}
      {(activeTab === 'all' || activeTab === 'facts') && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <span>✅</span> Confirmed Facts ({confirmedFacts.length})
            </h3>
            {confirmedFacts.length > 0 ? (
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {confirmedFacts.map((fact) => (
                  <div key={fact.id} className="p-2 rounded bg-zinc-950/50 border border-emerald-950/60 text-xs">
                    <span className="font-semibold text-zinc-200">{fact.entity}:</span>{' '}
                    <span className="text-zinc-300">{fact.value}</span>
                    <span className="ml-2 text-[10px] text-zinc-500">({fact.speaker || 'System'})</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">No confirmed facts yet.</p>
            )}
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400 flex items-center gap-1.5">
              <span>⚖️</span> Incident Decisions ({decisions.length})
            </h3>
            {decisions.length > 0 ? (
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {decisions.map((dec) => (
                  <div key={dec.id} className="p-2 rounded bg-zinc-950/50 border border-sky-950/60 text-xs">
                    <span className="font-semibold text-zinc-200">{dec.value}</span>
                    <span className="ml-2 text-[10px] text-zinc-500">(By: {dec.speaker || 'Commander'})</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500 italic">No decisions recorded yet.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Specialized Intelligence Panels Grid ── */}
      {(activeTab === 'all' || activeTab === 'conflicts' || activeTab === 'actions') && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(activeTab === 'all' || activeTab === 'conflicts') && <ConflictsPanel conflicts={conflicts} />}
          {(activeTab === 'all' || activeTab === 'actions') && <ActionItemsPanel actionItems={actionItems} />}
        </div>
      )}

      {/* ── Missing Information & Unresolved Risks ── */}
      {(activeTab === 'all') && (missingInfo.length > 0 || unresolvedRisks.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-amber-900/40 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
              <span>❓</span> Missing Information ({missingInfo.length})
            </h3>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {missingInfo.map((mi) => (
                <div key={mi.id} className="p-2 rounded bg-zinc-950/50 border border-amber-950/40 text-xs">
                  <p className="text-zinc-200">{mi.description}</p>
                  {mi.recommended_action && (
                    <p className="text-[11px] text-amber-400/90 mt-0.5 font-mono">Action: {mi.recommended_action}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-rose-900/40 space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
              <span>⚠️</span> Unresolved Risks ({unresolvedRisks.length})
            </h3>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {unresolvedRisks.map((risk) => (
                <div key={risk.id} className="p-2 rounded bg-zinc-950/50 border border-rose-950/40 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-zinc-200">{risk.description}</span>
                    <span className="text-[9px] uppercase px-1 rounded bg-rose-950 text-rose-300 font-mono border border-rose-800">
                      {risk.severity}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Participants & Final Summary ── */}
      {(activeTab === 'all' || activeTab === 'summary') && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ParticipantsPanel participants={participants} />
          <FinalSummaryPanel incidentId={incident.incident_id} initialSummary={incident.final_summary} />
        </div>
      )}
    </section>
  );
};
