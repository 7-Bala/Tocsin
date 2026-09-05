'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIncidentState } from '@/hooks/useIncidentState';
import { DynamicSituationTiles } from '@/components/DynamicSituationTiles';
import ExcalidrawIncidentMap from '@/components/ExcalidrawIncidentMap';
import {
  approveIncidentAction,
  rejectIncidentAction,
  completeActionItem,
  resolveEvidenceItem,
  getFinalSummary,
  runIdentityOutageDemo,
  createIncident,
  deleteIncident,
  simulateTranscript,
  recordDecision,
  supersedeDecision,
  fetchHandoffBrief,
  speakIntoChannel,
} from '@/hooks/useIncidentApi';
import { startRtmTranscriptSession, RtmTranscriptSession } from '@/lib/agoraRtmTranscripts';
import { decodeAgoraStreamMessage } from '@/lib/agoraStreamDecoder';
import { AGENT_RMS_SPEAKING_THRESHOLD, decideUtteranceAttribution } from '@/lib/echoGuard';
import { TurnSettler } from '@/lib/turnSettler';
import {
  AlertTriangleIcon,
  CheckIcon,
  XIcon,
  ZapIcon,
  ClockIcon,
  MapPinIcon,
  RepeatIcon,
  UsersIcon,
  ScaleIcon,
  Volume2Icon,
  CheckCircleIcon,
  ClipboardIcon,
} from '@/components/Icon';
import { Button } from '@/components/ui/button';
import type { Claim } from '@/types/incident';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * A room id unique to this page load.
 *
 * Doubles as the Agora channel name and the Tocsin incident id (the app treats
 * them as the same string). The date part makes rooms legible in logs and in the
 * database; the random suffix keeps two people opening the app in the same minute
 * from colliding into one another's incident.
 */
/**
 * How long after the agent stops speaking its audio is still treated as possibly
 * bleeding into the microphone. Evaluated when an utterance STARTS (VAD, real
 * time), so it only needs to cover the agent's trailing audio decay -- not
 * Chrome's 1-3s SpeechRecognition finalization lag, which the old result-time
 * check had to absorb by suppressing a full 3 seconds of genuine speech.
 */
const AGENT_ECHO_TAIL_MS = 700;

/**
 * How long RTM's own delivery of the operator's turns stays "proven" before
 * Chrome's local SpeechRecognition is trusted to fill in again. See
 * rtmLastUserTranscriptAtRef for why this exists: RTM and Chrome are two
 * independent ASR engines transcribing the same audio, each internally
 * debounced but never reconciled against each other -- windowed on RTM's own
 * ~2000ms settle cadence (roughly 2.5x it) so a momentary gap between two RTM
 * emissions doesn't wrongly wake Chrome mid-utterance, while a genuine RTM
 * outage still hands off within a few seconds rather than staying dark.
 */
const RTM_USER_TRANSCRIPT_RECENCY_MS = 5000;

function newRoomId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `room-${stamp}-${suffix}`;
}

function estimateDominantFrequency(data: Uint8Array, sampleRate: number, fftSize: number): number {
  if (data.length < 3) return 0;
  const minBin = Math.max(1, Math.floor((70 * fftSize) / sampleRate));
  const maxBin = Math.min(data.length - 2, Math.ceil((1200 * fftSize) / sampleRate));
  let peakBin = minBin;
  let peakValue = 0;
  for (let index = minBin; index <= maxBin; index++) {
    if (data[index] > peakValue) {
      peakValue = data[index];
      peakBin = index;
    }
  }
  if (peakValue < 10) return 0;
  const left = data[peakBin - 1];
  const right = data[peakBin + 1];
  const denominator = left - 2 * data[peakBin] + right;
  const correction = denominator === 0 ? 0 : 0.5 * (left - right) / denominator;
  return ((peakBin + Math.max(-0.5, Math.min(0.5, correction))) * sampleRate) / fftSize;
}

function getTimeDomainBandEnergy(data: Uint8Array | null, bandIndex: number, bandCount: number): number {
  if (!data?.length) return 0;
  const start = Math.floor((bandIndex * data.length) / bandCount);
  const end = Math.max(start + 1, Math.floor(((bandIndex + 1) * data.length) / bandCount));
  let sumSquares = 0;
  for (let index = start; index < end; index++) {
    const sample = (data[index] - 128) / 128;
    sumSquares += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSquares / (end - start)) * 14);
}

