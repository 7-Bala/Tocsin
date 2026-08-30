'use client';

import React from 'react';
import { Participant } from '@/types/incident';

interface ParticipantsPanelProps {
  participants: Participant[];
}

export const ParticipantsPanel: React.FC<ParticipantsPanelProps> = ({ participants }) => {
  if (!participants || participants.length === 0) {
    return (
      <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-500">
        No participants connected.
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3" aria-label="Incident participants">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
          <span>👥</span> Incident Participants & Roles ({participants.length})
        </h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {participants.map((p) => {
          const isInferred = p.role_source === 'inferred';

          return (
            <div
              key={p.id}
              className="p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/80 text-xs flex items-center justify-between gap-2"
            >
              <div className="space-y-0.5 truncate">
                <div className="font-semibold text-zinc-200 truncate">{p.name}</div>
                <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                  <span className="text-indigo-300 font-mono">{p.role}</span>
                  {isInferred && (
                    <span className="text-[10px] text-amber-400 bg-amber-950/40 px-1 py-0.2 rounded border border-amber-500/20" title="Role inferred from voice discussion">
                      Inferred ({Math.round((p.role_confidence || 0.6) * 100)}%)
                    </span>
                  )}
                  {p.role_source === 'declared' && (
                    <span className="text-[10px] text-zinc-500">Declared</span>
                  )}
                </div>
              </div>

              {p.agora_uid && (
                <span className="text-[10px] font-mono text-zinc-500 bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">
                  UID: {p.agora_uid}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
