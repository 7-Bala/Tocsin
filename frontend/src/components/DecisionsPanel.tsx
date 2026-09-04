'use client';

import React, { useState } from 'react';
import { Claim } from '@/types/incident';
import { recordDecision, supersedeDecision } from '@/hooks/useIncidentApi';
import { ScaleIcon } from '@/components/Icon';

interface DecisionsPanelProps {
  claims: Claim[];
  incidentId: string;
  onChanged?: () => void;
}

/**
 * First-class decisions with rationale and supersession.
 *
 * A decision is a Claim with claim_type "decision", carrying a rationale, who made
 * it, and (when it replaces an earlier call) a supersession link in both
 * directions. Only the active end of each chain is shown as current — a superseded
 * decision is history, not something an incoming commander should act on. See
 * docs/strategy/INNOVATION_ROADMAP.md §3.1.
 */
export const DecisionsPanel: React.FC<DecisionsPanelProps> = ({ claims, incidentId, onChanged }) => {
  const decisions = claims.filter((c) => c.claim_type === 'decision');
  const active = decisions.filter((d) => !d.superseded_by_id);
  const supersededById = new Map(decisions.map((d) => [d.id, d]));

  const [showForm, setShowForm] = useState(false);
  const [supersedeTarget, setSupersedeTarget] = useState<Claim | null>(null);
  const [entity, setEntity] = useState('');
  const [value, setValue] = useState('');
  const [rationale, setRationale] = useState('');
  const [decidedBy, setDecidedBy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setShowForm(false);
    setSupersedeTarget(null);
    setEntity('');
    setValue('');
    setRationale('');
    setDecidedBy('');
    setError(null);
  };

  const submit = async () => {
    if (!entity.trim() || !value.trim() || !rationale.trim() || !decidedBy.trim()) {
      setError('All fields are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = { entity: entity.trim(), value: value.trim(), rationale: rationale.trim(), decided_by: decidedBy.trim() };
      if (supersedeTarget) {
        await supersedeDecision(incidentId, supersedeTarget.id, payload);
      } else {
        await recordDecision(incidentId, payload);
      }
      resetForm();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save decision.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-2" aria-label="Incident decisions">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-sky-400 flex items-center gap-1.5">
          <ScaleIcon /> Decisions in Force ({active.length})
        </h3>
        {!showForm && (
          <button
            onClick={() => { setShowForm(true); setSupersedeTarget(null); }}
            className="text-[11px] px-2 py-0.5 rounded bg-sky-800 hover:bg-sky-700 text-white transition"
          >
            + Record decision
          </button>
        )}
      </div>

      {active.length > 0 ? (
        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {active.map((dec) => (
            <div key={dec.id} className="p-2 rounded bg-zinc-950/50 border border-sky-950/60 text-xs space-y-0.5">
              <div>
                <span className="font-semibold text-zinc-200">{dec.entity}:</span>{' '}
                <span className="text-zinc-300">{dec.value}</span>
              </div>
              {dec.rationale && (
                <p className="text-[11px] text-zinc-500">Because: {dec.rationale}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500">
                  By {dec.decided_by || dec.speaker || 'Commander'}
                  {dec.supersedes_id && supersededById.has(dec.supersedes_id) && (
                    <> · supersedes &ldquo;{supersededById.get(dec.supersedes_id)?.value}&rdquo;</>
                  )}
                </span>
                <button
                  onClick={() => {
                    setSupersedeTarget(dec);
                    setEntity(dec.entity);
                    setValue('');
                    setRationale('');
                    setDecidedBy('');
                    setShowForm(true);
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition"
                >
                  Supersede
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500 italic">No decisions recorded yet.</p>
      )}

      {decisions.length > active.length && (
        <p className="text-[10px] text-zinc-600">
          {decisions.length - active.length} superseded decision{decisions.length - active.length !== 1 ? 's' : ''} kept as history, not shown as current.
        </p>
      )}

      {showForm && (
        <div className="p-2.5 rounded-lg bg-zinc-950/70 border border-sky-500/20 space-y-1.5">
          <p className="text-[11px] font-semibold text-sky-400">
            {supersedeTarget ? `Supersede: "${supersedeTarget.value}"` : 'New decision'}
          </p>
          <input
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            placeholder="What this concerns (e.g. Rollback timing)"
            disabled={!!supersedeTarget}
            className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-200 disabled:opacity-60"
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="The decision itself"
            className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-200"
          />
          <input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Rationale — why this decision"
            className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-200"
          />
          <input
            value={decidedBy}
            onChange={(e) => setDecidedBy(e.target.value)}
            placeholder="Decided by"
            className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-200"
          />
          {error && <p className="text-[11px] text-rose-400">{error}</p>}
          <div className="flex gap-1.5">
            <button
              onClick={submit}
              disabled={submitting}
              className="text-[11px] px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 disabled:bg-zinc-800 text-white transition"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={resetForm}
              className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
