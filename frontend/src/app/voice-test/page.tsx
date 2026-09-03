'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIncidentState } from '@/hooks/useIncidentState';
import { DynamicSituationTiles } from '@/components/DynamicSituationTiles';
import LiveIncidentMap from '@/components/LiveIncidentMap';
import { startRtmTranscriptSession, RtmTranscriptSession } from '@/lib/agoraRtmTranscripts';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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
  // Default matches the canonical demo incident ID (same convention the root
  // dashboard's VoiceHUD uses: `activeIncident?.incident_id || 'inc-demo-identity-outage'`).
  // Previously defaulted to 'tocsin-emergency-room', which is not a real incident ID —
  // every /observations POST from this page 404'd silently against it. Agora channel
  // names and Tocsin incident IDs are treated as the same string throughout this app,
  // so reusing the incident ID here is consistent with the rest of the codebase.
  const [channelName,        setChannelName]       = useState('inc-demo-identity-outage');
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
  const [tokenDetails,       setTokenDetails]      = useState<{
    uid?: number | string; channel?: string; expiresIn?: number;
  } | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [isAwaitingReply, setIsAwaitingReply] = useState(false);
  const [isMounted,    setIsMounted]    = useState(false);
  const [currentTime,  setCurrentTime]  = useState<Date | null>(null);
  const [waveStartedAt, setWaveStartedAt] = useState<number | null>(null);

  // ── Transcript state ───────────────────────────────────────────────────
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const transcriptContainerRef      = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef           = useRef<boolean>(false);

  // ── Real incident state (item 1, step 4 of
  // docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md) ──────────────────────
  // Replaces the old client-side-only `incidentData` simulator (a ~200-line regex
  // function with hardcoded flood/fire/earthquake/cyclone detection patterns,
  // completely disconnected from the real backend evidence engine) with the exact
  // same live incident state the root dashboard (`/`) uses. See
  // frontend/src/hooks/useIncidentState.ts and TODO.md item 1 for the full history.
  const { activeIncident, wsStatus } = useIncidentState();

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
  // Chrome's local SpeechRecognition finalizes results with 1-3s of lag behind
  // the actual audio, so checking aiSpeakingRef.current at result-time misses
  // agent speech that already ended by the time onresult fires. Track when the
  // agent last stopped speaking and extend suppression past that lag window.
  const aiSpeechEndedAtRef = useRef<number>(0);

  // ── Speech recognition refs ────────────────────────────────────────────
  const speechRecognitionRef       = useRef<any>(null);
  const speechRecognitionActiveRef = useRef<boolean>(false);

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

  // ── Auto-scroll transcript ─────────────────────────────────────────────
  useEffect(() => {
    if (!userScrolledUpRef.current && transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcript]);

  const handleTranscriptScroll = () => {
    const el = transcriptContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 15;
    userScrolledUpRef.current = !isAtBottom;
  };

  // ── handleLeave ────────────────────────────────────────────────────────
  const handleLeave = useCallback(async () => {
    if (rtmSessionRef.current) { await rtmSessionRef.current.stop(); rtmSessionRef.current = null; }
    if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
    speechRecognitionActiveRef.current = false;
    if (speechRecognitionRef.current) { try { speechRecognitionRef.current.stop(); } catch {} speechRecognitionRef.current = null; }
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
    aiSmoothedRmsRef.current = 0;
    barLevelsRef.current.fill(0);
    smoothedLevelsRef.current.fill(0);
    barColorsRef.current.forEach(c => { c[0] = 75; c[1] = 85; c[2] = 99; });
    displayedSpeechProbRef.current = 0;
    displayedMicLevelRef.current = 0;
    addLog('Left voice channel. Dashboard data retained.');
  }, [addLog]);

  // ── Mount effect ───────────────────────────────────────────────────────
  useEffect(() => {
    setIsMounted(true);
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    addLog('Voice Command Center ready.');
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
    // Clear the local transcript display on join — the backend incident record itself
    // is real, persisted data and is intentionally left untouched.
    setTranscript([]);
    try {
      setConnectionState('FETCHING_TOKEN');
      addLog(`Requesting RTC token for '${channelName}'...`);
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
        if (Number(user.uid) === 9999) { setRemoteAgentPresent(true); addLog(`✨ [Agora ConvoAI] ${activeAgentLabelRef.current} (UID 9999) joined.`); }
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
          aiAmpRef.current = 0;
          aiSmoothedRmsRef.current = 0;
          if (aiSourceRef.current) { try { aiSourceRef.current.disconnect(); } catch {} }
          aiSourceRef.current = null;
          aiAnalyserRef.current = null;
          aiTimeDataRef.current = null;
          aiFreqDataRef.current = null;
          if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
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
      try {
        const rtmUserAccount = `tocsin-voicetest-${uid}`;
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
          onEvent: (decoded) => {
            if (decoded.speaker !== 'TOCSIN' || !decoded.isFinal) return;
            addTranscriptEntryRef.current('AI Agent', decoded.text);
            const incId = channelName.trim() || 'inc-demo-identity-outage';
            fetch(`${API_BASE_URL}/api/incidents/${incId}/observations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw_utterance: decoded.text, speaker: 'AI Agent', source: 'agora_voice_agent' }),
            }).catch(() => {});
          },
          onLog: addLog,
        });
      } catch (rtmErr: any) {
        addLog(`⚠️ RTM transcript session failed to start: ${rtmErr?.message || rtmErr} (voice call continues; AI transcript text may not appear)`);
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
      } catch { addLog('⚠️ Web Audio setup failed.'); }

      setVadStatus('LOADING');
      const { MicVAD } = await import('@ricky0123/vad-web');
      const myVad = await MicVAD.new({
        baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/', model: 'v5',
        onSpeechStart:    () => { vadCandidateRef.current = true; },
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
        const raw = new TextDecoder('utf-8').decode(data);
        try {
          const msg = JSON.parse(raw);
          const content = msg.text ?? msg.transcript ?? null;
          if (content && content.length > 3) {
            addTranscriptEntryRef.current('AI Agent', content);
            const incId = channelName.trim() || 'inc-demo-identity-outage';
            fetch(`${API_BASE_URL}/api/incidents/${incId}/observations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw_utterance: content, speaker: 'AI Agent', source: 'agora_voice_agent' }),
            }).catch(() => {});
          }
        } catch {}
      });

      const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
      if (SpeechRecognitionClass) {
        const rec = new SpeechRecognitionClass();
        rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) continue;
            // Chrome's local SpeechRecognition transcribes whatever the mic
            // picks up -- it cannot distinguish the operator's own voice from the
            // agent's speaker audio leaking back into the mic (common on
            // built-in laptop mic+speaker setups without headphones). Every
            // result from this path is unconditionally labeled 'You' below, so
            // without this guard, agent speech bleeding into the mic gets
            // mislabeled as the operator's own words. Suppress results while the
            // agent is actively speaking (aiSpeakingRef, tracked via the RTC
            // volume indicator) AND for a cooldown window after it stops --
            // Chrome finalizes SpeechRecognition results 1-3s behind the actual
            // audio, so a same-instant check alone misses agent speech that
            // already ended by the time onresult fires.
            if (aiSpeakingRef.current) continue;
            if (Date.now() - aiSpeechEndedAtRef.current < 3000) continue;
            const text = event.results[i][0].transcript.trim();
            if (text.length < 3) continue;
            addTranscriptEntryRef.current('You', text);
            const incId = channelName.trim() || 'inc-demo-identity-outage';
            fetch(`${API_BASE_URL}/api/incidents/${incId}/observations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw_utterance: text, speaker: 'Operator', source: 'voice_transcript' }),
            }).catch(() => {});
          }
        };
        rec.onerror = (e: any) => { if (e.error !== 'no-speech' && e.error !== 'aborted') addLog(`⚠️ [Speech recognition] ${e.error}`); };
        rec.onend   = () => { if (speechRecognitionActiveRef.current) { try { rec.start(); } catch {} } };
        speechRecognitionRef.current = rec; speechRecognitionActiveRef.current = true;
        try { rec.start(); } catch {}
      }
    } catch (err: any) { addLog(`Join/VAD Error: ${err.message}`); setConnectionState('ERROR'); }
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
      addLog(`✅ Agent dispatched — ${data.voice_pipeline}, LLM: ${providerLabel}${modeLabel}`);
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
    } catch { setAgentStatus('ERROR'); }
  };

  /**
   * Turn a real /observations response into a chat-readable reply.
   *
   * Deliberately reports what the extraction pipeline actually did rather than
   * generating free-form conversational text: this reply is a readout of structured
   * evidence-record state (category, evidence status, claims, conflicts), not a
   * simulated personality. That keeps it consistent with the rest of the product's
   * anti-hallucination stance — Tocsin does not say anything here that isn't backed
   * by what the backend actually returned.
   */
  const buildTocsinReply = (data: any): string => {
    if (data?.skipped) {
      return "Already logged — that's a duplicate of something said in the last 30 seconds.";
    }

    const parts: string[] = [];
    const category = data?.category ?? 'UNCLASSIFIED';
    const evidenceStatus = data?.evidence_status ?? 'UNVERIFIED';
    parts.push(`Logged as ${category} (${evidenceStatus}).`);

    const claims = data?.observation?.claims ?? [];
    if (claims.length > 0) {
      const first = claims[0];
      const extra = claims.length > 1 ? ` +${claims.length - 1} more` : '';
      parts.push(`Claim: "${first.entity}" → "${first.value}"${extra}.`);
    }

    if (data?.extraction_method === 'heuristic_fallback') {
      parts.push('⚠️ Extracted via keyword fallback (LLM unavailable) — treat as UNVERIFIED.');
    }

    const conflicts = data?.conflicts_detected ?? 0;
    if (conflicts > 0) {
      parts.push(`⚡ Contradicts ${conflicts} existing claim${conflicts > 1 ? 's' : ''} — flagged for review, see Conflicts panel.`);
    }

    const actionItems = data?.action_items_created ?? 0;
    if (actionItems > 0) {
      parts.push(`📋 Created ${actionItems} action item${actionItems > 1 ? 's' : ''}.`);
    }

    const missing = data?.missing_info_identified ?? 0;
    if (missing > 0) {
      parts.push(`❓ Flagged ${missing} open question${missing > 1 ? 's' : ''}.`);
    }

    if (Array.isArray(data?.persist_errors) && data.persist_errors.length > 0) {
      parts.push('⚠️ Database persistence failed — this may not survive a refresh.');
    }

    return parts.join(' ');
  };

  // Client-side ceiling on how long we'll wait for a reply, independent of whatever
  // the backend's own extraction timeout is. Live-observed 2026-08-31: a Gemini call
  // with no server-side timeout hung for 173s with zero feedback to the user. The
  // backend now enforces its own 12s cap (GEMINI_EXTRACTION_TIMEOUT_SECONDS), but this
  // is defense in depth — a proxy, DNS issue, or a future backend regression must not
  // be able to freeze this chat again. 20s gives the backend's 12s budget headroom for
  // DB writes and network round-trip before we give up client-side.
  const COMMAND_REPLY_TIMEOUT_MS = 20000;

  const handleCommandSubmit = async () => {
    if (!commandInput.trim() || isAwaitingReply) return;
    const text = commandInput.trim();
    addTranscriptEntry('You', text);
    setCommandInput('');
    setIsAwaitingReply(true);

    const incId = channelName.trim() || 'inc-demo-identity-outage';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COMMAND_REPLY_TIMEOUT_MS);

    try {
      const res = await fetch(`${API_BASE_URL}/api/incidents/${incId}/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_utterance: text, speaker: 'Operator', source: 'command_input' }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        addTranscriptEntry(
          'AI Agent',
          `⚠️ Could not log that (HTTP ${res.status}${errBody?.detail ? `: ${errBody.detail}` : ''}). Nothing was recorded.`
        );
        addLog(`⚠️ [Observation] POST failed for incident '${incId}': HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      addTranscriptEntry('AI Agent', buildTocsinReply(data));
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      addTranscriptEntry(
        'AI Agent',
        timedOut
          ? `⚠️ No reply after ${COMMAND_REPLY_TIMEOUT_MS / 1000}s — the backend may be overloaded. Your message was sent but Tocsin has not confirmed it was logged.`
          : '⚠️ Could not reach the backend to log that. Check the connection and try again.'
      );
      addLog(
        timedOut
          ? `⚠️ [Observation] Client-side timeout waiting for incident '${incId}'`
          : `⚠️ [Observation] Network error for incident '${incId}': ${err?.message || err}`
      );
    } finally {
      clearTimeout(timeoutId);
      setIsAwaitingReply(false);
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

  // Real ActionApprovalStatus values from the backend state machine (PROPOSED →
  // PENDING_APPROVAL → APPROVED → EXECUTING → VERIFIED | FAILED; REJECTED is
  // terminal). Read-only display — see the note above the Response & Actions section.
  const actionStatusBadge = (status: string): { bg: string; text: string; border: string; icon: string; iconBg: string } => {
    switch (status) {
      case 'APPROVED':
      case 'VERIFIED':
        return { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', icon: '✓', iconBg: '#f0fdf4' };
      case 'REJECTED':
      case 'FAILED':
        return { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', icon: '✕', iconBg: '#fef2f2' };
      case 'EXECUTING':
        return { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe', icon: '⚙', iconBg: '#eff6ff' };
      case 'PENDING_APPROVAL':
        return { bg: '#eef2ff', text: '#6366f1', border: '#c7d2fe', icon: '⚡', iconBg: '#eef2ff' };
      default: // PROPOSED
        return { bg: '#f4f4f5', text: '#71717a', border: '#e4e4e7', icon: '•', iconBg: '#f4f4f5' };
    }
  };

  // ── Dot component (reused throughout) ──────────────────────────────────
  const Dot = ({ color }: { color: 'green' | 'indigo' | 'gray' | 'red' | 'amber' }) => {
    const c = { green: '#16a34a', indigo: '#6366f1', gray: '#9b9b9b', red: '#dc2626', amber: '#d97706' }[color];
    return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0, marginRight: 5 }} />;
  };

  const connDotColor = connectionState === 'CONNECTED' ? 'green' : connectionState === 'ERROR' ? 'red' : 'gray';
  const agentDotColor = agentStatus === 'RUNNING' || remoteAgentPresent ? 'green' : agentStatus === 'ERROR' ? 'red' : agentStatus === 'STARTING' || agentStatus === 'STOPPING' ? 'amber' : 'gray';
  const vadDotColor = vadStatus === 'READY' ? 'green' : vadStatus === 'ERROR' ? 'red' : vadStatus === 'LOADING' ? 'amber' : 'gray';

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style suppressHydrationWarning>{`
        /* ── Reset & root ── */
        .vcc-root {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #f2f1ef;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          color: #1a1a1a;
          -webkit-font-smoothing: antialiased;
          font-size: 13px;
        }

        /* ── Top bar ── */
        .vcc-topbar {
          height: 48px;
          background: #ffffff;
          border-bottom: 1px solid #e5e5e5;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 20px;
          flex-shrink: 0;
          gap: 16px;
        }
        .vcc-topbar-brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 700;
          color: #1a1a1a;
          letter-spacing: -0.01em;
        }
        .vcc-topbar-badge {
          font-size: 9px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 4px;
          background: #f3f3f3;
          color: #6b6b6b;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .vcc-topbar-center {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11.5px;
          color: #6b6b6b;
        }
        .vcc-topbar-right {
          display: flex;
          align-items: center;
          gap: 16px;
          font-size: 12px;
          color: #4a4a4a;
        }

        /* ── Body layout ── */
        .vcc-body {
          flex: 1;
          display: grid;
          grid-template-columns: 310px 1fr 620px;
          min-height: 0;
          overflow: hidden;
        }

        /* ── Panel shared ── */
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
        .vcc-panel-scroll::-webkit-scrollbar { width: 8px; }
        .vcc-panel-scroll::-webkit-scrollbar-thumb { background: #c4c4c4; border-radius: 4px; }
        .vcc-panel-scroll::-webkit-scrollbar-thumb:hover { background: #6b6b6b; }
        .vcc-panel-scroll::-webkit-scrollbar-track { background: transparent; }

        /* ── Left panel ── */
        .vcc-left {
          background: #f8f8f7;
          border-right: 1px solid #e5e5e5;
        }
        .vcc-left-header {
          padding: 14px 16px 10px;
          border-bottom: 1px solid #eeeeee;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .vcc-left-title {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: #1a1a1a;
        }
        .vcc-conn-badge {
          display: flex;
          align-items: center;
          font-size: 10.5px;
          font-weight: 600;
          color: ${connectionState === 'CONNECTED' ? '#16a34a' : connectionState === 'ERROR' ? '#dc2626' : '#9b9b9b'};
        }

        /* ── Transcript ── */
        .vcc-transcript-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          padding: 12px 12px 0;
        }
        .vcc-section-label {
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: #9b9b9b;
          margin-bottom: 8px;
          flex-shrink: 0;
        }
        .vcc-transcript {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-bottom: 8px;
        }
        .vcc-transcript::-webkit-scrollbar { width: 8px; }
        .vcc-transcript::-webkit-scrollbar-thumb { background: #c4c4c4; border-radius: 4px; }
        .vcc-transcript::-webkit-scrollbar-thumb:hover { background: #6b6b6b; }
        .vcc-transcript::-webkit-scrollbar-track { background: transparent; }
        .vcc-transcript-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          flex: 1;
          gap: 4px;
          color: #b0b0b0;
          font-size: 12px;
          text-align: center;
          font-style: italic;
          padding: 24px 12px;
        }
        .vcc-msg {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 8px 10px;
          border-radius: 7px;
          border-left: 3px solid transparent;
          background: #ffffff;
          border: 1px solid #f0f0f0;
          animation: vcc-msg-in 0.2s cubic-bezier(0.16,1,0.3,1);
        }
        @keyframes vcc-msg-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .vcc-msg.you { border-left: 3px solid #ff9f0a; }
        .vcc-msg.ai  { border-left: 3px solid #30d158; }
        .vcc-msg-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .vcc-msg-speaker {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 1px 6px;
          border-radius: 3px;
        }
        .vcc-msg-speaker.you { background: #fff7ed; color: #ea580c; }
        .vcc-msg-speaker.ai  { background: #f0fdf4; color: #16a34a; }
        .vcc-msg-time {
          font-size: 9px;
          color: #b0b0b0;
          font-variant-numeric: tabular-nums;
        }
        .vcc-msg-text {
          font-size: 12px;
          line-height: 1.5;
          color: #2a2a2a;
          word-break: break-word;
        }

        /* ── Left controls ── */
        .vcc-left-controls {
          flex-shrink: 0;
          padding: 10px 12px;
          border-top: 1px solid #eeeeee;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .vcc-card-sm {
          background: #ffffff;
          border: 1px solid #e8e8e8;
          border-radius: 8px;
          padding: 10px 12px;
        }
        .vcc-card-sm .vcc-section-label { margin-bottom: 6px; }
        .vcc-channel-card { width: 260px; margin-top: 20px; }
        .vcc-input {
          width: 100%;
          padding: 7px 9px;
          border-radius: 6px;
          border: 1px solid #e0e0e0;
          background: #f8f8f7;
          font-size: 12px;
          color: #1a1a1a;
          font-family: monospace;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .vcc-input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.1); }
        .vcc-input:disabled { opacity: 0.6; cursor: not-allowed; }
        .vcc-btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }

        /* ── Buttons ── */
        .vcc-btn {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid #e0e0e0;
          background: #f5f5f4;
          color: #1a1a1a;
          transition: all 0.15s ease;
          font-family: inherit;
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .vcc-btn:hover:not(:disabled) { opacity: 0.85; transform: translateY(-0.5px); }
        .vcc-btn:active:not(:disabled) { transform: scale(0.98); }
        .vcc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .vcc-btn-primary { background: #1a1a1a; color: #ffffff; border-color: #1a1a1a; }
        .vcc-btn-danger  { background: #dc2626; color: #ffffff; border-color: #dc2626; }
        .vcc-btn-green   { background: #16a34a; color: #ffffff; border-color: #16a34a; }
        .vcc-btn-outline { background: transparent; color: #1a1a1a; border-color: #d4d4d4; }
        .vcc-btn-confirm { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; font-weight: 700; font-size: 11px; }
        .vcc-btn-confirm:hover:not(:disabled) { background: #dcfce7; }
        .vcc-btn-reject  { background: transparent; color: #dc2626; border-color: #fecaca; font-size: 11px; }
        .vcc-btn-reject:hover:not(:disabled)  { background: #fef2f2; }

        /* ── Command input ── */
        .vcc-cmd-row {
          display: flex;
          align-items: center;
          gap: 6px;
          background: #ffffff;
          border: 1px solid #e5e5e5;
          border-radius: 8px;
          padding: 8px 10px;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .vcc-cmd-row:focus-within { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.1); }
        .vcc-cmd-input {
          flex: 1;
          border: none;
          outline: none;
          font-size: 12px;
          color: #1a1a1a;
          background: transparent;
          font-family: inherit;
        }
        .vcc-cmd-input::placeholder { color: #c0c0c0; }
        .vcc-cmd-send {
          width: 26px; height: 26px;
          border-radius: 6px;
          background: #1a1a1a;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: opacity 0.15s, transform 0.15s;
        }
        .vcc-cmd-send:hover:not(:disabled) { opacity: 0.8; transform: scale(1.05); }
        .vcc-cmd-send:active:not(:disabled) { transform: scale(0.95); }
        .vcc-cmd-send-spinner {
          width: 11px; height: 11px;
          border: 1.5px solid rgba(255,255,255,0.35);
          border-top-color: #fff;
          border-radius: 50%;
          animation: vcc-spin 0.7s linear infinite;
        }
        @keyframes vcc-spin { to { transform: rotate(360deg); } }
        .vcc-cmd-thinking {
          font-size: 10.5px;
          color: #999;
          padding: 4px 2px 0 2px;
          font-style: italic;
        }

        /* ── Voice select ── */
        .vcc-select {
          padding: 5px 8px;
          border-radius: 6px;
          border: 1px solid #e0e0e0;
          background: #fff;
          font-size: 11.5px;
          color: #1a1a1a;
          font-family: inherit;
          outline: none;
        }

        /* ── Center panel ── */
        .vcc-center {
          background: #f2f1ef;
          border-right: 1px solid #e5e5e5;
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
          /* The map grows with the incident, so this column needs its own scroll --
             .vcc-root is height:100vh/overflow:hidden, so without this a busy map
             would be clipped rather than reachable. */
          overflow-y: auto;
          min-height: 0;
        }
        .vcc-center-inner::-webkit-scrollbar { width: 8px; }
        .vcc-center-inner::-webkit-scrollbar-thumb { background: #c4c4c4; border-radius: 4px; }
        .vcc-center-inner::-webkit-scrollbar-thumb:hover { background: #6b6b6b; }
        .vcc-center-inner::-webkit-scrollbar-track { background: transparent; }
        .vcc-map-slot {
          width: 100%;
          max-width: 760px;
          margin-top: 24px;
          flex-shrink: 0;
        }

        /* ── Centered Interaction Cluster (42px Mic + 12px Gap + 310px Dynamic Island) ── */
        .vcc-interaction-cluster {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin: 0 auto;
          max-width: 100%;
        }

        /* ── Standalone 42px Circular Microphone Control (Left of Island) ── */
        .vcc-cluster-mic-btn {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          border: 1px solid rgba(0, 0, 0, 0.08);
          background: #ffffff;
          color: #374151;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
          transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .vcc-cluster-mic-btn:hover:not(:disabled) {
          background: #f9fafb;
          border-color: rgba(0, 0, 0, 0.16);
          transform: scale(1.04);
        }
        .vcc-cluster-mic-btn:active:not(:disabled) {
          transform: scale(0.96);
        }
        .vcc-cluster-mic-btn:focus-visible {
          outline: 2px solid #3b82f6;
          outline-offset: 2px;
        }
        .vcc-cluster-mic-btn.active-user {
          color: #ff9f0a;
          border-color: #ff9f0a;
          background: #fff7ed;
          box-shadow: 0 0 12px rgba(255, 159, 10, 0.35);
        }
        .vcc-cluster-mic-btn.muted {
          color: #ef4444;
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

        /* ── Compact Apple Dynamic Island Capsule (310px x 54px) ── */
        .vcc-dynamic-island {
          width: min(310px, calc(100vw - 32px));
          height: 54px;
          border-radius: 9999px;
          background: #000000;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          box-sizing: border-box;
          user-select: none;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
          flex-shrink: 0;
        }
        .vcc-dynamic-island:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
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
        .vcc-island-dot.connected    { background: #30d158; }
        .vcc-island-dot.user         { background: #ff9f0a; }
        .vcc-island-dot.ai           { background: #30d158; }
        .vcc-island-dot.active       { background: #ffd60a; }
        .vcc-island-dot.muted        { background: #ef4444; }
        .vcc-island-dot.connecting   { background: #ffd60a; }
        .vcc-island-dot.disconnected { background: #9ca3af; }
        .vcc-island-dot.error        { background: #ef4444; }

        .vcc-island-label {
          font-size: 13px;
          font-weight: 600;
          color: #f3f4f6;
          letter-spacing: -0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 0.2s ease;
        }
        .vcc-island-label.connected    { color: #30d158; }
        .vcc-island-label.user         { color: #ff9f0a; }
        .vcc-island-label.ai           { color: #30d158; }
        .vcc-island-label.active       { color: #ffd60a; }
        .vcc-island-label.muted        { color: #ef4444; }
        .vcc-island-label.connecting   { color: #ffd60a; }
        .vcc-island-label.disconnected { color: #9ca3af; }
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

        /* ── Minimal Secondary Controls & Telemetry Below Island ── */
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
          color: #71717a;
          font-weight: 500;
          text-align: center;
        }

        .vcc-island-meters {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px 12px;
          background: #ffffff;
          border: 1px solid #e4e4e7;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
          box-sizing: border-box;
        }

        .vcc-submeter-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 10px;
          color: #71717a;
        }
        .vcc-submeter-label {
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-size: 8.5px;
          color: #a1a1aa;
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
          border-radius: 1px;
          background: #e4e4e7;
          opacity: 0.35;
          transition: background-color 0.08s ease, opacity 0.08s ease;
        }

        .vcc-submeter-track {
          flex: 1;
          height: 2.5px;
          background: #f4f4f5;
          border-radius: 999px;
          overflow: hidden;
        }
        .vcc-submeter-fill {
          height: 100%;
          border-radius: 999px;
          background: #ff9f0a;
        }
        .vcc-submeter-num {
          font-size: 9.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          width: 24px;
          text-align: right;
          color: #71717a;
        }

        /* ── System status row ── */
        .vcc-sys-status {
          flex-shrink: 0;
          border-top: 1px solid #e8e8e8;
          background: #fafaf9;
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
          color: #6b6b6b;
        }
        .vcc-sys-label { font-weight: 600; color: #4a4a4a; }

        /* ── Right panel ── */
        .vcc-right {
          background: #ffffff;
          border-left: 1px solid #e5e5e5;
          min-height: 0;
        }
        .vcc-right-inner {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .vcc-right-inner::-webkit-scrollbar { width: 8px; }
        .vcc-right-inner::-webkit-scrollbar-thumb { background: #c4c4c4; border-radius: 4px; }
        .vcc-right-inner::-webkit-scrollbar-thumb:hover { background: #6b6b6b; }
        .vcc-right-inner::-webkit-scrollbar-track { background: transparent; }

        /* ── Incident Timeline: internal scroll, not the whole right column ── */
        .vcc-tl-scroll {
          max-height: 280px;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 4px;
        }
        .vcc-tl-scroll::-webkit-scrollbar { width: 8px; }
        .vcc-tl-scroll::-webkit-scrollbar-thumb { background: #c4c4c4; border-radius: 4px; }
        .vcc-tl-scroll::-webkit-scrollbar-thumb:hover { background: #6b6b6b; }
        .vcc-tl-scroll::-webkit-scrollbar-track { background: transparent; }
        .vcc-right-title {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #1a1a1a;
          padding-bottom: 4px;
          border-bottom: 1px solid #f0f0f0;
          flex-shrink: 0;
        }

        /* ── Incident status card ── */
        .vcc-incident-card {
          background: #fff;
          border: 1px solid #e8e8e8;
          border-radius: 10px;
          padding: 14px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.05);
        }
        .vcc-incident-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .vcc-incident-icon {
          width: 40px; height: 40px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: ${activeIncident ? '#fee2e2' : '#f4f4f5'};
          color: ${activeIncident ? '#dc2626' : '#a0a0a0'};
        }
        .vcc-incident-title {
          font-size: 14px;
          font-weight: 700;
          color: ${activeIncident ? '#1a1a1a' : '#b0b0b0'};
          margin-bottom: 3px;
          line-height: 1.3;
        }
        .vcc-title-derived {
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.03em;
          color: #9b7ba8;
          background: #f6f2f8;
          border: 1px solid #e8dced;
          border-radius: 4px;
          padding: 1px 5px;
          display: inline-block;
          margin-bottom: 4px;
          cursor: help;
        }
        .vcc-incident-loc {
          font-size: 11.5px;
          color: #6b6b6b;
          display: flex;
          align-items: center;
          gap: 3px;
          margin-bottom: 2px;
        }
        .vcc-incident-id {
          font-size: 10px;
          color: #b0b0b0;
          font-family: monospace;
        }
        .vcc-incident-chips {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }
        .vcc-chip-group { display: flex; flex-direction: column; gap: 3px; }
        .vcc-chip-meta  { font-size: 9px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #b0b0b0; }
        .vcc-chip {
          display: inline-block;
          padding: 3px 9px;
          border-radius: 5px;
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.04em;
        }
        .vcc-inferred-note {
          font-size: 9.5px;
          color: #a0a0a0;
          font-style: italic;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid #f5f5f5;
        }

        /* ── Metrics grid ── */
        .vcc-metric-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .vcc-metric-item {
          background: #fafafa;
          border: 1px solid #ebebeb;
          border-radius: 8px;
          padding: 11px 13px;
          transition: background-color 0.2s ease, border-color 0.2s ease;
        }
        .vcc-metric-label { font-size: 10px; color: #9b9b9b; font-weight: 500; margin-bottom: 5px; }
        .vcc-metric-value { font-size: 20px; font-weight: 700; color: #1a1a1a; line-height: 1.1; transition: color 0.2s ease; }
        .vcc-metric-value.placeholder { color: #d0d0d0; }
        .vcc-metric-sub   { font-size: 10px; color: #9b9b9b; margin-top: 3px; }
        .vcc-metric-sub.warn { color: #d97706; font-weight: 600; }
        .vcc-metric-sub.alert { color: #dc2626; font-weight: 600; }

        /* ── Section card ── */
        .vcc-section-card {
          background: #fff;
          border: 1px solid #e8e8e8;
          border-radius: 10px;
          padding: 12px 14px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.04);
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
        .vcc-hypo-name { font-size: 11.5px; color: #2a2a2a; }
        .vcc-hypo-pct  { font-size: 11px; font-weight: 600; color: #6b6b6b; }
        .vcc-bar-track { height: 5px; background: #f0f0f0; border-radius: 3px; overflow: hidden; }
        .vcc-bar-fill  { height: 100%; background: #6366f1; border-radius: 3px; transition: width 0.6s ease; }

        /* ── Timeline ── */
        .vcc-tl { display: flex; flex-direction: column; }
        .vcc-tl-row { display: flex; gap: 0; align-items: stretch; }
        .vcc-tl-time { font-size: 9.5px; color: #b0b0b0; font-weight: 500; white-space: nowrap; width: 44px; flex-shrink: 0; padding-top: 2px; font-variant-numeric: tabular-nums; }
        .vcc-tl-mid  { display: flex; flex-direction: column; align-items: center; width: 16px; flex-shrink: 0; }
        .vcc-tl-dot  { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; }
        .vcc-tl-line { width: 1.5px; background: #ebebeb; flex: 1; min-height: 12px; margin-top: 3px; }
        .vcc-tl-body { flex: 1; padding-bottom: 10px; padding-left: 6px; }
        .vcc-tl-title { font-size: 11.5px; font-weight: 600; color: #1a1a1a; line-height: 1.3; }
        .vcc-tl-desc  { font-size: 10px; color: #9b9b9b; margin-top: 1px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }

        /* ── Actions ── */
        .vcc-action-item {
          display: flex;
          flex-direction: column;
          gap: 7px;
          padding: 10px 0;
          border-bottom: 1px solid #f5f5f5;
        }
        .vcc-action-item:last-child { border-bottom: none; padding-bottom: 0; }
        .vcc-action-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .vcc-action-icon { width: 30px; height: 30px; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; }
        .vcc-action-label { font-size: 12px; font-weight: 500; color: #1a1a1a; line-height: 1.4; flex: 1; }
        .vcc-action-status-badge {
          font-size: 9.5px;
          font-weight: 700;
          padding: 2px 7px;
          border-radius: 4px;
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
          .vcc-body { grid-template-columns: 280px 1fr 520px; }
        }
        @media (max-width: 1024px) {
          .vcc-body { grid-template-columns: 260px 1fr 420px; }
          .vcc-right-inner { padding: 12px; }
        }
        @media (max-width: 900px) {
          .vcc-body {
            grid-template-columns: 1fr;
            grid-template-rows: auto auto auto;
            overflow-y: auto;
          }
          .vcc-panel { height: auto; }
          .vcc-left  { border-right: none; border-bottom: 1px solid #e5e5e5; min-height: 320px; }
          .vcc-center { border-right: none; border-bottom: 1px solid #e5e5e5; }
          .vcc-right { border-left: none; }
          .vcc-transcript-section { max-height: 220px; }
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
            {connectionState === 'ERROR' && <span style={{ marginLeft: 10, color: '#dc2626', fontWeight: 600 }}>⚠ Connection Error</span>}
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

          {/* ════════════════════ LEFT PANEL ════════════════════ */}
          <aside className="vcc-panel vcc-left">
            <div className="vcc-left-header">
              <span className="vcc-left-title">Live Incident Room</span>
              <span className="vcc-conn-badge">
                <Dot color={connDotColor} />
                {connectionState === 'CONNECTED' ? 'Connected' :
                 connectionState === 'FETCHING_TOKEN' ? 'Authorizing...' :
                 connectionState === 'JOINING' ? 'Joining...' :
                 connectionState === 'ERROR' ? 'Error' : 'Disconnected'}
              </span>
            </div>

            {/* Live Conversation */}
            <div className="vcc-transcript-section">
              <div className="vcc-section-label">Live Conversation</div>
              <div
                ref={transcriptContainerRef}
                onScroll={handleTranscriptScroll}
                className="vcc-transcript"
                role="log"
                aria-label="Live conversation transcript"
                aria-live="polite"
              >
                {transcript.length === 0 ? (
                  <div className="vcc-transcript-empty">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d0d0d0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 6 }}>
                      <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"/>
                      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                    No conversation yet
                    <span style={{ fontSize: 10.5, marginTop: 2 }}>
                      {isConnected ? 'Speak to begin real-time transcription' : 'Join the incident room to begin'}
                    </span>
                  </div>
                ) : (
                  transcript.map(entry => (
                    <div key={entry.id} className={`vcc-msg ${entry.speaker === 'You' ? 'you' : 'ai'}`}>
                      <div className="vcc-msg-header">
                        <span className={`vcc-msg-speaker ${entry.speaker === 'You' ? 'you' : 'ai'}`}>
                          {entry.speaker === 'You' ? 'Field Operator' : 'TOCSIN'}
                        </span>
                        <span className="vcc-msg-time">{entry.time}</span>
                      </div>
                      <div className="vcc-msg-text">{entry.text}</div>
                    </div>
                  ))
                )}
                {/* Streaming indicator when AI is speaking */}
                {aiSpeaking && transcript.length > 0 && transcript[transcript.length - 1].speaker === 'AI Agent' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: 11, color: '#30d158', fontStyle: 'italic' }}>
                    <span style={{ display: 'flex', gap: 3 }}>
                      {[0, 0.2, 0.4].map((d, i) => (
                        <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#30d158', display: 'inline-block', animation: `vcc-blink 1s ${d}s ease-in-out infinite` }} />
                      ))}
                    </span>
                    Tocsin is responding...
                  </div>
                )}
              </div>
            </div>

            {/* Controls area */}
            <div className="vcc-left-controls">
              {/* Gemini Agent (only when connected) */}
              {isConnected && (
                <div className="vcc-card-sm">
                  <div className="vcc-section-label">Conversational Agent</div>
                  <div className="vcc-btn-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      className="vcc-select"
                      value={voicePipeline}
                      onChange={e => setVoicePipeline(e.target.value as 'gemini_live' | 'composed_tools')}
                      disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}
                      aria-label="Select conversational pipeline"
                      title="gemini_live: lowest latency, no MCP tools. composed_tools: Agora-managed Deepgram/OpenAI/MiniMax by default (no model key needed), supports MCP tools."
                    >
                      <option value="gemini_live">Gemini Live (low-latency)</option>
                      <option value="composed_tools">Managed Pipeline (tools-capable)</option>
                    </select>
                    {voicePipeline === 'composed_tools' && (
                      <select
                        className="vcc-select"
                        value={llmVendor}
                        onChange={e => setLlmVendor(e.target.value as 'openai' | 'gemini')}
                        disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}
                        aria-label="Select LLM vendor for managed pipeline"
                        title="openai: Agora-managed credential, no key of ours needed. gemini: our own GEMINI_API_KEY, subject to its quota."
                      >
                        <option value="openai">LLM: Agora-managed OpenAI</option>
                        <option value="gemini">LLM: BYOK Gemini</option>
                      </select>
                    )}
                    <select
                      className="vcc-select"
                      value={selectedVoice}
                      onChange={e => setSelectedVoice(e.target.value)}
                      disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING' || voicePipeline === 'composed_tools'}
                      aria-label="Select agent voice"
                      title={voicePipeline === 'composed_tools' ? 'Ignored on the managed pipeline — MiniMax TTS uses its own voice, not this Gemini Live voice enum.' : undefined}
                    >
                      <option value="Puck">Puck — Energetic</option>
                      <option value="Charon">Charon — Authoritative</option>
                      <option value="Aoede">Aoede — Calm</option>
                      <option value="Fenrir">Fenrir — Direct</option>
                      <option value="Kore">Kore — Clear</option>
                    </select>
                    {agentStatus === 'RUNNING' || remoteAgentPresent
                      ? <button className="vcc-btn vcc-btn-danger" onClick={handleStopAgent} disabled={agentStatus === 'STOPPING'}>
                          {agentStatus === 'STOPPING' ? 'Stopping...' : '■ Stop Agent'}
                        </button>
                      : <button
                          className={`vcc-btn ${agentStatus === 'STARTING' ? '' : 'vcc-btn-green'}`}
                          onClick={handleStartAgent}
                          disabled={agentStatus === 'STARTING'}
                        >
                          {agentStatus === 'STARTING' ? 'Launching...' : '▶ Start Agent'}
                        </button>
                    }
                  </div>
                </div>
              )}

              {/* Command / text input */}
              <div className="vcc-cmd-row">
                <input
                  className="vcc-cmd-input"
                  type="text"
                  placeholder={isAwaitingReply ? 'Waiting for Tocsin to reply…' : 'Describe the incident or type a command...'}
                  value={commandInput}
                  onChange={e => setCommandInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCommandSubmit()}
                  aria-label="Type incident description or command"
                  disabled={isAwaitingReply}
                />
                <button
                  className="vcc-cmd-send"
                  onClick={handleCommandSubmit}
                  aria-label="Send command"
                  disabled={isAwaitingReply}
                  style={isAwaitingReply ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                >
                  {isAwaitingReply ? (
                    <span className="vcc-cmd-send-spinner" aria-hidden="true" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  )}
                </button>
              </div>
              {isAwaitingReply && (
                <div className="vcc-cmd-thinking" aria-live="polite">
                  TOCSIN is processing…
                </div>
              )}
            </div>
          </aside>

          {/* ════════════════════ CENTER PANEL (DYNAMIC ISLAND CALL UI) ════════════════════ */}
          <main className="vcc-panel vcc-center" role="main">
            <div className="vcc-center-inner">

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

              {/* Voice channel — moved here from the left column so it lives with the
                  rest of the call controls, not next to the text-command chat input. */}
              <div className="vcc-card-sm vcc-channel-card">
                <div className="vcc-section-label">Voice Channel</div>
                <input
                  id="channel-input"
                  type="text"
                  className="vcc-input"
                  value={channelName}
                  onChange={e => setChannelName(e.target.value)}
                  disabled={connectionState !== 'DISCONNECTED' && connectionState !== 'ERROR'}
                  placeholder="channel-name"
                  aria-label="Voice channel name"
                />
                <div className="vcc-btn-row">
                  {isConnected
                    ? <button className="vcc-btn vcc-btn-danger" onClick={handleLeave}>Leave Channel</button>
                    : <button
                        className={`vcc-btn ${isConnecting ? '' : 'vcc-btn-primary'}`}
                        onClick={handleJoin}
                        disabled={isConnecting}
                        aria-label="Join voice channel"
                      >
                        {connectionState === 'FETCHING_TOKEN' ? 'Authorizing...' :
                         connectionState === 'JOINING' ? 'Connecting...' : 'Join Channel'}
                      </button>
                  }
                  {isConnected && (
                    <button
                      className={`vcc-btn ${isMuted ? 'vcc-btn-danger' : 'vcc-btn-green'}`}
                      onClick={handleToggleMute}
                      aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {isMuted ? '🔇 Unmute' : '🎤 Mute'}
                    </button>
                  )}
                </div>
              </div>

              {/* ── Live Incident Map ──
                  The centre column is where the conversation happens, so this is
                  where the incident gets drawn. Redraws itself from the evidence
                  record over the same WebSocket that feeds every other panel — no
                  refresh, no manual arranging, and nothing on it that a person in
                  the room didn't actually say. See LiveIncidentMap.tsx. */}
              <div className="vcc-map-slot">
                <LiveIncidentMap incident={activeIncident} />
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
                <div className="vcc-right-title">Incident Command</div>

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
                          claim (see incident_derivation.py) and flags it here. */}
                      {activeIncident?.title_auto_derived && (
                        <div className="vcc-title-derived" title="This title restates the strongest claim currently on the evidence record. Rename the incident to pin it.">
                          ⟳ auto-derived from evidence
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
                    <div className="vcc-inferred-note">
                      ⚠ Evidence assembled from ingested observations — verify before operational action
                    </div>
                  )}

                  {transcript.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={handleClearTranscript} className="vcc-btn" style={{ fontSize: 10, padding: '3px 8px' }}>
                        Clear Transcript
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Live Situation (real data — item 1, steps 2–4) ──
                    See docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md. Replaces the old
                    ~200-line client-side regex simulator (extractIncidentInfo, with
                    hardcoded flood/fire/earthquake/cyclone patterns) with tiles derived
                    live from the real backend evidence record via deriveDynamicTiles. */}
                <DynamicSituationTiles incident={activeIncident} wsStatus={wsStatus} />

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

                {/* ── Incident Timeline — real data, item 1 step 4 ── */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">Incident Timeline</div>
                  {(activeIncident?.timeline?.length ?? 0) > 0 ? (
                    <div className="vcc-tl-scroll">
                      <div className="vcc-tl">
                        {[...activeIncident!.timeline].reverse().slice(0, 20).map((item, i, arr) => (
                          <div className="vcc-tl-row" key={`${item.timestamp}-${i}`}>
                            <div className="vcc-tl-time">
                              {isMounted
                                ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : '—'}
                            </div>
                            <div className="vcc-tl-mid">
                              <div className="vcc-tl-dot" style={{ background: item.actor === 'SYSTEM' ? '#9b9b9b' : '#3b82f6' }} />
                              {i < arr.length - 1 && <div className="vcc-tl-line" />}
                            </div>
                            <div className="vcc-tl-body" style={{ paddingBottom: i < arr.length - 1 ? 10 : 0 }}>
                              <div className="vcc-tl-title">{item.event_type.replaceAll('_', ' ')}</div>
                              <div className="vcc-tl-desc" title={item.description}>{item.description}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="vcc-empty">Waiting for incident information...</p>
                  )}
                </div>

                {/* ── Response & Actions — real data, read-only, item 1 step 4 ──
                    The old confirm/reject buttons here never called any backend
                    endpoint — they were purely local, decorative UI state. Rather than
                    wire a second, parallel commander-approval flow into this page,
                    this now shows the REAL proposed-action status from the backend and
                    points to the main dashboard's already-implemented, commander-key
                    -gated approval workflow for taking action. Read-only here is more
                    honest than fake buttons that did nothing. */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">Response &amp; Actions</div>
                  {(activeIncident?.proposed_actions?.length ?? 0) > 0 ? (
                    <>
                      {activeIncident!.proposed_actions.map((action) => {
                        const badge = actionStatusBadge(action.status);
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
                          </div>
                        );
                      })}
                      <p className="vcc-empty" style={{ marginTop: 4 }}>
                        Approve or reject pending actions on the main dashboard (commander sign-off required).
                      </p>
                    </>
                  ) : (
                    <p className="vcc-empty">No response actions yet. Incident information will generate recommendations.</p>
                  )}
                </div>

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
        </footer>
      </div>
    </>
  );
}
