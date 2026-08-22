'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// Canvas-based soft glow ring — the reference-style audio-reactive halo.
// Draws N overlapping radial gradient blobs around the circle circumference.
// Overlapping alphas fuse into one continuous soft glow; amplitude pushes
// individual blobs outward for a fluid, organic deformation effect.
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

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const circleR = 75; // must match .vt-ai-circle div radius (150px / 2)

  ctx.clearRect(0, 0, W, H);

  const [r, g, b] = rgb;
  const N = 90; // higher angular resolution for smoother ring

  // Very thin, soft, subtle, and smooth
  const baseAlpha = isActive ? 0.035 + amplitude * 0.05 : isConnected ? 0.015 : 0.005;
  const spread    = isActive ? 10 + amplitude * 10 : isConnected ? 6 : 4;
  const rotOffset = phase * 0.2; // slower rotation

  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + rotOffset;

    let dr = 0;
    if (isActive && amplitude > 0.004) {
      // Subtler, lower frequency deformation
      const w1 = Math.sin(angle * 2 + phase * 1.2) * 1.5;
      const w2 = Math.cos(angle * 4 - phase * 0.9) * 1.0;
      const w3 = Math.sin(angle * 6 + phase * 1.5) * 0.5;
      dr = (w1 + w2 + w3) * amplitude * 4.5;
    } else if (isConnected) {
      // Micro-idle breath even when not speaking
      dr = Math.sin(angle * 2 + phase * 0.2) * 0.4;
    }

    const glowR  = circleR + 2 + Math.max(-2, dr);
    const blobX  = cx + glowR * Math.cos(angle);
    const blobY  = cy + glowR * Math.sin(angle);
    const blobSz = spread + Math.max(0, dr * 0.5);

    // Each blob: tight core fading to full transparency at blobSz radius
    const grad = ctx.createRadialGradient(blobX, blobY, 0, blobX, blobY, blobSz);
    const peak = Math.min(0.6, baseAlpha * 3.0);
    const mid  = Math.min(0.3, baseAlpha * 1.5);
    grad.addColorStop(0,    `rgba(${r},${g},${b},${peak})`);
    grad.addColorStop(0.4,  `rgba(${r},${g},${b},${mid})`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(blobX, blobY, blobSz, 0, Math.PI * 2);
    ctx.fill();
  }
}


type ConnectionState =
  | 'DISCONNECTED'
  | 'FETCHING_TOKEN'
  | 'JOINING'
  | 'CONNECTED'
  | 'ERROR';

type VadModelStatus = 'UNLOADED' | 'LOADING' | 'READY' | 'ERROR';
type AgentStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';

type TranscriptEntry = {
  id: string;
  speaker: 'You' | 'AI Agent';
  text: string;
  time: string;
};

