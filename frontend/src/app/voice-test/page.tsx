'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

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
    const sample = data[index] / 128 - 1;
    sumSquares += sample * sample;
  }
  return Math.min(1, Math.sqrt(sumSquares / (end - start)) * 18);
}

/**
 * Soft-glow radial ring canvas renderer (preserved for backward compatibility).
 * Kept off-screen so any RAF loop null-check passes safely.
 */
function drawGlowRing(
  canvas: HTMLCanvasElement,
  amplitude: number,
  phase: number,
  rgb: [number, number, number],
  isActive: boolean,
  isConnected: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, circleR = 75;
  ctx.clearRect(0, 0, W, H);
  const [r, g, b] = rgb;
  const N = 90;
  const baseAlpha = isActive ? 0.035 + amplitude * 0.05 : isConnected ? 0.015 : 0.005;
  const spread    = isActive ? 10 + amplitude * 10 : isConnected ? 6 : 4;
  const rotOffset = phase * 0.2;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + rotOffset;
    let dr = 0;
    if (isActive && amplitude > 0.004) {
      dr = (
        Math.sin(angle * 2 + phase * 1.2) * 1.5 +
        Math.cos(angle * 4 - phase * 0.9) * 1.0 +
        Math.sin(angle * 6 + phase * 1.5) * 0.5
      ) * amplitude * 4.5;
    } else if (isConnected) {
      dr = Math.sin(angle * 2 + phase * 0.2) * 0.4;
    }
    const glowR  = circleR + 2 + Math.max(-2, dr);
    const blobX  = cx + glowR * Math.cos(angle);
    const blobY  = cy + glowR * Math.sin(angle);
    const blobSz = spread + Math.max(0, dr * 0.5);
    const grad   = ctx.createRadialGradient(blobX, blobY, 0, blobX, blobY, blobSz);
    const peak   = Math.min(0.6, baseAlpha * 3.0);
    const mid    = Math.min(0.3, baseAlpha * 1.5);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${peak})`);
    grad.addColorStop(0.4, `rgba(${r},${g},${b},${mid})`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(blobX, blobY, blobSz, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnectionState = 'DISCONNECTED' | 'FETCHING_TOKEN' | 'JOINING' | 'CONNECTED' | 'ERROR';
type VadModelStatus  = 'UNLOADED' | 'LOADING' | 'READY' | 'ERROR';
type AgentStatus     = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
type TranscriptEntry = { id: string; speaker: 'You' | 'AI Agent'; text: string; time: string };

// ─── Component ───────────────────────────────────────────────────────────────

export default function VoiceTestPage() {

  // ── Core session state ─────────────────────────────────────────────────
  const [channelName,        setChannelName]       = useState('tocsin-emergency-room');
  const [connectionState,    setConnectionState]   = useState<ConnectionState>('DISCONNECTED');
  const [isMuted,            setIsMuted]           = useState(false);
  const [isSpeaking,         setIsSpeaking]        = useState(false);
  const [aiSpeaking,         setAiSpeaking]        = useState(false);
  const [speechProbability,  setSpeechProbability] = useState(0);
  const [vadStatus,          setVadStatus]         = useState<VadModelStatus>('UNLOADED');
  const [agentStatus,        setAgentStatus]       = useState<AgentStatus>('STOPPED');
  const [agentId,            setAgentId]           = useState<string | null>(null);
  const [selectedVoice,      setSelectedVoice]     = useState('Puck');
  const [remoteAgentPresent, setRemoteAgentPresent] = useState(false);
  const [logs,               setLogs]              = useState<string[]>([]);
  const [tokenDetails,       setTokenDetails]      = useState<{
    uid?: number | string; channel?: string; expiresIn?: number;
  } | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [isMounted,    setIsMounted]    = useState(false);
  const [currentTime,  setCurrentTime]  = useState<Date | null>(null);
  const [waveStartedAt, setWaveStartedAt] = useState<number | null>(null);

  // ── Transcript state ───────────────────────────────────────────────────
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const transcriptContainerRef      = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef           = useRef<boolean>(false);

  // ── Persistent incident state ──────────────────────────────────────────
  const [incidentData, setIncidentData] = useState<{
    title: string; location: string; incidentId: string;
    severity: string; status: string; startedAt: string;
    metrics: {
      peopleAffected: string; peopleAffectedSub: string;
      waterLevel: string;     waterLevelSub: string;
      riskLevel: string;
      resourcesDeployed: string; resourcesSub: string;
    };
    timeline: Array<{ time: string; title: string; desc: string; color: string }>;
    causes:   Array<{ name: string; pct: number }>;
    actions:  Array<{ label: string; status: string; cls: string; iconBg: string }>;
  } | null>(null);

  // ── Task state ─────────────────────────────────────────────────────────
  type TaskStatus = 'idle' | 'running' | 'done' | 'error';
  type Task = { label: string; status: TaskStatus };
  const [tasks, setTasks] = useState<Task[]>([]);

  // ── Action confirmation UI state (local-only; no backend execution) ────
  const [actionStates, setActionStates] = useState<Record<string, 'confirmed' | 'rejected'>>({});

  // ── Agora / VAD refs ───────────────────────────────────────────────────
  const rtcClientRef       = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const vadInstanceRef     = useRef<any>(null);
  const isMutedRef         = useRef<boolean>(false);

  // ── Robust Speech Detection Gate refs ──────────────────────────────────
  const noiseFloorRef      = useRef<number>(0.006);
  const smoothedUserRmsRef = useRef<number>(0);
  const smoothedUserVisualRmsRef = useRef<number>(0);
  const speakingFramesRef  = useRef<number>(0);
  const quietFramesRef     = useRef<number>(0);
  const vadCandidateRef    = useRef<boolean>(false);
  const vadProbabilityRef  = useRef<number>(0);

  // ── Visualizer bar levels ref (16 Dynamic Island bars, preallocated) ──
  const BAR_COUNT = 16;
  const barLevelsRef  = useRef<Float32Array>(new Float32Array(BAR_COUNT));
  const micMeterElRef = useRef<HTMLDivElement | null>(null);

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
  const userPitchRef       = useRef<number>(0);
  const aiPitchRef         = useRef<number>(0);

  const aiAmpRef           = useRef<number>(0);
  const userAmpRef         = useRef<number>(0);
  const phaseRef           = useRef<number>(0);
  const rafRef             = useRef<number>(0);
  const glowCanvasRef      = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const aiSpeakingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef      = useRef<boolean>(false);
  const aiSpeakingRef      = useRef<boolean>(false);
  const isConnectedRef     = useRef<boolean>(false);

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

  // ── Incident extraction NLP ────────────────────────────────────────────
  const extractIncidentInfo = useCallback((text: string, source: 'user' | 'ai' = 'user') => {
    const lower = text.toLowerCase();
    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const has = (...patterns: RegExp[]) => patterns.some(p => p.test(lower));

    const newTasks: string[] = [];
    const dispatchPatterns: Array<[RegExp, string]> = [
      [/dispatch(?:ing)?\s+(?:\d+\s+)?(?:flood\s+)?rescue\s+team/i,       'Dispatch flood rescue team'],
      [/dispatch(?:ing)?\s+(?:\d+\s+)?rescue\s+boat/i,                    'Dispatch rescue boats'],
      [/dispatch(?:ing)?\s+(?:\d+\s+)?helicopter/i,                        'Dispatch helicopter(s)'],
      [/dispatch(?:ing)?\s+(?:\d+\s+)?ambulance/i,                         'Dispatch ambulance(s)'],
      [/dispatch(?:ing)?\s+(?:\d+\s+)?fire\s+(?:truck|engine|brigade)/i,  'Dispatch fire brigade'],
      [/dispatch(?:ing)?\s+(?:\d+\s+)?relief\s+(?:team|unit|squad)/i,     'Dispatch relief team'],
      [/send(?:ing)?\s+(?:\d+\s+)?(?:flood\s+)?rescue\s+team/i,           'Deploy flood rescue team'],
      [/send(?:ing)?\s+(?:\d+\s+)?rescue\s+boat/i,                        'Deploy rescue boats'],
      [/send(?:ing)?\s+(?:\d+\s+)?helicopter/i,                            'Deploy helicopter(s)'],
      [/send(?:ing)?\s+(?:\d+\s+)?ambulance/i,                             'Deploy ambulance(s)'],
      [/deploy(?:ing)?\s+(?:\d+\s+)?(?:flood\s+)?rescue\s+team/i,         'Deploy rescue team'],
      [/deploy(?:ing)?\s+(?:\d+\s+)?(?:rescue\s+)?boat/i,                 'Deploy rescue boats'],
      [/deploy(?:ing)?\s+(?:\d+\s+)?helicopter/i,                          'Deploy helicopter(s)'],
      [/mobiliz(?:e|ing)\s+(?:\d+\s+)?(?:rescue|relief|emergency)\s+team/i, 'Mobilize emergency team'],
      [/alert(?:ing)?\s+(?:the\s+)?(?:local\s+)?(?:police|authorities)/i, 'Alert local authorities'],
      [/contact(?:ing)?\s+(?:the\s+)?(?:district|state|national)\s+(?:authority|government|ndrf|sdrf)/i, 'Contact district authority'],
      [/coordinat(?:e|ing)\s+(?:with\s+)?(?:ndrf|sdrf|army|navy|air\s+force)/i, 'Coordinate with NDRF/SDRF'],
      [/set(?:ting)?\s+up\s+(?:a\s+)?(?:relief|evacuation|rescue)\s+(?:camp|center|centre)/i, 'Set up relief camp'],
      [/evacuat(?:e|ing|ion)/i,                                             'Initiate evacuation'],
      [/issue\s+(?:an?\s+)?(?:alert|warning|advisory)/i,                   'Issue public alert / warning'],
      [/not(?:ify|ifying)\s+(?:local\s+)?(?:hospital|medical)/i,           'Notify medical facilities'],
      [/request(?:ing)?\s+(?:additional\s+)?(?:ndrf|sdrf|army|military)/i, 'Request NDRF/SDRF assistance'],
      [/secur(?:e|ing)\s+(?:the\s+)?area/i,                                'Secure the affected area'],
      [/open(?:ing)?\s+(?:emergency\s+)?(?:shelter|relief\s+camp)/i,       'Open emergency shelter'],
      [/provid(?:e|ing)\s+(?:first\s+aid|medical\s+assistance)/i,          'Provide first aid / medical'],
      [/restor(?:e|ing)\s+(?:power|electricity|communication)/i,            'Restore power / communication'],
    ];
    for (const [pattern, label] of dispatchPatterns) {
      if (pattern.test(text)) newTasks.push(label);
    }

    setIncidentData(prev => {
      let d = prev
        ? { ...prev, metrics: { ...prev.metrics }, timeline: [...prev.timeline], causes: [...prev.causes], actions: [...prev.actions] }
        : {
            title: '—', location: '—',
            incidentId: 'INC-' + Math.floor(1000 + Math.random() * 9000),
            severity: '', status: 'ACTIVE', startedAt: nowStr,
            metrics: { peopleAffected: '', peopleAffectedSub: '', waterLevel: '', waterLevelSub: '', riskLevel: '', resourcesDeployed: '', resourcesSub: '' },
            timeline: [] as Array<{ time: string; title: string; desc: string; color: string }>,
            causes:   [] as Array<{ name: string; pct: number }>,
            actions:  [] as Array<{ label: string; status: string; cls: string; iconBg: string }>,
          };

      let changed = false;

      let detectedType = '';
      if (has(/\bflood(?:ing|s|ed)?\b/, /\binundation\b/, /\bsubmerg/, /\bwaterlog/))         detectedType = 'Flood Emergency';
      else if (has(/\bfire\b/, /\bblaze\b/, /\bburning\b/, /\binferno\b/, /\bwildfire\b/))   detectedType = 'Fire Emergency';
      else if (has(/\bearthquake\b/, /\btremor\b/, /\bseismic\b/, /\bquake\b/))              detectedType = 'Earthquake Emergency';
      else if (has(/\bcyclone\b/, /\bhurricane\b/, /\btyphoon\b/, /\btropical\s+storm\b/))   detectedType = 'Cyclone / Storm Emergency';
      else if (has(/\blandslide\b/, /\bmudslide\b/, /\bdebris\s+flow\b/))                    detectedType = 'Landslide Emergency';
      else if (has(/\btsunami\b/))                                                            detectedType = 'Tsunami Emergency';
      else if (has(/\bdrought\b/, /\bwater\s+scarcity\b/, /\bwater\s+shortage\b/))           detectedType = 'Drought Emergency';
      else if (has(/\baccident\b/, /\bcrash\b/, /\bcollision\b/))                            detectedType = 'Accident / Disaster';
      if (detectedType && d.title !== detectedType) { d.title = detectedType; changed = true; }

      const cityMatch  = text.match(/\b(Guwahati|Dibrugarh|Jorhat|Silchar|Tezpur|Nagaon|Delhi|Mumbai|Chennai|Kolkata|Bangalore|Bengaluru|Hyderabad|Pune|Ahmedabad|Jaipur|Lucknow|Patna|Bhopal|Bhubaneswar|Chandigarh|Dehradun|Imphal|Kohima|Aizawl|Agartala|Gangtok|Shillong|Itanagar|Shimla|Jammu|Srinagar|Leh|Raipur|Panaji|Thiruvananthapuram|Kochi|Varanasi|Nagpur|Visakhapatnam|Coimbatore|Madurai|Indore|Surat)\b/);
      const stateMatch = text.match(/\b(Assam|Maharashtra|Tamil Nadu|West Bengal|Karnataka|Andhra Pradesh|Telangana|Gujarat|Rajasthan|Uttar Pradesh|Bihar|Madhya Pradesh|Odisha|Chhattisgarh|Punjab|Haryana|Uttarakhand|Manipur|Nagaland|Mizoram|Tripura|Meghalaya|Arunachal Pradesh|Sikkim|Himachal Pradesh|Jammu and Kashmir|Ladakh|Goa|Kerala|Jharkhand)\b/);
      if (cityMatch || stateMatch) {
        const city = cityMatch?.[1], state = stateMatch?.[1];
        const loc  = city && state ? `${city}, ${state}` : city ?? state ?? d.location;
        if (loc !== d.location) { d.location = loc; changed = true; }
      } else {
        const locMatch = text.match(/\b(?:in|at|near|around|from|located in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
        if (locMatch && locMatch[1] !== d.location) { d.location = locMatch[1]; changed = true; }
      }

      const peopleMatch = text.match(/(?:approximately|about|around|over|more than|at least|nearly|some|roughly)?\s*(\d[\d,]*)\s*(?:\+\s*)?(people|persons|individuals|families|households|residents|victims|survivors|civilians|children|workers|trapped|stranded|affected|injured|dead|killed|missing|displaced|homeless|evacuated)/i);
      if (peopleMatch) {
        const count = peopleMatch[1].replace(/,/g, '');
        const plus  = (text.includes(peopleMatch[1] + '+') || has(/more than|over|at least|approximately|about|around/)) ? '+' : '';
        d.metrics.peopleAffected    = count + plus;
        d.metrics.peopleAffectedSub = has(/dead|killed/) ? 'Casualties reported' : has(/injur/) ? 'Injured' : has(/miss(?:ing)?/) ? 'Missing persons' : has(/trap(?:ped)?/, /strand(?:ed)?/) ? 'Trapped / needs evacuation' : has(/displac(?:ed)?/, /homeless/, /evacuat(?:ed)?/) ? 'Displaced' : 'Affected';
        changed = true;
      }

      if (has(/\bcritical\b/, /\bsevere\b/, /\bcatastrophic\b/, /\bextreme\b/, /\bdevastating\b/, /\bdire\b/)) {
        if (d.severity !== 'CRITICAL') { d.severity = 'CRITICAL'; d.metrics.riskLevel = 'Critical'; changed = true; }
      } else if (has(/\bhigh\b/, /\bserious\b/, /\bsignificant\b/, /\bmajor\b/, /\burgent\b/)) {
        if (!d.severity || d.severity === 'MEDIUM' || d.severity === 'LOW') { d.severity = 'HIGH'; d.metrics.riskLevel = 'High'; changed = true; }
      } else if (has(/\bmoderate\b/, /\bmedium\b/)) {
        if (!d.severity || d.severity === 'LOW') { d.severity = 'MEDIUM'; d.metrics.riskLevel = 'Medium'; changed = true; }
      } else if (has(/\blow\b/, /\bminor\b/, /\bslight\b/)) {
        if (!d.severity) { d.severity = 'LOW'; d.metrics.riskLevel = 'Low'; changed = true; }
      }

      const waterNum = text.match(/([\d]+(?:\.[\d]+)?)\s*(m\b|meter|metre|meters|metres|ft\b|feet|foot|cm\b|centimeter)\s*(?:of\s+)?(?:water|flood|inundation)?/i)
                    || text.match(/(?:water|flood|river|level|risen?|rise)\s+(?:level\s+)?(?:to|of|by|at|is|around|about|reached?|stands?\s+at)?\s*([\d]+(?:\.[\d]+)?)\s*(m\b|meter|metre|ft\b|feet|cm\b)/i);
      if (waterNum) {
        const val = waterNum[1], rawUnit = (waterNum[2] || '').toLowerCase();
        const unit = rawUnit.startsWith('m') ? 'm' : rawUnit.startsWith('f') ? 'ft' : 'cm';
        if (d.metrics.waterLevel !== val + unit) { d.metrics.waterLevel = val + unit; d.metrics.waterLevelSub = 'Measured level'; changed = true; }
      } else if (has(/water.{0,40}rising/, /flood.{0,20}rising/, /river.{0,20}overflow/, /water.{0,20}overflow/)) {
        if (d.metrics.waterLevel !== 'Rising') { d.metrics.waterLevel = 'Rising'; d.metrics.waterLevelSub = 'Rising rapidly'; changed = true; }
      } else if (has(/water.{0,20}reced/, /flood.{0,20}reced/, /water.{0,20}subsid/)) {
        if (d.metrics.waterLevel !== 'Receding') { d.metrics.waterLevel = 'Receding'; d.metrics.waterLevelSub = 'Situation improving'; changed = true; }
      } else if (has(/\bwaterlogged\b/, /\bsubmerged\b/, /\binundated\b/)) {
        if (!d.metrics.waterLevel) { d.metrics.waterLevel = 'High'; d.metrics.waterLevelSub = 'Area submerged'; changed = true; }
      } else if (has(/water\s+level|flood\s+level|river\s+level|dam\s+level/)) {
        if (has(/danger|alarming|above\s+danger/)) { d.metrics.waterLevel = 'Critical'; d.metrics.waterLevelSub = 'Above danger mark'; changed = true; }
        else if (has(/stable|normal/)) { d.metrics.waterLevel = 'Stable'; d.metrics.waterLevelSub = 'Situation monitored'; changed = true; }
      }

      const resourceMatch = text.match(/(\d+)\s*(?:flood\s+)?(?:rescue\s+)?(?:boats?|helicopters?|vehicles?|ambulances?|fire\s*trucks?|teams?|units?|personnel|workers?)/i);
      if (resourceMatch) {
        const count = resourceMatch[1];
        const type  = /boat/i.test(text) ? 'boat(s)' : /helicopter/i.test(text) ? 'helicopter(s)' : /ambulance/i.test(text) ? 'ambulance(s)' : /fire/i.test(text) ? 'fire truck(s)' : /team/i.test(text) ? 'team(s)' : 'unit(s)';
        d.metrics.resourcesDeployed = count; d.metrics.resourcesSub = `${count} ${type} deployed`; changed = true;
      } else if (has(/\bdispatch\b/, /\bdeploy\b/, /\bsend(?:ing)?\b/, /\bmobiliz/)) {
        const rType = has(/\bboat/) ? 'Rescue boats' : has(/\bhelicopter/) ? 'Helicopters' : has(/\bambulance/) ? 'Ambulances' : has(/\bfire\b/) ? 'Fire trucks' : has(/\brescue\s+team\b/, /\brelief\s+team\b/) ? 'Rescue teams' : has(/\bndrf\b/, /\bsdrf\b/) ? 'NDRF/SDRF' : has(/\bevacuat/) ? 'Evacuation teams' : null;
        if (rType) { if (!d.metrics.resourcesDeployed) d.metrics.resourcesDeployed = 'Requested'; d.metrics.resourcesSub = `${rType} requested`; changed = true; }
      }

      const existingCauseNames = new Set(d.causes.map(c => c.name));
      const causesToAdd: Array<{ name: string; pct: number }> = [];
      if (has(/heavy\s+rain/, /intense\s+rain/, /torrential/, /rainfall/, /downpour/, /monsoon/))       if (!existingCauseNames.has('Heavy Rainfall'))          causesToAdd.push({ name: 'Heavy Rainfall',         pct: 70 });
      if (has(/dam\s+breach/, /dam\s+fail/, /dam\s+overflow/, /reservoir\s+breach/))                   if (!existingCauseNames.has('Dam Breach'))              causesToAdd.push({ name: 'Dam Breach',             pct: 85 });
      if (has(/drainage\s+fail/, /blocked\s+drain/, /poor\s+drain/, /sewage\s+overflow/))              if (!existingCauseNames.has('Drainage Failure'))        causesToAdd.push({ name: 'Drainage Failure',       pct: 55 });
      if (has(/deforest/, /soil\s+erosion/))                                                           if (!existingCauseNames.has('Deforestation'))           causesToAdd.push({ name: 'Deforestation',          pct: 40 });
      if (has(/infrastructure\s+fail/, /bridge\s+(?:fail|collaps)/, /road\s+wash/))                   if (!existingCauseNames.has('Infrastructure Failure'))  causesToAdd.push({ name: 'Infrastructure Failure', pct: 50 });
      if (has(/earthquake/, /tremor/, /seismic/))                                                      if (!existingCauseNames.has('Seismic Activity'))        causesToAdd.push({ name: 'Seismic Activity',       pct: 90 });
      if (has(/electrical\s+fault/, /short\s+circuit/, /gas\s+leak/))                                 if (!existingCauseNames.has('Electrical / Gas Fault'))  causesToAdd.push({ name: 'Electrical / Gas Fault', pct: 65 });
      if (has(/cyclone/, /hurricane/, /strong\s+wind/, /storm\s+surge/))                               if (!existingCauseNames.has('Cyclonic Storm'))          causesToAdd.push({ name: 'Cyclonic Storm',         pct: 80 });
      if (causesToAdd.length) { d.causes = [...d.causes, ...causesToAdd]; changed = true; }

      const existingActionLabels = new Set(d.actions.map(a => a.label));
      const newActions = newTasks
        .filter(label => !existingActionLabels.has(label))
        .map(label => ({ label, status: source === 'ai' ? 'AI Decision' : 'Requested', cls: '', iconBg: source === 'ai' ? '#e0f2fe' : '#f0fdf4' }));
      if (newActions.length) { d.actions = [...d.actions, ...newActions]; changed = true; }

      if (changed) {
        const snippet = text.length > 90 ? text.slice(0, 90) + '\u2026' : text;
        const tlEntry = { time: nowStr, title: source === 'ai' ? 'AI Assessment' : 'Field Report', desc: snippet, color: source === 'ai' ? '#6366f1' : '#3b82f6' };
        const alreadyExists = d.timeline.some(e => e.desc === snippet && e.time === nowStr);
        if (!alreadyExists) d.timeline = [tlEntry, ...d.timeline.slice(0, 19)];
        return d;
      }
      return prev;
    });

    if (newTasks.length > 0) {
      setTasks(prev => {
        const existingLabels = new Set(prev.map(t => t.label));
        const fresh = newTasks.filter(label => !existingLabels.has(label)).map(label => ({ label, status: 'running' as const }));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    }
  }, []);

  // ── handleLeave ────────────────────────────────────────────────────────
  const handleLeave = useCallback(async () => {
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
    smoothedUserVisualRmsRef.current = 0;
    aiSmoothedRmsRef.current = 0;
    userAmpRef.current = 0;
    userPitchRef.current = 0;
    aiPitchRef.current = 0;
    barLevelsRef.current.fill(0);
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

  // ── Unified Real Audio-Reactive Analysis & Waveform Renderer ───────────
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      // ── Step 1: Measure Real User Microphone Audio ──
      let rawUserRms = 0;
      if (userAnalyserRef.current && userTimeDataRef.current) {
        userAnalyserRef.current.getByteTimeDomainData(userTimeDataRef.current);
        let sumSq = 0;
        const len = userTimeDataRef.current.length;
        for (let j = 0; j < len; j++) {
          const v = userTimeDataRef.current[j] / 128 - 1;
          sumSq += v * v;
        }
        rawUserRms = Math.sqrt(sumSq / len);
      }
      if (userAnalyserRef.current && userFreqDataRef.current) {
        userAnalyserRef.current.getByteFrequencyData(userFreqDataRef.current);
        const detectedPitch = estimateDominantFrequency(
          userFreqDataRef.current,
          audioCtxRef.current?.sampleRate || 48000,
          userAnalyserRef.current.fftSize
        );
        if (detectedPitch > 0) userPitchRef.current += (detectedPitch - userPitchRef.current) * 0.16;
      }

      // ── Step 2: Measure Real AI Remote Output Audio ──
      let rawAiRms = 0;
      if (aiAnalyserRef.current && aiTimeDataRef.current) {
        aiAnalyserRef.current.getByteTimeDomainData(aiTimeDataRef.current);
        let sumSq = 0;
        const len = aiTimeDataRef.current.length;
        for (let j = 0; j < len; j++) {
          const v = aiTimeDataRef.current[j] / 128 - 1;
          sumSq += v * v;
        }
        rawAiRms = Math.sqrt(sumSq / len);
      }
      if (aiAnalyserRef.current && aiFreqDataRef.current) {
        aiAnalyserRef.current.getByteFrequencyData(aiFreqDataRef.current);
        const detectedPitch = estimateDominantFrequency(
          aiFreqDataRef.current,
          audioCtxRef.current?.sampleRate || 48000,
          aiAnalyserRef.current.fftSize
        );
        if (detectedPitch > 0) aiPitchRef.current += (detectedPitch - aiPitchRef.current) * 0.16;
      }
      // Fallback for AI amplitude from Agora volume indicator if remote audio node is not direct
      const aiVolLevel = aiAmpRef.current / 100;
      const effectiveAiRaw = Math.max(rawAiRms, aiSpeakingRef.current ? Math.max(0.04, aiVolLevel * 0.45) : 0);

      // ── Step 3: Physical Audio Smoothing (Attack 0.35, Release 0.08) ──
      const userAttack = 0.35, userRelease = 0.08;
      smoothedUserRmsRef.current += (rawUserRms - smoothedUserRmsRef.current) * (rawUserRms > smoothedUserRmsRef.current ? userAttack : userRelease);
      const smoothedUserRms = smoothedUserRmsRef.current;

      const localTrackVolume = Number(localAudioTrackRef.current?.getVolumeLevel?.() || 0);
      const effectiveUserVisualRaw = Math.max(
        rawUserRms,
        Math.max(0, Math.min(1, localTrackVolume)) * 0.11,
        (userAmpRef.current / 100) * 0.11
      );
      const visualAttack = 0.56, visualRelease = 0.16;
      smoothedUserVisualRmsRef.current += (effectiveUserVisualRaw - smoothedUserVisualRmsRef.current)
        * (effectiveUserVisualRaw > smoothedUserVisualRmsRef.current ? visualAttack : visualRelease);
      const smoothedUserVisualRms = smoothedUserVisualRmsRef.current;

      const aiAttack = 0.35, aiRelease = 0.08;
      aiSmoothedRmsRef.current += (effectiveAiRaw - aiSmoothedRmsRef.current) * (effectiveAiRaw > aiSmoothedRmsRef.current ? aiAttack : aiRelease);
      const smoothedAiRms = aiSmoothedRmsRef.current;

      // ── Step 4: Calibrated Adaptive Noise Floor ──
      const isQuiet = smoothedUserRms < noiseFloorRef.current * 1.8;
      if (isQuiet || !isSpeakingRef.current) {
        noiseFloorRef.current += (smoothedUserRms - noiseFloorRef.current) * 0.015;
      }
      noiseFloorRef.current = Math.max(0.003, Math.min(0.035, noiseFloorRef.current));
      const noiseFloor = noiseFloorRef.current;

      // ── Step 5: Conservative Speech Gate with Hysteresis ──
      const SPEECH_ON_THRESHOLD  = Math.max(0.020, noiseFloor * 2.8);
      const SPEECH_OFF_THRESHOLD = Math.max(0.011, noiseFloor * 1.6);
      const SPEECH_ATTACK_FRAMES  = 3; // ~50ms confirmation
      const SPEECH_RELEASE_FRAMES = 12; // ~200ms confirmation before releasing

      if (!isSpeakingRef.current) {
        if (smoothedUserRms > SPEECH_ON_THRESHOLD && !isMutedRef.current && isConnectedRef.current && !aiSpeakingRef.current) {
          speakingFramesRef.current++;
        } else {
          speakingFramesRef.current = 0;
        }
        if (speakingFramesRef.current >= SPEECH_ATTACK_FRAMES) {
          isSpeakingRef.current = true;
          setIsSpeaking(true);
          quietFramesRef.current = 0;
        }
      } else {
        if (smoothedUserRms < SPEECH_OFF_THRESHOLD || isMutedRef.current || !isConnectedRef.current) {
          quietFramesRef.current++;
        } else {
          quietFramesRef.current = 0;
        }
        if (quietFramesRef.current >= SPEECH_RELEASE_FRAMES) {
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          speakingFramesRef.current = 0;
        }
      }

      phaseRef.current = (phaseRef.current + 0.05) % (Math.PI * 200);
      const phase = phaseRef.current;

      // ── Step 6: Determine Active Audio Source & Characteristics ──
      const connected = isConnectedRef.current;
      const aiActive = connected && (aiSpeakingRef.current || smoothedAiRms > 0.02);
      const userVisualizationActive = connected && !isMutedRef.current && smoothedUserVisualRms > Math.max(0.006, noiseFloor * 0.8);
      const userActive = userVisualizationActive && !aiActive;

      // ── Step 7: Update Live Mic Level Meter (Direct DOM for 60 FPS performance) ──
      if (micMeterElRef.current) {
        const activeLevel = connected && !isMutedRef.current ? Math.min(1, Math.max(0, (smoothedUserVisualRms - noiseFloor * 0.5) / 0.06)) : 0;
        const totalSegments = 12;
        const activeCount = Math.round(activeLevel * totalSegments);
        const segments = micMeterElRef.current.children;
        for (let s = 0; s < segments.length; s++) {
          const segEl = segments[s] as HTMLElement;
          if (s < activeCount) {
            segEl.style.backgroundColor = s >= 10 ? '#ef4444' : s >= 8 ? '#f59e0b' : '#16a34a';
            segEl.style.opacity = '1';
          } else {
            segEl.style.backgroundColor = '#e5e7eb';
            segEl.style.opacity = '0.4';
          }
        }
      }

      // ── Step 8: High-DPI Real-Time Symmetrical Audio Waveform Renderer ──
      if (waveformCanvasRef.current) {
        const canvas = waveformCanvasRef.current;
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const W = 135, H = 18;
        if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, W, H);

          const barGap = 2;
          const barWidth = 3;
          const centerY  = H / 2;
          const barLevels = barLevelsRef.current;
          const REST_LEVEL = connected && !isMutedRef.current ? 0.008 : 0.004;
          const userPitch = Math.max(0, Math.min(1, (userPitchRef.current - 90) / 720));
          const aiPitch = Math.max(0, Math.min(1, (aiPitchRef.current - 90) / 720));

          for (let i = 0; i < BAR_COUNT; i++) {
            let targetBar = REST_LEVEL;

            if (userActive) {
              // Normalized RMS energy envelope with non-linear perception curve
              const normalizedRms = Math.min(1, Math.max(0, (smoothedUserVisualRms - noiseFloor * 0.5) / 0.055));
              const energy = Math.pow(normalizedRms, 0.45);

              // Symmetrical logarithmic frequency bin distribution
              // Center bars = fundamental voice frequencies (85-300Hz)
              // Outer bars = voice formants & high harmonics (300-3400Hz)
              const dist = i / (BAR_COUNT - 1); // low frequencies at left, harmonics at right
              const binIdx = Math.min(
                (userFreqDataRef.current?.length || 1) - 1,
                Math.floor(Math.pow(dist, 1.4) * 64) + 2
              );
              const freqMag = userFreqDataRef.current ? (userFreqDataRef.current[binIdx] || 0) / 255 : 0;
              const freqEnergy = Math.pow(freqMag, 1.2);
              const timeEnergy = getTimeDomainBandEnergy(userTimeDataRef.current, i, BAR_COUNT);
              const bandEnergy = Math.max(freqEnergy, timeEnergy);

              const pitchShape = 0.72 + userPitch * 0.5;
              targetBar = REST_LEVEL + energy * (0.22 + bandEnergy * 0.78) * pitchShape;
              targetBar = Math.min(1, Math.max(REST_LEVEL, targetBar));

              // Fast attack, smooth decay
              const ATTACK = 0.5, RELEASE = 0.14;
              barLevels[i] += (targetBar - barLevels[i]) * (targetBar > barLevels[i] ? ATTACK : RELEASE);

            } else if (aiActive) {
              // Real AI Audio Spectrum or smooth harmonic envelope
              const normalizedAiRms = Math.min(1, Math.max(0, smoothedAiRms / 0.20));
              const aiEnergy = Math.pow(normalizedAiRms, 0.65);

              const dist = i / (BAR_COUNT - 1);
              let aiFreqMag = 0;
              if (aiFreqDataRef.current && aiFreqDataRef.current.length > 0) {
                const binIdx = Math.min(aiFreqDataRef.current.length - 1, Math.floor(Math.pow(dist, 1.4) * 64) + 2);
                aiFreqMag = (aiFreqDataRef.current[binIdx] || 0) / 255;
              } else {
                // Keep the fallback quiet and pitch-shaped until remote FFT data arrives.
                aiFreqMag = 0.18 + (1 - dist) * 0.24 + aiPitch * 0.18;
              }

              const pitchShape = 0.72 + aiPitch * 0.5;
              targetBar = REST_LEVEL + aiEnergy * (0.28 + aiFreqMag * 0.58) * pitchShape;
              targetBar = Math.min(1, Math.max(REST_LEVEL, targetBar));

              const ATTACK = 0.5, RELEASE = 0.14;
              barLevels[i] += (targetBar - barLevels[i]) * (targetBar > barLevels[i] ? ATTACK : RELEASE);

            } else if (connected && !isMutedRef.current) {
              // Standby / Silence: Smooth natural decay to minimal resting line (no fake looping wave)
              targetBar = REST_LEVEL;
              const RELEASE = 0.08;
              barLevels[i] += (targetBar - barLevels[i]) * RELEASE;

            } else {
              // Muted / Disconnected: flat quiet resting baseline
              barLevels[i] += (targetBar - barLevels[i]) * 0.08;
            }

            const barH = Math.max(0.8, Math.min(H - 4, barLevels[i] * (H - 4)));
            const x = i * (barWidth + barGap);
            const y = centerY - barH / 2;

            // Color scheme matching state
            if (userActive || aiActive) {
              ctx.fillStyle = '#FD4F30';
            } else if (connected && !isMutedRef.current) {
              ctx.fillStyle = 'rgba(255, 72, 26, 0.62)';
            } else if (isMutedRef.current) {
              ctx.fillStyle = 'rgba(255, 72, 26, 0.48)';
            } else {
              ctx.fillStyle = 'rgba(255, 72, 26, 0.82)';
            }

            ctx.beginPath();
            const radius = Math.min(barWidth / 2, barH / 2);
            if (typeof (ctx as any).roundRect === 'function') {
              (ctx as any).roundRect(x, y, barWidth, barH, radius);
            } else {
              ctx.rect(x, y, barWidth, barH);
            }
            ctx.fill();
          }

          ctx.restore();
        }
      }

      // Glow canvas — kept off-screen for backward-compat
      if (glowCanvasRef.current) {
        const rgb: [number, number, number] = aiActive ? [96, 165, 250] : [148, 163, 184];
        drawGlowRing(glowCanvasRef.current, aiActive ? smoothedAiRms * 0.9 : 0, phase, rgb, aiActive, connected);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── handleJoin ─────────────────────────────────────────────────────────
  const handleJoin = async () => {
    if (!channelName.trim()) { addLog('Error: Channel name cannot be empty.'); return; }
    setIncidentData(null); setTasks([]); setTranscript([]); setActionStates({});
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
        if (Number(user.uid) === 9999) { setRemoteAgentPresent(true); addLog('✨ [Agora ConvoAI] Gemini Live Agent (UID 9999) joined.'); }
        await client.subscribe(user, mediaType as 'audio' | 'video');
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
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
          aiPitchRef.current = 0;
          if (aiSourceRef.current) { try { aiSourceRef.current.disconnect(); } catch {} }
          aiSourceRef.current = null;
          aiAnalyserRef.current = null;
          aiTimeDataRef.current = null;
          aiFreqDataRef.current = null;
          if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
          addLog('ℹ️ Gemini Live Agent (UID 9999) left the channel.');
        }
      });

      await client.join(app_id, channelName, token, uid);
      setConnectionState('CONNECTED');
      setWaveStartedAt(Date.now());

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
          aiSpeakingTimerRef.current = setTimeout(() => { setAiSpeaking(false); aiAmpRef.current = 0; aiSpeakingTimerRef.current = null; }, 400);
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

      client.on('stream-message', (uid: number, data: Uint8Array) => {
        const raw = new TextDecoder('utf-8').decode(data);
        try {
          const msg = JSON.parse(raw);
          const content = msg.text ?? msg.transcript ?? null;
          if (content && content.length > 3) { addTranscriptEntryRef.current('AI Agent', content); extractIncidentInfo(content, 'ai'); }
        } catch {}
      });

      const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
      if (SpeechRecognitionClass) {
        const rec = new SpeechRecognitionClass();
        rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) continue;
            const text = event.results[i][0].transcript.trim();
            if (text.length < 3) continue;
            addTranscriptEntryRef.current('You', text);
            extractIncidentInfo(text, 'user');
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
        body: JSON.stringify({ channel_name: channelName.trim(), agent_uid: 9999, voice: selectedVoice }),
      });
      const data = await res.json();
      setAgentId(data.agent_id); setAgentStatus('RUNNING');
      addLog('✅ Gemini Live Agent dispatched!');
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

  const handleCommandSubmit = () => {
    if (!commandInput.trim()) return;
    const text = commandInput.trim();
    addTranscriptEntry('You', text); extractIncidentInfo(text); setCommandInput('');
  };

  const handleResetIncident = () => {
    setIncidentData(null); setTasks([]); setTranscript([]); setActionStates({});
    addLog('Incident data, tasks, and transcript reset.');
  };

  // ── Computed state ─────────────────────────────────────────────────────
  const isConnected  = connectionState === 'CONNECTED';
  const isConnecting = connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING';
  const now = currentTime || new Date();
  const waveDuration = waveStartedAt ? Math.max(0, Math.floor((now.getTime() - waveStartedAt) / 1000)) : 0;
  const waveTimeLabel = `${String(Math.floor(waveDuration / 60)).padStart(2, '0')}:${String(waveDuration % 60).padStart(2, '0')}`;

  const voiceState =
    connectionState === 'ERROR' ? 'error'
    : isConnecting ? 'connecting'
    : connectionState !== 'CONNECTED' ? 'disconnected'
    : aiSpeaking ? 'ai-speaking'
    : isSpeaking && !isMuted ? 'listening'
    : isMuted ? 'muted'
    : 'standby';

  const statusLabel =
    voiceState === 'error' ? 'Connection error' :
    voiceState === 'connecting' ? 'Connecting...' :
    voiceState === 'disconnected' ? 'Ready to connect' :
    voiceState === 'ai-speaking' ? 'Tocsin is speaking' :
    voiceState === 'listening' ? 'Listening' :
    voiceState === 'muted' ? 'Microphone muted' :
    'Standby';

  const statusSub =
    voiceState === 'error' ? 'Check connection and try again' :
    voiceState === 'connecting' ? 'Establishing secure voice channel...' :
    voiceState === 'disconnected' ? 'Join the emergency channel to begin' :
    voiceState === 'ai-speaking' ? 'Tocsin is responding to your report' :
    voiceState === 'listening' ? 'Transcribing live audio...' :
    voiceState === 'muted' ? 'Unmute microphone to speak' :
    'Waiting for voice input from field operators';

  const statusColor =
    voiceState === 'error' ? '#dc2626' :
    voiceState === 'connecting' ? '#6366f1' :
    voiceState === 'disconnected' ? '#9ca3af' :
    voiceState === 'ai-speaking' ? '#6366f1' :
    voiceState === 'listening' ? '#16a34a' :
    voiceState === 'muted' ? '#ef4444' :
    '#6b7280';

  const sevStyle = (sev: string): { bg: string; text: string; border: string } => {
    switch (sev) {
      case 'CRITICAL': return { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' };
      case 'HIGH':     return { bg: '#fffbeb', text: '#d97706', border: '#fde68a' };
      case 'MEDIUM':   return { bg: '#fefce8', text: '#ca8a04', border: '#fde047' };
      case 'LOW':      return { bg: '#eff6ff', text: '#2563eb', border: '#bfdbfe' };
      default:         return { bg: '#f4f4f5', text: '#71717a', border: '#e4e4e7' };
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
      {/* ── Off-screen glow canvas kept for backward compatibility ── */}
      <canvas ref={glowCanvasRef} width={220} height={220} aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', top: '-9999px', pointerEvents: 'none' }} />

      <style suppressHydrationWarning>{`
        /* ── Reset & root ── */
        .vcc-root {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #f2f1ef;
          min-height: 100vh;
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
        .vcc-panel-scroll::-webkit-scrollbar { width: 4px; }
        .vcc-panel-scroll::-webkit-scrollbar-thumb { background: #d8d8d8; border-radius: 2px; }

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
        .vcc-transcript::-webkit-scrollbar { width: 3px; }
        .vcc-transcript::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 2px; }
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
        .vcc-msg.you { border-left: 3px solid #16a34a; }
        .vcc-msg.ai  { border-left: 3px solid #6366f1; }
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
        .vcc-msg-speaker.you { background: #f0fdf4; color: #16a34a; }
        .vcc-msg-speaker.ai  { background: #eef2ff; color: #6366f1; }
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
        .vcc-cmd-send:hover { opacity: 0.8; transform: scale(1.05); }
        .vcc-cmd-send:active { transform: scale(0.95); }

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
        }

        /* ── Focused Voice Interaction Box (No giant empty orb) ── */
        .vcc-interaction-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          width: 100%;
          max-width: 360px;
          background: #ffffff;
          border: 1px solid #e8e8e8;
          border-radius: 14px;
          padding: 24px 20px 20px;
          box-shadow: 0 1px 6px rgba(0,0,0,0.04);
        }

        .vcc-card-top {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          width: 100%;
        }
        .vcc-badge-header {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6b7280;
          margin-bottom: 2px;
        }

        /* ── Status title & subtitle ── */
        .vcc-status-title {
          font-size: 17px;
          font-weight: 700;
          color: #1a1a1a;
          letter-spacing: -0.02em;
          text-align: center;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .vcc-status-dot {
          width: 9px; height: 9px;
          border-radius: 50%;
          background: ${statusColor};
          flex-shrink: 0;
          box-shadow: ${voiceState === 'listening' ? '0 0 10px #16a34a' : voiceState === 'ai-speaking' ? '0 0 10px #6366f1' : 'none'};
          animation: ${voiceState === 'listening' || voiceState === 'ai-speaking' ? 'vcc-pulse-dot 1.2s ease-in-out infinite' : 'none'};
        }
        @keyframes vcc-pulse-dot {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.7; }
        }

        .vcc-status-desc {
          font-size: 11.5px;
          color: #9b9b9b;
          text-align: center;
          line-height: 1.4;
          max-width: 260px;
        }

        /* ── Waveform Canvas Container ── */
        .vcc-waveform-box {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: center;
          gap: 0;
          width: 200px;
          height: 28px;
          padding: 0 10px;
          box-sizing: border-box;
          background: #000000;
          border: 0;
          border-radius: 999px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.18);
        }
        .vcc-wave-canvas {
          display: block;
          width: 135px;
          height: 18px;
          flex: 0 0 135px;
        }
        .vcc-wave-time {
          min-width: 35px;
          color: #FD4F30;
          font-family: Inter, sans-serif;
          font-size: 12px;
          font-weight: 600;
          line-height: 16px;
          font-variant-numeric: tabular-nums;
          letter-spacing: normal;
          text-align: right;
        }
        .vcc-waveform-box .vcc-meter-row,
        .vcc-waveform-box .vcc-vad-row {
          display: none;
        }

        /* ── Live Mic Level Meter (12 discrete segments) ── */
        .vcc-meter-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 320px;
          padding: 0 4px;
        }
        .vcc-meter-label {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #9ca3af;
        }
        .vcc-led-track {
          display: flex;
          gap: 3px;
          align-items: center;
        }
        .vcc-led-seg {
          width: 12px;
          height: 5px;
          border-radius: 1.5px;
          background: #e5e7eb;
          opacity: 0.4;
          transition: background-color 0.08s ease, opacity 0.08s ease;
        }

        /* ── Speech Detection / VAD Meter ── */
        .vcc-vad-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 320px;
          padding: 0 4px;
          font-size: 10px;
          color: #6b7280;
        }
        .vcc-vad-track {
          width: 140px;
          height: 4px;
          background: #ebebeb;
          border-radius: 2px;
          overflow: hidden;
        }
        .vcc-vad-fill {
          height: 100%;
          border-radius: 2px;
          background: #6366f1;
          transition: width 0.1s ease;
        }

        /* ── Microphone button ── */
        .vcc-mic-section {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .vcc-mic-btn {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 2px solid #e2e8f0;
          background: #ffffff;
          color: #4a4a4a;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.18s cubic-bezier(0.16,1,0.3,1);
          box-shadow: 0 1px 4px rgba(0,0,0,0.06);
          outline: none;
        }
        .vcc-mic-btn:hover:not(:disabled) {
          border-color: #6366f1;
          color: #6366f1;
          transform: translateY(-1.5px);
          box-shadow: 0 4px 12px rgba(99,102,241,0.18);
        }
        .vcc-mic-btn:active:not(:disabled) {
          transform: scale(0.95);
        }
        .vcc-mic-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 3px; }
        .vcc-mic-btn.active-listening {
          border-color: #16a34a;
          color: #16a34a;
          box-shadow: 0 0 14px rgba(22, 163, 74, 0.25);
        }
        .vcc-mic-btn.muted {
          background: #fef2f2;
          border-color: #fecaca;
          color: #dc2626;
        }
        .vcc-mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .vcc-mic-hint {
          font-size: 10px;
          color: #9ca3af;
          font-weight: 500;
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
        }
        .vcc-right-inner {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
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
          background: ${incidentData ? '#fee2e2' : '#f4f4f5'};
          color: ${incidentData ? '#dc2626' : '#a0a0a0'};
        }
        .vcc-incident-title {
          font-size: 14px;
          font-weight: 700;
          color: ${incidentData ? '#1a1a1a' : '#b0b0b0'};
          margin-bottom: 3px;
          line-height: 1.3;
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
          .vcc-status-dot { animation: none !important; }
          .vcc-sys-dot    { animation: none !important; }
          @keyframes vcc-pulse-dot {}
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
            <span className="vcc-topbar-badge">Voice Command Center</span>
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
              <span className="vcc-left-title">AI Response Agent</span>
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
                      {isConnected ? 'Speak to begin real-time transcription' : 'Join the emergency channel to begin'}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: 11, color: '#6366f1', fontStyle: 'italic' }}>
                    <span style={{ display: 'flex', gap: 3 }}>
                      {[0, 0.2, 0.4].map((d, i) => (
                        <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#6366f1', display: 'inline-block', animation: `vcc-blink 1s ${d}s ease-in-out infinite` }} />
                      ))}
                    </span>
                    Tocsin is responding...
                  </div>
                )}
              </div>
            </div>

            {/* Controls area */}
            <div className="vcc-left-controls">
              {/* Voice channel */}
              <div className="vcc-card-sm">
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

              {/* Gemini Agent (only when connected) */}
              {isConnected && (
                <div className="vcc-card-sm">
                  <div className="vcc-section-label">Gemini Agent</div>
                  <div className="vcc-btn-row" style={{ alignItems: 'center' }}>
                    <select
                      className="vcc-select"
                      value={selectedVoice}
                      onChange={e => setSelectedVoice(e.target.value)}
                      disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}
                      aria-label="Select agent voice"
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
                  placeholder="Describe the incident or type a command..."
                  value={commandInput}
                  onChange={e => setCommandInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCommandSubmit()}
                  aria-label="Type incident description or command"
                />
                <button className="vcc-cmd-send" onClick={handleCommandSubmit} aria-label="Send command">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>
            </div>
          </aside>

          {/* ════════════════════ CENTER PANEL (FOCUSED VOICE INTERACTION) ════════════════════ */}
          <main className="vcc-panel vcc-center" role="main">
            <div className="vcc-center-inner">
              <div className="vcc-interaction-card">

                {/* Header & Status */}
                <div className="vcc-card-top">
                  <span className="vcc-badge-header">Voice Interaction</span>
                  <div className="vcc-status-title">
                    <span className="vcc-status-dot" />
                    {statusLabel}
                  </div>
                  <div className="vcc-status-desc">{statusSub}</div>
                </div>

                {/* ── Focal High-DPI Audio Equalizer Waveform Canvas ── */}
                <div className="vcc-waveform-box">
                  <canvas
                    ref={waveformCanvasRef}
                    className="vcc-wave-canvas"
                    width={135}
                    height={18}
                    aria-label="Real-time voice waveform equalizer"
                  />
                  <span className="vcc-wave-time" aria-label={`Voice session duration ${waveTimeLabel}`}>
                    {waveTimeLabel}
                  </span>

                  {/* ── Live Mic Audio Level Meter (12 discrete segments) ── */}
                  <div className="vcc-meter-row">
                    <span className="vcc-meter-label">Mic Level</span>
                    <div ref={micMeterElRef} className="vcc-led-track" aria-label="Microphone input level">
                      {Array.from({ length: 12 }).map((_, idx) => (
                        <div key={idx} className="vcc-led-seg" />
                      ))}
                    </div>
                  </div>

                  {/* ── VAD Speech Detection Probability ── */}
                  {isConnected && vadStatus === 'READY' && (
                    <div className="vcc-vad-row">
                      <span className="vcc-meter-label">Speech Detection</span>
                      <div className="vcc-vad-track" role="progressbar" aria-valuenow={speechProbability} aria-valuemin={0} aria-valuemax={100}>
                        <div className="vcc-vad-fill" style={{ width: `${speechProbability}%` }} />
                      </div>
                      <span style={{ fontSize: 9.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: 26, textAlign: 'right' }}>
                        {speechProbability}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Tactical Microphone Button */}
                <div className="vcc-mic-section">
                  <button
                    className={`vcc-mic-btn ${isSpeaking && !isMuted ? 'active-listening' : isMuted ? 'muted' : ''}`}
                    onClick={handleToggleMute}
                    disabled={!isConnected}
                    aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                    title={!isConnected ? 'Connect first' : isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="1" y1="1" x2="23" y2="23"/>
                        <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
                        <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/>
                        <line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="23" x2="16" y2="23"/>
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"/>
                        <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="22"/>
                      </svg>
                    )}
                  </button>
                  <span className="vcc-mic-hint">
                    {!isConnected ? 'Join channel to speak' : isMuted ? 'Microphone muted (click to unmute)' : isSpeaking ? 'Transcribing...' : 'Microphone active'}
                  </span>
                </div>

              </div>
            </div>

            {/* System status */}
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

                {/* ── Incident Status ── */}
                <div className="vcc-incident-card">
                  <div className="vcc-incident-row">
                    <div className="vcc-incident-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="vcc-incident-title">
                        {incidentData?.title ?? 'Awaiting incident information'}
                      </div>
                      <div className="vcc-incident-loc">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#9b9b9b" strokeWidth="2.5">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
                        </svg>
                        {incidentData?.location ?? 'Location not yet determined'}
                      </div>
                      <div className="vcc-incident-id">{incidentData?.incidentId ?? '—'}</div>
                    </div>
                  </div>

                  {incidentData && (
                    <div className="vcc-incident-chips">
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Severity</span>
                        {incidentData.severity ? (
                          <span className="vcc-chip" style={{ background: sevStyle(incidentData.severity).bg, color: sevStyle(incidentData.severity).text, border: `1px solid ${sevStyle(incidentData.severity).border}` }}>
                            {incidentData.severity}
                          </span>
                        ) : (
                          <span className="vcc-chip" style={{ background: '#f4f4f5', color: '#9b9b9b' }}>Unknown</span>
                        )}
                      </div>
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Status</span>
                        <span className="vcc-chip" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>{incidentData.status}</span>
                      </div>
                      <div className="vcc-chip-group">
                        <span className="vcc-chip-meta">Started</span>
                        <span style={{ fontSize: 11.5, color: '#4a4a4a', fontWeight: 500 }}>{incidentData.startedAt}</span>
                      </div>
                    </div>
                  )}

                  {incidentData && (
                    <div className="vcc-inferred-note">
                      ⚠ All values are AI-inferred from voice — verify before operational action
                    </div>
                  )}

                  {incidentData && (
                    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={handleResetIncident} className="vcc-btn" style={{ fontSize: 10, padding: '3px 8px' }}>
                        Reset Incident
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Live Situation ── */}
                <div className="vcc-section-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div className="vcc-section-label" style={{ margin: 0 }}>Live Situation</div>
                    <span style={{ fontSize: 9.5, color: '#b0b0b0', fontStyle: 'italic' }}>AI Inferred</span>
                  </div>
                  <div className="vcc-metric-grid">
                    <div className="vcc-metric-item">
                      <div className="vcc-metric-label">People Affected</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.peopleAffected ? 'placeholder' : ''}`}>
                        {incidentData?.metrics.peopleAffected || '—'}
                      </div>
                      <div className={`vcc-metric-sub ${incidentData?.metrics.peopleAffectedSub?.includes('Trapped') ? 'alert' : ''}`}>
                        {incidentData?.metrics.peopleAffectedSub || 'Awaiting data'}
                      </div>
                    </div>
                    <div className="vcc-metric-item">
                      <div className="vcc-metric-label">Water Level</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.waterLevel ? 'placeholder' : ''}`} style={{ fontSize: incidentData?.metrics.waterLevel && incidentData.metrics.waterLevel.length > 5 ? 15 : 20 }}>
                        {incidentData?.metrics.waterLevel || '—'}
                      </div>
                      <div className={`vcc-metric-sub ${incidentData?.metrics.waterLevelSub?.includes('Rising') || incidentData?.metrics.waterLevelSub?.includes('Critical') ? 'alert' : ''}`}>
                        {incidentData?.metrics.waterLevelSub || 'Unconfirmed'}
                      </div>
                    </div>
                    <div className="vcc-metric-item">
                      <div className="vcc-metric-label">Risk Level</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.riskLevel ? 'placeholder' : ''}`}
                        style={{ fontSize: 15, color: incidentData?.metrics.riskLevel === 'Critical' ? '#dc2626' : incidentData?.metrics.riskLevel === 'High' ? '#d97706' : '#1a1a1a' }}>
                        {incidentData?.metrics.riskLevel || '—'}
                      </div>
                    </div>
                    <div className="vcc-metric-item">
                      <div className="vcc-metric-label">Resources</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.resourcesDeployed ? 'placeholder' : ''}`} style={{ fontSize: incidentData?.metrics.resourcesDeployed && incidentData.metrics.resourcesDeployed.length > 4 ? 13 : 20 }}>
                        {incidentData?.metrics.resourcesDeployed || '—'}
                      </div>
                      <div className="vcc-metric-sub">{incidentData?.metrics.resourcesSub || 'Standby'}</div>
                    </div>
                  </div>
                </div>

                {/* ── Possible Causes ── */}
                {(incidentData?.causes?.length ?? 0) > 0 && (
                  <div className="vcc-section-card">
                    <div className="vcc-section-label">Possible Causes <span style={{ fontWeight: 400, fontSize: 9, letterSpacing: 0, textTransform: 'none', color: '#c0c0c0', marginLeft: 4 }}>Hypotheses</span></div>
                    {incidentData!.causes.map(h => (
                      <div className="vcc-hypo" key={h.name}>
                        <div className="vcc-hypo-row">
                          <span className="vcc-hypo-name">{h.name}</span>
                          <span className="vcc-hypo-pct">{h.pct}%</span>
                        </div>
                        <div className="vcc-bar-track">
                          <div className="vcc-bar-fill" style={{ width: `${h.pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Incident Timeline ── */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">Incident Timeline</div>
                  {(incidentData?.timeline?.length ?? 0) > 0 ? (
                    <div className="vcc-tl">
                      {incidentData!.timeline.map((item, i, arr) => (
                        <div className="vcc-tl-row" key={i}>
                          <div className="vcc-tl-time">{item.time}</div>
                          <div className="vcc-tl-mid">
                            <div className="vcc-tl-dot" style={{ background: item.color }} />
                            {i < arr.length - 1 && <div className="vcc-tl-line" />}
                          </div>
                          <div className="vcc-tl-body" style={{ paddingBottom: i < arr.length - 1 ? 10 : 0 }}>
                            <div className="vcc-tl-title">{item.title}</div>
                            <div className="vcc-tl-desc" title={item.desc}>{item.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="vcc-empty">Waiting for incident information...</p>
                  )}
                </div>

                {/* ── Response & Actions ── */}
                <div className="vcc-section-card">
                  <div className="vcc-section-label">Response &amp; Actions</div>
                  {(incidentData?.actions?.length ?? 0) > 0 ? (
                    incidentData!.actions.map(action => {
                      const aState = actionStates[action.label];
                      return (
                        <div className="vcc-action-item" key={action.label}>
                          <div className="vcc-action-top">
                            <div className="vcc-action-icon" style={{ background: action.iconBg }}>
                              {aState === 'confirmed' ? '✓' : aState === 'rejected' ? '✕' : '⚡'}
                            </div>
                            <span className="vcc-action-label">{action.label}</span>
                            <span className="vcc-action-status-badge" style={{
                              background: aState === 'confirmed' ? '#f0fdf4' : aState === 'rejected' ? '#fef2f2' : action.status === 'AI Decision' ? '#eef2ff' : '#f0fdf4',
                              color: aState === 'confirmed' ? '#16a34a' : aState === 'rejected' ? '#dc2626' : action.status === 'AI Decision' ? '#6366f1' : '#16a34a',
                              border: `1px solid ${aState === 'confirmed' ? '#bbf7d0' : aState === 'rejected' ? '#fecaca' : action.status === 'AI Decision' ? '#c7d2fe' : '#bbf7d0'}`,
                            }}>
                              {aState === 'confirmed' ? 'Confirmed' : aState === 'rejected' ? 'Rejected' : action.status}
                            </span>
                          </div>

                          {/* Confirm / Reject only for unresolved AI-recommended actions */}
                          {!aState && (action.status === 'AI Decision' || action.status === 'Requested') && (
                            <div style={{ display: 'flex', gap: 6, paddingLeft: 36 }}>
                              <button
                                className="vcc-btn vcc-btn-confirm"
                                onClick={() => setActionStates(prev => ({ ...prev, [action.label]: 'confirmed' }))}
                                aria-label={`Confirm action: ${action.label}`}
                              >
                                ✓ Confirm
                              </button>
                              <button
                                className="vcc-btn vcc-btn-reject"
                                onClick={() => setActionStates(prev => ({ ...prev, [action.label]: 'rejected' }))}
                                aria-label={`Reject action: ${action.label}`}
                              >
                                ✕ Reject
                              </button>
                            </div>
                          )}
                          {aState === 'confirmed' && (
                            <div className="vcc-action-confirmed-note" style={{ paddingLeft: 36 }}>
                              Confirmed by operator — awaiting operational execution
                            </div>
                          )}
                          {aState === 'rejected' && (
                            <div className="vcc-action-rejected-note" style={{ paddingLeft: 36 }}>
                              Rejected by operator
                            </div>
                          )}
                        </div>
                      );
                    })
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
          {incidentData && <span>{transcript.length} utterance{transcript.length !== 1 ? 's' : ''} · {incidentData.timeline.length} timeline event{incidentData.timeline.length !== 1 ? 's' : ''}</span>}
          {tasks.length > 0 && <span>{tasks.length} task{tasks.length !== 1 ? 's' : ''} detected</span>}
        </footer>
      </div>
    </>
  );
}
