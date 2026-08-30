'use client';

import React from 'react';
import { ConflictRecord } from '@/types/incident';

interface ConflictsPanelProps {
  conflicts: ConflictRecord[];
}

export const ConflictsPanel: React.FC<ConflictsPanelProps> = ({ conflicts }) => {
  const openConflicts = conflicts.filter((c) => c.status === 'OPEN');

  if (openConflicts.length === 0) {
    return (
      <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-950/10 text-xs text-emerald-400">
        <span className="font-semibold">✓ No active conflicts detected</span> across recorded observations.
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-950/10 space-y-3" aria-label="Incident conflicts">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2">
          <span>⚠️</span> Conflicting Information ({openConflicts.length})
        </h3>
        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300">
          Requires Verification
        </span>
      </div>

      <div className="space-y-2">
        {openConflicts.map((c) => (
          <div key={c.id} className="p-3 rounded-lg bg-zinc-900/80 border border-rose-500/20 text-xs space-y-1.5">
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
              <p className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/20 p-1.5 rounded">
                💡 <span className="font-semibold">Recommended:</span> {c.recommended_action}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
