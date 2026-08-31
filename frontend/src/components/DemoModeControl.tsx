'use client';

import React, { useState } from 'react';
import { runIdentityOutageDemo, simulateTranscript, checkIncidentReminders } from '@/hooks/useIncidentApi';
import { IncidentState } from '@/types/incident';

interface DemoModeControlProps {
  activeIncidentId: string | null;
  onIncidentUpdated: (state: IncidentState) => void;
}

export const DemoModeControl: React.FC<DemoModeControlProps> = ({
  activeIncidentId,
  onIncidentUpdated,
}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isCheckingReminders, setIsCheckingReminders] = useState(false);
  const [speaker, setSpeaker] = useState('Dave Miller');
  const [role, setRole] = useState('ENGINEER');
  const [transcriptText, setTranscriptText] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleRunDemoScenario = async () => {
    try {
      setIsRunning(true);
      setStatusMessage('Executing deterministic Identity Outage scenario...');
      const res = await runIdentityOutageDemo();
      if (res.state) {
        onIncidentUpdated(res.state);
        setStatusMessage('✅ Identity Outage demo scenario loaded into PostgreSQL & UI!');
      }
    } catch (err: any) {
      setStatusMessage(`❌ Demo execution error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleInjectTranscript = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transcriptText.trim()) return;

    try {
      setIsSimulating(true);
      const incId = activeIncidentId || 'inc-demo-identity-outage';
      await simulateTranscript(incId, {
        speaker,
        speaker_role: role,
        raw_utterance: transcriptText.trim(),
      });
      setTranscriptText('');
      setStatusMessage(`🎙️ Ingested utterance from ${speaker} into canonical pipeline.`);
    } catch (err: any) {
      setStatusMessage(`❌ Ingestion error: ${err.message}`);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleCheckReminders = async () => {
    try {
      setIsCheckingReminders(true);
      const incId = activeIncidentId || 'inc-demo-identity-outage';
      const res = await checkIncidentReminders(incId);
      setStatusMessage(`⏰ Overdue scan complete: ${res.overdue_reminders_emitted} reminders emitted.`);
    } catch (err: any) {
      setStatusMessage(`❌ Reminder scan error: ${err.message}`);
    } finally {
      setIsCheckingReminders(false);
    }
  };

  return (
    <section
      className="p-4 rounded-xl bg-gradient-to-r from-zinc-900/90 via-indigo-950/40 to-zinc-900/90 border border-indigo-500/30 space-y-3"
      aria-label="Demo mode control suite"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300">
            DEMO MODE
          </span>
          <h2 className="text-sm font-semibold text-zinc-100">
            Deterministic Scenario Runner & Voice Ingestion Simulator
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span> Postgres Ready
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-indigo-400"></span> Gemini Optional
          </span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-sky-400"></span> WebSocket Sync
          </span>
        </div>
      </div>

      {/* Control Actions Row */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          onClick={handleRunDemoScenario}
          disabled={isRunning}
          className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white shadow transition flex items-center gap-1.5"
        >
          <span>{isRunning ? '⏳ Executing...' : '⚡ Run Identity Outage Scenario'}</span>
        </button>

        <button
          onClick={handleCheckReminders}
          disabled={isCheckingReminders}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-xs font-medium text-zinc-200 border border-zinc-700 transition flex items-center gap-1.5"
        >
          <span>{isCheckingReminders ? '⏳ Scanning...' : '⏰ Scan Overdue Action Reminders'}</span>
        </button>

        {statusMessage && (
          <span className="text-xs text-zinc-300 italic font-mono bg-zinc-950/70 px-2 py-1 rounded border border-zinc-800">
            {statusMessage}
          </span>
        )}
      </div>

      {/* Manual Voice Transcript Injection Drawer */}
      <form onSubmit={handleInjectTranscript} className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs font-medium text-zinc-400">Simulate Utterance:</span>
        <select
          value={speaker}
          onChange={(e) => {
            setSpeaker(e.target.value);
            if (e.target.value === 'Dave Miller') setRole('ENGINEER');
            else if (e.target.value === 'Priya Sharma') setRole('SUPPORT');
            else if (e.target.value === 'Commander Sarah Chen') setRole('INCIDENT_COMMANDER');
            else if (e.target.value === 'Marcus Vance') setRole('BUSINESS_LEADERSHIP');
          }}
          className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
        >
          <option value="Dave Miller">Dave Miller (Engineer)</option>
          <option value="Priya Sharma">Priya Sharma (Support)</option>
          <option value="Commander Sarah Chen">Commander Sarah Chen (Commander)</option>
          <option value="Marcus Vance">Marcus Vance (Business Lead)</option>
        </select>

        <input
          type="text"
          value={transcriptText}
          onChange={(e) => setTranscriptText(e.target.value)}
          placeholder="e.g. Database connection pool usage dropped back to 35% after restart."
          className="flex-1 min-w-[280px] bg-zinc-950 border border-zinc-800 rounded px-3 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
        />

        <button
          type="submit"
          disabled={isSimulating || !transcriptText.trim()}
          className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-xs font-medium text-zinc-100 transition"
        >
          {isSimulating ? 'Ingesting...' : 'Inject Observation'}
        </button>
      </form>
    </section>
  );
};
