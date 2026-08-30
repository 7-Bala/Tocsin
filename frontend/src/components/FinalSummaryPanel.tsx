'use client';

import React, { useState } from 'react';
import { requestSpokenSummary, getFinalSummary } from '@/hooks/useIncidentApi';

interface FinalSummaryPanelProps {
  incidentId: string;
  initialSummary?: string | null;
}

export const FinalSummaryPanel: React.FC<FinalSummaryPanelProps> = ({ incidentId, initialSummary }) => {
  const [summary, setSummary] = useState<string | null>(initialSummary || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateSummary = async (type: 'spoken' | 'final') => {
    setLoading(true);
    setError(null);
    try {
      if (type === 'spoken') {
        const res = await requestSpokenSummary(incidentId);
        setSummary(res.content);
      } else {
        const res = await getFinalSummary(incidentId);
        setSummary(res.content);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to generate summary');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3" aria-label="Incident summaries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
          <span>📑</span> Evidence-Bounded Incident Summary
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleGenerateSummary('spoken')}
            disabled={loading}
            className="px-2.5 py-1 text-xs font-semibold rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition disabled:opacity-50"
          >
            {loading ? 'Generating...' : '🔊 Spoken Summary'}
          </button>
          <button
            onClick={() => handleGenerateSummary('final')}
            disabled={loading}
            className="px-2.5 py-1 text-xs font-semibold rounded bg-indigo-600 hover:bg-indigo-500 text-white transition disabled:opacity-50"
          >
            {loading ? 'Generating...' : '📄 Generate Final Report'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-rose-400 bg-rose-950/40 p-2 rounded border border-rose-500/20">{error}</p>}

      {summary ? (
        <div className="p-3.5 rounded-lg bg-zinc-950/80 border border-zinc-800 font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
          {summary}
        </div>
      ) : (
        <p className="text-xs text-zinc-500 italic">
          Click &quot;Spoken Summary&quot; or &quot;Generate Final Report&quot; to synthesize all confirmed facts, open tasks, conflicts, and risks from the database.
        </p>
      )}
    </div>
  );
};
