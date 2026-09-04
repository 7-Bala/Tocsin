'use client';

import React, { useState } from 'react';
import { ConflictRecord } from '@/types/incident';
import { resolveEvidenceItem } from '@/hooks/useIncidentApi';
import { CheckIcon, AlertTriangleIcon, LightbulbIcon } from '@/components/Icon';

interface ConflictsPanelProps {
  conflicts: ConflictRecord[];
  incidentId?: string | null;
  onResolved?: () => void;
}

/**
 * Contradictions are shown as *resolvable* items, not as a read-only alert list.
 *
 * Tocsin detects that two people said incompatible things; it deliberately does not
 * decide who was right. A named human closes the item and states the evidence that
 * settled it. Without that, the panel accumulates permanently-open entries — including
 * ones the room settled verbally minutes earlier — and becomes actively misleading
 * about what is still open.
 */
export const ConflictsPanel: React.FC<ConflictsPanelProps> = ({
  conflicts,
  incidentId,
  onResolved,
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resolvedBy, setResolvedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openConflicts = conflicts.filter((c) => c.status !== 'RESOLVED');
  const settledConflicts = conflicts.filter((c) => c.status === 'RESOLVED');

  const canSubmit = resolvedBy.trim().length >= 2 && notes.trim().length >= 3 && !busy;

  const submitResolution = async (conflictId: string) => {
    if (!incidentId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await resolveEvidenceItem(
        incidentId,
        'conflicts',
        conflictId,
        resolvedBy.trim(),
        notes.trim()
      );
      setActiveId(null);
      setNotes('');
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resolve conflict.');
    } finally {
      setBusy(false);
    }
  };

  if (openConflicts.length === 0 && settledConflicts.length === 0) {
    return (
      <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-950/10 text-xs text-emerald-400">
        <span className="font-semibold inline-flex items-center gap-1"><CheckIcon /> No contradictions detected</span> across recorded observations.
      </div>
    );
  }

  return (
    <div
      className="p-4 rounded-xl border border-rose-500/30 bg-rose-950/10 space-y-3"
      aria-label="Incident conflicts"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2">
          <AlertTriangleIcon /> Contradictions ({openConflicts.length} open)
        </h3>
        {openConflicts.length > 0 && (
          <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300">
            Needs human resolution
          </span>
        )}
      </div>

      {openConflicts.length === 0 && (
        <p className="text-xs text-emerald-400 flex items-center gap-1">
          <CheckIcon /> All detected contradictions have been resolved.
        </p>
      )}

      <div className="space-y-2">
        {openConflicts.map((c) => (
          <div
            key={c.id}
            className="p-3 rounded-lg bg-zinc-900/80 border border-rose-500/20 text-xs space-y-1.5"
          >
            <div className="font-semibold text-zinc-200">
              Entity: <span className="text-rose-300 underline">{c.entity}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] bg-zinc-950/60 p-2 rounded">
              <div>
                <span className="text-zinc-400">Source A ({c.speaker_a || c.source_a}):</span>
                <p className="text-zinc-200 font-mono mt-0.5">{c.value_a}</p>
              </div>
              <div>
                <span className="text-zinc-400">Source B ({c.speaker_b || c.source_b}):</span>
                <p className="text-zinc-200 font-mono mt-0.5">{c.value_b}</p>
              </div>
            </div>
            {c.recommended_action && (
              <p className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/20 p-1.5 rounded flex items-start gap-1">
                <LightbulbIcon /> <span><span className="font-semibold">Recommended:</span> {c.recommended_action}</span>
              </p>
            )}

            {incidentId && activeId !== c.id && (
              <button
                onClick={() => {
                  setActiveId(c.id);
                  setError(null);
                }}
                className="mt-1 px-2.5 py-1 rounded text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition"
              >
                Resolve this contradiction
              </button>
            )}

            {incidentId && activeId === c.id && (
              <div className="mt-2 p-2.5 rounded bg-zinc-950/80 border border-zinc-700 space-y-2">
                <p className="text-[10px] text-zinc-400">
                  Tocsin does not decide which claim was correct. Record who settled it
                  and what evidence they used.
                </p>
                <input
                  type="text"
                  value={resolvedBy}
                  onChange={(e) => setResolvedBy(e.target.value)}
                  placeholder="Resolved by (your name)"
                  className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-100 placeholder-zinc-500"
                />
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What evidence settled this? e.g. 'Checked identity-service dashboard: connection pool at 22%.'"
                  rows={2}
                  className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-100 placeholder-zinc-500 resize-none"
                />
                {error && <p className="text-[11px] text-rose-400">{error}</p>}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => submitResolution(c.id)}
                    disabled={!canSubmit}
                    className="px-2.5 py-1 rounded text-[11px] font-medium bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white transition"
                  >
                    {busy ? 'Recording…' : 'Record resolution'}
                  </button>
                  <button
                    onClick={() => {
                      setActiveId(null);
                      setError(null);
                    }}
                    className="px-2.5 py-1 rounded text-[11px] text-zinc-400 hover:text-zinc-200 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {settledConflicts.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200 text-[11px]">
            Settled contradictions ({settledConflicts.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {settledConflicts.map((c) => (
              <div
                key={c.id}
                className="p-2 rounded bg-zinc-950/50 border border-emerald-900/40 text-[11px] space-y-0.5"
              >
                <div className="text-zinc-300">
                  <span className="font-semibold">{c.entity}</span> — settled by{' '}
                  <span className="text-emerald-400">{c.resolved_by || 'unknown'}</span>
                </div>
                {c.resolution_notes && (
                  <p className="text-zinc-400 italic">{c.resolution_notes}</p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};
