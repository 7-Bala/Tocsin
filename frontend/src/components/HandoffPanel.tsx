'use client';

import React, { useState } from 'react';
import { fetchHandoffBrief, speakIntoChannel } from '@/hooks/useIncidentApi';

interface HandoffPanelProps {
  incidentId?: string | null;
}

interface HandoffCounts {
  contradictions: number;
  questions: number;
  actions: number;
  overdue_actions: number;
  unowned_actions: number;
  risks: number;
}

/**
 * Shift-handoff brief.
 *
 * Incident practice documents that a handoff must be both read onto the bridge and
 * written into the incident document — verbal alone is lost, written alone may not be
 * acknowledged. Both forms are generated from the same evidence record here so they
 * cannot drift apart.
 *
 * The spoken script is prepared text. "Broadcast" below calls Agora's documented
 * /speak endpoint (see docs/agora/RESEARCH.md §4/§9) to have an already-running
 * ConvoAI agent read it aloud into the live voice channel — it requires an agent
 * already started via VoiceHUD's "Dispatch AI" for this incident's channel, and
 * fails with a clear error (not a silent no-op) if none is running. This wiring is
 * CREDENTIAL REQUIRED / NOT YET LIVE-VERIFIED: request-building matches Agora's
 * documented schema, but no live session has confirmed audio is actually heard.
 */
export const HandoffPanel: React.FC<HandoffPanelProps> = ({ incidentId }) => {
  const [brief, setBrief] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

  const generate = async () => {
    if (!incidentId) return;
    setLoading(true);
    setError(null);
    try {
      setBrief(await fetchHandoffBrief(incidentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate handoff brief.');
    } finally {
      setLoading(false);
    }
  };

  const copySpoken = async () => {
    if (!brief?.spoken_brief) return;
    try {
      await navigator.clipboard.writeText(brief.spoken_brief);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard unavailable in this browser context.');
    }
  };

  const broadcastSpoken = async () => {
    if (!brief?.spoken_brief || !incidentId) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    try {
      await speakIntoChannel(incidentId, brief.spoken_brief);
      setBroadcastResult('✅ Sent to the live agent — audio delivery not independently confirmed by this UI.');
    } catch (e) {
      setBroadcastResult(
        `⚠️ ${e instanceof Error ? e.message : 'Broadcast failed.'} (Requires an agent already running for this incident’s voice channel — start one via "Dispatch AI" first.)`
      );
    } finally {
      setBroadcasting(false);
    }
  };

  const counts: HandoffCounts | null = brief?.open_item_counts ?? null;
  const sections = brief?.sections;

  return (
    <div
      className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3"
      aria-label="Shift handoff brief"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <span>🔁</span> Shift Handoff Brief
          </h3>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Written record + spoken script from the same evidence, so the two cannot diverge.
          </p>
        </div>
        <button
          onClick={generate}
          disabled={!incidentId || loading}
          className="px-3 py-1.5 rounded text-xs font-medium bg-indigo-700 hover:bg-indigo-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white transition"
        >
          {loading ? 'Generating…' : 'Generate handoff'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-rose-400 bg-rose-950/30 border border-rose-500/20 p-2 rounded">
          {error}
        </p>
      )}

      {!brief && !error && (
        <p className="text-xs text-zinc-500 italic">
          Generate a brief when handing this incident to another commander.
        </p>
      )}

      {brief && counts && (
        <div className="space-y-3">
          {/* Open-item counts: what the incoming shift owns */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
            {/* Tone classes are written out in full: Tailwind cannot resolve
                dynamically-constructed class names like `text-${tone}-400`. */}
            {[
              { label: 'Contradictions', value: counts.contradictions, tone: 'text-rose-400' },
              { label: 'Open questions', value: counts.questions, tone: 'text-amber-400' },
              { label: 'Open actions', value: counts.actions, tone: 'text-sky-400' },
              { label: 'Overdue', value: counts.overdue_actions, tone: 'text-rose-400' },
              { label: 'Unowned', value: counts.unowned_actions, tone: 'text-amber-400' },
              { label: 'Risks', value: counts.risks, tone: 'text-amber-400' },
            ].map((c) => (
              <div
                key={c.label}
                className="p-2 rounded bg-zinc-950/60 border border-zinc-800 text-center"
              >
                <div
                  className={`text-lg font-bold ${c.value === 0 ? 'text-zinc-500' : c.tone}`}
                >
                  {c.value}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                  {c.label}
                </div>
              </div>
            ))}
          </div>

          {/* Spoken script */}
          <div className="p-3 rounded-lg bg-zinc-950/70 border border-indigo-500/20 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-400">
                🎙 Read this onto the bridge
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={copySpoken}
                  className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={broadcastSpoken}
                  disabled={broadcasting}
                  className="text-[11px] px-2 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white border border-indigo-600 disabled:border-zinc-700 transition"
                >
                  {broadcasting ? 'Broadcasting…' : '🔊 Broadcast'}
                </button>
              </div>
            </div>
            <p className="text-xs text-zinc-200 leading-relaxed">{brief.spoken_brief}</p>
            {broadcastResult ? (
              <p className="text-[10px] text-zinc-400">{broadcastResult}</p>
            ) : (
              <p className="text-[10px] text-zinc-500">
                Broadcast requires an agent already running for this incident&apos;s voice channel.
              </p>
            )}
          </div>

          {/* Record quality disclosure */}
          {sections?.record_quality && (
            <p className="text-[11px] text-amber-300/90 bg-amber-950/20 border border-amber-500/20 p-2 rounded">
              <span className="font-semibold">Record quality:</span>{' '}
              {sections.record_quality.caveat}
            </p>
          )}

          {/* Open contradictions detail */}
          {sections?.open_contradictions?.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-rose-400">
                Unresolved contradictions
              </h4>
              {sections.open_contradictions.map((c: any) => (
                <div
                  key={c.conflict_id}
                  className="p-2 rounded bg-zinc-950/50 border border-rose-900/40 text-[11px]"
                >
                  <span className="font-semibold text-zinc-200">{c.entity}</span>
                  <span className="text-zinc-400">
                    {' '}
                    — {c.position_a?.speaker || 'Source A'}: “{c.position_a?.value}” vs{' '}
                    {c.position_b?.speaker || 'Source B'}: “{c.position_b?.value}”
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Ownership */}
          {sections?.ownership?.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-sky-400">
                Who owes what
              </h4>
              {sections.ownership.map((a: any) => (
                <div
                  key={a.action_item_id}
                  className="p-2 rounded bg-zinc-950/50 border border-zinc-800 text-[11px] flex items-start justify-between gap-2"
                >
                  <span className="text-zinc-200">{a.description}</span>
                  <span
                    className={`font-mono whitespace-nowrap ${
                      a.overdue ? 'text-rose-400' : a.unowned ? 'text-amber-400' : 'text-zinc-400'
                    }`}
                  >
                    {a.unowned ? '⚠ UNASSIGNED' : a.owner}
                    {a.overdue ? ' · OVERDUE' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Open questions */}
          {sections?.open_questions?.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-amber-400">
                Nobody has checked
              </h4>
              {sections.open_questions.map((q: any) => (
                <div
                  key={q.missing_info_id}
                  className="p-2 rounded bg-zinc-950/50 border border-amber-900/40 text-[11px] text-zinc-200"
                >
                  {q.description}
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-zinc-500 border-t border-zinc-800 pt-2">
            {brief.ai_disclaimer}
          </p>
        </div>
      )}
    </div>
  );
};
