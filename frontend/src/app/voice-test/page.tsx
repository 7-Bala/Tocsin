'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DynamicSituationTiles } from '@/components/DynamicSituationTiles';

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
  const [remoteAgentPresent, setRemoteAgentPresent] = useState(false);
  const [logs,               setLogs]              = useState<string[]>([]);
  const [tokenDetails,       setTokenDetails]      = useState<{
    uid?: number | string; channel?: string; expiresIn?: number;
  } | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [isAwaitingReply, setIsAwaitingReply] = useState(false);
  const [isMounted,    setIsMounted]    = useState(false);
  // Dark-launch flag for the new dynamic-tiles panel (item 1, step 3 of
  // docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md). Read from window.location rather
  // than Next's useSearchParams() to avoid both a Suspense-boundary requirement and
  // any risk of reintroducing the SSR/hydration mismatch fixed elsewhere this session
  // — starts false on every render (server and first client paint match), flips true
  // only after mount, same pattern as `isMounted` above.
  const [showDynamicTiles, setShowDynamicTiles] = useState(false);
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
      if (!detectedType && has(/login/, /authentication/, /identity-service/, /identity service/)) detectedType = 'Identity Service Outage';
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

      const waterNum = text.match(/([\d]+(?:\.[\d]+)?)\s*%\s*(?:of\s+)?(?:login|authentication|identity|requests?|errors?|failures?)/i)
                    || text.match(/([\d]+(?:\.[\d]+)?)\s*(m\b|meter|metre|meters|metres|ft\b|feet|foot|cm\b|centimeter)\s*(?:of\s+)?(?:water|flood|inundation)?/i)
                    || text.match(/(?:water|flood|river|level|risen?|rise)\s+(?:level\s+)?(?:to|of|by|at|is|around|about|reached?|stands?\s+at)?\s*([\d]+(?:\.[\d]+)?)\s*(m\b|meter|metre|ft\b|feet|cm\b)/i);
      if (waterNum) {
        const val = waterNum[1], rawUnit = (waterNum[2] || '%').toLowerCase();
        const unit = rawUnit === '%' ? '%' : rawUnit.startsWith('m') ? 'm' : rawUnit.startsWith('f') ? 'ft' : 'cm';
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
    try {
      setShowDynamicTiles(new URLSearchParams(window.location.search).get('debug_tiles') === '1');
    } catch {
      // Non-fatal: dark-launch flag simply stays off.
    }
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
          if (content && content.length > 3) {
            addTranscriptEntryRef.current('AI Agent', content);
            extractIncidentInfo(content, 'ai');
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
            const text = event.results[i][0].transcript.trim();
            if (text.length < 3) continue;
            addTranscriptEntryRef.current('You', text);
            extractIncidentInfo(text, 'user');
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
    extractIncidentInfo(text);
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

  const handleResetIncident = () => {
    setIncidentData(null); setTasks([]); setTranscript([]); setActionStates({});
    addLog('Incident data, tasks, and transcript reset.');
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
                        {incidentData?.title ?? 'Customer Login and Identity Outage'}
                      </div>
                      <div className="vcc-incident-loc">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#9b9b9b" strokeWidth="2.5">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
                        </svg>
                        {incidentData?.location ?? 'Identity service · Multiple regions'}
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
                      <div className="vcc-metric-label">Customers Affected</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.peopleAffected ? 'placeholder' : ''}`}>
                        {incidentData?.metrics.peopleAffected || '—'}
                      </div>
                      <div className={`vcc-metric-sub ${incidentData?.metrics.peopleAffectedSub?.includes('Trapped') ? 'alert' : ''}`}>
                        {incidentData?.metrics.peopleAffectedSub || 'Awaiting data'}
                      </div>
                    </div>
                    <div className="vcc-metric-item">
                      <div className="vcc-metric-label">Gateway Error Rate</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.waterLevel ? 'placeholder' : ''}`} style={{ fontSize: incidentData?.metrics.waterLevel && incidentData.metrics.waterLevel.length > 5 ? 15 : 20 }}>
                        {incidentData?.metrics.waterLevel || '—'}
                      </div>
                      <div className={`vcc-metric-sub ${incidentData?.metrics.waterLevelSub?.includes('Rising') || incidentData?.metrics.waterLevelSub?.includes('Critical') ? 'alert' : ''}`}>
                        {incidentData?.metrics.waterLevelSub || 'Awaiting telemetry'}
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
                      <div className="vcc-metric-label">Service Health</div>
                      <div className={`vcc-metric-value ${!incidentData?.metrics.resourcesDeployed ? 'placeholder' : ''}`} style={{ fontSize: incidentData?.metrics.resourcesDeployed && incidentData.metrics.resourcesDeployed.length > 4 ? 13 : 20 }}>
                        {incidentData?.metrics.resourcesDeployed || '—'}
                      </div>
                      <div className="vcc-metric-sub">{incidentData?.metrics.resourcesSub || 'Awaiting telemetry'}</div>
                    </div>
                  </div>
                </div>

                {/* ── Dynamic Situation Tiles (dark-launch, item 1 step 3) ──
                    Rendered ONLY behind ?debug_tiles=1, alongside the panel above,
                    not replacing it. See docs/strategy/VOICE_TEST_DYNAMIC_TILES_PLAN.md
                    §9 step 3: verify against the real running backend before step 4
                    swaps the visible panel over and deletes extractIncidentInfo(). */}
                {isMounted && showDynamicTiles && (
                  <div>
                    <div
                      style={{
                        fontSize: 9,
                        color: '#a78bfa',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      ⚙ Debug: Dynamic Tiles (real backend data)
                    </div>
                    <DynamicSituationTiles />
                  </div>
                )}

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