function calculateRMS(data: Uint8Array | null): number {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  const len = data.length;
  for (let i = 0; i < len; i++) {
    const normalized = (data[i] - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / len);
}

function approach(current: number, target: number, speed: number, dt: number): number {
  const alpha = 1 - Math.exp(-speed * dt);
  return current + (target - current) * alpha;
}

function getLogFrequencyEnergy(freqData: Uint8Array | null, distFromCenter: number): number {
  if (!freqData || freqData.length === 0) return 0;
  const logFrac = Math.pow(distFromCenter, 1.3);
  const maxBins = Math.min(freqData.length, 120);
  const binIdx = Math.min(maxBins - 1, Math.floor(2 + logFrac * (maxBins - 3)));
  const rawVal = freqData[binIdx] || 0;
  return Math.pow(rawVal / 255, 1.15);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnectionState = 'DISCONNECTED' | 'FETCHING_TOKEN' | 'JOINING' | 'CONNECTED' | 'ERROR';
type VadModelStatus  = 'UNLOADED' | 'LOADING' | 'READY' | 'ERROR';
type AgentStatus     = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
type TranscriptEntry = { id: string; speaker: 'You' | 'AI Agent'; text: string; time: string };

// ─── Component ───────────────────────────────────────────────────────────────

export default function VoiceTestPage() {

  // ── Core session state ─────────────────────────────────────────────────
  // Agora channel names and Tocsin incident IDs are the same string throughout this
  // app: the room *is* the incident. The value starts empty and is filled with a
  // freshly generated room id in the mount effect below -- generating it in this
  // initializer would run once during SSR and again during hydration, producing two
  // different ids for the same render (React hydration mismatch #418/#425).
  const [channelName,        setChannelName]       = useState('');
  const [connectionState,    setConnectionState]   = useState<ConnectionState>('DISCONNECTED');
  const [isMuted,            setIsMuted]           = useState(false);
  const [isSpeaking,         setIsSpeaking]        = useState(false);
  const [aiSpeaking,         setAiSpeaking]        = useState(false);
  const [speechProbability,  setSpeechProbability] = useState(0);
  const [vadStatus,          setVadStatus]         = useState<VadModelStatus>('UNLOADED');
  const [agentStatus,        setAgentStatus]       = useState<AgentStatus>('STOPPED');
  const [agentId,            setAgentId]           = useState<string | null>(null);
  const [selectedVoice,      setSelectedVoice]     = useState('Puck');
  // Pipeline choice, per the hackathon organizers' 2026-09-02 WhatsApp mandate:
  // Agora Conversational AI is required, and composed_tools + Agora-managed
  // OpenAI/Deepgram/MiniMax needs no model API key of ours at all. gemini_live
  // stays the default (lowest latency, unchanged prior behavior); composed_tools
  // is opt-in because it trades that latency for MCP tool-calling support, which
  // gemini_live's mllm pipeline does not offer per Agora's own docs.
  const [voicePipeline,      setVoicePipeline]     = useState<'gemini_live' | 'composed_tools'>('gemini_live');
  // What the *running* agent actually is, per the backend's own start-agent response --
  // not the dropdown selection, which can be changed after dispatch. Read by the RTC
  // join/leave handlers below so their log lines never say "Gemini Live" for an agent
  // that's actually running composed_tools/managed-OpenAI (or vice versa).
  const activeAgentLabelRef = useRef<string>('Voice Agent');
  const [llmVendor,          setLlmVendor]         = useState<'openai' | 'gemini'>('openai');
  const [remoteAgentPresent, setRemoteAgentPresent] = useState(false);
  const [logs,               setLogs]              = useState<string[]>([]);
  const [showSessionLog,     setShowSessionLog]    = useState(false);
  const [suppressedUtteranceCount, setSuppressedUtteranceCount] = useState(0);
  const [tokenDetails,       setTokenDetails]      = useState<{
    uid?: number | string; channel?: string; expiresIn?: number;
  } | null>(null);
  const [isMounted,    setIsMounted]    = useState(false);
  const [currentTime,  setCurrentTime]  = useState<Date | null>(null);
  const [waveStartedAt, setWaveStartedAt] = useState<number | null>(null);

  // ── Transcript state ───────────────────────────────────────────────────
  // No longer rendered as a feed (the left conversation panel was removed),
  // but kept as the underlying record: addTranscriptEntry's last-entry check
  // is a real dedup guard for the observation-ingestion pipeline below, and
  // transcript.length still drives the status-bar utterance count.
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  // ── Real incident state (item 1, step 4 of
  // docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md) ──────────────────────
  // Replaces the old client-side-only `incidentData` simulator (a ~200-line regex
  // function with hardcoded flood/fire/earthquake/cyclone detection patterns,
  // completely disconnected from the real backend evidence engine) with the exact
  // same live incident state the root dashboard (`/`) uses. See
  // frontend/src/hooks/useIncidentState.ts and TODO.md item 1 for the full history.
  // The incident id of the room currently joined, or null when not in one.
  //
  // This is the whole session model: joining a channel creates a brand-new, empty
  // incident and starts gathering evidence into it; leaving purges it. Nothing is
  // loaded on mount and there is no incident picker, because an incident that
  // outlives its conversation shows accumulated evidence that the person looking at
  // the screen never said -- which is indistinguishable from the product making
  // things up. Everything on this page reads from this one id.
  const [sessionIncidentId, setSessionIncidentId] = useState<string | null>(null);

  const {
    activeIncident,
    wsStatus,
    refreshActiveIncident,
    handleIncidentUpdated,
  } = useIncidentState(sessionIncidentId);

  // ── Commander console state (merged in from the root dashboard) ─────────
  // The commander key is held in component state ONLY, never persisted to
  // localStorage and never baked into the bundle -- it is typed per session.
  // See hooks/useIncidentApi.ts DEFAULT_COMMANDER_KEY for why.
  const [commanderKey, setCommanderKey] = useState('');
  const [showCommanderKey, setShowCommanderKey] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  // Bumped on every new error so the shake animation replays even when the
  // same error text repeats (e.g. two wrong-key attempts in a row) -- keying
  // purely on `commandError` wouldn't re-trigger a CSS animation for an
  // unchanged value.
  const [commandErrorKey, setCommandErrorKey] = useState(0);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [finalReport, setFinalReport] = useState<string | null>(null);
  const [isControlsCollapsed, setIsControlsCollapsed] = useState(false);
  const [isDemoRunning, setIsDemoRunning] = useState(false);
  const [demoFeedback, setDemoFeedback] = useState<string | null>(null);

  // ── Ported back from the removed root dashboard (/) ─────────────────────
  // These five had no equivalent anywhere on this page and were flagged
  // rather than silently discarded when / was deleted; kept native to this
  // page's light design system instead of importing the old dark-themed
  // components wholesale.

  // Manual utterance simulator (DemoModeControl) -- types a line as a named
  // role without needing a working microphone.
  const [simSpeaker, setSimSpeaker] = useState('Dave Miller');
  const [simUtterance, setSimUtterance] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const simSpeakerRole = (speaker: string) =>
    speaker === 'Priya Sharma' ? 'SUPPORT'
    : speaker === 'Commander Sarah Chen' ? 'INCIDENT_COMMANDER'
    : speaker === 'Marcus Vance' ? 'BUSINESS_LEADERSHIP'
    : 'ENGINEER';

  // Participants -- no state needed, reads activeIncident.participants directly.

  // Decisions in force (DecisionsPanel)
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [supersedeTarget, setSupersedeTarget] = useState<Claim | null>(null);
  const [decisionEntity, setDecisionEntity] = useState('');
  const [decisionValue, setDecisionValue] = useState('');
  const [decisionRationale, setDecisionRationale] = useState('');
  const [decisionBy, setDecisionBy] = useState('');
  const [isSavingDecision, setIsSavingDecision] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  // Shift handoff brief (HandoffPanel)
  const [handoffBrief, setHandoffBrief] = useState<any | null>(null);
  const [isGeneratingHandoff, setIsGeneratingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [isBroadcastingHandoff, setIsBroadcastingHandoff] = useState(false);
  const [handoffBroadcastResult, setHandoffBroadcastResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Agora / VAD refs ───────────────────────────────────────────────────
  const rtcClientRef       = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const vadInstanceRef     = useRef<any>(null);
  const isMutedRef         = useRef<boolean>(false);
  const rtmSessionRef      = useRef<RtmTranscriptSession | null>(null);

  // ── Robust Speech Detection Gate refs ──────────────────────────────────
  const noiseFloorRef      = useRef<number>(0.006);
  const smoothedUserRmsRef = useRef<number>(0);
  const speakingFramesRef  = useRef<number>(0);
  const quietFramesRef     = useRef<number>(0);
  const vadCandidateRef    = useRef<boolean>(false);
  const vadProbabilityRef  = useRef<number>(0);

  // ── Visualizer bar levels & spatial color refs (20 Dynamic Island segments) ──
  const BAR_COUNT = 20;
  const barLevelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const smoothedLevelsRef = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const barColorsRef = useRef<Array<[number, number, number]>>(
    Array.from({ length: BAR_COUNT }, () => [75, 85, 99])
  );
  const lastTimestampRef = useRef<number>(0);

  // ── DOM meter refs for direct 60fps interpolation ─────────────────────
  const micMeterElRef     = useRef<HTMLDivElement | null>(null);
  const speechFillElRef   = useRef<HTMLDivElement | null>(null);
  const speechValElRef    = useRef<HTMLSpanElement | null>(null);
  const displayedSpeechProbRef = useRef<number>(0);
  const displayedMicLevelRef   = useRef<number>(0);

  // ── Web Audio Analyser refs (User + AI Remote Audio) ───────────────────
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const userAnalyserRef    = useRef<AnalyserNode | null>(null);
  const userTimeDataRef    = useRef<Uint8Array | null>(null);
  const userFreqDataRef    = useRef<Uint8Array | null>(null);
  const userSourceRef      = useRef<MediaStreamAudioSourceNode | null>(null);

  const aiAnalyserRef      = useRef<AnalyserNode | null>(null);
  const aiTimeDataRef      = useRef<Uint8Array | null>(null);
  const aiFreqDataRef      = useRef<Uint8Array | null>(null);
  const aiSourceRef        = useRef<MediaStreamAudioSourceNode | null>(null);
  const aiSmoothedRmsRef   = useRef<number>(0);

  const aiAmpRef           = useRef<number>(0);
  const userAmpRef         = useRef<number>(0);
  const rafRef             = useRef<number>(0);
  const waveformCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const aiSpeakingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef      = useRef<boolean>(false);
  const aiSpeakingRef      = useRef<boolean>(false);
  const isConnectedRef     = useRef<boolean>(false);
  // When the agent last stopped speaking. Used at VAD speech-start time (not at
  // SpeechRecognition result time) to cover the agent's trailing audio still
  // decaying out of the speakers as a new utterance begins.
  const aiSpeechEndedAtRef = useRef<number>(0);

  // Whether the utterance currently being spoken belongs to the operator rather
  // than to the agent's audio leaking back through the microphone. Decided once,
  // in real time, when the VAD detects speech starting -- see onSpeechStart in
  // handleJoin for why the decision cannot be deferred to result-time. Starts
  // true so speech that begins before any agent activity is kept.
  const currentUtteranceIsOperatorRef = useRef<boolean>(true);

  // How many utterances the echo guard has attributed to the agent. Surfaced in
  // the session log so over-suppression is visible within seconds rather than
  // being discovered afterwards in the database -- which is how the 2026-09-04
  // "six lines produced zero observations" bug survived a whole session.
  const suppressedUtteranceCountRef = useRef<number>(0);
  // Tracks the agent-audio falling edge from the analyser, so the echo tail is
  // accurate to an animation frame instead of to the SDK's 2000ms poll.
  const aiAudioWasAudibleRef = useRef<boolean>(false);
  // When agentRms was last seen above threshold, RAW -- independent of the
  // exponential smoothing's attack lag. See echoGuard.ts's
  // AGENT_AUDIO_RECENCY_MS for the race this closes (the agent's own opening
  // greeting was recorded as Operator speech on 2026-09-05). -Infinity means
  // "never observed", which reads as an astronomically large gap and so fails
  // open exactly like a fresh session should.
  const aiLastAudibleAtRef = useRef<number>(-Infinity);

  /**
   * Every ref the echo guard reads, torn down to a clean slate. Call this
   * whenever the agent is definitively gone -- it leaves the RTC channel
   * (`user-left`) or is stopped from this side (`handleStopAgent`) -- so no
   * stale timestamp can outlive the agent that produced it.
   *
   * `user-left` used to reset most of this inline but not `aiSpeechEndedAtRef`
   * or `aiAudioWasAudibleRef`, and `handleStopAgent` reset none of it. Both
   * gaps meant a real "agent recently stopped speaking" timestamp from before
   * the stop could keep suppressing genuine operator speech afterward, since
   * the tail check (echoGuard.ts) only measures elapsed time -- it has no way
   * to tell a fresh timestamp from a stale one on its own. This is what closes
   * that gap, for both exits, in one place.
   */
  const resetEchoGuardState = () => {
    aiAmpRef.current = 0;
    aiSmoothedRmsRef.current = 0;
    aiAudioWasAudibleRef.current = false;
    aiSpeechEndedAtRef.current = 0;
    aiLastAudibleAtRef.current = -Infinity;
    if (aiSourceRef.current) { try { aiSourceRef.current.disconnect(); } catch {} }
    aiSourceRef.current = null;
    aiAnalyserRef.current = null;
    aiTimeDataRef.current = null;
    aiFreqDataRef.current = null;
    if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
  };

  // ── Speech recognition refs ────────────────────────────────────────────
  const speechRecognitionRef       = useRef<any>(null);
  const speechRecognitionActiveRef = useRef<boolean>(false);
  // Chrome delivers `continuous` SpeechRecognition results as discrete, final,
  // NON-overlapping segments (event.resultIndex only exposes new ones) -- there
  // is no growing-partial signal here the way there is on Agora's RTM stream.
  // A ~2s pause mid-sentence is enough for Chrome to finalize a segment and
  // start a fresh one on resumption, so without merging, one spoken sentence
  // with a natural breath becomes several disconnected observations. Verified
  // live 2026-09-05: "Platform team" / "...parts are crosslooping." / "And they
  // are getting" / "...oh, I am killed" -- four rows for one sentence, none of
  // which were growing prefixes of each other, so the backend's prefix-dedup
  // (which only drops a later SHORTER fragment) could not merge them either.
  //
  // Fixed by accumulating consecutive finals into a running buffer and routing
  // that buffer through the same TurnSettler used for the RTM path: each new
  // chunk is appended and re-ingested as the buffer's current full text, so
  // TurnSettler's silence debounce decides the real sentence boundary instead
  // of Chrome's per-segment finalization. A fresh turn key per flushed sentence
  // (localSpeechTurnIdRef) stops two DIFFERENT sentences that happen to share
  // an opening phrase from being misread as one continuing.
  const localSpeechSettlerRef = useRef<TurnSettler | null>(null);
  const localSpeechBufferRef  = useRef<string>('');
  const localSpeechTurnIdRef  = useRef<number>(0);

  // Live-caught 2026-09-05, retest of the fix above: TWO independent paths
  // capture the operator's own voice -- Agora's RTM transcript stream (its own
  // TurnSettler, in agoraRtmTranscripts.ts) AND this file's local Chrome
  // SpeechRecognition settler. Each debounces perfectly within itself, but
  // nothing reconciles the two AGAINST each other, and they are two different
  // ASR engines transcribing the same audio -- "crosslooping" from one,
  // "crash looking" from the other, for the same clause, arriving 1.5s apart.
  // Exact-string dedup (ingestObservation's 8s window) cannot catch that,
  // because the wording genuinely differs.
  //
  // Rather than attempt fuzzy cross-path matching (real risk of the opposite
  // regression: two genuinely different sentences wrongly judged "the same"),
  // Chrome's path is suppressed once RTM has proven THIS SESSION it can
  // deliver the operator's own turns -- Agora's own ASR is the primary source;
  // Chrome is the fallback for when RTM cannot. Windowed, not a one-way latch:
  // if RTM goes quiet for longer than this, Chrome resumes, so a mid-session
  // RTM failure is never silently uncovered by both paths going dark.
  const rtmLastUserTranscriptAtRef = useRef<number>(-Infinity);

  // ── Ref mirrors ────────────────────────────────────────────────────────
  useEffect(() => { isSpeakingRef.current  = isSpeaking;  }, [isSpeaking]);
  useEffect(() => { aiSpeakingRef.current  = aiSpeaking;  }, [aiSpeaking]);
  useEffect(() => { isConnectedRef.current = connectionState === 'CONNECTED'; }, [connectionState]);

  // ── Diagnostic log ─────────────────────────────────────────────────────
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [`[${ts}] ${msg}`, ...prev.slice(0, 49)]);
    // `logs` state has no visible panel on this page today -- mirror to console so
    // live-session diagnosis (RTM login/subscribe/decoder errors) doesn't require
    // reading React state through the DOM.
    console.log(`[voice-test] ${msg}`);
  }, []);

  // A rejected promise nobody attached a .catch()/try-catch to normally prints as
  // "Uncaught (in promise)" in the console and is easy to miss during a live debug
  // session, especially one relying on remote console capture. Live-observed
  // 2026-09-03: RTM login appeared to hang past its own 10s timeout with zero log
  // output either way -- turned out the timeout's rejection *was* firing, but from
  // inside a detached promise chain whose rejection was never awaited by anything,
  // so it surfaced only as a silent unhandled rejection. This makes that class of
  // failure impossible to miss again.
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const reason = event?.reason;
      const detail = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
      addLog(`[Unhandled promise rejection] ${detail}`);
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, [addLog]);

  // Mirrors sessionIncidentId into a ref. The Agora RTM and browser-speech
  // callbacks that feed observations in are registered once at join time and would
  // otherwise close over whatever the id was at that moment.
  const sessionIncidentIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIncidentIdRef.current = sessionIncidentId; }, [sessionIncidentId]);

  // ── Transcript entry ───────────────────────────────────────────────────
  const addTranscriptEntry = useCallback((speaker: 'You' | 'AI Agent', text: string) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setTranscript(prev => {
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.speaker === speaker && last.text === cleanText) return prev;
      }
      return [...prev, { id: Math.random().toString(36).substring(2, 9), speaker, text: cleanText, time }];
    });
  }, []);

  const addTranscriptEntryRef = useRef(addTranscriptEntry);
  useEffect(() => { addTranscriptEntryRef.current = addTranscriptEntry; }, [addTranscriptEntry]);

  // ── Unified Observation Ingestion (Agora RTM + Browser Speech) ───────────
  const recentUtterancesRef = useRef<Map<string, number>>(new Map());

  const ingestObservation = useCallback((speaker: 'You' | 'AI Agent', rawText: string) => {
    const text = rawText.trim();
    if (text.length < 2) return;

    // Deduplicate identical utterances arriving within 8 seconds (e.g. Agora RTM + browser SpeechRecognition)
    const normKey = `${speaker}:${text.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const now = Date.now();
    for (const [k, ts] of recentUtterancesRef.current.entries()) {
      if (now - ts > 8000) recentUtterancesRef.current.delete(k);
    }
    if (recentUtterancesRef.current.has(normKey)) return;
    recentUtterancesRef.current.set(normKey, now);

    addTranscriptEntryRef.current(speaker, text);

    // No session, nowhere to put it. This used to fall back to a hardcoded
    // 'inc-demo-identity-outage' id, which quietly wrote speech from an
    // un-joined page into a long-lived shared incident.
    const incId = sessionIncidentIdRef.current;
    if (!incId) return;

    fetch(`${API_BASE_URL}/api/incidents/${incId}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_utterance: text,
        speaker: speaker === 'AI Agent' ? 'AI Agent' : 'Operator',
        source: speaker === 'AI Agent' ? 'agora_voice_agent' : 'voice_transcript',
      }),
    }).catch((err) => {
      console.warn('[voice-test] Observation ingestion failed:', err);
    });
  }, []);

  const ingestObservationRef = useRef(ingestObservation);
  useEffect(() => { ingestObservationRef.current = ingestObservation; }, [ingestObservation]);

  // ── handleLeave ────────────────────────────────────────────────────────
  const handleLeave = useCallback(async () => {
    if (rtmSessionRef.current) { await rtmSessionRef.current.stop(); rtmSessionRef.current = null; }
    if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
    speechRecognitionActiveRef.current = false;
    if (speechRecognitionRef.current) { try { speechRecognitionRef.current.stop(); } catch {} speechRecognitionRef.current = null; }
    // Flush rather than drop -- the last thing said before leaving is always
    // mid-buffer here, same reasoning as the RTM settler's destroy() below.
    if (localSpeechSettlerRef.current) { localSpeechSettlerRef.current.destroy(); localSpeechSettlerRef.current = null; }
    localSpeechBufferRef.current = '';
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
      userAnalyserRef.current = null; userTimeDataRef.current = null; userFreqDataRef.current = null;
      aiAnalyserRef.current = null;   aiTimeDataRef.current = null;   aiFreqDataRef.current = null;
      userSourceRef.current = null;   aiSourceRef.current = null;
    }
    if (vadInstanceRef.current) {
      try {
        if (typeof vadInstanceRef.current.pause   === 'function') await vadInstanceRef.current.pause();
        if (typeof vadInstanceRef.current.destroy === 'function') await vadInstanceRef.current.destroy();
      } catch (e: any) { addLog(`VAD teardown warning: ${e.message}`); }
      vadInstanceRef.current = null;
    }
    if (localAudioTrackRef.current) { localAudioTrackRef.current.stop(); localAudioTrackRef.current.close(); localAudioTrackRef.current = null; }
    if (rtcClientRef.current) {
      try { await rtcClientRef.current.leave(); } catch (e: any) { addLog(`Leave warning: ${e.message}`); }
      rtcClientRef.current = null;
    }
    setConnectionState('DISCONNECTED');
    setWaveStartedAt(null);
    setVadStatus('UNLOADED');
    setIsSpeaking(false);
    isSpeakingRef.current = false;
    setAiSpeaking(false);
    aiSpeakingRef.current = false;
    setRemoteAgentPresent(false);
    speakingFramesRef.current = 0;
    quietFramesRef.current = 0;
    vadCandidateRef.current = false;
    smoothedUserRmsRef.current = 0;
    // Reset alongside aiSpeakingRef above. Leaving a stale timestamp here meant
    // the next session started inside the previous session's echo tail. This
    // also nulls the analyser/source (previously left dangling on Leave, unlike
    // user-left and handleStopAgent), so a rejoin can never read from audio
    // nodes wired to a room that no longer exists.
    resetEchoGuardState();
    // A new room's RTM session hasn't proven anything yet -- must not inherit
    // "recently proven" from the room just left, or Chrome stays wrongly
    // suppressed for the first seconds of the next session.
    rtmLastUserTranscriptAtRef.current = -Infinity;
    suppressedUtteranceCountRef.current = 0;
    setSuppressedUtteranceCount(0);
    barLevelsRef.current.fill(0);
    smoothedLevelsRef.current.fill(0);
    barColorsRef.current.forEach(c => { c[0] = 75; c[1] = 85; c[2] = 99; });
    displayedSpeechProbRef.current = 0;
    displayedMicLevelRef.current = 0;

    // ── Wipe the incident record this session produced ────────────────────
    // Leaving the room ends the incident. The evidence belonged to this
    // conversation and does not outlive it, so the server-side record is purged
    // and every local panel is emptied. This is irreversible and deliberate: the
    // alternative (the previous behavior, "Dashboard data retained") meant the
    // next person to open the page inherited someone else's accumulated claims,
    // conflicts and action items with nothing marking them as stale.
    const endedIncidentId = sessionIncidentIdRef.current;
    setSessionIncidentId(null);
    sessionIncidentIdRef.current = null;
    setTranscript([]);
    recentUtterancesRef.current.clear();

    if (endedIncidentId) {
      try {
        const result = await deleteIncident(endedIncidentId);
        addLog(
          result.existed
            ? `Left channel. Incident '${endedIncidentId}' and all its evidence were purged.`
            : `Left channel. Nothing to purge for '${endedIncidentId}'.`
        );
      } catch (e: any) {
        // A failed wipe must be stated, not swallowed -- otherwise the record is
        // still on the server while the UI implies it is gone.
        addLog(`Left channel, but purging '${endedIncidentId}' FAILED: ${e.message}`);
      }
    } else {
      addLog('Left voice channel.');
    }
  }, [addLog]);

  // ── Mount effect ───────────────────────────────────────────────────────
  useEffect(() => {
    setIsMounted(true);
    setCurrentTime(new Date());
    // A fresh room id per page load, so "join" can never land in a room that
    // already holds someone else's conversation. Generated here rather than in the
    // useState initializer to keep the first client render byte-identical to the
    // server-rendered HTML.
    setChannelName(newRoomId());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    addLog('Incident room ready. Join a channel to open an incident record.');
    return () => { clearInterval(timer); handleLeave(); };
  }, [addLog, handleLeave]);

  // ── Unified Real Audio-Reactive Analysis & Dynamic Island Renderer ─────
  useEffect(() => {
    const loop = (timestamp: number) => {
      rafRef.current = requestAnimationFrame(loop);
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      const now = timestamp || performance.now();
      const lastTime = lastTimestampRef.current || now;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTimestampRef.current = now;

      // ── Step 1: Read Real User Microphone Audio ──
      let rawUserRms = 0;
      if (userAnalyserRef.current && userTimeDataRef.current) {
        userAnalyserRef.current.getByteTimeDomainData(userTimeDataRef.current as any);
        rawUserRms = calculateRMS(userTimeDataRef.current);
      }
      if (userAnalyserRef.current && userFreqDataRef.current) {
        userAnalyserRef.current.getByteFrequencyData(userFreqDataRef.current as any);
      }

      // ── Step 2: Read Real AI Remote Audio ──
      let rawAiRms = 0;
      if (aiAnalyserRef.current && aiTimeDataRef.current) {
        aiAnalyserRef.current.getByteTimeDomainData(aiTimeDataRef.current as any);
        rawAiRms = calculateRMS(aiTimeDataRef.current);
      }
      if (aiAnalyserRef.current && aiFreqDataRef.current) {
        aiAnalyserRef.current.getByteFrequencyData(aiFreqDataRef.current as any);
      }

      // Agora volume indicators as physical fallback telemetry
      const localTrackVol = Number(localAudioTrackRef.current?.getVolumeLevel?.() || 0);
      const effectiveUserRaw = Math.max(
        rawUserRms,
        localTrackVol * 0.12,
        (userAmpRef.current / 100) * 0.12
      );

      const aiVolLevel = aiAmpRef.current / 100;
      const effectiveAiRaw = Math.max(
        rawAiRms,
        aiSpeakingRef.current ? Math.max(0.02, aiVolLevel * 0.30) : 0
      );

      // ── Step 3: Physical Audio RMS Smoothing (Fast Attack, Smooth Decay) ──
      smoothedUserRmsRef.current = approach(
        smoothedUserRmsRef.current,
        effectiveUserRaw,
        effectiveUserRaw > smoothedUserRmsRef.current ? 42.0 : 8.5,
        dt
      );
      const smoothedUserRms = smoothedUserRmsRef.current;

      aiSmoothedRmsRef.current = approach(
        aiSmoothedRmsRef.current,
        effectiveAiRaw,
        effectiveAiRaw > aiSmoothedRmsRef.current ? 42.0 : 8.5,
        dt
      );
      const smoothedAiRms = aiSmoothedRmsRef.current;

      // Agent-audio falling edge, sampled every frame. This is what makes the
      // echo tail meaningful when RTM delivers no agent state at all: without
      // it, aiSpeechEndedAtRef is only ever written by the RTM callback or by
      // the SDK's 2000ms volume-indicator, and a short agent reply can begin
      // and end entirely between two of those ticks.
      if (aiAnalyserRef.current) {
        const audible = smoothedAiRms > AGENT_RMS_SPEAKING_THRESHOLD;
        if (audible) aiLastAudibleAtRef.current = Date.now();
        if (aiAudioWasAudibleRef.current && !audible) {
          aiSpeechEndedAtRef.current = Date.now();
        }
        aiAudioWasAudibleRef.current = audible;
      }

      // ── Step 4: Calibrated Adaptive Noise Floor ──
      const isQuiet = smoothedUserRms < noiseFloorRef.current * 1.5;
      if (isQuiet && isConnectedRef.current && !isMutedRef.current) {
        noiseFloorRef.current += (smoothedUserRms - noiseFloorRef.current) * (1 - Math.exp(-0.8 * dt));
      }
      noiseFloorRef.current = Math.max(0.003, Math.min(0.035, noiseFloorRef.current));
      const noiseFloor = noiseFloorRef.current;

      // ── Step 5: Speech Gate with Hysteresis (Semantic Speaking State Only) ──
      const SPEECH_ON_THRESHOLD  = Math.max(0.020, noiseFloor * 2.8);
      const SPEECH_OFF_THRESHOLD = Math.max(0.010, noiseFloor * 1.6);
      const SPEECH_ATTACK_FRAMES  = 3;
      const SPEECH_RELEASE_FRAMES = 12;

      if (!isSpeakingRef.current) {
        if (smoothedUserRms > SPEECH_ON_THRESHOLD && !isMutedRef.current && isConnectedRef.current && smoothedAiRms < 0.02) {
          speakingFramesRef.current++;
          if (speakingFramesRef.current >= SPEECH_ATTACK_FRAMES) {
            isSpeakingRef.current = true;
            setIsSpeaking(true);
            quietFramesRef.current = 0;
          }
        } else {
          speakingFramesRef.current = 0;
        }
      } else {
        if (smoothedUserRms < SPEECH_OFF_THRESHOLD || isMutedRef.current || !isConnectedRef.current) {
          quietFramesRef.current++;
          if (quietFramesRef.current >= SPEECH_RELEASE_FRAMES) {
            isSpeakingRef.current = false;
            setIsSpeaking(false);
            speakingFramesRef.current = 0;
          }
        } else {
          quietFramesRef.current = 0;
        }
      }

      // ── Step 6: Dynamic Normalization & Strict Silence Cutoff ──
      const userDynamicRange = 0.080;
      const userEffectiveRms = Math.max(0, smoothedUserRms - noiseFloor);
      const normalizedUser = Math.min(1, Math.max(0, userEffectiveRms / userDynamicRange));
      const userVisualEnergy = normalizedUser < 0.012 ? 0 : Math.pow(normalizedUser, 0.60);

      const aiDynamicRange = 0.090;
      const normalizedAi = Math.min(1, Math.max(0, smoothedAiRms / aiDynamicRange));
      const aiVisualEnergy = normalizedAi < 0.012 ? 0 : Math.pow(normalizedAi, 0.60);

      // ── Step 7: Independent Simultaneous Audio Energy Calculation ──
      const connected = isConnectedRef.current;
      const muted = isMutedRef.current;

      // Effective energies: User audio is 0 if muted/disconnected; AI audio continues if connected
      const userEffectiveEnergy = connected && !muted ? userVisualEnergy : 0;
      const aiEffectiveEnergy = connected ? aiVisualEnergy : 0;

      const uFreq = userFreqDataRef.current;
      const aFreq = aiFreqDataRef.current;

      // ── Step 8: Unified 20-Segment Dual-Energy Waveform Physical Engine ──
      const barLevels = barLevelsRef.current;
      const barColors = barColorsRef.current;
      const smoothedLevels = smoothedLevelsRef.current;

      const BASELINE = 0.06; // Fixed ~1.5px baseline on 24px max canvas height
      const ATTACK_SPEED = 42.0;
      const RELEASE_SPEED = 9.0;

      for (let i = 0; i < BAR_COUNT; i++) {
        const pos = i / (BAR_COUNT - 1); // 0.0 (left: AI) -> 1.0 (right: User)
        const distFromCenter = Math.abs(pos - 0.5) * 2; // 0 at center, 1 at ends

        // Real frequency spectrum harmonics
        const aiFreqVal   = getLogFrequencyEnergy(aFreq, (1.0 - pos) * 0.85 + 0.15);
        const userFreqVal = getLogFrequencyEnergy(uFreq, pos * 0.85 + 0.15);

        // Spatial spread weighting: AI concentrated on left, User on right, smoothly overlapping in center
        const aiSpatialWeight   = Math.pow(1.0 - pos, 0.75) * 0.70 + 0.30;
        const userSpatialWeight = Math.pow(pos, 0.75) * 0.70 + 0.30;

        const aiHeightContribution   = aiEffectiveEnergy * aiSpatialWeight * (0.75 + 0.25 * aiFreqVal);
        const userHeightContribution = userEffectiveEnergy * userSpatialWeight * (0.75 + 0.25 * userFreqVal);

        // Gaussian central arch
        const centerArch = 0.85 + 0.15 * (1.0 - Math.pow(distFromCenter, 1.6));
        const combinedVoiceHeight = Math.max(aiHeightContribution, userHeightContribution) * 0.70 + (aiHeightContribution + userHeightContribution) * 0.30;

        let targetHeight = BASELINE;
        if (connected && (userEffectiveEnergy > 0 || aiEffectiveEnergy > 0)) {
          targetHeight = BASELINE + combinedVoiceHeight * (1.0 - BASELINE) * centerArch;
          targetHeight = Math.min(1.0, Math.max(BASELINE, targetHeight));
        }

        const speed = targetHeight > barLevels[i] ? ATTACK_SPEED : RELEASE_SPEED;
        barLevels[i] = approach(barLevels[i], targetHeight, speed, dt);

        // ── Color Calculation: Continuous Green (AI) -> Warm Yellow (Center) -> Orange (User) ──
        let targetR: number, targetG: number, targetB: number;
        if (!connected) {
          targetR = 75; targetG = 85; targetB = 99; // Disconnected Slate: #4B5563
        } else {
          // Dynamic active palette: Green (#30D158: 48, 209, 88) -> Yellow (#FFD60A: 255, 214, 10) -> Orange (#FF9F0A: 255, 159, 10)
          let activeR: number, activeG: number, activeB: number;
          if (pos <= 0.5) {
            const k = pos / 0.5;
            activeR = 48 + (255 - 48) * k;
            activeG = 209 + (214 - 209) * k;
            activeB = 88 + (10 - 88) * k;
          } else {
            const k = (pos - 0.5) / 0.5;
            activeR = 255;
            activeG = 214 + (159 - 214) * k;
            activeB = 10;
          }

          // In silent/resting state, preserve spatial identity with subtle subdued tones
          const restingR = 45 + 35 * pos;
          const restingG = 85 - 25 * pos;
          const restingB = 60 - 30 * pos;

          const activity = Math.max(
            aiEffectiveEnergy * (1.0 - pos * 0.5),
            userEffectiveEnergy * (0.5 + pos * 0.5)
          );
          const glowFactor = Math.min(1.0, Math.max(0.0, (activity - 0.01) / 0.10));

          targetR = restingR + (activeR - restingR) * (0.35 + 0.65 * glowFactor);
          targetG = restingG + (activeG - restingG) * (0.35 + 0.65 * glowFactor);
          targetB = restingB + (activeB - restingB) * (0.35 + 0.65 * glowFactor);
        }

        barColors[i][0] = approach(barColors[i][0], targetR, 14.0, dt);
        barColors[i][1] = approach(barColors[i][1], targetG, 14.0, dt);
        barColors[i][2] = approach(barColors[i][2], targetB, 14.0, dt);
      }

      // ── Step 9: 3-Point Gaussian Neighbor Smoothing & Crisp High-DPI Canvas ──
      if (waveformCanvasRef.current) {
        const canvas = waveformCanvasRef.current;
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const cssW = 120;
        const cssH = 26;

        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, cssW, cssH);

          // 3-point Gaussian neighbor smoothing across adjacent bars
          for (let i = 0; i < BAR_COUNT; i++) {
            const prev = i > 0 ? barLevels[i - 1] : barLevels[i];
            const curr = barLevels[i];
            const next = i < BAR_COUNT - 1 ? barLevels[i + 1] : barLevels[i];
            smoothedLevels[i] = prev * 0.22 + curr * 0.56 + next * 0.22;
          }

          const barWidth = 2.2;
          const barGap = 2.0;
          const totalWaveWidth = BAR_COUNT * barWidth + (BAR_COUNT - 1) * barGap;
          const startX = Math.round((cssW - totalWaveWidth) / 2);
          const centerY = cssH / 2;

          for (let i = 0; i < BAR_COUNT; i++) {
            const normLevel = smoothedLevels[i];
            const minBarHeight = 1.5;
            const maxBarHeight = 22; // max height inside 26px canvas
            const barHeight = Math.max(minBarHeight, Math.min(maxBarHeight, normLevel * maxBarHeight));

            const x = startX + i * (barWidth + barGap);
            const y = centerY - barHeight / 2;
            const radius = Math.min(barWidth / 2, barHeight / 2);

            const r = Math.round(barColors[i][0]);
            const g = Math.round(barColors[i][1]);
            const b = Math.round(barColors[i][2]);
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(x, y, barWidth, barHeight, radius);
            } else {
              ctx.rect(x, y, barWidth, barHeight);
            }
            ctx.fill();
          }
        }
      }

      // ── Step 10: Smooth Secondary DOM Indicators (Zero React Re-renders) ──
      // Speech confidence meter
      const targetProb = muted ? 0 : vadProbabilityRef.current;
      displayedSpeechProbRef.current = approach(displayedSpeechProbRef.current, targetProb, 14.0, dt);
      if (speechFillElRef.current) {
        speechFillElRef.current.style.width = `${Math.max(0, Math.min(100, displayedSpeechProbRef.current)).toFixed(1)}%`;
      }
      if (speechValElRef.current) {
        speechValElRef.current.textContent = `${Math.round(displayedSpeechProbRef.current)}%`;
      }

      // Live Mic Level meter (12 LED segments)
      const targetMicLevel = connected && !muted ? userVisualEnergy : 0;
      displayedMicLevelRef.current = approach(displayedMicLevelRef.current, targetMicLevel, 20.0, dt);
      if (micMeterElRef.current) {
        const segs = micMeterElRef.current.children;
        const activeCount = Math.round(displayedMicLevelRef.current * segs.length);
        for (let s = 0; s < segs.length; s++) {
          const el = segs[s] as HTMLElement;
          if (s < activeCount) {
            el.style.backgroundColor = s >= 10 ? '#ef4444' : s >= 8 ? '#f59e0b' : '#30d158';
            el.style.opacity = '1';
          } else {
            el.style.backgroundColor = '#e4e4e7';
            el.style.opacity = '0.35';
          }
        }
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── handleJoin ─────────────────────────────────────────────────────────
  const handleJoin = async () => {
    if (!channelName.trim()) { addLog('Error: Channel name cannot be empty.'); return; }
    const roomId = channelName.trim();
    setTranscript([]);
    recentUtterancesRef.current.clear();
    try {
      // ── Open a genuinely empty incident record for this room ────────────
      // Purge first: if this room id was used before (a reload mid-session, or a
      // reused name), its leftovers would otherwise read as evidence from the
      // conversation about to happen. Then create the incident with no title
      // story and no seeded symptoms -- title, severity, status and hypotheses
      // are derived server-side from real claims by incident_derivation.py as
      // people actually speak.
      setConnectionState('FETCHING_TOKEN');
      addLog(`Opening a fresh incident record for '${roomId}'...`);
      await deleteIncident(roomId).catch(() => {
        // Nothing to purge is the normal case for a new room id.
      });
      await createIncident({
        title: 'Untitled Incident — Awaiting Reports',
        event_type: 'TECHNICAL_INCIDENT',
        incident_id: roomId,
      });
      setSessionIncidentId(roomId);
      sessionIncidentIdRef.current = roomId;
      addLog(`Incident '${roomId}' opened. Gathering evidence from this conversation.`);

      addLog(`Requesting RTC token for '${roomId}'...`);
      const randomUid = Math.floor(1000 + Math.random() * 9000);
      const tokenRes  = await fetch(`${API_BASE_URL}/api/agora/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name: channelName.trim(), uid: randomUid, role: 'publisher', expire_seconds: 3600 }),
      });
      if (!tokenRes.ok) throw new Error('Token request failed');
      const { token, app_id, uid } = await tokenRes.json();
      setTokenDetails({ uid, channel: channelName });
      setConnectionState('JOINING');

      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
      const client   = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtcClientRef.current = client;

      const audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      audioCtxRef.current = audioCtx;

      client.on('user-published', async (user: any, mediaType: string) => {
        if (Number(user.uid) === 9999) { setRemoteAgentPresent(true); addLog(`[Agora ConvoAI] ${activeAgentLabelRef.current} (UID 9999) joined.`); }
        await client.subscribe(user, mediaType as 'audio' | 'video');
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
          // Mitigates acoustic echo (agent's own voice looping back into the mic)
          // on built-in laptop mic+speaker setups, where software AEC alone often
          // isn't enough to fully cancel speaker bleed at full volume. This is a
          // mitigation, not a fix -- AEC:true is already set on the mic track
          // below; headphones remain the reliable fix for acoustic feedback.
          if (typeof user.audioTrack.setVolume === 'function') {
            user.audioTrack.setVolume(60);
          }
          // Pipe remote audio track to Web Audio Analyser for real AI audio visualization
          try {
            const mediaStreamTrack = user.audioTrack.getMediaStreamTrack();
            if (mediaStreamTrack && audioCtxRef.current) {
              const remoteStream = new MediaStream([mediaStreamTrack]);
              if (aiSourceRef.current) { try { aiSourceRef.current.disconnect(); } catch {} }
              const remoteSource = audioCtxRef.current.createMediaStreamSource(remoteStream);
              const aiAnalyser = audioCtxRef.current.createAnalyser();
              aiAnalyser.fftSize = 1024;
              aiAnalyser.smoothingTimeConstant = 0.45;
              aiAnalyser.minDecibels = -90;
              aiAnalyser.maxDecibels = -10;
              remoteSource.connect(aiAnalyser);
              aiSourceRef.current = remoteSource;
              aiAnalyserRef.current = aiAnalyser;
              aiTimeDataRef.current = new Uint8Array(aiAnalyser.fftSize);
              aiFreqDataRef.current = new Uint8Array(aiAnalyser.frequencyBinCount);
            }
          } catch (e: any) {
            console.warn('Could not attach remote audio analyser:', e.message);
          }
        }
      });

      client.on('user-left', (user: any) => {
        if (Number(user.uid) === 9999) {
          setRemoteAgentPresent(false); setAgentStatus('STOPPED'); setAiSpeaking(false);
          resetEchoGuardState();
          addLog(`ℹ️ ${activeAgentLabelRef.current} (UID 9999) left the channel.`);
        }
      });

      await client.join(app_id, channelName, token, uid);
      setConnectionState('CONNECTED');
      setWaveStartedAt(Date.now());

      // Primary transcript transport: Agora Signaling (RTM). See
      // docs/agora/RESEARCH.md §5 — backend/app/api/agora.py now sends
      // parameters.data_channel: "rtm" on agent-join, which is what actually
      // selects the transcript transport. Login failure here does not block the
      // voice call; only the "AI Agent" transcript lines below depend on it.
      //
      // RTM identity MUST be the bare stringified RTC uid, not a prefixed label.
      // Live-observed 2026-09-04: RTM login and channel subscribe both succeeded
      // cleanly every time, yet zero transcript messages ever arrived, on either
      // pipeline, even while the agent was audibly speaking (confirmed by tapping
      // the real Web Audio analyser on its RTC track directly). The official
      // agent-client-toolkit's own init() example flags exactly this: RTM_USER_ID
      // "must match the RTM token subject; often String(rtcUid)" -- and its
      // subscribeMessage() doesn't call channel.subscribe() at all, it only
      // registers a message listener, implying Agora delivers transcripts
      // point-to-point to the RTM identity matching the participant's own RTC
      // uid, not as a channel-wide broadcast. `remote_rtc_uids` in the join
      // payload is likewise keyed by bare RTC uid. A prefixed identity like
      // "tocsin-voicetest-<uid>" is simply the wrong mailbox -- the agent would
      // address messages to "<uid>", which nothing was ever logged in as.
      try {
        const rtmUserAccount = String(uid);
        const rtmTokenRes = await fetch(`${API_BASE_URL}/api/agora/rtm-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_account: rtmUserAccount, expire_seconds: 3600 }),
        });
        if (!rtmTokenRes.ok) throw new Error('RTM token request failed');
        const { token: rtmToken } = await rtmTokenRes.json();
        rtmSessionRef.current = await startRtmTranscriptSession({
          appId: app_id,
          rtmToken,
          userAccount: rtmUserAccount,
          channelName,
          // The toolkit attaches to the RTC client we already joined with; it
          // does not create or join one of its own.
          rtcClient: client,
          onEvent: (decoded) => {
            // agoraRtmTranscripts.ts now only calls this once a turn has
            // settled (debounced against Agora's live-growing transcript
            // stream) -- every event here is already final, so there is
            // nothing left to gate on.
            if (!decoded.text) return;
            const speakerLabel: 'You' | 'AI Agent' = decoded.speaker === 'TOCSIN' ? 'AI Agent' : 'You';
            // RTM just proved it can deliver the operator's own turn -- see
            // RTM_USER_TRANSCRIPT_RECENCY_MS. Stamped BEFORE Chrome's own local
            // path can suppress on it, so this utterance's RTM version and
            // Chrome's version of the SAME utterance don't both land if RTM
            // resolves first.
            if (speakerLabel === 'You') rtmLastUserTranscriptAtRef.current = Date.now();
            ingestObservationRef.current(speakerLabel, decoded.text);
          },
          // Primary mic-echo guard signal. AGENT_STATE_CHANGED is pushed over RTM
          // the instant the agent's pipeline state changes -- unlike RTC's
          // volume-indicator below, which is HARD-CODED by the SDK to fire only
          // every 2000ms (confirmed in agora-rtc-sdk-ng's own .d.ts: "reports the
          // volumes every two seconds, regardless of whether there are active
          // speakers"). That fixed 2s granularity is why a short agent reply --
          // e.g. its own greeting, "Tocsin emergency coordinator active, how can
          // I assist" -- was live-observed on 2026-09-04 leaking through
          // Chrome's SpeechRecognition and landing in the evidence record
          // mislabeled as the human Operator: the utterance finished and was
          // finalized by SpeechRecognition before the first volume-indicator
          // tick ever arrived, so aiSpeakingRef.current was still false when the
          // guard below checked it. RTM state pushes are not on a fixed poll, so
          // they arrive fast enough to gate even short utterances. The
          // volume-indicator path stays as a secondary signal for the amplitude
          // meter and as a fallback if RTM state delivery is ever interrupted.
          onAgentState: (state) => {
            addLog(`Agent state: ${state}`);
            const speaking = state === 'speaking';
            aiSpeakingRef.current = speaking;
            setAiSpeaking(speaking);
            if (!speaking) aiSpeechEndedAtRef.current = Date.now();
          },
          onLog: addLog,
        });
      } catch (rtmErr: any) {
        addLog(`RTM transcript session failed to start: ${rtmErr?.message || rtmErr} (voice call continues; AI transcript text may not appear)`);
      }

      client.enableAudioVolumeIndicator();
      client.on('volume-indicator', (volumes: any[]) => {
        let aiVol = 0;
        let userVol = 0;
        volumes.forEach(vol => {
          if (Number(vol.uid) === 9999) aiVol = vol.level;
          if (Number(vol.uid) === Number(uid)) userVol = vol.level;
        });
        aiAmpRef.current = aiVol;
        userAmpRef.current = userVol;
        if (aiVol > 5) {
          if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
          setAiSpeaking(true);
        } else if (!aiSpeakingTimerRef.current) {
          aiSpeakingTimerRef.current = setTimeout(() => {
            setAiSpeaking(false);
            aiAmpRef.current = 0;
            aiSpeakingTimerRef.current = null;
            aiSpeechEndedAtRef.current = Date.now();
          }, 400);
        }
      });

      localAudioTrackRef.current = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard', AEC: true, ANS: true, AGC: false });
      await client.publish([localAudioTrackRef.current]);

      // Analyze the already-published Agora microphone track; do not open a second mic stream.
      try {
        const userAnalyser = audioCtx.createAnalyser();
        userAnalyser.fftSize = 1024;
        userAnalyser.smoothingTimeConstant = 0.45;
        userAnalyser.minDecibels = -90;
        userAnalyser.maxDecibels = -10;
        const localMediaStreamTrack = localAudioTrackRef.current?.getMediaStreamTrack?.();
        if (!localMediaStreamTrack) throw new Error('Agora microphone track is unavailable');
        const localStream = new MediaStream([localMediaStreamTrack]);
        userSourceRef.current = audioCtx.createMediaStreamSource(localStream);
        userSourceRef.current.connect(userAnalyser);
        userAnalyserRef.current = userAnalyser;
        userTimeDataRef.current = new Uint8Array(userAnalyser.fftSize);
        userFreqDataRef.current = new Uint8Array(userAnalyser.frequencyBinCount);
      } catch { addLog('Web Audio setup failed.'); }

      setVadStatus('LOADING');
      const { MicVAD } = await import('@ricky0123/vad-web');
      const myVad = await MicVAD.new({
        baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/', model: 'v5',
        onSpeechStart: () => {
          vadCandidateRef.current = true;
          // Attribute this utterance NOW, while we still know whether the agent
          // is speaking. Chrome finalizes SpeechRecognition results 1-3s after
          // the speech actually ended, so deciding at finalize time (what this
          // used to do) asks the question at the worst possible moment: the
          // agent has typically started replying by then, and the operator's
          // own sentence gets discarded as echo. Each reply pushed the cooldown
          // forward, so in a real back-and-forth every line was dropped and the
          // evidence record stayed empty. VAD fires in real time, so this is
          // the honest point to judge who is talking.
          //
          // The signals are ranked by how fast they can tell us the agent is
          // talking. RTM agent state is fastest but was delivered ZERO times in
          // the 2026-09-05 run, and RTC's volume-indicator is hard-coded by the
          // SDK to a 2000ms poll -- too coarse for a short reply. The analyser
          // on the agent's own remote track updates every animation frame and
          // depends on neither, so it is what actually catches the echo.
          const decision = decideUtteranceAttribution({
            agentRms: aiSmoothedRmsRef.current,
            agentSignalAvailable: aiAnalyserRef.current !== null,
            rtmAgentSpeaking: aiSpeakingRef.current,
            msSinceAgentSpeechEnded: Date.now() - aiSpeechEndedAtRef.current,
            msSinceAgentAudioObserved: Date.now() - aiLastAudibleAtRef.current,
            echoTailMs: AGENT_ECHO_TAIL_MS,
          });
          currentUtteranceIsOperatorRef.current = decision.attributeToOperator;
          if (!decision.attributeToOperator) {
            suppressedUtteranceCountRef.current += 1;
            setSuppressedUtteranceCount(suppressedUtteranceCountRef.current);
            addLog(`Utterance attributed to agent, not recorded — ${decision.reason}`);
          }
        },
        onSpeechEnd:      () => { vadCandidateRef.current = false; },
        onFrameProcessed: (p: any) => {
          const prob = Math.round((p?.isSpeech || 0) * 100);
          vadProbabilityRef.current = prob;
          if (!isMutedRef.current) setSpeechProbability(prob);
        },
      });
      vadInstanceRef.current = myVad; setVadStatus('READY');

      // Legacy/fallback transport — primary transcript delivery is now RTM (above).
      // Kept in case Agora ever delivers over RTC stream-message again.
      client.on('stream-message', (uid: number, data: Uint8Array) => {
        try {
          const raw = new TextDecoder('utf-8').decode(data);
          addLog(`[Stream Message] from UID ${uid} (${data.length} bytes): ${raw.slice(0, 100)}`);
          const decoded = decodeAgoraStreamMessage(uid, data);
          if (decoded && decoded.text) {
            const speakerLabel: 'You' | 'AI Agent' = decoded.speaker === 'TOCSIN' ? 'AI Agent' : 'You';
            ingestObservationRef.current(speakerLabel, decoded.text);
          }
        } catch (err: any) {
          addLog(`[Stream Message error] ${err?.message}`);
        }
      });

      // Debounces Chrome's discrete final segments into one observation per
      // real sentence, the same way TurnSettler already does for Agora's RTM
      // stream. See the ref declarations above for why this exists.
      localSpeechBufferRef.current = '';
      localSpeechTurnIdRef.current = 0;
      localSpeechSettlerRef.current = new TurnSettler({
        stableMs: 2000,
        onSettled: (turn) => {
          const text = turn.text.trim();
          if (text) ingestObservationRef.current('You', text);
          localSpeechBufferRef.current = '';
          localSpeechTurnIdRef.current += 1;
        },
      });

      const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
      if (SpeechRecognitionClass) {
        const rec = new SpeechRecognitionClass();
        rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) continue;
            // Chrome's local SpeechRecognition transcribes whatever the mic
            // picks up -- it cannot distinguish the operator's own voice from
            // the agent's speaker audio leaking back into the mic (common on
            // built-in laptop mic+speaker setups without headphones). Every
            // result from this path is unconditionally labeled 'You' below, so
            // agent speech bleeding into the mic must not reach the evidence
            // record as the operator's own words.
            //
            // The verdict was decided in real time by the VAD's onSpeechStart
            // above, not here. Re-checking aiSpeakingRef at this point (what
            // this code used to do) is unreliable in the one direction that
            // matters: Chrome delivers this callback 1-3s after the speech
            // ended, by which time the agent is usually mid-reply, so genuine
            // operator speech was being thrown away. Live-reported 2026-09-04:
            // a full six-line incident script produced zero observations
            // because every line was suppressed this way.
            if (!currentUtteranceIsOperatorRef.current) continue;
            // RTM has proven itself recently -- its transcription of this same
            // speech is either already on the record or on its way. Chrome's
            // own version would be a second, differently-worded copy of the
            // same sentence, not new information. See RTM_USER_TRANSCRIPT_RECENCY_MS.
            if (Date.now() - rtmLastUserTranscriptAtRef.current < RTM_USER_TRANSCRIPT_RECENCY_MS) continue;
            const chunk = event.results[i][0].transcript.trim();
            if (!chunk) continue;
            // Accumulate rather than ingest directly -- see localSpeechSettlerRef.
            localSpeechBufferRef.current = localSpeechBufferRef.current
              ? `${localSpeechBufferRef.current} ${chunk}`
              : chunk;
            localSpeechSettlerRef.current?.ingest(
              `local:${localSpeechTurnIdRef.current}`,
              localSpeechBufferRef.current,
              false, // never trust Chrome's per-segment "final" as the whole utterance's end
              true,
              'user.transcription'
            );
          }
        };
        rec.onerror = (e: any) => { if (e.error !== 'no-speech' && e.error !== 'aborted') addLog(`[Speech recognition] ${e.error}`); };
        rec.onend   = () => { if (speechRecognitionActiveRef.current) { try { rec.start(); } catch {} } };
        speechRecognitionRef.current = rec; speechRecognitionActiveRef.current = true;
        try { rec.start(); } catch {}
      }
    } catch (err: any) {
      addLog(`Join/VAD Error: ${err.message}`);
      // A failed join means you are not in a room, so the incident record opened
      // moments ago has no conversation behind it. Tear all the way down rather
      // than leaving an empty orphan incident on the server. handleLeave also
      // purges it; setting ERROR afterwards keeps the failure visible.
      await handleLeave();
      setConnectionState('ERROR');
    }
  };

  // ── Other handlers ─────────────────────────────────────────────────────
  const handleToggleMute = () => {
    if (!localAudioTrackRef.current) return;
    const next = !isMuted;
    localAudioTrackRef.current.setEnabled(!next);
    setIsMuted(next);
    isMutedRef.current = next;
    if (next) {
      setIsSpeaking(false);
      isSpeakingRef.current = false;
      speakingFramesRef.current = 0;
      quietFramesRef.current = 0;
      vadCandidateRef.current = false;
    }
  };

  const handleStartAgent = async () => {
    try {
      setAgentStatus('STARTING');
      const res  = await fetch(`${API_BASE_URL}/api/agora/start-agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_name: channelName.trim(),
          agent_uid: 9999,
          // Every official Agora example scopes the agent to an explicit
          // participant uid; this project previously sent none, which made
          // the backend default to a wildcard untested by any first-party
          // reference. Only meaningful once Join Channel has set tokenDetails.
          remote_uid: tokenDetails?.uid,
          voice: selectedVoice,
          voice_pipeline: voicePipeline,
          ...(voicePipeline === 'composed_tools' ? { composed_tools_llm_vendor: llmVendor } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      setAgentId(data.agent_id); setAgentStatus('RUNNING');
      // Report what the backend actually started, not an assumed label — the
      // backend already distinguishes managed-OpenAI from BYOK-Gemini and flags
      // when the requested voice was silently ignored (composed_tools synthesizes
      // via MiniMax, a separate voice_id namespace from the Gemini Live voice enum).
      const providerLabel = data.llm_provider === 'openai'
        ? 'Agora-managed OpenAI'
        : 'Gemini';
      const modeLabel = data.llm_credential_mode === 'managed' ? ' (managed, keyless)' : '';
      addLog(`Agent dispatched — ${data.voice_pipeline}, LLM: ${providerLabel}${modeLabel}`);
      if (data.voice_note) addLog(`ℹ️ ${data.voice_note}`);
      activeAgentLabelRef.current = data.voice_pipeline === 'gemini_live'
        ? 'Gemini Live Agent'
        : `Managed Agent (${providerLabel})`;
    } catch (err: any) { setAgentStatus('ERROR'); addLog(`Agent start failed: ${err.message}`); }
  };

  const handleStopAgent = async () => {
    try {
      setAgentStatus('STOPPING');
      await fetch(`${API_BASE_URL}/api/agora/stop-agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name: channelName.trim(), agent_id: agentId }),
      });
      setAgentStatus('STOPPED'); setAgentId(null); setRemoteAgentPresent(false);
      // Stopping the agent via this REST call and the agent's RTC user actually
      // leaving the channel are two separate events that can land apart in time
      // -- this reset must not wait for `user-left`. Without it, an echo-tail
      // timestamp from just before Stop was clicked could keep suppressing
      // genuine operator speech for up to AGENT_ECHO_TAIL_MS afterward, and any
      // leftover RTM state chatter has nothing fresh to re-arm.
      resetEchoGuardState();
    } catch { setAgentStatus('ERROR'); }
  };

  const handleRunDemo = async () => {
    // Seeds the scripted scenario into the room you are in. Without a room there
    // is no incident to seed, and writing to a fixed demo id would produce an
    // incident nothing on screen is watching.
    if (!sessionIncidentId) {
      addLog('Join a channel first — the demo scenario seeds the current incident record.');
      setDemoFeedback('Join a channel first');
      setTimeout(() => setDemoFeedback(null), 3000);
      return;
    }
    try {
      setIsDemoRunning(true);
      setDemoFeedback('Loading scenario…');
      addLog(`Executing deterministic Identity Outage demo scenario into '${sessionIncidentId}'...`);
      const res = await runIdentityOutageDemo(sessionIncidentId);
      await refreshActiveIncident();
      if (res?.state) {
        addLog('Seeded deterministic Identity Outage demo scenario into PostgreSQL.');
        setDemoFeedback('Scenario loaded');
      } else {
        addLog('Executed identity outage demo scenario.');
        setDemoFeedback('Scenario loaded');
      }
      setTimeout(() => setDemoFeedback(null), 3500);
    } catch (err: any) {
      addLog(`Demo execution error: ${err.message}`);
      setDemoFeedback(`Error: ${err.message}`);
      setTimeout(() => setDemoFeedback(null), 4000);
    } finally {
      setIsDemoRunning(false);
    }
  };

  // Replaces the old handleResetIncident, which cleared the local fake-simulator
  // state (incidentData/tasks/actionStates — all removed, item 1 step 4). There is no
  // honest equivalent of "reset the incident" now that this page shows the real
  // backend record: that would mean deleting real evidence, which this page has no
  // business doing. Clearing the local transcript display is the safe, real action
  // that remains — it does not touch anything server-side.
  const handleClearTranscript = () => {
    setTranscript([]);
    addLog('Transcript display cleared (backend evidence record is unaffected).');
  };

  // ── Commander console handlers ─────────────────────────────────────────
  // Every one of these calls a real backend endpoint and then refreshes the
  // incident from the server rather than optimistically mutating local state:
  // if the server rejects the operation (401 on a bad commander key, 409 on a
  // duplicate approval, 503 when TOCSIN_COMMANDER_KEY is unset) the UI must
  // show the failure, not a success that did not happen.
  const runCommand = useCallback(
    async (id: string, label: string, fn: () => Promise<unknown>) => {
      if (!activeIncident) return;
      setBusyId(id);
      setCommandError(null);
      try {
        await fn();
        await refreshActiveIncident();
        addLog(`${label}`);
      } catch (err: any) {
        const msg = err?.message || 'Request failed';
        setCommandError(msg);
        setCommandErrorKey((k) => k + 1);
        addLog(`${label} failed — ${msg}`);
      } finally {
        setBusyId(null);
      }
    },
    [activeIncident, refreshActiveIncident, addLog]
  );

  const handleApprove = (actionId: string, toolName: string) =>
    runCommand(actionId, `Approved ${toolName}`, () =>
      approveIncidentAction(
        activeIncident!.incident_id,
        actionId,
        { commander_id: 'Voice Room Commander', notes: 'Approved from incident room' },
        commanderKey
      )
    );

  const handleReject = (actionId: string, toolName: string) => {
    const reason = rejectReason.trim();
    if (!reason) {
      setCommandError('A rejection reason is required — rejections are terminal and must be justified.');
      setCommandErrorKey((k) => k + 1);
      return;
    }
    return runCommand(actionId, `Rejected ${toolName}`, async () => {
      await rejectIncidentAction(
        activeIncident!.incident_id,
        actionId,
        { commander_id: 'Voice Room Commander', reason },
        commanderKey
      );
      setRejectingId(null);
      setRejectReason('');
    });
  };

  const handleCompleteItem = (itemId: string) =>
    runCommand(itemId, 'Action item completed', () =>
      completeActionItem(activeIncident!.incident_id, itemId, 'Confirmed complete in incident room')
    );

  const handleResolveConflict = (conflictId: string, notes: string) =>
    runCommand(conflictId, 'Contradiction resolved', () =>
      resolveEvidenceItem(
        activeIncident!.incident_id,
        'conflicts',
        conflictId,
        'Voice Room Commander',
        notes
      )
    );

  const handleGenerateReport = () =>
    runCommand('final-report', 'Final report generated', async () => {
      const res = await getFinalSummary(activeIncident!.incident_id);
      setFinalReport(res.content);
    });

  // ── Ported handlers (manual simulator, decisions, handoff) ──────────────

  const handleSimulateUtterance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simUtterance.trim() || !activeIncident) return;
    setIsSimulating(true);
    try {
      await simulateTranscript(activeIncident.incident_id, {
        speaker: simSpeaker,
        speaker_role: simSpeakerRole(simSpeaker),
        raw_utterance: simUtterance.trim(),
      });
      setSimUtterance('');
      await refreshActiveIncident();
      addLog(`Simulated utterance from ${simSpeaker} ingested.`);
    } catch (err: any) {
      addLog(`Simulate utterance failed: ${err?.message || err}`);
    } finally {
      setIsSimulating(false);
    }
  };

  const resetDecisionForm = () => {
    setShowDecisionForm(false);
    setSupersedeTarget(null);
    setDecisionEntity('');
    setDecisionValue('');
    setDecisionRationale('');
    setDecisionBy('');
    setDecisionError(null);
  };

  const handleSaveDecision = async () => {
    if (!activeIncident) return;
    if (!decisionEntity.trim() || !decisionValue.trim() || !decisionRationale.trim() || !decisionBy.trim()) {
      setDecisionError('All fields are required.');
      return;
    }
    setIsSavingDecision(true);
    setDecisionError(null);
    try {
      const payload = {
        entity: decisionEntity.trim(),
        value: decisionValue.trim(),
        rationale: decisionRationale.trim(),
        decided_by: decisionBy.trim(),
      };
      if (supersedeTarget) {
        await supersedeDecision(activeIncident.incident_id, supersedeTarget.id, payload);
      } else {
        await recordDecision(activeIncident.incident_id, payload);
      }
      resetDecisionForm();
      await refreshActiveIncident();
    } catch (e: any) {
      setDecisionError(e?.message || 'Failed to save decision.');
    } finally {
      setIsSavingDecision(false);
    }
  };

  const handleGenerateHandoff = async () => {
    if (!activeIncident) return;
    setIsGeneratingHandoff(true);
    setHandoffError(null);
    try {
      setHandoffBrief(await fetchHandoffBrief(activeIncident.incident_id));
    } catch (e: any) {
      setHandoffError(e?.message || 'Failed to generate handoff brief.');
    } finally {
      setIsGeneratingHandoff(false);
    }
  };

  const handleCopyHandoff = async () => {
    if (!handoffBrief?.spoken_brief) return;
    try {
      await navigator.clipboard.writeText(handoffBrief.spoken_brief);
      setHandoffCopied(true);
      setTimeout(() => setHandoffCopied(false), 2000);
    } catch {
      setHandoffError('Clipboard unavailable in this browser context.');
    }
  };

  const handleBroadcastHandoff = async () => {
    if (!handoffBrief?.spoken_brief || !activeIncident) return;
    setIsBroadcastingHandoff(true);
    setHandoffBroadcastResult(null);
    try {
      await speakIntoChannel(activeIncident.incident_id, handoffBrief.spoken_brief);
      setHandoffBroadcastResult({ ok: true, message: 'Sent to the live agent — audio delivery not independently confirmed by this UI.' });
    } catch (e: any) {
      setHandoffBroadcastResult({
        ok: false,
        message: `${e?.message || 'Broadcast failed.'} (Requires an agent already running for this incident's voice channel.)`,
      });
    } finally {
      setIsBroadcastingHandoff(false);
    }
  };

  // ── Computed state ─────────────────────────────────────────────────────
  const isConnected  = connectionState === 'CONNECTED';
  const isConnecting = connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING';
  const now = currentTime || new Date();

  const voiceState =
    connectionState === 'ERROR' ? 'error'
    : isConnecting ? 'connecting'
    : connectionState !== 'CONNECTED' ? 'disconnected'
    : isMuted ? 'muted'
    : aiSpeaking ? 'ai-speaking'
    : isSpeaking ? 'user-speaking'
    : 'standby';

  const waveDuration = waveStartedAt ? Math.max(0, Math.floor((Date.now() - waveStartedAt) / 1000)) : 0;
  const waveMinutes = Math.floor(waveDuration / 60);
  const waveSeconds = waveDuration % 60;
  const waveTimeLabel = `${waveMinutes}:${waveSeconds.toString().padStart(2, '0')}`;

  const islandStatusText =
    connectionState === 'ERROR' ? 'Error' :
    isConnecting ? 'Connecting...' :
    connectionState !== 'CONNECTED' ? 'Ready' :
    isMuted ? 'Muted' :
    isSpeaking && aiSpeaking ? 'Active' :
    isSpeaking ? 'You' :
    aiSpeaking ? 'Tocsin' :
    'Connected';

  const islandDotClass =
    connectionState === 'ERROR' ? 'error' :
    isConnecting ? 'connecting' :
    connectionState !== 'CONNECTED' ? 'disconnected' :
    isMuted ? 'muted' :
    isSpeaking && aiSpeaking ? 'active' :
    isSpeaking ? 'user' :
    aiSpeaking ? 'ai' :
    'connected';

  const sevStyle = (sev: string): { bg: string; text: string; border: string } => {
    switch (sev) {
      case 'CRITICAL': return { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' };
      case 'HIGH':     return { bg: '#fffbeb', text: '#d97706', border: '#fde68a' };
      case 'MEDIUM':   return { bg: '#fefce8', text: '#ca8a04', border: '#fde047' };
      case 'LOW':      return { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' };
      default:         return { bg: '#f4f4f5', text: '#71717a', border: '#e4e4e7' };
    }
  };

  // The status chip used to be hardcoded green for every value, so a DEGRADING
  // incident rendered in reassuring green while the record showed services down.
  // Colour has to follow the actual lifecycle state or it is worse than no colour.
  const statusStyle = (s: string): { bg: string; text: string; border: string } => {
    switch (s) {
      case 'DEGRADING':  return { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' };
      case 'RESOLVING':  return { bg: '#fffbeb', text: '#d97706', border: '#fde68a' };
      case 'STABILIZED': return { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' };
      case 'CLOSED':     return { bg: '#f4f4f5', text: '#52525b', border: '#e4e4e7' };
      default:           return { bg: '#f4f4f5', text: '#71717a', border: '#e4e4e7' }; // IDLE
    }
  };

  const actionStatusBadge = (status: string): { bg: string; text: string; border: string; icon: React.ReactNode; iconBg: string } => {
    switch (status) {
      case 'APPROVED':
      case 'VERIFIED':
        return { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', icon: <CheckIcon />, iconBg: '#f0fdf4' };
      case 'REJECTED':
      case 'FAILED':
        return { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', icon: <XIcon />, iconBg: '#fef2f2' };
      case 'EXECUTING':
        return { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe', icon: <ZapIcon />, iconBg: '#eff6ff' };
      case 'PENDING_APPROVAL':
        return { bg: '#eef2ff', text: '#6366f1', border: '#c7d2fe', icon: <ClockIcon />, iconBg: '#eef2ff' };
      default: // PROPOSED
        return { bg: '#f4f4f5', text: '#71717a', border: '#e4e4e7', icon: <MapPinIcon />, iconBg: '#f4f4f5' };
    }
  };

  const Dot = ({ color }: { color: 'green' | 'indigo' | 'gray' | 'red' | 'amber' }) => {
    const c = { green: '#16a34a', indigo: '#6366f1', gray: '#9b9b9b', red: '#dc2626', amber: '#d97706' }[color];
    return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0, marginRight: 5 }} />;
  };

  const connDotColor = connectionState === 'CONNECTED' ? 'green' : connectionState === 'ERROR' ? 'red' : 'gray';
  const agentDotColor = agentStatus === 'RUNNING' || remoteAgentPresent ? 'green' : agentStatus === 'ERROR' ? 'red' : agentStatus === 'STARTING' || agentStatus === 'STOPPING' ? 'amber' : 'gray';
  const vadDotColor = vadStatus === 'READY' ? 'green' : vadStatus === 'ERROR' ? 'red' : vadStatus === 'LOADING' ? 'amber' : 'gray';

  return (
    <>
      <style suppressHydrationWarning>{`
        /* ── Material 3 Design Tokens & Root ── */
        .vcc-root {
          font-family: -apple-system, BlinkMacSystemFont, 'Google Sans Text', 'Google Sans', Roboto, 'Segoe UI', Inter, sans-serif;
          background: #f8fafc;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          color: #0f172a;
          -webkit-font-smoothing: antialiased;
          font-size: 13px;
        }

        /* ── Top bar (Material 3 Small Top App Bar) ── */
        .vcc-topbar {
          height: 50px;
          background: #ffffff;
          border-bottom: 1px solid #e2e8f0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 20px;
          flex-shrink: 0;
          gap: 16px;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        }
        .vcc-topbar-brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13.5px;
          font-weight: 700;
          color: #0f172a;
          letter-spacing: -0.01em;
        }
        .vcc-topbar-badge {
          font-size: 9.5px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 3px;
          background: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .vcc-topbar-center {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11.5px;
          color: #64748b;
          font-weight: 500;
        }
        .vcc-topbar-right {
          display: flex;
          align-items: center;
          gap: 16px;
          font-size: 12px;
          color: #475569;
        }

        /* ── Body layout ── */
        .vcc-body {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 620px;
          min-height: 0;
          overflow: hidden;
        }

        /* ── Panel shared (Material 3 Surfaces) ── */
        .vcc-panel {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .vcc-panel-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .vcc-panel-scroll::-webkit-scrollbar { width: 6px; }
        .vcc-panel-scroll::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.35); border-radius: 9999px; }
        .vcc-panel-scroll::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.6); }
        .vcc-panel-scroll::-webkit-scrollbar-track { background: transparent; }

        .vcc-section-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #64748b;
          margin-bottom: 8px;
          flex-shrink: 0;
        }
        /* Session record status (replaces the old incident switcher) */
        .vcc-session-row {
          display: flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
        }
        .vcc-session-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: #16a34a;
          flex-shrink: 0;
        }
        .vcc-session-dot.idle { background: #cbd5e1; }
        .vcc-session-state {
          font-size: 11.5px;
          font-weight: 600;
          color: #15803d;
        }
        .vcc-session-state.idle { color: #94a3b8; }
        .vcc-session-id {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          color: #475569;
          background: #f1f5f9;
          border: 1px solid #e2e8f0;
          border-radius: 3px;
          padding: 1px 5px;
        }
        .vcc-session-note {
          font-size: 10.5px;
          line-height: 1.45;
          color: #94a3b8;
          margin-top: 5px;
        }
        .vcc-card-sm {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 10px 12px;
        }
        .vcc-card-sm .vcc-section-label { margin-bottom: 6px; }
        .vcc-channel-card { width: 260px; margin-top: 20px; }
        .vcc-input {
          width: 100%;
          padding: 7px 10px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          font-size: 12px;
          color: #0f172a;
          font-family: inherit;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .vcc-input:focus {
          border-color: #0f172a;
          box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.08);
        }
        .vcc-input:disabled { opacity: 0.6; cursor: not-allowed; background: #f8fafc; }
        .vcc-btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }

        /* ── Voice select ── */
        .vcc-select {
          padding: 5px 8px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          font-size: 11.5px;
          color: #0f172a;
          font-family: inherit;
          outline: none;
          transition: border-color 0.15s;
        }
        .vcc-select:focus { border-color: #0f172a; }

        /* ── Center panel (Dynamic Island & Live Graph) ── */
        .vcc-center {
          background: #f1f5f9;
          border-right: 1px solid #e2e8f0;
          display: flex;
          flex-direction: column;
        }
        .vcc-center-inner {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 24px 20px;
          gap: 0;
          overflow-y: auto;
          min-height: 0;
        }
        .vcc-center-inner::-webkit-scrollbar { width: 6px; }
        .vcc-center-inner::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.35); border-radius: 9999px; }
        .vcc-center-inner::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.6); }
        .vcc-center-inner::-webkit-scrollbar-track { background: transparent; }
        .vcc-map-slot {
          width: 100%;
          max-width: 760px;
          margin-bottom: 24px;
          flex-shrink: 0;
        }

        /* ── Centered Interaction Cluster (FAB Mic + Dynamic Island) ── */
        .vcc-interaction-cluster {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin: 0 auto;
          max-width: 100%;
        }

        /* ── Circular Material 3 Floating Mic Button ── */
        .vcc-cluster-mic-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 1px solid #cbd5e1;
          background: #ffffff;
          color: #334155;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
          transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
        }
        .vcc-cluster-mic-btn:hover:not(:disabled) {
          background: #f8fafc;
          border-color: #94a3b8;
          transform: scale(1.04);
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.09);
        }
        .vcc-cluster-mic-btn:active:not(:disabled) {
          transform: scale(0.96);
        }
        .vcc-cluster-mic-btn:focus-visible {
          outline: 2px solid #0f172a;
          outline-offset: 2px;
        }
        .vcc-cluster-mic-btn.active-user {
          color: #ea580c;
          border-color: #f97316;
          background: #fff7ed;
          /* A solid ring reads as "this control is active" without the diffuse
             glow that reads as decorative AI-magic shimmer. */
          box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.16);
        }
        .vcc-cluster-mic-btn.muted {
          color: #dc2626;
          border-color: #ef4444;
          background: #fef2f2;
        }
        .vcc-cluster-mic-btn.disconnected {
          opacity: 0.5;
        }
        .vcc-cluster-mic-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        /* ── Dynamic Island Capsule ── */
        .vcc-dynamic-island {
          width: min(310px, calc(100vw - 32px));
          height: 54px;
          border-radius: 9999px;
          background: #0f172a;
          /* Flat, not floating -- an incident-command surface should feel
             stable, not like an elevated consumer-app call bubble. */
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          box-sizing: border-box;
          user-select: none;
          transition: box-shadow 0.2s ease;
          flex-shrink: 0;
        }
        .vcc-dynamic-island:hover {
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.24);
        }

        .vcc-island-left {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          flex: 1 1 auto;
          overflow: hidden;
        }

        .vcc-island-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          transition: background-color 0.2s ease;
        }
        .vcc-island-dot.connected    { background: #22c55e; }
        .vcc-island-dot.user         { background: #f97316; }
        .vcc-island-dot.ai           { background: #22c55e; }
        .vcc-island-dot.active       { background: #eab308; }
        .vcc-island-dot.muted        { background: #ef4444; }
        .vcc-island-dot.connecting   { background: #eab308; }
        .vcc-island-dot.disconnected { background: #94a3b8; }
        .vcc-island-dot.error        { background: #ef4444; }

        .vcc-island-label {
          font-size: 13px;
          font-weight: 600;
          color: #f8fafc;
          letter-spacing: -0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 0.2s ease;
        }
        .vcc-island-label.connected    { color: #22c55e; }
        .vcc-island-label.user         { color: #f97316; }
        .vcc-island-label.ai           { color: #22c55e; }
        .vcc-island-label.active       { color: #eab308; }
        .vcc-island-label.muted        { color: #ef4444; }
        .vcc-island-label.connecting   { color: #eab308; }
        .vcc-island-label.disconnected { color: #94a3b8; }
        .vcc-island-label.error        { color: #ef4444; }

        .vcc-island-wave {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex: 0 0 120px;
          height: 26px;
        }
        .vcc-island-canvas {
          display: block;
          width: 120px;
          height: 26px;
        }

        /* ── Telemetry & Secondary Controls ── */
        .vcc-island-controls {
          margin-top: 18px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          width: min(320px, calc(100vw - 32px));
        }

        .vcc-island-hint {
          font-size: 11px;
          color: #64748b;
          font-weight: 500;
          text-align: center;
        }

        .vcc-island-meters {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 14px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          box-sizing: border-box;
        }

        .vcc-submeter-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 10px;
          color: #64748b;
        }
        .vcc-submeter-label {
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-size: 8.5px;
          color: #94a3b8;
          min-width: 90px;
        }

        .vcc-submeter-leds {
          display: flex;
          gap: 2.5px;
          align-items: center;
        }
        .vcc-submeter-seg {
          width: 9px;
          height: 4px;
          border-radius: 2px;
          background: #e2e8f0;
          opacity: 0.35;
          transition: background-color 0.08s ease, opacity 0.08s ease;
        }

        .vcc-submeter-track {
          flex: 1;
          height: 3px;
          background: #f1f5f9;
          border-radius: 999px;
          overflow: hidden;
        }
        .vcc-submeter-fill {
          height: 100%;
          border-radius: 999px;
          background: #f97316;
        }
        .vcc-submeter-num {
          font-size: 9.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          width: 24px;
          text-align: right;
          color: #64748b;
        }

        /* ── System status row ── */
        .vcc-sys-status {
          flex-shrink: 0;
          border-top: 1px solid #e2e8f0;
          background: #ffffff;
          padding: 10px 20px;
          display: flex;
          align-items: center;
          gap: 20px;
          flex-wrap: wrap;
        }
        .vcc-sys-item {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: #64748b;
        }
        .vcc-sys-label { font-weight: 600; color: #334155; }

        /* ── Right panel (Material 3 Incident Command Deck) ── */
        .vcc-right {
          background: #f8fafc;
          border-left: 1px solid #e2e8f0;
          min-height: 0;
        }
        .vcc-right-inner {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .vcc-right-inner::-webkit-scrollbar { width: 6px; }
        .vcc-right-inner::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.35); border-radius: 9999px; }
        .vcc-right-inner::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.6); }
        .vcc-right-inner::-webkit-scrollbar-track { background: transparent; }

        /* ── Incident Timeline scroll ── */
        .vcc-tl-scroll {
          max-height: 280px;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 4px;
        }
        .vcc-tl-scroll::-webkit-scrollbar { width: 6px; }
        .vcc-tl-scroll::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.35); border-radius: 9999px; }
        .vcc-tl-scroll::-webkit-scrollbar-thumb:hover { background: rgba(100, 116, 139, 0.6); }
        .vcc-tl-scroll::-webkit-scrollbar-track { background: transparent; }
        .vcc-right-title {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #475569;
          padding-bottom: 4px;
          border-bottom: 1px solid #e2e8f0;
          flex-shrink: 0;
        }

        /* ── Compact Horizontal Control Deck (Material 3 Card) ── */
        .vcc-control-deck {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex-shrink: 0;
        }
        .vcc-deck-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 8px;
          border-bottom: 1px solid #f1f5f9;
        }
        .vcc-deck-title {
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #1e293b;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .vcc-deck-badges {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .vcc-deck-toggle-btn {
          background: #f1f5f9;
          border: 1px solid #e2e8f0;
          border-radius: 3px;
          padding: 2px 8px;
          font-size: 9.5px;
          font-weight: 600;
          color: #475569;
          cursor: pointer;
          transition: all 0.15s ease;
          text-transform: none;
          letter-spacing: normal;
          margin-left: 2px;
        }
        .vcc-deck-toggle-btn:hover {
          background: #e2e8f0;
          color: #0f172a;
        }
        .vcc-deck-content {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .vcc-deck-columns {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 900px) {
          .vcc-deck-columns {
            grid-template-columns: 1fr;
            gap: 8px;
          }
        }
        .vcc-deck-col {
          display: flex;
          flex-direction: column;
          gap: 5px;
          min-width: 0;
        }
        .vcc-deck-label {
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: #64748b;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .vcc-deck-status-txt {
          font-size: 9.5px;
          font-weight: 600;
          color: #475569;
        }
        .vcc-badge-live {
          font-size: 8.5px;
          font-weight: 700;
          color: #15803d;
          background: #dcfce7;
          padding: 1.5px 5px;
          border-radius: 3px;
        }
        .vcc-deck-inline-row {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
        }
        .vcc-input-compact {
          padding: 5px 8px;
          font-size: 11.5px;
          height: 30px;
          box-sizing: border-box;
          border-radius: 8px;
        }
        .vcc-select-compact {
          padding: 4px 7px;
          font-size: 11px;
          height: 30px;
          background: #ffffff;
          border-color: #cbd5e1;
          box-sizing: border-box;
          border-radius: 8px;
          /* Flex items (this and vcc-input-compact) default to min-width: auto,
             which refuses to shrink below content width even with flex-shrink
             set. With three selects in .vcc-deck-inline-row (pipeline, LLM
             vendor when composed_tools is active, voice) plus the Start/Stop
             button, that pushed the button off the visible row entirely once
             the vendor select appeared -- the row's total intrinsic width
             exceeded the container and nothing was actually allowed to
             shrink. min-width: 0 lets these genuinely shrink to fit. */
          min-width: 0;
        }
        .vcc-deck-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding-top: 8px;
          border-top: 1px solid #f1f5f9;
          flex-wrap: wrap;
        }
        .vcc-deck-footer-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .vcc-deck-tool-tag {
          font-size: 9.5px;
          font-weight: 600;
          color: #3f5a74;
          background: #eef2f6;
          border: 1px solid #dbe3ea;
          padding: 2.5px 8px;
          border-radius: 3px;
          white-space: nowrap;
        }
        .vcc-deck-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 9px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 3px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          color: #475569;
        }

        /* ── Incident status card (Material 3 Card) ── */
        .vcc-incident-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 16px;
        }
        .vcc-incident-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .vcc-incident-icon {
          width: 42px; height: 42px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: ${activeIncident ? '#fee2e2' : '#f1f5f9'};
          color: ${activeIncident ? '#dc2626' : '#94a3b8'};
        }
        .vcc-incident-title {
          font-size: 14.5px;
          font-weight: 700;
          color: ${activeIncident ? '#0f172a' : '#94a3b8'};
          margin-bottom: 3px;
          line-height: 1.3;
        }
        .vcc-title-derived {
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.03em;
          color: #7c3aed;
          background: #f5f3ff;
          border: 1px solid #ddd6fe;
          border-radius: 3px;
          padding: 1.5px 7px;
          display: inline-block;
          margin-bottom: 4px;
          cursor: help;
        }
        .vcc-incident-loc {
          font-size: 11.5px;
          color: #64748b;
          display: flex;
          align-items: center;
          gap: 3px;
          margin-bottom: 2px;
        }
        .vcc-incident-id {
          font-size: 10px;
          color: #94a3b8;
          font-family: monospace;
        }
        .vcc-incident-chips {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }
        .vcc-chip-group { display: flex; flex-direction: column; gap: 3px; }
        .vcc-chip-meta  { font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #94a3b8; }
        .vcc-chip {
          display: inline-block;
          padding: 3px 9px;
          border-radius: 3px;
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.03em;
        }
        .vcc-inferred-note {
          font-size: 9.5px;
          color: #94a3b8;
          font-style: italic;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid #f1f5f9;
        }

        /* ── Metrics grid (Material 3 Tonal Containers) ── */
        .vcc-metric-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .vcc-metric-item {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 12px 14px;
          transition: background-color 0.2s ease, border-color 0.2s ease;
        }
        .vcc-metric-label { font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 5px; }
        .vcc-metric-value { font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.1; transition: color 0.2s ease; }
        .vcc-metric-value.placeholder { color: #cbd5e1; }
        .vcc-metric-sub   { font-size: 10px; color: #64748b; margin-top: 3px; }
        .vcc-metric-sub.warn { color: #d97706; font-weight: 600; }
        .vcc-metric-sub.alert { color: #dc2626; font-weight: 600; }

        /* ── Section card (Material 3 Card) ── */
        .vcc-section-card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 16px 18px;
        }

        /* ── Hypotheses ── */
        .vcc-hypo { margin-bottom: 9px; }
        .vcc-hypo:last-child { margin-bottom: 0; }
        .vcc-hypo-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        .vcc-hypo-name { font-size: 11.5px; color: #1e293b; font-weight: 500; }
        .vcc-hypo-pct  { font-size: 11px; font-weight: 600; color: #64748b; }
        .vcc-bar-track { height: 6px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
        .vcc-bar-fill  { height: 100%; background: #0f172a; border-radius: 999px; transition: width 0.6s ease; }

        /* ── Timeline ── */
        .vcc-tl { display: flex; flex-direction: column; }
        .vcc-tl-row { display: flex; gap: 0; align-items: stretch; }
        .vcc-tl-time { font-size: 9.5px; color: #94a3b8; font-weight: 600; white-space: nowrap; width: 44px; flex-shrink: 0; padding-top: 2px; font-variant-numeric: tabular-nums; }
        .vcc-tl-mid  { display: flex; flex-direction: column; align-items: center; width: 16px; flex-shrink: 0; }
        .vcc-tl-dot  { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; }
        .vcc-tl-line { width: 1.5px; background: #e2e8f0; flex: 1; min-height: 12px; margin-top: 3px; }
        .vcc-tl-body { flex: 1; padding-bottom: 10px; padding-left: 6px; }
        .vcc-tl-title { font-size: 11.5px; font-weight: 600; color: #0f172a; line-height: 1.3; }
        .vcc-tl-desc  { font-size: 10px; color: #64748b; margin-top: 1px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }

        /* ── Actions ── */
        .vcc-action-item {
          display: flex;
          flex-direction: column;
          gap: 7px;
          padding: 10px 0;
          border-bottom: 1px solid #f1f5f9;
        }
        .vcc-action-item:last-child { border-bottom: none; padding-bottom: 0; }
        .vcc-action-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .vcc-action-icon { width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; }
        .vcc-action-label { font-size: 12px; font-weight: 500; color: #0f172a; line-height: 1.4; flex: 1; }
        .vcc-action-status-badge {
          font-size: 9.5px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 3px;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .vcc-action-confirmed-note {
          font-size: 10px;
          color: #16a34a;
          font-style: italic;
        }
        .vcc-action-rejected-note {
          font-size: 10px;
          color: #dc2626;
          font-style: italic;
        }

        /* ── Commander panels ── */
        .vcc-count-pill {
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.02em;
          padding: 2px 7px;
          border-radius: 3px;
          background: #f1f5f9;
          color: #475569;
          margin-left: 6px;
          text-transform: none;
        }
        .vcc-count-warn { background: #fef3c7; color: #92600c; }
        .vcc-count-lock { background: #eef2f6; color: #3f5a74; }

        /* Contradictions */
        .vcc-conflict {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 0;
          border-bottom: 1px solid #f1f5f9;
        }
        .vcc-conflict:last-child { border-bottom: none; padding-bottom: 0; }
        .vcc-conflict-entity {
          font-size: 11.5px;
          font-weight: 600;
          color: #0f172a;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .vcc-conflict-state {
          font-size: 8.5px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 3px;
          white-space: nowrap;
        }
        .vcc-conflict-state.warn { background: #fef3c7; color: #b45309; }
        .vcc-conflict-state.ok   { background: #dcfce7; color: #15803d; }
        .vcc-conflict-sides {
          display: flex;
          align-items: stretch;
          gap: 8px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 8px 10px;
        }
        .vcc-conflict-side { flex: 1; min-width: 0; }
        .vcc-conflict-src {
          font-size: 9.5px;
          font-weight: 600;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin-bottom: 2px;
        }
        .vcc-conflict-val { font-size: 11px; color: #1e293b; line-height: 1.35; }
        .vcc-conflict-vs {
          font-size: 9px;
          font-weight: 700;
          color: #94a3b8;
          align-self: center;
          flex-shrink: 0;
        }
        .vcc-conflict-rec { font-size: 10px; color: #64748b; font-style: italic; }

        /* Action items — Notion-style checklist */
        .vcc-todo-group { display: flex; flex-direction: column; }
        .vcc-todo-group-done {
          margin-top: 6px;
          padding-top: 6px;
          border-top: 1px solid #f1f5f9;
        }
        .vcc-todo-group-label {
          font-size: 10px;
          font-weight: 600;
          color: #94a3b8;
          margin-bottom: 2px;
        }
        .vcc-todo-row {
          display: flex;
          align-items: flex-start;
          gap: 9px;
          padding: 6px 4px;
          border-radius: 5px;
          transition: background-color 0.12s ease;
        }
        .vcc-todo-row:hover { background: #f8fafc; }
        .vcc-todo-checkbox {
          appearance: none;
          -webkit-appearance: none;
          flex-shrink: 0;
          width: 16px;
          height: 16px;
          margin-top: 1.5px;
          border-radius: 4px;
          border: 1.5px solid #cbd5e1;
          background: #ffffff;
          cursor: pointer;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #ffffff;
          transition: background-color 0.12s ease, border-color 0.12s ease;
        }
        /* :not(.checked) is load-bearing. Without it this rule (specificity 0,3,0 --
           class + :hover + :not) outranks .vcc-todo-checkbox.checked (0,2,0) and
           repaints an already-completed item's dark fill with the light hover
           background, so hovering a checked box made it look unchecked. Same
           specificity trap as the earlier .vcc-btn hover bug: a shared base-class
           :hover silently overriding a state variant that never restates the
           property on its own :hover. */
        .vcc-todo-checkbox:hover:not(:disabled):not(.checked) { border-color: #94a3b8; background: #f8fafc; }
        .vcc-todo-checkbox:disabled { opacity: 0.5; cursor: not-allowed; }
        .vcc-todo-checkbox.checked {
          background: #0f172a;
          border-color: #0f172a;
          cursor: default;
        }
        .vcc-todo-body { flex: 1; min-width: 0; }
        .vcc-todo-desc { font-size: 11.5px; color: #1e293b; line-height: 1.4; }
        .vcc-todo-desc.done { text-decoration: line-through; color: #94a3b8; }
        .vcc-todo-meta {
          font-size: 10px;
          color: #94a3b8;
          margin-top: 1px;
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .vcc-todo-overdue { color: #b91c1c; font-weight: 600; }

        /* Risks */
        .vcc-risk {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 7px 0;
          border-bottom: 1px solid #f1f5f9;
        }
        .vcc-risk:last-child { border-bottom: none; padding-bottom: 0; }
        .vcc-risk-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: #f59e0b;
          flex-shrink: 0;
          margin-top: 5px;
        }
        .vcc-risk-text { flex: 1; font-size: 11.5px; color: #1e293b; line-height: 1.4; }
        .vcc-risk-sev {
          font-size: 8.5px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 3px;
          background: #fee2e2;
          color: #dc2626;
          flex-shrink: 0;
        }

        /* Commander key + errors */
        .vcc-cmd-key { margin-bottom: 8px; }
        .vcc-key-show-toggle {
          display: flex;
          align-items: center;
          gap: 5px;
          margin-top: 6px;
          font-size: 10.5px;
          color: #64748b;
          cursor: pointer;
          user-select: none;
        }
        .vcc-key-show-toggle input[type='checkbox'] {
          width: 13px;
          height: 13px;
          margin: 0;
          accent-color: #6366f1;
          cursor: pointer;
        }
        .vcc-key-hint { font-size: 9.5px; color: #64748b; margin: 4px 0 0; line-height: 1.4; }
        .vcc-key-hint code { font-size: 9px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; color: #334155; }

        /* Error slot: animates open/closed via grid-template-rows rather than
           mount/unmount, so the panel below never jumps -- an instant
           appear/disappear next to a key you're actively editing is exactly
           what reads as "glitchy" rather than as a deliberate response. */
        .vcc-cmd-error-slot {
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          transition: grid-template-rows 0.22s ease, opacity 0.18s ease;
        }
        .vcc-cmd-error-slot.open { grid-template-rows: 1fr; opacity: 1; margin-bottom: 8px; }
        .vcc-cmd-error-slot > .vcc-cmd-error { overflow: hidden; }
        .vcc-cmd-error {
          display: flex;
          align-items: flex-start;
          gap: 5px;
          font-size: 10.5px;
          font-weight: 600;
          color: #b91c1c;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 6px;
          padding: 7px 9px;
          line-height: 1.4;
          animation: vcc-error-shake 0.32s ease;
        }
        @keyframes vcc-error-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-4px); }
          40% { transform: translateX(3px); }
          60% { transform: translateX(-2px); }
          80% { transform: translateX(1px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vcc-cmd-error { animation: none; }
          .vcc-cmd-error-slot { transition: none; }
        }
        .vcc-reject-box { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }

        /* Final report */
        .vcc-report {
          margin: 10px 0 0;
          padding: 10px 12px;
          background: #fafafa;
          border: 1px solid #f0f0f0;
          border-radius: 7px;
          font-size: 10.5px;
          line-height: 1.55;
          color: #2a2a2a;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 260px;
          overflow-y: auto;
          font-family: inherit;
        }

        /* ── Status bar (footer) ── */
        .vcc-statusbar {
          height: 28px;
          background: #fafaf9;
          border-top: 1px solid #e5e5e5;
          display: flex;
          align-items: center;
          gap: 20px;
          padding: 0 20px;
          font-size: 10.5px;
          color: #b0b0b0;
          flex-shrink: 0;
        }

        /* Session log — deliberately quiet: same muted palette as the status
           bar it hangs off, so it reads as instrumentation rather than as part
           of the incident record. */
        .vcc-log-toggle {
          margin-left: auto;
          background: none;
          border: none;
          padding: 0;
          font: inherit;
          color: #b0b0b0;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .vcc-log-toggle:hover { color: #737373; }
        .vcc-log-badge {
          background: #fef3c7;
          color: #92400e;
          border-radius: 9999px;
          padding: 1px 7px;
          font-size: 10px;
        }
        .vcc-log-panel {
          max-height: 168px;
          overflow-y: auto;
          background: #fafaf9;
          border-top: 1px solid #e5e5e5;
          padding: 8px 20px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10.5px;
          line-height: 1.6;
          color: #737373;
          flex-shrink: 0;
        }
        .vcc-log-line { white-space: pre-wrap; word-break: break-word; }
        .vcc-log-empty { color: #b0b0b0; font-style: italic; }

        /* ── Utility: empty state ── */
        .vcc-empty {
          font-size: 11.5px;
          color: #b0b0b0;
          font-style: italic;
          padding: 6px 0;
        }

        /* ── Pulse dot (topbar) ── */
        .vcc-sys-dot {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: #16a34a;
          animation: vcc-blink 2.5s ease-in-out infinite;
        }
        @keyframes vcc-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

        /* ── Responsive ── */
        @media (max-width: 1280px) {
          .vcc-body { grid-template-columns: 1fr 520px; }
        }
        @media (max-width: 1024px) {
          .vcc-body { grid-template-columns: 1fr 420px; }
          .vcc-right-inner { padding: 12px; }
        }
        @media (max-width: 900px) {
          .vcc-body {
            grid-template-columns: 1fr;
            grid-template-rows: auto auto;
            overflow-y: auto;
          }
          .vcc-panel { height: auto; }
          .vcc-center { border-right: none; border-bottom: 1px solid #e5e5e5; }
          .vcc-right { border-left: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .vcc-dynamic-island { transition: none !important; }
          .vcc-island-dot { transition: none !important; }
          .vcc-sys-dot    { animation: none !important; }
          @keyframes vcc-blink {}
        }

      `}</style>

      <div className="vcc-root">

        {/* ═══════════════════════════════════════ TOP BAR ═══════════════════════════════════════ */}
        <header className="vcc-topbar">
          <div className="vcc-topbar-brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            TOCSIN
            <span className="vcc-topbar-badge">Incident Intelligence</span>
          </div>

          <div className="vcc-topbar-center">
            <span className="vcc-sys-dot" />
            System Online
            {isConnected && <span style={{ marginLeft: 10, color: '#16a34a', fontWeight: 600 }}>● Voice Connected</span>}
            {connectionState === 'ERROR' && <span style={{ marginLeft: 10, color: '#dc2626', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangleIcon /> Connection Error</span>}
          </div>

          <div className="vcc-topbar-right">
            {isMounted && (
              <>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span style={{ color: '#9b9b9b' }}>
                  {now.getDate()} {now.toLocaleString('default', { month: 'short' })} {now.getFullYear()}
                </span>
              </>
            )}
          </div>
        </header>

        {/* ═══════════════════════════════════════ BODY ═══════════════════════════════════════ */}
        <div className="vcc-body">

          {/* ════════════════════ CENTER PANEL (DYNAMIC ISLAND CALL UI) ════════════════════ */}
          <main className="vcc-panel vcc-center" role="main">
            <div className="vcc-center-inner">

              {/* ── Live Incident Whiteboard (Excalidraw) ──
                  Moved above the mic/dynamic-island cluster so the evidence
                  map is the first thing in view. Redraws itself from the
                  evidence record over the same WebSocket that feeds every
                  other panel — no refresh, no manual arranging, and nothing
                  on it that a person in the room didn't actually say. See
                  ExcalidrawIncidentMap.tsx. */}
              <div className="vcc-map-slot">
                <ExcalidrawIncidentMap incident={activeIncident} />
              </div>

              {/* ── Centered Interaction Cluster (42px Mic + 12px Gap + 310px Dynamic Island) ── */}
              <div className="vcc-interaction-cluster" role="region" aria-label="Voice interaction control and visualizer">
                {/* Standalone 42px Circular Mic Button */}
                <button
                  className={`vcc-cluster-mic-btn ${
                    isMuted ? 'muted' :
                    !isConnected ? 'disconnected' :
                    isSpeaking ? 'active-user' : ''
                  }`}
                  onClick={isConnected ? handleToggleMute : handleJoin}
                  disabled={connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING'}
                  aria-label={!isConnected ? 'Connect to voice channel' : isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  title={!isConnected ? 'Connect to voice' : isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {isMuted ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="1" y1="1" x2="23" y2="23"/>
                      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
                      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/>
                      <line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"/>
                      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                  )}
                </button>

                {/* 310px Pure Black Dynamic Island Capsule */}
                <div className="vcc-dynamic-island" aria-label="Dynamic island call visualizer">
                  {/* Left: Status Dot & Concise Label */}
                  <div className="vcc-island-left">
                    <span className={`vcc-island-dot ${islandDotClass}`} aria-hidden="true" />
                    <span className={`vcc-island-label ${islandDotClass}`}>
                      {islandStatusText}
                    </span>
                  </div>

                  {/* Right: Unified 20-Segment Dual-Energy Waveform Canvas */}
                  <div className="vcc-island-wave">
                    <canvas
                      ref={waveformCanvasRef}
                      className="vcc-island-canvas"
                      width={120}
                      height={26}
                      aria-label="Real-time voice dynamic island audio waveform"
                    />
                  </div>
                </div>
              </div>

              {/* ── Minimal Secondary Controls & Telemetry Below Island ── */}
              <div className="vcc-island-controls">
                <div className="vcc-island-hint">
                  {!isConnected ? 'Tap microphone or join channel to start' : isMuted ? 'Microphone muted (tap mic to unmute)' : isSpeaking ? 'Field operator voice active' : aiSpeaking ? 'Tocsin AI responding' : 'Microphone active · Ready'}
                </div>

                {/* Secondary Meters (Fluid VAD & Mic Level) */}
                {isConnected && (
                  <div className="vcc-island-meters">
                    {/* Live Mic Level */}
                    <div className="vcc-submeter-row">
                      <span className="vcc-submeter-label">Mic Level</span>
                      <div ref={micMeterElRef} className="vcc-submeter-leds" aria-label="Microphone input level">
                        {Array.from({ length: 12 }).map((_, idx) => (
                          <div key={idx} className="vcc-submeter-seg" />
                        ))}
                      </div>
                    </div>

                    {/* VAD Speech Detection Probability */}
                    {vadStatus === 'READY' && (
                      <div className="vcc-submeter-row">
                        <span className="vcc-submeter-label">Speech Confidence</span>
                        <div className="vcc-submeter-track" role="progressbar" aria-label="Voice activity confidence">
                          <div ref={speechFillElRef} className="vcc-submeter-fill" style={{ width: '0%' }} />
                        </div>
                        <span ref={speechValElRef} className="vcc-submeter-num">
                          0%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* System status footer */}
            <div className="vcc-sys-status" role="status" aria-label="System status">
              <div className="vcc-sys-item"><span className="vcc-sys-label">Voice</span><Dot color={connDotColor} />{connectionState === 'CONNECTED' ? 'Connected' : connectionState === 'ERROR' ? 'Error' : 'Offline'}</div>
              <div className="vcc-sys-item"><span className="vcc-sys-label">Agent</span><Dot color={agentDotColor} />{agentStatus === 'RUNNING' || remoteAgentPresent ? 'Active' : agentStatus === 'STARTING' ? 'Starting' : agentStatus === 'STOPPING' ? 'Stopping' : agentStatus === 'ERROR' ? 'Error' : 'Stopped'}</div>
              <div className="vcc-sys-item"><span className="vcc-sys-label">VAD</span><Dot color={vadDotColor} />{vadStatus}</div>
              {tokenDetails?.uid && <div className="vcc-sys-item"><span className="vcc-sys-label">UID</span>#{tokenDetails.uid}</div>}
            </div>
          </main>

          {/* ════════════════════ RIGHT PANEL ════════════════════ */}
          <aside className="vcc-panel vcc-right">
            <div className="vcc-panel-scroll">
              <div className="vcc-right-inner">
                <div className="vcc-right-title">Incident Command &amp; Controls</div>

                {/* ── Session record status ──
                    Replaces the old incident switcher + creation form. There is
                    nothing to pick between: the room you joined is the incident,
                    and it lives only as long as the session. */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">Incident Record</div>
                  {sessionIncidentId ? (
                    <div className="vcc-session-live">
                      <div className="vcc-session-row">
                        <span className="vcc-session-dot" />
                        <span className="vcc-session-state">Recording</span>
                        <code className="vcc-session-id">{sessionIncidentId}</code>
                      </div>
                      <div className="vcc-session-note">
                        Opened empty on join. Everything below was derived from this
                        conversation, and is erased when you leave the channel.
                      </div>
                    </div>
                  ) : (
                    <div className="vcc-session-idle">
                      <div className="vcc-session-row">
                        <span className="vcc-session-dot idle" />
                        <span className="vcc-session-state idle">No active record</span>
                      </div>
                      <div className="vcc-session-note">
                        Join the channel to open a fresh incident record. Nothing is
                        tracked until then.
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Integrated Startup & Agent Control Deck ── */}
                <div className="vcc-control-deck">
                  <div className="vcc-deck-header">
                    <div className="vcc-deck-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="21" x2="4" y2="14"/>
                        <line x1="4" y1="10" x2="4" y2="3"/>
                        <line x1="12" y1="21" x2="12" y2="12"/>
                        <line x1="12" y1="8" x2="12" y2="3"/>
                        <line x1="20" y1="21" x2="20" y2="16"/>
                        <line x1="20" y1="12" x2="20" y2="3"/>
                        <line x1="1" y1="14" x2="7" y2="14"/>
                        <line x1="9" y1="8" x2="15" y2="8"/>
                        <line x1="17" y1="16" x2="23" y2="16"/>
                      </svg>
                      Room &amp; Agent Controls
                      <button
                        className="vcc-deck-toggle-btn"
                        onClick={() => setIsControlsCollapsed(!isControlsCollapsed)}
                        aria-label={isControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
                      >
                        {isControlsCollapsed ? '+ Expand' : '− Collapse'}
                      </button>
                    </div>
                    <div className="vcc-deck-badges">
                      <span className="vcc-deck-pill">
                        <Dot color={connDotColor} />
                        {connectionState === 'CONNECTED' ? 'Voice Active' : connectionState === 'ERROR' ? 'Voice Error' : 'Voice Offline'}
                      </span>
                      <span className="vcc-deck-pill">
                        <Dot color={agentDotColor} />
                        {agentStatus === 'RUNNING' || remoteAgentPresent ? 'Agent Live' : agentStatus === 'STARTING' ? 'Starting' : 'Agent Idle'}
                      </span>
                    </div>
                  </div>

                  {!isControlsCollapsed && (
                    <div className="vcc-deck-content">
                      {/* 2-Column Horizontal Split */}
                      <div className="vcc-deck-columns">
                        {/* Column 1: Voice Channel */}
                        <div className="vcc-deck-col">
                          <div className="vcc-deck-label">
                            <span>Voice Channel</span>
                            {isConnected && <span className="vcc-badge-live">CONNECTED</span>}
                          </div>
                          <div className="vcc-deck-inline-row">
                            <input
                              id="channel-input"
                              type="text"
                              className="vcc-input vcc-input-compact"
                              value={channelName}
                              onChange={e => setChannelName(e.target.value)}
                              disabled={connectionState !== 'DISCONNECTED' && connectionState !== 'ERROR'}
                              placeholder="channel-name"
                              aria-label="Voice channel name"
                              style={{ flex: 1 }}
                            />
                            {!isConnected ? (
                              <Button
                                size="compact"
                                variant={isConnecting ? 'outline' : 'default'}
                                onClick={handleJoin}
                                disabled={isConnecting}
                                aria-label="Join voice channel"
                              >
                                {connectionState === 'FETCHING_TOKEN' ? 'Auth…' : connectionState === 'JOINING' ? 'Connecting…' : 'Join'}
                              </Button>
                            ) : (
                              <Button
                                size="compact"
                                variant="destructive"
                                onClick={handleLeave}
                                aria-label="Leave voice channel"
                              >
                                Leave
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Column 2: Conversational Agent */}
                        <div className="vcc-deck-col">
                          <div className="vcc-deck-label">
                            <span>Conversational Agent</span>
                            <span className="vcc-deck-status-txt">
                              {agentStatus === 'RUNNING' || remoteAgentPresent ? '● Active' : agentStatus === 'STARTING' ? '◌ Starting' : '○ Stopped'}
                            </span>
                          </div>
                          <div className="vcc-deck-inline-row">
                            <select
                              className="vcc-select vcc-select-compact"
                              value={voicePipeline}
                              onChange={e => setVoicePipeline(e.target.value as 'gemini_live' | 'composed_tools')}
                              disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}
                              aria-label="Select conversational pipeline"
                              title="gemini_live: lowest latency. composed_tools: supports MCP tools."
                              style={{ flex: 1.2 }}
                            >
                              <option value="gemini_live">Gemini Live</option>
                              <option value="composed_tools">Managed Tools</option>
                            </select>
                            {voicePipeline === 'composed_tools' && (
                              <select
                                className="vcc-select vcc-select-compact"
                                value={llmVendor}
                                onChange={e => setLlmVendor(e.target.value as 'openai' | 'gemini')}
                                disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}
                                aria-label="Select LLM vendor"
                                style={{ flex: 0.9 }}
                              >
                                <option value="openai">OpenAI</option>
                                <option value="gemini">Gemini</option>
                              </select>
                            )}
                            <select
                              className="vcc-select vcc-select-compact"
                              value={selectedVoice}
                              onChange={e => setSelectedVoice(e.target.value)}
                              disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING' || voicePipeline === 'composed_tools'}
                              aria-label="Select agent voice"
                              style={{ flex: 0.9 }}
                            >
                              <option value="Puck">Puck</option>
                              <option value="Charon">Charon</option>
                              <option value="Aoede">Aoede</option>
                              <option value="Fenrir">Fenrir</option>
                              <option value="Kore">Kore</option>
                            </select>
                            {agentStatus === 'RUNNING' || remoteAgentPresent ? (
                              <Button
                                size="compact"
                                variant="destructive"
                                onClick={handleStopAgent}
                                disabled={agentStatus === 'STOPPING'}
                                style={{ flexShrink: 0 }}
                              >
                                {agentStatus === 'STOPPING' ? 'Stopping…' : '■ Stop'}
                              </Button>
                            ) : (
                              <Button
                                size="compact"
                                variant={agentStatus === 'STARTING' ? 'outline' : 'confirm'}
                                onClick={handleStartAgent}
                                disabled={!isConnected || agentStatus === 'STARTING'}
                                title={!isConnected ? 'Connect voice channel first' : undefined}
                                style={{ flexShrink: 0 }}
                              >
                                {agentStatus === 'STARTING' ? 'Starting…' : '▶ Start'}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Bottom Utility Bar */}
                      <div className="vcc-deck-footer">
                        <span className="vcc-deck-tool-tag" title="FastMCP Streamable HTTP server on port 8001" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <ZapIcon /> 14 Tools
                        </span>
                        <div className="vcc-deck-footer-actions">
                          <Button
                            size="mini"
                            variant="outline"
                            disabled={isDemoRunning || !sessionIncidentId}
                            onClick={handleRunDemo}
                            title={
                              sessionIncidentId
                                ? 'Seed the deterministic customer login outage scenario into the current incident record'
                                : 'Join a channel first — the scenario seeds the active incident record'
                            }
                          >
                            {isDemoRunning ? 'Loading…' : demoFeedback || (<><ZapIcon /> Load Demo</>)}
                          </Button>
                          {transcript.length > 0 && (
                            <Button
                              size="mini"
                              variant="outline"
                              onClick={handleClearTranscript}
                              title="Clear transcript conversation history"
                            >
                              Clear Log
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* ── Manual utterance simulator (ported from the removed
                          root dashboard's DemoModeControl) -- types a line as a
                          named role without needing a working microphone. ── */}
                      {activeIncident && (
                        <form
                          onSubmit={handleSimulateUtterance}
                          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}
                        >
                          <span style={{ fontSize: 10.5, fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>
                            Simulate utterance:
                          </span>
                          <select
                            className="vcc-select vcc-select-compact"
                            value={simSpeaker}
                            onChange={(e) => setSimSpeaker(e.target.value)}
                            aria-label="Simulated speaker"
                          >
                            <option value="Dave Miller">Dave Miller (Engineer)</option>
                            <option value="Priya Sharma">Priya Sharma (Support)</option>
                            <option value="Commander Sarah Chen">Commander Sarah Chen (Commander)</option>
                            <option value="Marcus Vance">Marcus Vance (Business Lead)</option>
                          </select>
                          <input
                            className="vcc-input"
                            style={{ flex: 1, minWidth: 180 }}
                            placeholder="e.g. Database connection pool usage dropped back to 35% after restart."
                            value={simUtterance}
                            onChange={(e) => setSimUtterance(e.target.value)}
                          />
                          <Button
                            type="submit"
                            size="mini"
                            variant="outline"
                            disabled={isSimulating || !simUtterance.trim()}
                          >
                            {isSimulating ? 'Ingesting…' : 'Inject'}
                          </Button>
                        </form>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Incident Status (real data — item 1, step 4) ── */}
                <div className="vcc-incident-card">
                  <div className="vcc-incident-row">
                    <div className="vcc-incident-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      {/* No incident on the record means exactly that. The previous
                          fallback here rendered the seeded demo story ("Customer Login
                          and Identity Outage") whenever activeIncident was null, so a
                          disconnected socket looked identical to a real, live incident
                          with that title. Showing the absence is the honest state. */}
                      <div
                        className="vcc-incident-title"
                        style={activeIncident ? undefined : { color: '#9b9b9b', fontWeight: 500 }}
                      >
                        {activeIncident?.title ?? 'No incident on the record yet'}
                      </div>
                      {/* A machine-derived title must never read as one a commander
                          wrote. The backend re-derives it from the strongest current
                          claim (see incident_derivation.py) and flags it here.
                          title_auto_derived only means "not pinned by a human" -- it
                          is true from the moment an incident is created, before any
                          claim exists to derive anything from. Gating on claims.length
                          too, so a placeholder creation title is never mislabeled as
                          reflecting evidence that doesn't exist yet (live-reported
                          2026-09-03: a freshly-reset incident with zero claims still
                          showed this badge on its plain creation title). */}
                      {activeIncident?.title_auto_derived && (activeIncident?.claims?.length ?? 0) > 0 && (
                        <div className="vcc-title-derived" title="This title restates the strongest claim currently on the evidence record. Rename the incident to pin it." style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <RepeatIcon /> auto-derived from evidence
                        </div>
                      )}
                      <div className="vcc-incident-loc">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#9b9b9b" strokeWidth="2.5">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
                        </svg>
                        {activeIncident?.event_type
                          ? activeIncident.event_type.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
                          : 'Awaiting first observation'}
                      </div>
                      <div className="vcc-incident-id">{activeIncident?.incident_id ?? '—'}</div>
                    </div>
                  </div>

                  {activeIncident && (
                    <div className="vcc-incident-chips">
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Severity</span>
                        {activeIncident.severity ? (
                          <span className="vcc-chip" style={{ background: sevStyle(activeIncident.severity).bg, color: sevStyle(activeIncident.severity).text, border: `1px solid ${sevStyle(activeIncident.severity).border}` }}>
                            {activeIncident.severity}
                          </span>
                        ) : (
                          <span className="vcc-chip" style={{ background: '#f4f4f5', color: '#9b9b9b' }}>Unknown</span>
                        )}
                      </div>
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Status</span>
                        <span
                          className="vcc-chip"
                          style={{
                            background: statusStyle(activeIncident.status).bg,
                            color: statusStyle(activeIncident.status).text,
                            border: `1px solid ${statusStyle(activeIncident.status).border}`,
                          }}
                        >
                          {activeIncident.status}
                        </span>
                      </div>
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Started</span>
                        <span style={{ fontSize: 11.5, color: '#4a4a4a', fontWeight: 500 }}>
                          {isMounted && activeIncident.created_at
                            ? new Date(activeIncident.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : '—'}
                        </span>
                      </div>
                    </div>
                  )}

                  {activeIncident && (
                    <div className="vcc-inferred-note" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangleIcon /> Evidence assembled from ingested observations — verify before operational action
                    </div>
                  )}
                </div>

                {/* ── Live Situation (real data — item 1, steps 2–4) ──
                    See docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md. Replaces the old
                    ~200-line client-side regex simulator (extractIncidentInfo, with
                    hardcoded flood/fire/earthquake/cyclone patterns) with tiles derived
                    live from the real backend evidence record via deriveDynamicTiles. */}
                <DynamicSituationTiles
                  incident={activeIncident}
                  wsStatus={wsStatus}
                  hasSession={!!sessionIncidentId}
                />

                {/* ── Possible Causes (Hypotheses) — real data, item 1 step 4 ── */}
                {(activeIncident?.hypotheses?.length ?? 0) > 0 && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">Possible Causes <span style={{ fontWeight: 400, fontSize: 9, letterSpacing: 0, textTransform: 'none', color: '#c0c0c0', marginLeft: 4 }}>Hypotheses</span></div>
                    {activeIncident!.hypotheses.map((h) => (
                      <div className="vcc-hypo" key={h.id}>
                        <div className="vcc-hypo-row">
                          <span className="vcc-hypo-name">{h.title}</span>
                          <span className="vcc-hypo-pct">{Math.round(h.confidence * 100)}%</span>
                        </div>
                        <div className="vcc-bar-track">
                          <div className="vcc-bar-fill" style={{ width: `${Math.round(h.confidence * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* The Incident Timeline panel was removed 2026-09-05. The whiteboard
                    is now a timestamped flowchart, so a second chronological view of
                    the same evidence was redundant screen furniture. The timeline DATA
                    is untouched and still drives the final report -- it lives in
                    state_json.timeline, which is what the dashboard reads. Note the
                    `timeline_entries` TABLE has never been written to: there is no
                    TimelineRepository, so that table is NOT IMPLEMENTED, not merely
                    empty. */}

                {/* ── Contradictions ──
                    The single most product-defining panel: two people asserted
                    incompatible things about the same entity and Tocsin refuses to
                    silently pick one. Resolution is human and attributed. */}
                {(activeIncident?.conflicts?.length ?? 0) > 0 && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">
                      Contradictions
                      <span className="vcc-count-pill vcc-count-warn">
                        {activeIncident!.conflicts!.filter(c => c.status !== 'RESOLVED').length} open
                      </span>
                    </div>
                    {activeIncident!.conflicts!.map((c) => {
                      const resolved = c.status === 'RESOLVED';
                      return (
                        <div className="vcc-conflict" key={c.id}>
                          <div className="vcc-conflict-entity">
                            {c.entity}
                            <span className={`vcc-conflict-state ${resolved ? 'ok' : 'warn'}`}>
                              {resolved ? 'RESOLVED' : 'NEEDS HUMAN RESOLUTION'}
                            </span>
                          </div>
                          <div className="vcc-conflict-sides">
                            <div className="vcc-conflict-side">
                              <div className="vcc-conflict-src">{c.speaker_a || c.source_a}</div>
                              <div className="vcc-conflict-val">“{c.value_a}”</div>
                            </div>
                            <div className="vcc-conflict-vs">vs</div>
                            <div className="vcc-conflict-side">
                              <div className="vcc-conflict-src">{c.speaker_b || c.source_b}</div>
                              <div className="vcc-conflict-val">“{c.value_b}”</div>
                            </div>
                          </div>
                          {c.recommended_action && (
                            <div className="vcc-conflict-rec">→ {c.recommended_action}</div>
                          )}
                          {!resolved && (
                            <Button
                              size="xs"
                              variant="confirm"
                              disabled={busyId === c.id}
                              onClick={() =>
                                handleResolveConflict(
                                  c.id,
                                  c.recommended_action || 'Resolved by commander in incident room'
                                )
                              }
                              style={{ alignSelf: 'flex-start', marginTop: 2 }}
                            >
                              {busyId === c.id ? 'Resolving…' : 'Mark resolved'}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ── Action items: a Notion-style checklist ──
                    Grouped into To do / Completed rather than one flat list,
                    with a real checkbox (checking it off IS the complete
                    action -- no separate button) matching how a to-do list
                    is actually used. Read the same activeIncident.action_items
                    array as before; this is presentation only, no new state. */}
                {(activeIncident?.action_items?.length ?? 0) > 0 && (() => {
                  const items = activeIncident!.action_items!;
                  const openItems = items.filter((i) => i.status !== 'COMPLETE');
                  const doneItems = items.filter((i) => i.status === 'COMPLETE');
                  const dueLabel = (item: typeof items[number]) =>
                    item.due_at && isMounted
                      ? new Date(item.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : null;

                  return (
                    <div className="vcc-section-card">
                      <div className="vcc-section-label">
                        Action Items
                        <span className="vcc-count-pill">{openItems.length}</span>
                      </div>

                      {openItems.length > 0 && (
                        <div className="vcc-todo-group">
                          {openItems.map((item) => {
                            const overdue = item.status === 'OVERDUE';
                            const due = dueLabel(item);
                            return (
                              <div className="vcc-todo-row" key={item.id}>
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={false}
                                  aria-label={`Mark "${item.description}" complete`}
                                  className="vcc-todo-checkbox"
                                  disabled={busyId === item.id}
                                  onClick={() => handleCompleteItem(item.id)}
                                />
                                <div className="vcc-todo-body">
                                  <div className="vcc-todo-desc">{item.description}</div>
                                  <div className="vcc-todo-meta">
                                    <span>{item.owner_name || 'Unassigned'}</span>
                                    {due && (
                                      <span className={overdue ? 'vcc-todo-overdue' : undefined}>
                                        · due {due}{overdue ? ' (overdue)' : ''}
                                      </span>
                                    )}
                                    {item.status === 'BLOCKED' && <span className="vcc-todo-overdue">· blocked</span>}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {doneItems.length > 0 && (
                        <div className="vcc-todo-group vcc-todo-group-done">
                          <div className="vcc-todo-group-label">Completed ({doneItems.length})</div>
                          {doneItems.map((item) => (
                            <div className="vcc-todo-row" key={item.id}>
                              <span className="vcc-todo-checkbox checked" aria-hidden="true">
                                <CheckIcon size={11} />
                              </span>
                              <div className="vcc-todo-body">
                                <div className="vcc-todo-desc done">{item.description}</div>
                                <div className="vcc-todo-meta">
                                  <span>{item.owner_name || 'Unassigned'}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ── Unresolved risks: what could still go wrong ── */}
                {(activeIncident?.unresolved_risks?.length ?? 0) > 0 && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">
                      Unresolved Risks
                      <span className="vcc-count-pill vcc-count-warn">
                        {activeIncident!.unresolved_risks!.length}
                      </span>
                    </div>
                    {activeIncident!.unresolved_risks!.map((r) => (
                      <div className="vcc-risk" key={r.id}>
                        <span className="vcc-risk-dot" />
                        <span className="vcc-risk-text">{r.description}</span>
                        {r.severity && <span className="vcc-risk-sev">{r.severity}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Participants (ported from the removed root dashboard) ── */}
                {(activeIncident?.participants?.length ?? 0) > 0 && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">
                      Participants
                      <span className="vcc-count-pill">{activeIncident!.participants!.length}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {activeIncident!.participants!.map((p) => {
                        const inferred = p.role_source === 'inferred';
                        return (
                          <div
                            key={p.id}
                            style={{
                              padding: '7px 9px',
                              borderRadius: 6,
                              border: '1px solid #e2e8f0',
                              background: '#f8fafc',
                              fontSize: 11,
                            }}
                          >
                            <div style={{ fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.name}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#475569' }}>{p.role}</span>
                              {inferred ? (
                                <span
                                  title="Role inferred from voice discussion"
                                  style={{ fontSize: 9, color: '#92600c', background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}
                                >
                                  Inferred ({Math.round((p.role_confidence || 0.6) * 100)}%)
                                </span>
                              ) : (
                                <span style={{ fontSize: 9, color: '#94a3b8' }}>Declared</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Decisions in force (ported from the removed root dashboard) ──
                    Distinct from Response & Actions below: a decision is a recorded
                    commander call with rationale, not a proposed tool execution. */}
                {activeIncident && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <ScaleIcon /> Decisions in Force
                        <span className="vcc-count-pill">
                          {(activeIncident.claims || []).filter((c) => c.claim_type === 'decision' && !c.superseded_by_id).length}
                        </span>
                      </span>
                      {!showDecisionForm && (
                        <Button size="xs" variant="outline" onClick={() => { setShowDecisionForm(true); setSupersedeTarget(null); }}>
                          + Record
                        </Button>
                      )}
                    </div>

                    {(() => {
                      const decisions = (activeIncident.claims || []).filter((c) => c.claim_type === 'decision');
                      const active = decisions.filter((d) => !d.superseded_by_id);
                      const byId = new Map(decisions.map((d) => [d.id, d]));
                      if (active.length === 0) {
                        return <p className="vcc-empty">No decisions recorded yet.</p>;
                      }
                      return active.map((dec) => (
                        <div key={dec.id} style={{ padding: '8px 0', borderBottom: '1px solid #f5f5f5' }}>
                          <div style={{ fontSize: 11.5 }}>
                            <span style={{ fontWeight: 600, color: '#0f172a' }}>{dec.entity}:</span>{' '}
                            <span style={{ color: '#334155' }}>{dec.value}</span>
                          </div>
                          {dec.rationale && (
                            <p style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>Because: {dec.rationale}</p>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                            <span style={{ fontSize: 10, color: '#94a3b8' }}>
                              By {dec.decided_by || dec.speaker || 'Commander'}
                              {dec.supersedes_id && byId.has(dec.supersedes_id) && (
                                <> · supersedes &ldquo;{byId.get(dec.supersedes_id)?.value}&rdquo;</>
                              )}
                            </span>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                setSupersedeTarget(dec);
                                setDecisionEntity(dec.entity);
                                setDecisionValue('');
                                setDecisionRationale('');
                                setDecisionBy('');
                                setShowDecisionForm(true);
                              }}
                            >
                              Supersede
                            </Button>
                          </div>
                        </div>
                      ));
                    })()}

                    {showDecisionForm && (
                      <div style={{ marginTop: 8, padding: 10, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <p style={{ fontSize: 10.5, fontWeight: 600, color: '#0f172a' }}>
                          {supersedeTarget ? `Supersede: "${supersedeTarget.value}"` : 'New decision'}
                        </p>
                        <input
                          className="vcc-input"
                          placeholder="What this concerns (e.g. Rollback timing)"
                          value={decisionEntity}
                          onChange={(e) => setDecisionEntity(e.target.value)}
                          disabled={!!supersedeTarget}
                        />
                        <input
                          className="vcc-input"
                          placeholder="The decision itself"
                          value={decisionValue}
                          onChange={(e) => setDecisionValue(e.target.value)}
                        />
                        <input
                          className="vcc-input"
                          placeholder="Rationale — why this decision"
                          value={decisionRationale}
                          onChange={(e) => setDecisionRationale(e.target.value)}
                        />
                        <input
                          className="vcc-input"
                          placeholder="Decided by"
                          value={decisionBy}
                          onChange={(e) => setDecisionBy(e.target.value)}
                        />
                        {decisionError && <div className="vcc-cmd-error"><AlertTriangleIcon /> {decisionError}</div>}
                        <div className="vcc-btn-row" style={{ marginTop: 0 }}>
                          <Button size="xs" variant="default" disabled={isSavingDecision} onClick={handleSaveDecision}>
                            {isSavingDecision ? 'Saving…' : 'Save'}
                          </Button>
                          <Button size="xs" variant="outline" onClick={resetDecisionForm}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Response & Actions — now a REAL commander console ──
                    Previously read-only: the old confirm/reject buttons here never
                    called any backend endpoint (purely decorative local state), so
                    they were stripped and this panel pointed at the root dashboard
                    instead. It now performs the genuine, commander-key-gated
                    approve/reject against /api/incidents/{id}/actions/{id}/approve
                    and /reject, so the whole incident can be run from this one page.
                    The key is typed per session and never stored. */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">
                    Response &amp; Actions
                    <span className="vcc-count-pill vcc-count-lock">commander</span>
                  </div>

                  {(activeIncident?.proposed_actions?.length ?? 0) > 0 ? (
                    <>
                      <div className="vcc-cmd-key">
                        <input
                          type={showCommanderKey ? 'text' : 'password'}
                          className="vcc-input"
                          placeholder="Commander key — required to approve or reject"
                          value={commanderKey}
                          onChange={(e) => {
                            setCommanderKey(e.target.value);
                            // A stale "invalid credentials" message sitting under
                            // the box while you're actively correcting the key is
                            // what read as "glitching" -- clear it the moment the
                            // key changes so the error only ever reflects the
                            // current value, not the last attempt.
                            if (commandError) setCommandError(null);
                          }}
                          autoComplete="off"
                        />
                        <label className="vcc-key-show-toggle">
                          <input
                            type="checkbox"
                            checked={showCommanderKey}
                            onChange={(e) => setShowCommanderKey(e.target.checked)}
                          />
                          Show key
                        </label>
                        <p className="vcc-key-hint">
                          Verified server-side against <code>TOCSIN_COMMANDER_KEY</code>. Never stored in the browser.
                        </p>
                      </div>

                      <div className={`vcc-cmd-error-slot ${commandError ? 'open' : ''}`}>
                        <div className="vcc-cmd-error" key={commandErrorKey}><AlertTriangleIcon /> {commandError}</div>
                      </div>

                      {activeIncident!.proposed_actions.map((action) => {
                        const badge = actionStatusBadge(action.status);
                        const pending = action.status === 'PENDING_APPROVAL' || action.status === 'PROPOSED';
                        return (
                          <div className="vcc-action-item" key={action.action_id}>
                            <div className="vcc-action-top">
                              <div className="vcc-action-icon" style={{ background: badge.iconBg }}>{badge.icon}</div>
                              <span className="vcc-action-label">{action.tool_name.replaceAll('_', ' ')}</span>
                              <span
                                className="vcc-action-status-badge"
                                style={{ background: badge.bg, color: badge.text, border: `1px solid ${badge.border}` }}
                              >
                                {action.status.replaceAll('_', ' ')}
                              </span>
                            </div>
                            <div className="vcc-action-confirmed-note" style={{ paddingLeft: 36 }}>
                              {action.rationale}
                            </div>

                            {action.rejection_reason && (
                              <div className="vcc-action-rejected-note" style={{ paddingLeft: 36 }}>
                                Rejected: {action.rejection_reason}
                              </div>
                            )}

                            {pending && (
                              <div style={{ paddingLeft: 36 }}>
                                {rejectingId === action.action_id ? (
                                  <div className="vcc-reject-box">
                                    <input
                                      className="vcc-input"
                                      placeholder="Reason for rejection (required — rejection is terminal)"
                                      value={rejectReason}
                                      onChange={(e) => setRejectReason(e.target.value)}
                                    />
                                    <div className="vcc-btn-row">
                                      <Button
                                        size="xs"
                                        variant="reject"
                                        disabled={busyId === action.action_id}
                                        onClick={() => handleReject(action.action_id, action.tool_name)}
                                      >
                                        {busyId === action.action_id ? 'Rejecting…' : 'Confirm rejection'}
                                      </Button>
                                      <Button
                                        size="xs"
                                        variant="outline"
                                        onClick={() => { setRejectingId(null); setRejectReason(''); }}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="vcc-btn-row">
                                    <Button
                                      size="xs"
                                      variant="confirm"
                                      disabled={busyId === action.action_id}
                                      onClick={() => handleApprove(action.action_id, action.tool_name)}
                                    >
                                      {busyId === action.action_id ? 'Approving…' : 'Approve'}
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="reject"
                                      onClick={() => { setRejectingId(action.action_id); setCommandError(null); }}
                                    >
                                      Reject
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  ) : (
                    <p className="vcc-empty">No response actions yet. Incident information will generate recommendations.</p>
                  )}
                </div>

                {/* ── Final report: the evidence-bounded close-out ── */}
                {activeIncident && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">Final Report</div>
                    <Button
                      size="sm"
                      disabled={busyId === 'final-report'}
                      onClick={handleGenerateReport}
                    >
                      {busyId === 'final-report' ? 'Generating…' : 'Generate final report'}
                    </Button>
                    {finalReport && <pre className="vcc-report">{finalReport}</pre>}
                  </div>
                )}

                {/* ── Shift handoff brief (ported from the removed root
                    dashboard). Written + spoken forms from the same evidence
                    record so they cannot diverge -- see the original
                    HandoffPanel.tsx for the full reasoning. Broadcast requires
                    an agent already running for this incident's voice
                    channel; CREDENTIAL REQUIRED / NOT YET LIVE-VERIFIED that
                    audio is actually heard. ── */}
                {activeIncident && (
                  <div className="vcc-section-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <div>
                        <div className="vcc-section-label" style={{ marginBottom: 2 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <RepeatIcon /> Shift Handoff Brief
                          </span>
                        </div>
                        <p style={{ fontSize: 10.5, color: '#94a3b8' }}>
                          Written record + spoken script from the same evidence.
                        </p>
                      </div>
                      <Button size="xs" disabled={isGeneratingHandoff} onClick={handleGenerateHandoff}>
                        {isGeneratingHandoff ? 'Generating…' : 'Generate handoff'}
                      </Button>
                    </div>

                    {handoffError && <div className="vcc-cmd-error" style={{ marginTop: 8 }}><AlertTriangleIcon /> {handoffError}</div>}

                    {!handoffBrief && !handoffError && (
                      <p className="vcc-empty" style={{ marginTop: 6 }}>
                        Generate a brief when handing this incident to another commander.
                      </p>
                    )}

                    {handoffBrief?.open_item_counts && (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 10 }}>
                          {[
                            { label: 'Contradictions', value: handoffBrief.open_item_counts.contradictions },
                            { label: 'Open questions', value: handoffBrief.open_item_counts.questions },
                            { label: 'Open actions', value: handoffBrief.open_item_counts.actions },
                            { label: 'Overdue', value: handoffBrief.open_item_counts.overdue_actions },
                            { label: 'Unowned', value: handoffBrief.open_item_counts.unowned_actions },
                            { label: 'Risks', value: handoffBrief.open_item_counts.risks },
                          ].map((c) => (
                            <div key={c.label} style={{ padding: '7px 4px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', textAlign: 'center' }}>
                              <div style={{ fontSize: 16, fontWeight: 700, color: c.value === 0 ? '#94a3b8' : '#0f172a' }}>{c.value}</div>
                              <div style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>{c.label}</div>
                            </div>
                          ))}
                        </div>

                        <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#475569', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <MapPinIcon /> Read this onto the bridge
                            </span>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <Button size="xs" variant="outline" onClick={handleCopyHandoff}>
                                {handoffCopied ? (<><CheckIcon /> Copied</>) : (<><ClipboardIcon /> Copy</>)}
                              </Button>
                              <Button size="xs" variant="outline" disabled={isBroadcastingHandoff} onClick={handleBroadcastHandoff}>
                                {isBroadcastingHandoff ? 'Broadcasting…' : (<><Volume2Icon /> Broadcast</>)}
                              </Button>
                            </div>
                          </div>
                          <p style={{ fontSize: 11.5, color: '#1e293b', marginTop: 6, lineHeight: 1.5 }}>{handoffBrief.spoken_brief}</p>
                          {handoffBroadcastResult && (
                            <p style={{ fontSize: 10, marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 4, color: handoffBroadcastResult.ok ? '#64748b' : '#92600c' }}>
                              {handoffBroadcastResult.ok ? <CheckCircleIcon /> : <AlertTriangleIcon />}
                              <span>{handoffBroadcastResult.message}</span>
                            </p>
                          )}
                        </div>

                        {handoffBrief.sections?.record_quality && (
                          <p style={{ fontSize: 10.5, color: '#92600c', background: '#fef3c7', border: '1px solid #fde68a', padding: 8, borderRadius: 6, marginTop: 10 }}>
                            <b>Record quality:</b> {handoffBrief.sections.record_quality.caveat}
                          </p>
                        )}

                        <p style={{ fontSize: 10, color: '#94a3b8', borderTop: '1px solid #f1f5f9', paddingTop: 8, marginTop: 10 }}>
                          {handoffBrief.ai_disclaimer}
                        </p>
                      </>
                    )}
                  </div>
                )}

              </div>
            </div>
          </aside>

        </div>

        {/* ═══════════════════════════════════════ STATUS BAR ═══════════════════════════════════════ */}
        <footer className="vcc-statusbar" role="contentinfo">
          <span>
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: isConnected ? '#16a34a' : '#d4d4d4', marginRight: 5, verticalAlign: 'middle' }} />
            {isConnected ? 'Voice channel active' : 'Not connected'}
          </span>
          {activeIncident && <span>{transcript.length} utterance{transcript.length !== 1 ? 's' : ''} · {activeIncident.timeline.length} timeline event{activeIncident.timeline.length !== 1 ? 's' : ''}</span>}
          {(activeIncident?.action_items?.length ?? 0) > 0 && (
            <span>{activeIncident?.action_items?.length} action item{activeIncident?.action_items?.length !== 1 ? 's' : ''} tracked</span>
          )}
          {/*
            Session log. `logs` has always been populated but never rendered --
            addLog() only reached console.log. That is the single reason the
            2026-09-05 run's damage went unnoticed while it was being recorded:
            RTM transcript delivery failed, the message saying so was written to
            a console nobody had open, and the operator had no way to know the
            agent's replies were being captured as their own speech.

            Collapsed by default and visually subordinate, to leave this page's
            light design as it is.
          */}
          <button
            type="button"
            className="vcc-log-toggle"
            onClick={() => setShowSessionLog((v) => !v)}
            aria-expanded={showSessionLog}
          >
            {showSessionLog ? '▾' : '▸'} Session log{logs.length ? ` (${logs.length})` : ''}
            {suppressedUtteranceCount > 0 && (
              <span className="vcc-log-badge" title="Utterances attributed to the agent rather than to you">
                {suppressedUtteranceCount} echo-suppressed
              </span>
            )}
          </button>
        </footer>
        {showSessionLog && (
          <div className="vcc-log-panel" role="log" aria-label="Session log">
            {logs.length === 0 ? (
              <div className="vcc-log-empty">Nothing logged yet this session.</div>
            ) : (
              logs.slice(-200).map((line, i) => (
                <div key={i} className="vcc-log-line">{line}</div>
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}
