'use client';

import React from 'react';
import { ActionItem } from '@/types/incident';
import { ClipboardIcon, UserIcon, AlertTriangleIcon, ClockIcon } from '@/components/Icon';

interface ActionItemsPanelProps {
  actionItems: ActionItem[];
}

export const ActionItemsPanel: React.FC<ActionItemsPanelProps> = ({ actionItems }) => {
  if (!actionItems || actionItems.length === 0) {
    return (
      <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-500">
        No active action items assigned.
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3" aria-label="Action items">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
          <ClipboardIcon /> Action Items & Task Ownership ({actionItems.length})
        </h3>
      </div>

      <div className="space-y-2">
        {actionItems.map((item) => {
          const isOverdue = item.status === 'OVERDUE';
          const isComplete = item.status === 'COMPLETE';
          // An action item nobody owns is a silent accountability gap — it should
          // never read the same as one that's simply assigned. Flagged distinctly
          // (amber) rather than folded into the neutral "Owner: X" line, and doesn't
          // wait for the item to also go overdue before it becomes visible.
          const isUnowned = !item.owner_name && !isComplete;

          return (
            <div
              key={item.id}
              className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                isOverdue
                  ? 'border-rose-500/40 bg-rose-950/20 text-rose-200'
                  : isComplete
                  ? 'border-emerald-500/20 bg-emerald-950/10 text-zinc-400 line-through'
                  : isUnowned
                  ? 'border-amber-500/40 bg-amber-950/20 text-zinc-200'
                  : 'border-zinc-800 bg-zinc-900/80 text-zinc-200'
              }`}
            >
              <div className="space-y-1 flex-1 min-w-0">
                <p className="font-medium truncate">{item.description}</p>
                <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <UserIcon /> Owner:{' '}
                    {isUnowned ? (
                      <span className="text-amber-300 font-semibold inline-flex items-center gap-1" title="No owner assigned — nobody is accountable for this item">
                        <AlertTriangleIcon /> Unassigned
                      </span>
                    ) : (
                      <span className="text-zinc-200 font-semibold">{item.owner_name || 'Unassigned'}</span>
                    )}
                  </span>
                  {item.due_at && (
                    <span className="inline-flex items-center gap-1">
                      <ClockIcon /> Due: {new Date(item.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase whitespace-nowrap ${
                    isOverdue
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : isComplete
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  }`}
                >
                  {item.status}
                </span>

                {!isComplete && (
                  <button
                    onClick={() => {
                      import('@/hooks/useIncidentApi').then((api) => {
                        api.completeActionItem(item.incident_id, item.id, 'Verified complete via operator check').catch(() => {});
                      });
                    }}
                    className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 border border-zinc-700 transition"
                    title="Mark task completed"
                  >
                    Complete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