export default function VoiceTestPage() {
  const [channelName, setChannelName] = useState('tocsin-emergency-room');
  const [connectionState, setConnectionState] = useState<ConnectionState>('DISCONNECTED');
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [speechProbability, setSpeechProbability] = useState(0);
  const [vadStatus, setVadStatus] = useState<VadModelStatus>('UNLOADED');
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('STOPPED');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('Puck');
  const [remoteAgentPresent, setRemoteAgentPresent] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [tokenDetails, setTokenDetails] = useState<{
    uid?: number | string;
    channel?: string;
    expiresIn?: number;
  } | null>(null);
  const [commandInput, setCommandInput] = useState('');
  const [isMounted, setIsMounted] = useState(false);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef<boolean>(false);

  // ─── Persistent incident state ─────────────────────────────────────────────
  const [incidentData, setIncidentData] = useState<{
    title: string;
    location: string;
    incidentId: string;
    severity: string;
    status: string;
    startedAt: string;
    metrics: {
      peopleAffected: string;
      peopleAffectedSub: string;
      waterLevel: string;
      waterLevelSub: string;
      riskLevel: string;
      resourcesDeployed: string;
      resourcesSub: string;
    };
    timeline: Array<{ time: string; title: string; desc: string; color: string }>;
    causes: Array<{ name: string; pct: number }>;
    actions: Array<{ label: string; status: string; cls: string; iconBg: string }>;
  } | null>(null);

  // ─── Task state ────────────────────────────────────────────────────────────
  type TaskStatus = 'idle' | 'running' | 'done' | 'error';
  type Task = { label: string; status: TaskStatus };
  const [tasks, setTasks] = useState<Task[]>([]);

  // ─── Agora / VAD refs ─────────────────────────────────────────────────────
  const rtcClientRef = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const vadInstanceRef = useRef<any>(null);
  const isMutedRef = useRef<boolean>(false);

  // ─── Web Audio / Animation refs ───────────────────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeDataRef = useRef<Uint8Array | null>(null);
  const freqDataRef = useRef<Uint8Array | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const userAmpSmoothRef = useRef<number>(0);
  const aiAmpRef = useRef<number>(0);
  const aiAmpSmoothRef = useRef<number>(0);

  const phaseRef = useRef<number>(0);
  const rafRef = useRef<number>(0);

  const glowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const aiSpeakingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isSpeakingRef = useRef<boolean>(false);
  const aiSpeakingRef = useRef<boolean>(false);
  const isConnectedRef = useRef<boolean>(false);

  const speechRecognitionRef = useRef<any>(null);
  const speechRecognitionActiveRef = useRef<boolean>(false);

  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);
  useEffect(() => { aiSpeakingRef.current = aiSpeaking; }, [aiSpeaking]);
  useEffect(() => {
    isConnectedRef.current = connectionState === 'CONNECTED';
  }, [connectionState]);

  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${msg}`, ...prev.slice(0, 49)]);
  }, []);

  const addTranscriptEntry = useCallback((speaker: 'You' | 'AI Agent', text: string) => {
    const cleanText = text.trim();
    if (!cleanText) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setTranscript(prev => {
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.speaker === speaker && last.text === cleanText) return prev;
      }
      return [
        ...prev,
        { id: Math.random().toString(36).substring(2, 9), speaker, text: cleanText, time }
      ];
    });
  }, []);

  // Ref mirror for addTranscriptEntry to prevent stale closures in long sessions
  const addTranscriptEntryRef = useRef(addTranscriptEntry);
  useEffect(() => { addTranscriptEntryRef.current = addTranscriptEntry; }, [addTranscriptEntry]);

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
        ? {
            ...prev,
            metrics:  { ...prev.metrics },
            timeline: [...prev.timeline],
            causes:   [...prev.causes],
            actions:  [...prev.actions],
          }
        : {
            title: '—',
            location: '—',
            incidentId: 'INC-' + Math.floor(1000 + Math.random() * 9000),
            severity: '',
            status: 'ACTIVE',
            startedAt: nowStr,
            metrics: {
              peopleAffected: '', peopleAffectedSub: '',
              waterLevel: '',     waterLevelSub: '',
              riskLevel: '',
              resourcesDeployed: '', resourcesSub: '',
            },
            timeline: [] as Array<{ time: string; title: string; desc: string; color: string }>,
            causes:   [] as Array<{ name: string; pct: number }>,
            actions:  [] as Array<{ label: string; status: string; cls: string; iconBg: string }>,
          };

      let changed = false;

      let detectedType = '';
      if (has(/\bflood(?:ing|s|ed)?\b/, /\binundation\b/, /\bsubmerg/, /\bwaterlog/))
        detectedType = 'Flood Emergency';
      else if (has(/\bfire\b/, /\bblaze\b/, /\bburning\b/, /\binferno\b/, /\bwildfire\b/))
        detectedType = 'Fire Emergency';
      else if (has(/\bearthquake\b/, /\btremor\b/, /\bseismic\b/, /\bquake\b/))
        detectedType = 'Earthquake Emergency';
      else if (has(/\bcyclone\b/, /\bhurricane\b/, /\btyphoon\b/, /\btropical\s+storm\b/))
        detectedType = 'Cyclone / Storm Emergency';
      else if (has(/\blandslide\b/, /\bmudslide\b/, /\bdebris\s+flow\b/))
        detectedType = 'Landslide Emergency';
      else if (has(/\btsunami\b/))
        detectedType = 'Tsunami Emergency';
      else if (has(/\bdrought\b/, /\bwater\s+scarcity\b/, /\bwater\s+shortage\b/))
        detectedType = 'Drought Emergency';
      else if (has(/\baccident\b/, /\bcrash\b/, /\bcollision\b/))
        detectedType = 'Accident / Disaster';
      if (detectedType && d.title !== detectedType) { d.title = detectedType; changed = true; }

      const cityMatch = text.match(
        /\b(Guwahati|Dibrugarh|Jorhat|Silchar|Tezpur|Nagaon|Delhi|Mumbai|Chennai|Kolkata|Bangalore|Bengaluru|Hyderabad|Pune|Ahmedabad|Jaipur|Lucknow|Patna|Bhopal|Bhubaneswar|Chandigarh|Dehradun|Imphal|Kohima|Aizawl|Agartala|Gangtok|Shillong|Itanagar|Shimla|Jammu|Srinagar|Leh|Raipur|Panaji|Thiruvananthapuram|Kochi|Varanasi|Nagpur|Visakhapatnam|Coimbatore|Madurai|Indore|Surat)\b/
      );
      const stateMatch = text.match(
        /\b(Assam|Maharashtra|Tamil Nadu|West Bengal|Karnataka|Andhra Pradesh|Telangana|Gujarat|Rajasthan|Uttar Pradesh|Bihar|Madhya Pradesh|Odisha|Chhattisgarh|Punjab|Haryana|Uttarakhand|Manipur|Nagaland|Mizoram|Tripura|Meghalaya|Arunachal Pradesh|Sikkim|Himachal Pradesh|Jammu and Kashmir|Ladakh|Goa|Kerala|Jharkhand)\b/
      );
      if (cityMatch || stateMatch) {
        const city = cityMatch?.[1];
        const state = stateMatch?.[1];
        const loc = city && state ? `${city}, ${state}` : city ?? state ?? d.location;
        if (loc !== d.location) { d.location = loc; changed = true; }
      } else {
        const locMatch = text.match(/\b(?:in|at|near|around|from|located in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
        if (locMatch && locMatch[1] !== d.location) { d.location = locMatch[1]; changed = true; }
      }

      const peopleMatch = text.match(
        /(?:approximately|about|around|over|more than|at least|nearly|some|roughly)?\s*(\d[\d,]*)\s*(?:\+\s*)?(people|persons|individuals|families|households|residents|victims|survivors|civilians|children|workers|trapped|stranded|affected|injured|dead|killed|missing|displaced|homeless|evacuated)/i
      );
      if (peopleMatch) {
        const count = peopleMatch[1].replace(/,/g, '');
        const plus = (text.includes(peopleMatch[1] + '+') || has(/more than|over|at least|approximately|about|around/)) ? '+' : '';
        d.metrics.peopleAffected    = count + plus;
        d.metrics.peopleAffectedSub = has(/dead|killed/)                    ? 'Casualties reported'
          : has(/injur/)                                                     ? 'Injured'
          : has(/miss(?:ing)?/)                                              ? 'Missing persons'
          : has(/trap(?:ped)?/, /strand(?:ed)?/)                            ? 'Trapped / needs evacuation'
          : has(/displac(?:ed)?/, /homeless/, /evacuat(?:ed)?/)             ? 'Displaced'
          : 'Affected';
        changed = true;
      }

      if (has(/\bcritical\b/, /\bsevere\b/, /\bcatastrophic\b/, /\bextreme\b/, /\bdevastating\b/, /\bdire\b/)) {
        if (d.severity !== 'CRITICAL') { d.severity = 'CRITICAL'; d.metrics.riskLevel = 'Critical'; changed = true; }
      } else if (has(/\bhigh\b/, /\bserious\b/, /\bsignificant\b/, /\bmajor\b/, /\burgent\b/)) {
        if (!d.severity || d.severity === 'MEDIUM' || d.severity === 'LOW') {
          d.severity = 'HIGH'; d.metrics.riskLevel = 'High'; changed = true;
        }
      } else if (has(/\bmoderate\b/, /\bmedium\b/)) {
        if (!d.severity || d.severity === 'LOW') { d.severity = 'MEDIUM'; d.metrics.riskLevel = 'Medium'; changed = true; }
      } else if (has(/\blow\b/, /\bminor\b/, /\bslight\b/)) {
        if (!d.severity) { d.severity = 'LOW'; d.metrics.riskLevel = 'Low'; changed = true; }
      }

      const waterNum =
        text.match(/(\d+(?:\.\d+)?)\s*(m\b|meter|metre|meters|metres|ft\b|feet|foot|cm\b|centimeter)\s*(?:of\s+)?(?:water|flood|inundation)?/i) ||
        text.match(/(?:water|flood|river|level|risen?|rise)\s+(?:level\s+)?(?:to|of|by|at|is|around|about|reached?|stands?\s+at)?\s*(\d+(?:\.\d+)?)\s*(m\b|meter|metre|ft\b|feet|cm\b)/i);
      if (waterNum) {
        const val = waterNum[1];
        const rawUnit = (waterNum[2] || '').toLowerCase();
        const unit = rawUnit.startsWith('m') ? 'm' : rawUnit.startsWith('f') ? 'ft' : 'cm';
        if (d.metrics.waterLevel !== val + unit) {
          d.metrics.waterLevel    = val + unit;
          d.metrics.waterLevelSub = 'Measured level';
          changed = true;
        }
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

      const resourceMatch = text.match(
        /(\d+)\s*(?:flood\s+)?(?:rescue\s+)?(?:boats?|helicopters?|vehicles?|ambulances?|fire\s*trucks?|teams?|units?|personnel|workers?)/i
      );
      if (resourceMatch) {
        const count = resourceMatch[1];
        const type = /boat/i.test(text) ? 'boat(s)' : /helicopter/i.test(text) ? 'helicopter(s)'
          : /ambulance/i.test(text) ? 'ambulance(s)' : /fire/i.test(text) ? 'fire truck(s)'
          : /team/i.test(text) ? 'team(s)' : 'unit(s)';
        d.metrics.resourcesDeployed = count;
        d.metrics.resourcesSub      = `${count} ${type} deployed`;
        changed = true;
      } else if (has(/\bdispatch\b/, /\bdeploy\b/, /\bsend(?:ing)?\b/, /\bmobiliz/)) {
        const rType = has(/\bboat/)        ? 'Rescue boats'
          : has(/\bhelicopter/)            ? 'Helicopters'
          : has(/\bambulance/)             ? 'Ambulances'
          : has(/\bfire\b/)               ? 'Fire trucks'
          : has(/\brescue\s+team\b/, /\brelief\s+team\b/) ? 'Rescue teams'
          : has(/\bndrf\b/, /\bsdrf\b/)   ? 'NDRF/SDRF'
          : has(/\bevacuat/)              ? 'Evacuation teams'
          : null;
        if (rType) {
          if (!d.metrics.resourcesDeployed) d.metrics.resourcesDeployed = 'Requested';
          d.metrics.resourcesSub = `${rType} requested`;
          changed = true;
        }
      }

      const existingCauseNames = new Set(d.causes.map(c => c.name));
      const causesToAdd: Array<{ name: string; pct: number }> = [];
      if (has(/heavy\s+rain/, /intense\s+rain/, /torrential/, /rainfall/, /downpour/, /monsoon/))
        if (!existingCauseNames.has('Heavy Rainfall'))         causesToAdd.push({ name: 'Heavy Rainfall',        pct: 70 });
      if (has(/dam\s+breach/, /dam\s+fail/, /dam\s+overflow/, /reservoir\s+breach/))
        if (!existingCauseNames.has('Dam Breach'))             causesToAdd.push({ name: 'Dam Breach',            pct: 85 });
      if (has(/drainage\s+fail/, /blocked\s+drain/, /poor\s+drain/, /sewage\s+overflow/))
        if (!existingCauseNames.has('Drainage Failure'))       causesToAdd.push({ name: 'Drainage Failure',      pct: 55 });
      if (has(/deforest/, /soil\s+erosion/))
        if (!existingCauseNames.has('Deforestation'))          causesToAdd.push({ name: 'Deforestation',         pct: 40 });
      if (has(/infrastructure\s+fail/, /bridge\s+(?:fail|collaps)/, /road\s+wash/))
        if (!existingCauseNames.has('Infrastructure Failure')) causesToAdd.push({ name: 'Infrastructure Failure',pct: 50 });
      if (has(/earthquake/, /tremor/, /seismic/))
        if (!existingCauseNames.has('Seismic Activity'))       causesToAdd.push({ name: 'Seismic Activity',      pct: 90 });
      if (has(/electrical\s+fault/, /short\s+circuit/, /gas\s+leak/))
        if (!existingCauseNames.has('Electrical / Gas Fault')) causesToAdd.push({ name: 'Electrical / Gas Fault',pct: 65 });
      if (has(/cyclone/, /hurricane/, /strong\s+wind/, /storm\s+surge/))
        if (!existingCauseNames.has('Cyclonic Storm'))         causesToAdd.push({ name: 'Cyclonic Storm',        pct: 80 });
      if (causesToAdd.length) { d.causes = [...d.causes, ...causesToAdd]; changed = true; }

      const existingActionLabels = new Set(d.actions.map(a => a.label));
      const newActions = newTasks
        .filter(label => !existingActionLabels.has(label))
        .map(label => ({
          label,
          status: source === 'ai' ? 'AI Decision' : 'Requested',
          cls:    '',
          iconBg: source === 'ai' ? '#e0f2fe' : '#f0fdf4',
        }));
      if (newActions.length) { d.actions = [...d.actions, ...newActions]; changed = true; }

      if (changed) {
        const snippet = text.length > 90 ? text.slice(0, 90) + '\u2026' : text;
        const tlEntry = {
          time:  nowStr,
          title: source === 'ai' ? 'AI Assessment' : 'Field Report',
          desc:  snippet,
          color: source === 'ai' ? '#6366f1' : '#3b82f6',
        };
        const alreadyExists = d.timeline.some(e => e.desc === snippet && e.time === nowStr);
        if (!alreadyExists) d.timeline = [tlEntry, ...d.timeline.slice(0, 19)];
        return d;
      }
      return prev;
    });

    if (newTasks.length > 0) {
      setTasks(prev => {
        const existingLabels = new Set(prev.map(t => t.label));
        const fresh = newTasks
          .filter(label => !existingLabels.has(label))
          .map(label => ({ label, status: 'running' as const }));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    }
  }, []);

  // ─── handleLeave (Bug 1 Fix: Dashboard data PERSISTS on leave) ───────────
  const handleLeave = useCallback(async () => {
    if (aiSpeakingTimerRef.current) {
      clearTimeout(aiSpeakingTimerRef.current);
      aiSpeakingTimerRef.current = null;
    }

    speechRecognitionActiveRef.current = false;
    if (speechRecognitionRef.current) {
      try { speechRecognitionRef.current.stop(); } catch {}
      speechRecognitionRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
      analyserRef.current = null;
      timeDataRef.current = null;
      freqDataRef.current = null;
    }
    
    if (vadInstanceRef.current) {
      try {
        if (typeof vadInstanceRef.current.pause === 'function') await vadInstanceRef.current.pause();
        if (typeof vadInstanceRef.current.destroy === 'function') await vadInstanceRef.current.destroy();
      } catch (e: any) { addLog(`VAD teardown warning: ${e.message}`); }
      vadInstanceRef.current = null;
    }

    if (localAudioTrackRef.current) {
      localAudioTrackRef.current.stop();
      localAudioTrackRef.current.close();
      localAudioTrackRef.current = null;
    }

    if (rtcClientRef.current) {
      try { await rtcClientRef.current.leave(); }
      catch (e: any) { addLog(`Leave warning: ${e.message}`); }
      rtcClientRef.current = null;
    }

    setConnectionState('DISCONNECTED');
    setVadStatus('UNLOADED');
    setIsSpeaking(false);
    setAiSpeaking(false);
    setRemoteAgentPresent(false);
    addLog('Left voice channel. Dashboard data retained.');
  }, [addLog]);

  useEffect(() => {
    setIsMounted(true);
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    addLog('Voice test diagnostic console ready.');
    return () => { clearInterval(timer); handleLeave(); };
  }, [addLog, handleLeave]);

  // ─── RAF animation loop (Bug 2, 4 & 5 Fixes) ──────────────────────────────
  useEffect(() => {
    const loop = (timestamp: number) => {
      rafRef.current = requestAnimationFrame(loop);

      // Auto-resume AudioContext if browser suspended it
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }

      // Read time-domain for mic RMS amplitude
      let micAmp = 0;
      if (analyserRef.current && timeDataRef.current) {
        analyserRef.current.getByteTimeDomainData(timeDataRef.current);
        let sumSq = 0;
        const len = timeDataRef.current.length;
        for (let j = 0; j < len; j++) {
          const v = (timeDataRef.current[j] - 128) / 128;
          sumSq += v * v;
        }
        micAmp = Math.sqrt(sumSq / len) * 4.5;
      }

      // Read frequency spectrum data
      if (analyserRef.current && freqDataRef.current) {
        analyserRef.current.getByteFrequencyData(freqDataRef.current);
      }

      if (micAmp > userAmpSmoothRef.current) {
        userAmpSmoothRef.current = userAmpSmoothRef.current * 0.4 + micAmp * 0.6;
      } else {
        userAmpSmoothRef.current = userAmpSmoothRef.current * 0.92 + micAmp * 0.08;
      }
      const userAmp = Math.min(1, userAmpSmoothRef.current);

      // Bug 4 Fix: Smooth exponential decay for AI speaking amplitude
      const targetAiAmp = aiSpeakingRef.current ? Math.min(1, aiAmpRef.current / 100) : 0;
      if (targetAiAmp > aiAmpSmoothRef.current) {
        aiAmpSmoothRef.current = aiAmpSmoothRef.current * 0.5 + targetAiAmp * 0.5; // Fast attack
      } else {
        aiAmpSmoothRef.current = aiAmpSmoothRef.current * 0.88 + targetAiAmp * 0.12; // Smooth ~400ms decay
      }
      const aiAmpSmooth = aiAmpSmoothRef.current;

      phaseRef.current = (phaseRef.current + 0.05) % (Math.PI * 200);
      const phase = phaseRef.current;

      const userActive = (isSpeakingRef.current || userAmp > 0.04) && !isMutedRef.current;
      const aiActive = (aiSpeakingRef.current || aiAmpSmooth > 0.01) && !userActive;
      const connected = isConnectedRef.current;

      // Bug 2 & 5 Fix: Compact waveform canvas rendering + live mic frequency reactivity
      if (waveformCanvasRef.current) {
        const canvas = waveformCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const W = canvas.width;
          const H = canvas.height;
          ctx.clearRect(0, 0, W, H);

          const barCount = 18;
          const barGap = 3;
          const barWidth = Math.max(2, (W - (barCount - 1) * barGap) / barCount);
          const centerY = H / 2;

          let barColor = '#d4d4d4';
          if (userActive) barColor = '#16a34a';
          else if (aiActive) barColor = '#6366f1';
          else if (connected) barColor = '#a3a3a3';

          const freqData = freqDataRef.current;

          for (let i = 0; i < barCount; i++) {
            let h = 2;
            if (userActive) {
              if (freqData && freqData.length > 0) {
                const bin = Math.floor((i / barCount) * (freqData.length * 0.7));
                const val = freqData[bin] / 255;
                h = 2 + (val * 0.65 + userAmp * 0.35) * (H - 4);
              } else {
                const s = (Math.sin((i / barCount) * Math.PI * 3 + phase * 2) + 1) * 0.5;
                h = 2 + userAmp * (H - 4) * s;
              }
            } else if (aiActive) {
              const pos = (barCount - 1 - i) / (barCount - 1);
              const s1 = (Math.sin(pos * Math.PI * 2.8 - phase * 1.6) + 1) * 0.5;
              const s2 = (Math.sin(pos * Math.PI * 4.8 + phase * 2.1) + 1) * 0.5;
              h = 2 + Math.max(0.05, aiAmpSmooth) * (H - 4) * (s1 * 0.55 + s2 * 0.45);
            } else if (connected) {
              h = 2 + ((Math.sin(phase * 0.32 + i * 0.31) + 1) * 0.5) * 3;
            }

            h = Math.max(2, Math.min(H - 2, h));
            const x = i * (barWidth + barGap);
            const y = centerY - h / 2;

            ctx.fillStyle = barColor;
            ctx.beginPath();
            if (typeof (ctx as any).roundRect === 'function') {
              (ctx as any).roundRect(x, y, barWidth, h, 1.5);
            } else {
              ctx.rect(x, y, barWidth, h);
            }
            ctx.fill();
          }
        }
      }

      if (glowCanvasRef.current) {
        let amp = 0;
        let active = false;
        let rgb: [number, number, number] = [148, 163, 184];

        if (aiActive) {
          amp = aiAmpSmooth * 0.9;
          active = true;
          rgb = [96, 165, 250];
        }

        drawGlowRing(glowCanvasRef.current, amp, phase, rgb, active, connected);
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleJoin = async () => {
    if (!channelName.trim()) { addLog('Error: Channel name cannot be empty.'); return; }

    // Reset data for NEW session
    setIncidentData(null);
    setTasks([]);
    setTranscript([]);

    try {
      setConnectionState('FETCHING_TOKEN');
      addLog(`Requesting RTC token for '${channelName}'...`);

      const randomUid = Math.floor(1000 + Math.random() * 9000);
      const tokenRes = await fetch(`${API_BASE_URL}/api/agora/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name: channelName.trim(), uid: randomUid, role: 'publisher', expire_seconds: 3600 }),
      });

      if (!tokenRes.ok) throw new Error('Token request failed');
      const { token, app_id, uid } = await tokenRes.json();
      setTokenDetails({ uid, channel: channelName });
      setConnectionState('JOINING');

      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtcClientRef.current = client;

      client.on('user-published', async (user: any, mediaType: string) => {
        if (Number(user.uid) === 9999) {
          setRemoteAgentPresent(true);
          addLog('✨ [Agora ConvoAI] Gemini Live Agent (UID 9999) joined.');
        }
        await client.subscribe(user, mediaType as 'audio' | 'video');
        if (mediaType === 'audio' && user.audioTrack) user.audioTrack.play();
      });

      client.on('user-left', (user: any) => {
        if (Number(user.uid) === 9999) {
          setRemoteAgentPresent(false);
          setAgentStatus('STOPPED');
          setAiSpeaking(false);
          aiAmpRef.current = 0;
          if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
          addLog('ℹ️ Gemini Live Agent (UID 9999) left the channel.');
        }
      });

      await client.join(app_id, channelName, token, uid);
      setConnectionState('CONNECTED');

      client.enableAudioVolumeIndicator();
      client.on('volume-indicator', (volumes: any[]) => {
        let aiVol = 0;
        volumes.forEach((vol) => { if (Number(vol.uid) === 9999) aiVol = vol.level; });
        aiAmpRef.current = aiVol;

        if (aiVol > 5) {
          if (aiSpeakingTimerRef.current) { clearTimeout(aiSpeakingTimerRef.current); aiSpeakingTimerRef.current = null; }
          setAiSpeaking(true);
        } else if (!aiSpeakingTimerRef.current) {
          aiSpeakingTimerRef.current = setTimeout(() => { setAiSpeaking(false); aiAmpRef.current = 0; aiSpeakingTimerRef.current = null; }, 500);
        }
      });

      localAudioTrackRef.current = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard', AEC: true, ANS: true, AGC: false });
      await client.publish([localAudioTrackRef.current]);

      // Web Audio setup with separate time & frequency buffers
      try {
        const rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micStreamRef.current = rawMicStream;
        const audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        audioCtx.createMediaStreamSource(rawMicStream).connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        timeDataRef.current = new Uint8Array(analyser.fftSize);
        freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch (audioErr: any) { addLog(`⚠️ Web Audio setup failed.`); }

      setVadStatus('LOADING');
      const { MicVAD } = await import('@ricky0123/vad-web');
      const myVad = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        model: 'v5',
        onSpeechStart: () => { if (!isMutedRef.current) setIsSpeaking(true); },
        onSpeechEnd: () => { setIsSpeaking(false); },
        onFrameProcessed: (probabilities: any) => {
          if (!isMutedRef.current && probabilities) setSpeechProbability(Math.round((probabilities.isSpeech || 0) * 100));
        },
      });
      vadInstanceRef.current = myVad;
      setVadStatus('READY');

      client.on('stream-message', (uid: number, data: Uint8Array) => {
        const raw = new TextDecoder('utf-8').decode(data);
        try {
          const msg = JSON.parse(raw);
          const content = msg.text ?? msg.transcript ?? null;
          if (content && content.length > 3) {
            addTranscriptEntryRef.current('AI Agent', content);
            extractIncidentInfo(content, 'ai');
          }
        } catch {}
      });

      // Bug 3 Fix: Speech Recognition with auto-restart onend handler
      const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
      if (SpeechRecognitionClass) {
        const rec = new SpeechRecognitionClass();
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal) continue;
            const text = event.results[i][0].transcript.trim();
            if (text.length < 3) continue;
            addTranscriptEntryRef.current('You', text);
            extractIncidentInfo(text, 'user');
          }
        };
        rec.onerror = (e: any) => {
          if (e.error !== 'no-speech' && e.error !== 'aborted') {
            addLog(`⚠️ [Speech recognition] ${e.error}`);
          }
        };
        rec.onend = () => {
          if (speechRecognitionActiveRef.current) {
            try { rec.start(); } catch {}
          }
        };
        speechRecognitionRef.current = rec;
        speechRecognitionActiveRef.current = true;
        try { rec.start(); } catch {}
      }
    } catch (err: any) {
      addLog(`Join/VAD Error: ${err.message}`);
      setConnectionState('ERROR');
    }
  };

  const handleToggleMute = () => {
    if (!localAudioTrackRef.current) return;
    const next = !isMuted;
    localAudioTrackRef.current.setEnabled(!next);
    setIsMuted(next);
    isMutedRef.current = next;
  };

  const handleStartAgent = async () => {
    try {
      setAgentStatus('STARTING');
      const res = await fetch(`${API_BASE_URL}/api/agora/start-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name: channelName.trim(), agent_uid: 9999, voice: selectedVoice }),
      });
      const data = await res.json();
      setAgentId(data.agent_id);
      setAgentStatus('RUNNING');
      addLog('✅ Gemini Live Agent dispatched!');
    } catch (err: any) { setAgentStatus('ERROR'); addLog(`Agent start failed: ${err.message}`); }
  };

  const handleStopAgent = async () => {
    try {
      setAgentStatus('STOPPING');
      await fetch(`${API_BASE_URL}/api/agora/stop-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_name: channelName.trim(), agent_id: agentId }),
      });
      setAgentStatus('STOPPED'); setAgentId(null); setRemoteAgentPresent(false);
    } catch (err: any) { setAgentStatus('ERROR'); }
  };

  const handleCommandSubmit = () => {
    if (!commandInput.trim()) return;
    const text = commandInput.trim();
    addTranscriptEntry('You', text);
    extractIncidentInfo(text);
    setCommandInput('');
  };

  const isConnected = connectionState === 'CONNECTED';
  const isConnecting = connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING';
  const activeSpeakerCount = (isSpeaking ? 1 : 0) + (aiSpeaking ? 1 : 0);

  const handleResetIncident = () => {
    setIncidentData(null); setTasks([]); setTranscript([]);
    addLog('Incident data, tasks, and transcript reset.');
  };

  const now = currentTime || new Date();

  return (
    <>
      <style suppressHydrationWarning>{`
        .vt-root {
          font-family: var(--font-inter, -apple-system, BlinkMacSystemFont, sans-serif);
          background: #f2f1ef; min-height: 100vh;
          display: flex; flex-direction: column; color: #1a1a1a;
          -webkit-font-smoothing: antialiased;
        }
        .vt-topbar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 28px; height: 52px; background: #ffffff;
          border-bottom: 1px solid #e5e5e5; flex-shrink: 0;
        }
        .vt-topbar-center { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b6b6b; }
        .vt-system-dot { width: 7px; height: 7px; border-radius: 50%; background: #16a34a; animation: pulse-dot 2s ease-in-out infinite; }
        .vt-topbar-right { display: flex; align-items: center; gap: 20px; font-size: 13px; color: #1a1a1a; }
        .vt-body { flex: 1; display: grid; grid-template-columns: 310px 1fr 620px; min-height: 0; overflow: hidden; }
        .vt-panel { padding: 20px 16px; overflow-y: auto; height: calc(100vh - 84px); }
        .vt-panel::-webkit-scrollbar { width: 4px; }
        .vt-panel::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 2px; }
        .vt-left { border-right: 1px solid #e5e5e5; background: #f8f8f7; display: flex; flex-direction: column; gap: 12px; }
        .vt-left-header { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 4px; }
        .vt-left-title { font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #1a1a1a; }
        .vt-active-badge { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: #16a34a; }
        .vt-active-dot { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; }
        .vt-card { background: #ffffff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .vt-card-label { font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: #9b9b9b; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
        .vt-card-label-icon { width: 14px; height: 14px; color: #9b9b9b; }

        /* Transcript styles */
        .vt-transcript-box {
          background: #fafafa;
          border: 1px solid #e8e8e8;
          border-radius: 8px;
          padding: 10px;
          height: 170px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 8px;
        }
        .vt-transcript-box::-webkit-scrollbar { width: 4px; }
        .vt-transcript-box::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 2px; }
        .vt-transcript-empty {
          font-size: 12px;
          color: #a0a0a0;
          font-style: italic;
          text-align: center;
          margin: auto 0;
        }
        .vt-transcript-line {
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 7px 9px;
          border-radius: 6px;
          background: #ffffff;
          border: 1px solid #f0f0f0;
        }
        .vt-transcript-line.user {
          border-left: 3px solid #16a34a;
        }
        .vt-transcript-line.ai {
          border-left: 3px solid #6366f1;
        }
        .vt-transcript-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .vt-transcript-badge {
          font-size: 9.5px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .vt-transcript-badge.user {
          background: #f0fdf4;
          color: #16a34a;
          border: 1px solid #bbf7d0;
        }
        .vt-transcript-badge.ai {
          background: #e0e7ff;
          color: #4338ca;
          border: 1px solid #c7d2fe;
        }
        .vt-transcript-time {
          font-size: 9.5px;
          color: #a0a0a0;
        }
        .vt-transcript-text {
          font-size: 12px;
          color: #2a2a2a;
          line-height: 1.45;
          word-break: break-word;
        }

        .vt-speakers { font-size: 12px; color: #6b6b6b; display: flex; align-items: center; gap: 6px; }
        .vt-speakers-dot { color: #6366f1; font-size: 10px; }
        .vt-insight-text { font-size: 12.5px; line-height: 1.65; color: #4a4a4a; }
        .vt-task-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 12.5px; color: #2a2a2a; }
        .vt-task-item:last-child { border-bottom: none; }
        .vt-task-check { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #e0e0e0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.3s ease; }
        .vt-task-check.done { background: #16a34a; border-color: #16a34a; }
        .vt-task-check.running { background: #f97316; border-color: #f97316; }
        .vt-task-check.error { background: #dc2626; border-color: #dc2626; }
        .vt-task-check.done svg, .vt-task-check.running svg, .vt-task-check.error svg { display: block; }
        .vt-task-check svg { display: none; }
        .vt-command-row { display: flex; align-items: center; gap: 8px; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 10px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-top: auto; }
        .vt-command-input { flex: 1; border: none; outline: none; font-size: 12.5px; color: #1a1a1a; background: transparent; font-family: inherit; }
        .vt-command-input::placeholder { color: #b0b0b0; }
        .vt-command-btn { width: 28px; height: 28px; border-radius: 6px; background: #1a1a1a; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: opacity 0.2s; }
        .vt-command-btn:hover { opacity: 0.75; }
        .vt-voice-controls { display: flex; gap: 6px; flex-wrap: wrap; }
        .vt-btn { padding: 6px 12px; border-radius: 7px; border: 1px solid #e0e0e0; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit; }
        .vt-btn-primary { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
        .vt-btn-primary:hover { opacity: 0.82; }
        .vt-btn-danger { background: #dc2626; color: #fff; border-color: #dc2626; }
        .vt-btn-green { background: #16a34a; color: #fff; border-color: #16a34a; }
        .vt-btn-muted { background: #f5f5f4; color: #6b6b6b; border-color: #e0e0e0; cursor: not-allowed; }
        .vt-select { padding: 5px 8px; border-radius: 6px; border: 1px solid #e0e0e0; background: #fff; font-size: 11.5px; color: #1a1a1a; font-family: inherit; outline: none; }
        .vt-center { background: #f2f1ef; display: flex; flex-direction: column; align-items: center; justify-content: center; border-right: 1px solid #e5e5e5; }
        .vt-center-visualizer-box { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; width: 100%; max-width: 480px; padding: 24px; }
        .vt-minimal-status { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #6b6b6b; letter-spacing: -0.01em; white-space: nowrap; }
        .vt-status-dot-subtle { width: 7px; height: 7px; border-radius: 50%; background: #a3a3a3; transition: background-color 0.3s ease, box-shadow 0.3s ease; }
        .vt-status-dot-subtle.user { background: #16a34a; box-shadow: 0 0 8px rgba(22,163,74,0.4); }
        .vt-status-dot-subtle.ai { background: #6366f1; box-shadow: 0 0 8px rgba(99,102,241,0.4); }
        .vt-status-dot-subtle.online { background: #10b981; }
        .vt-status-dot-subtle.offline { background: #d4d4d4; }
        .vt-user-waveform-section { display: flex; align-items: center; justify-content: center; gap: 16px; width: 100%; }
        .vt-mic-btn-inline { width: 40px; height: 40px; border-radius: 50%; background: #ffffff; border: 1px solid #e2e8f0; color: #334155; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s cubic-bezier(0.16,1,0.3,1); flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .vt-mic-btn-inline:hover { border-color: #6366f1; color: #6366f1; transform: translateY(-1px); box-shadow: 0 3px 8px rgba(99,102,241,0.15); }
        .vt-mic-btn-inline.muted { background: #fef2f2; border-color: #fecaca; color: #dc2626; box-shadow: none; }
        
        /* Bug 2 Fix: Reduced waveform dimensions */
        .vt-waveform-canvas { width: 160px; height: 24px; display: block; }

        .vt-right { background: #ffffff; display: flex; flex-direction: column; gap: 0; border-left: 1px solid #e5e5e5; overflow-y: auto; }
        .vt-right::-webkit-scrollbar { width: 4px; }
        .vt-right::-webkit-scrollbar-thumb { background: #d0d0d0; border-radius: 2px; }
        .vt-right-inner { padding: 20px; display: flex; flex-direction: column; gap: 14px; min-height: 100%; }
        .vt-right-title { font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #1a1a1a; margin-bottom: 2px; }
        .vt-incident-card { background: #fff; border: 1px solid #e8e8e8; border-radius: 12px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
        .vt-incident-main { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .vt-incident-left-group { display: flex; align-items: center; gap: 14px; }
        .vt-incident-icon { width: 46px; height: 46px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .vt-incident-info h3 { font-size: 15px; font-weight: 700; color: #1a1a1a; margin-bottom: 3px; margin-top: 1px; }
        .vt-incident-loc { font-size: 11.5px; color: #6b6b6b; display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
        .vt-incident-id { font-size: 10.5px; color: #b0b0b0; font-family: monospace; }
        .vt-incident-chips { display: flex; gap: 16px; align-items: flex-start; }
        .vt-chip-group { display: flex; flex-direction: column; gap: 4px; }
        .vt-chip-label { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #b0b0b0; }
        .vt-chip { padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; display: inline-block; }
        .vt-chip-red { background: #fef2f2; color: #dc2626; border: 1.5px solid #fecaca; }
        .vt-chip-green { background: #f0fdf4; color: #16a34a; border: 1.5px solid #bbf7d0; }
        .vt-chip-time { background: transparent; color: #2a2a2a; border: none; padding: 0; font-size: 11.5px; font-weight: 500; line-height: 1.5; }
        .vt-section-title { font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #1a1a1a; margin-bottom: 10px; }
        .vt-situation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .vt-situation-item { background: #fafafa; border: 1px solid #ebebeb; border-radius: 10px; padding: 12px 14px; }
        .vt-situation-label { font-size: 10px; color: #9b9b9b; font-weight: 500; margin-bottom: 6px; }
        .vt-situation-value { font-size: 22px; font-weight: 700; color: #1a1a1a; line-height: 1; }
        .vt-situation-sub { font-size: 10px; color: #9b9b9b; margin-top: 4px; }
        .vt-situation-sub.red { color: #dc2626; font-weight: 600; }
        .vt-situation-sub.green { color: #16a34a; font-weight: 600; }
        .vt-critical-text { font-size: 14px; font-weight: 800; color: #dc2626; letter-spacing: 0.04em; margin-top: 2px; }
        .vt-main-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 14px; align-items: start; }
        .vt-section-card { background: #fff; border: 1px solid #e8e8e8; border-radius: 12px; padding: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
        .vt-timeline { display: flex; flex-direction: column; }
        .vt-tl-row { display: flex; gap: 0; align-items: stretch; }
        .vt-tl-time { font-size: 9.5px; color: #b0b0b0; font-weight: 500; white-space: nowrap; width: 52px; flex-shrink: 0; padding-top: 1px; }
        .vt-tl-mid { display: flex; flex-direction: column; align-items: center; width: 18px; flex-shrink: 0; }
        .vt-tl-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
        .vt-tl-line { width: 1.5px; background: #e5e5e5; flex: 1; min-height: 14px; margin-top: 3px; }
        .vt-tl-content { flex: 1; padding-bottom: 12px; padding-left: 4px; }
        .vt-tl-title { font-size: 11.5px; font-weight: 600; color: #1a1a1a; line-height: 1.3; }
        .vt-tl-desc { font-size: 10px; color: #9b9b9b; margin-top: 1px; line-height: 1.4; }
        .vt-hypothesis-item { margin-bottom: 10px; }
        .vt-hypothesis-item:last-child { margin-bottom: 0; }
        .vt-hypothesis-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
        .vt-hypothesis-name { font-size: 11.5px; color: #2a2a2a; }
        .vt-hypothesis-pct { font-size: 11px; font-weight: 600; color: #4a4a4a; }
        .vt-bar-track { height: 5px; background: #f0f0f0; border-radius: 3px; overflow: hidden; }
        .vt-bar-fill { height: 100%; background: #6366f1; border-radius: 3px; transition: width 0.6s ease; }
        .vt-action-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f3f3; }
        .vt-action-item:last-child { border-bottom: none; }
        .vt-action-left { display: flex; align-items: center; gap: 10px; }
        .vt-action-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; }
        .vt-action-label { font-size: 11.5px; font-weight: 500; color: #1a1a1a; line-height: 1.3; }
        .vt-status-badge { display: flex; font-size: 10.5px; font-weight: 600; color: #16a34a; align-items: center; gap: 4px; }
        .vt-ai-orb-wrapper { position: relative; width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; }
        .vt-glow-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; border-radius: 50%; }
        .vt-ai-circle { position: absolute; width: 150px; height: 150px; border-radius: 50%; background: #f5f4f2; box-shadow: 0 2px 16px rgba(0,0,0,0.07); pointer-events: none; z-index: 2; }
        .vt-statusbar { height: 32px; background: #fff; border-top: 1px solid #e5e5e5; display: flex; align-items: center; gap: 20px; padding: 0 20px; font-size: 11px; color: #b0b0b0; flex-shrink: 0; }
        .vt-statusbar-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${isConnected ? '#16a34a' : '#d4d4d4'}; margin-right: 5px; vertical-align: middle; }
        @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>

      <div className="vt-root">
        <header className="vt-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="vt-topbar-center">
              <span className="vt-system-dot" />
              System Online
            </div>
          </div>
          <div className="vt-topbar-right">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b6b6b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {isMounted && (
              <>
                <span style={{ fontWeight: 600 }}>
                  {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ color: '#9b9b9b' }}>
                  {now.getDate()} {now.toLocaleString('default', { month: 'short' })} {now.getFullYear()}
                </span>
              </>
            )}
          </div>
        </header>

        <div className="vt-body">
          <aside className="vt-panel vt-left">
            <div className="vt-left-header">
              <span className="vt-left-title">AI Response Agent</span>
              <span className="vt-active-badge"><span className="vt-active-dot" />Active</span>
            </div>

            <div className="vt-card">
              <div className="vt-card-label">
                <svg className="vt-card-label-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
                Live Conversation
              </div>

              <div
                ref={transcriptContainerRef}
                onScroll={handleTranscriptScroll}
                className="vt-transcript-box"
              >
                {transcript.length === 0 ? (
                  <div className="vt-transcript-empty">
                    {!isConnected
                      ? 'Ready to connect'
                      : isSpeaking
                      ? 'Speaking detected...'
                      : aiSpeaking
                      ? 'AI responding...'
                      : 'Listening to team...'}
                  </div>
                ) : (
                  transcript.map((entry) => (
                    <div key={entry.id} className={`vt-transcript-line ${entry.speaker === 'You' ? 'user' : 'ai'}`}>
                      <div className="vt-transcript-meta">
                        <span className={`vt-transcript-badge ${entry.speaker === 'You' ? 'user' : 'ai'}`}>
                          {entry.speaker}
                        </span>
                        <span className="vt-transcript-time">{entry.time}</span>
                      </div>
                      <div className="vt-transcript-text">{entry.text}</div>
                    </div>
                  ))
                )}
              </div>

              <div className="vt-speakers">
                <span className="vt-speakers-dot">●</span>
                {isConnected
                  ? activeSpeakerCount === 0
                    ? 'No active speakers'
                    : `${activeSpeakerCount} active ${activeSpeakerCount === 1 ? 'speaker' : 'speakers'}`
                  : 'Not connected'}
              </div>
            </div>

            <div className="vt-card" style={{ padding: '12px 14px' }}>
              <div className="vt-card-label" style={{ marginBottom: '8px' }}>Voice Channel</div>
              <input
                id="channel-input" type="text" value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                disabled={connectionState !== 'DISCONNECTED' && connectionState !== 'ERROR'}
                style={{ width: '100%', padding: '7px 10px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#f8f8f7', fontSize: '12px', color: '#1a1a1a', fontFamily: 'monospace', marginBottom: '8px', outline: 'none', boxSizing: 'border-box' }}
              />
              <div className="vt-voice-controls">
                {isConnected
                  ? <button className="vt-btn vt-btn-danger" onClick={handleLeave}>Leave Channel</button>
                  : <button className={`vt-btn ${isConnecting ? 'vt-btn-muted' : 'vt-btn-primary'}`} onClick={handleJoin} disabled={isConnecting}>
                      {connectionState === 'FETCHING_TOKEN' ? 'Authorizing...' : connectionState === 'JOINING' ? 'Connecting...' : 'Join Channel'}
                    </button>}
                {isConnected && (
                  <button className={`vt-btn ${isMuted ? 'vt-btn-danger' : 'vt-btn-green'}`} onClick={handleToggleMute} style={{ fontSize: '11px' }}>
                    {isMuted ? 'Unmute' : 'Mic On'}
                  </button>
                )}
              </div>
            </div>

            {isConnected && (
              <div className="vt-card" style={{ padding: '12px 14px' }}>
                <div className="vt-card-label" style={{ marginBottom: '8px' }}>Gemini Agent</div>
                <div className="vt-voice-controls">
                  <select className="vt-select" value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} disabled={agentStatus === 'RUNNING' || agentStatus === 'STARTING'}>
                    <option value="Puck">Puck (Energetic)</option>
                    <option value="Charon">Charon (Authoritative)</option>
                    <option value="Aoede">Aoede (Calm)</option>
                    <option value="Fenrir">Fenrir (Direct)</option>
                    <option value="Kore">Kore (Clear)</option>
                  </select>
                  {agentStatus === 'RUNNING' || remoteAgentPresent
                    ? <button className="vt-btn vt-btn-danger" onClick={handleStopAgent} disabled={agentStatus === 'STOPPING'}>{agentStatus === 'STOPPING' ? 'Stopping...' : 'Stop Agent'}</button>
                    : <button className={`vt-btn ${agentStatus === 'STARTING' ? 'vt-btn-muted' : 'vt-btn-green'}`} onClick={handleStartAgent} disabled={agentStatus === 'STARTING'}>{agentStatus === 'STARTING' ? 'Launching...' : '▶ Start Agent'}</button>}
                </div>
              </div>
            )}

            <div className="vt-command-row">
              <input className="vt-command-input" type="text" placeholder="Describe the incident or give command..."
                value={commandInput} onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCommandSubmit()} />
              <button className="vt-command-btn" onClick={handleCommandSubmit} aria-label="Send command">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </aside>

          <main className="vt-panel vt-center">
            <div className="vt-center-visualizer-box">
              <div className="vt-minimal-status">
                <span className={`vt-status-dot-subtle ${isSpeaking ? 'user' : aiSpeaking ? 'ai' : isConnected ? 'online' : 'offline'}`} />
                {isSpeaking ? 'User speaking' : aiSpeaking ? 'AI speaking' : isConnected ? 'Listening...' : 'Not connected'}
              </div>

              <div className="vt-ai-orb-wrapper">
                <canvas
                  ref={glowCanvasRef}
                  className="vt-glow-canvas"
                  width={220}
                  height={220}
                />
                <div className="vt-ai-circle" />
              </div>

              <div className="vt-user-waveform-section">
                <button className={`vt-mic-btn-inline ${isMuted ? 'muted' : ''}`} onClick={handleToggleMute} title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'} aria-label="Toggle Microphone">
                  {isMuted ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                      <line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="22"/>
                    </svg>
                  )}
                </button>

                <canvas
                  ref={waveformCanvasRef}
                  className="vt-waveform-canvas"
                  width={160}
                  height={24}
                />
              </div>
            </div>
          </main>

          <aside className="vt-right">
            <div className="vt-right-inner">
              <div className="vt-right-title">Incident Dashboard</div>

              <div className="vt-incident-card">
                <div className="vt-incident-main">
                  <div className="vt-incident-left-group">
                    <div className="vt-incident-icon" style={{ background: incidentData ? '#dc2626' : '#d4d4d4' }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                    </div>
                    <div className="vt-incident-info">
                      <h3 style={{ color: incidentData ? '#1a1a1a' : '#aaa' }}>{incidentData?.title ?? 'Awaiting information'}</h3>
                      <div className="vt-incident-loc">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9b9b9b" strokeWidth="2.5">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                        </svg>
                        {incidentData?.location ?? 'Not determined'}
                      </div>
                      <div className="vt-incident-id">{incidentData?.incidentId ?? '—'}</div>
                    </div>
                  </div>
                  <div className="vt-incident-chips">
                    <div className="vt-chip-group">
                      <span className="vt-chip-label">Severity</span>
                      {incidentData?.severity
                        ? <span className="vt-chip vt-chip-red">{incidentData.severity}</span>
                        : <span className="vt-chip" style={{ background: '#f4f4f5', color: '#71717a' }}>—</span>}
                    </div>
                    <div className="vt-chip-group">
                      <span className="vt-chip-label">Status</span>
                      {incidentData?.status
                        ? <span className="vt-chip vt-chip-green">{incidentData.status}</span>
                        : <span className="vt-chip" style={{ background: '#f4f4f5', color: '#71717a' }}>—</span>}
                    </div>
                    <div className="vt-chip-group">
                      <span className="vt-chip-label">Started At</span>
                      <span className="vt-chip vt-chip-time">{incidentData?.startedAt ?? '—'}</span>
                    </div>
                  </div>
                </div>
                {incidentData && (
                  <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={handleResetIncident} style={{ fontSize: '10px', color: '#9b9b9b', background: 'none', border: '1px solid #e5e5e5', borderRadius: '5px', padding: '3px 8px', cursor: 'pointer' }}>
                      Reset Incident
                    </button>
                  </div>
                )}
              </div>

              <div className="vt-main-grid">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="vt-section-card">
                    <div className="vt-section-title">Live Situation</div>
                    <div className="vt-situation-grid">
                      <div className="vt-situation-item">
                        <div className="vt-situation-label">People Affected</div>
                        <div style={{ margin: '4px 0 6px', color: '#6366f1' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                        </div>
                        <div className="vt-situation-value" style={{ color: incidentData?.metrics.peopleAffected ? '#1a1a1a' : '#ccc' }}>{incidentData?.metrics.peopleAffected || '—'}</div>
                        <div className={`vt-situation-sub ${incidentData?.metrics.peopleAffectedSub ? 'green' : ''}`}>{incidentData?.metrics.peopleAffectedSub || 'Awaiting data'}</div>
                      </div>
                      <div className="vt-situation-item">
                        <div className="vt-situation-label">Water Level</div>
                        <div style={{ margin: '4px 0 6px', color: '#3b82f6' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" /></svg>
                        </div>
                        <div className="vt-situation-value" style={{ color: incidentData?.metrics.waterLevel ? '#1a1a1a' : '#ccc' }}>{incidentData?.metrics.waterLevel || '—'}</div>
                        <div className={`vt-situation-sub ${incidentData?.metrics.waterLevelSub?.includes('Rising') ? 'red' : ''}`}>{incidentData?.metrics.waterLevelSub || 'Unconfirmed'}</div>
                      </div>
                      <div className="vt-situation-item">
                        <div className="vt-situation-label">Risk Level</div>
                        <div style={{ margin: '4px 0 6px', color: '#dc2626' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                        </div>
                        <div className={incidentData?.metrics.riskLevel === 'Critical' ? 'vt-critical-text' : 'vt-situation-value'} style={{ fontSize: incidentData?.metrics.riskLevel === 'Critical' ? '14px' : '16px', color: incidentData?.metrics.riskLevel ? '#dc2626' : '#ccc' }}>
                          {incidentData?.metrics.riskLevel || '—'}
                        </div>
                      </div>
                      <div className="vt-situation-item">
                        <div className="vt-situation-label">Resources Deployed</div>
                        <div style={{ margin: '4px 0 6px', color: '#16a34a' }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13" rx="2" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></svg>
                        </div>
                        <div className="vt-situation-value" style={{ color: incidentData?.metrics.resourcesDeployed ? '#1a1a1a' : '#ccc' }}>{incidentData?.metrics.resourcesDeployed || '—'}</div>
                        <div className="vt-situation-sub">{incidentData?.metrics.resourcesSub || 'Standby'}</div>
                      </div>
                    </div>
                  </div>

                  <div className="vt-section-card">
                    <div className="vt-section-title">Possible Causes <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: '9px', color: '#c0c0c0', marginLeft: '4px' }}>(Hypotheses)</span></div>
                    {incidentData?.causes.length
                      ? incidentData.causes.map((h) => (
                        <div className="vt-hypothesis-item" key={h.name}>
                          <div className="vt-hypothesis-row"><span className="vt-hypothesis-name">{h.name}</span><span className="vt-hypothesis-pct">{h.pct}%</span></div>
                          <div className="vt-bar-track"><div className="vt-bar-fill" style={{ width: `${h.pct}%` }} /></div>
                        </div>
                      ))
                      : <p style={{ fontSize: '11.5px', color: '#999', fontStyle: 'italic', margin: '6px 0' }}>Awaiting information...</p>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div className="vt-section-card">
                    <div className="vt-section-title">Incident Timeline</div>
                    {incidentData?.timeline.length
                      ? (
                        <div className="vt-timeline">
                          {incidentData.timeline.map((item, i, arr) => (
                            <div className="vt-tl-row" key={i}>
                              <div className="vt-tl-time">{item.time}</div>
                              <div className="vt-tl-mid">
                                <div className="vt-tl-dot" style={{ background: item.color }} />
                                {i < arr.length - 1 && <div className="vt-tl-line" />}
                              </div>
                              <div className="vt-tl-content" style={{ paddingBottom: i < arr.length - 1 ? '10px' : '0' }}>
                                <div className="vt-tl-title">{item.title}</div>
                                <div className="vt-tl-desc">{item.desc}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                      : <p style={{ fontSize: '11.5px', color: '#999', fontStyle: 'italic', margin: '6px 0' }}>Waiting for incident information...</p>}
                  </div>

                  <div className="vt-section-card">
                    <div className="vt-section-title">Response &amp; Actions</div>
                    {incidentData?.actions.length
                      ? incidentData.actions.map((action) => (
                        <div className="vt-action-item" key={action.label}>
                          <div className="vt-action-left">
                            <div className="vt-action-icon" style={{ background: action.iconBg }}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                            </div>
                            <span className="vt-action-label">{action.label}</span>
                          </div>
                          <div className={`vt-status-badge ${action.cls}`}>{action.status}</div>
                        </div>
                      ))
                      : <p style={{ fontSize: '11.5px', color: '#999', fontStyle: 'italic', margin: '6px 0' }}>Awaiting confirmed actions...</p>}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="vt-statusbar">
          <span><span className="vt-statusbar-dot" />{isConnected ? 'Live updates connected' : 'Not connected'}</span>
          {isConnected && <span style={{ color: '#b0b0b0' }}>VAD: {vadStatus} · UID: {tokenDetails?.uid}</span>}
        </footer>
      </div>
    </>
  );
}
