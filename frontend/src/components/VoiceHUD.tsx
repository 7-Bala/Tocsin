'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type ConnectionState =
  | 'DISCONNECTED'
  | 'FETCHING_TOKEN'
  | 'JOINING'
  | 'CONNECTED'
  | 'ERROR';

type VadModelStatus = 'UNLOADED' | 'LOADING' | 'READY' | 'ERROR';
type AgentStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';

interface VoiceHUDProps {
  channelName?: string;
  onVoiceLog?: (msg: string) => void;
}

export const VoiceHUD: React.FC<VoiceHUDProps> = ({
  channelName = 'tocsin-emergency-room',
  onVoiceLog,
}) => {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('DISCONNECTED');
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechProbability, setSpeechProbability] = useState(0);
  const [rawAmplitude, setRawAmplitude] = useState(0);
  const [vadStatus, setVadStatus] = useState<VadModelStatus>('UNLOADED');
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('STOPPED');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('Puck');
  const [remoteAgentPresent, setRemoteAgentPresent] = useState(false);
  const [localLogs, setLocalLogs] = useState<string[]>([]);

  const rtcClientRef = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const vadInstanceRef = useRef<any>(null);
  const isMutedRef = useRef<boolean>(false);
  const ampIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = useCallback(
    (msg: string) => {
      const timestamp = new Date().toLocaleTimeString();
      const line = `[${timestamp}] ${msg}`;
      setLocalLogs((prev) => [line, ...prev.slice(0, 29)]);
      if (onVoiceLog) onVoiceLog(msg);
    },
    [onVoiceLog]
  );

  const handleLeave = useCallback(async () => {
    if (ampIntervalRef.current) {
      clearInterval(ampIntervalRef.current);
      ampIntervalRef.current = null;
    }

    if (vadInstanceRef.current) {
      try {
        if (typeof vadInstanceRef.current.pause === 'function') {
          await vadInstanceRef.current.pause();
        }
        if (typeof vadInstanceRef.current.destroy === 'function') {
          await vadInstanceRef.current.destroy();
        }
      } catch (e: any) {
        addLog(`VAD teardown warning: ${e.message}`);
      }
      vadInstanceRef.current = null;
    }

    if (localAudioTrackRef.current) {
      localAudioTrackRef.current.stop();
      localAudioTrackRef.current.close();
      localAudioTrackRef.current = null;
    }

    if (rtcClientRef.current) {
      try {
        await rtcClientRef.current.leave();
        addLog('Left Agora voice room.');
      } catch (e: any) {
        addLog(`Leave warning: ${e.message}`);
      }
      rtcClientRef.current = null;
    }

    setConnectionState('DISCONNECTED');
    setVadStatus('UNLOADED');
    setIsSpeaking(false);
    setSpeechProbability(0);
    setRawAmplitude(0);
    setIsMuted(false);
    isMutedRef.current = false;
    setRemoteAgentPresent(false);
  }, [addLog]);

  useEffect(() => {
    return () => {
      handleLeave();
    };
  }, [handleLeave]);

  const handleJoin = async () => {
    try {
      setConnectionState('FETCHING_TOKEN');
      addLog(`Requesting RTC token for channel '${channelName}'...`);

      const randomUid = Math.floor(1000 + Math.random() * 9000);
      const tokenRes = await fetch(`${API_BASE_URL}/api/agora/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_name: channelName.trim(),
          uid: randomUid,
          role: 'publisher',
          expire_seconds: 3600,
        }),
      });

      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        throw new Error(errData.detail || `Token request failed HTTP ${tokenRes.status}`);
      }

      const { token, app_id, channel_name, uid } = await tokenRes.json();
      setConnectionState('JOINING');

      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
      AgoraRTC.setLogLevel(1);

      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtcClientRef.current = client;

      client.on('user-published', async (user, mediaType) => {
        addLog(`Remote speaker joined: UID ${user.uid} (${mediaType})`);
        if (Number(user.uid) === 9999) {
          setRemoteAgentPresent(true);
          addLog('✨ Gemini Live Voice Agent (UID 9999) joined and active!');
        }
        await client.subscribe(user, mediaType);
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
        }
      });

      client.on('user-unpublished', (user) => {
        addLog(`Remote speaker unpublished: UID ${user.uid}`);
      });

      client.on('user-left', (user) => {
        addLog(`Remote speaker left: UID ${user.uid}`);
        if (Number(user.uid) === 9999) {
          setRemoteAgentPresent(false);
          setAgentStatus('STOPPED');
        }
      });

      await client.join(app_id, channel_name, token, uid);
      addLog(`Joined voice room as UID ${uid}`);

      const localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: 'speech_standard',
        AEC: true,
        ANS: true,
        AGC: false,
      });
      localAudioTrackRef.current = localAudioTrack;
      await client.publish([localAudioTrack]);

      setConnectionState('CONNECTED');
      setIsMuted(false);
      isMutedRef.current = false;

      // Silero Neural VAD via WASM
      setVadStatus('LOADING');
      try {
        const { MicVAD } = await import('@ricky0123/vad-web');
        const myVad = await MicVAD.new({
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          model: 'v5',
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          minSpeechMs: 100,
          preSpeechPadMs: 300,
          redemptionMs: 400,
          onSpeechStart: () => {
            if (!isMutedRef.current) {
              setIsSpeaking(true);
              addLog('🎙️ [Silero VAD] Human speech detected');
            }
          },
          onSpeechEnd: () => {
            setIsSpeaking(false);
          },
          onVADMisfire: () => {
            setIsSpeaking(false);
          },
          onFrameProcessed: (probabilities) => {
            if (!isMutedRef.current && probabilities) {
              setSpeechProbability(Math.round((probabilities.isSpeech || 0) * 100));
            } else {
              setSpeechProbability(0);
            }
          },
        });
        vadInstanceRef.current = myVad;
        setVadStatus('READY');
        addLog('✅ [Silero VAD] Neural VAD active');
      } catch (vadErr: any) {
        addLog(`VAD fallback: ${vadErr.message}`);
        setVadStatus('ERROR');
      }

      ampIntervalRef.current = setInterval(() => {
        if (localAudioTrackRef.current && !isMutedRef.current) {
          const raw = localAudioTrackRef.current.getVolumeLevel() || 0.0;
          setRawAmplitude(Math.min(100, Math.round(raw * 100)));
        } else {
          setRawAmplitude(0);
        }
      }, 60);
    } catch (err: any) {
      addLog(`Voice Error: ${err.message}`);
      setConnectionState('ERROR');
      handleLeave();
    }
  };

  const handleToggleMute = () => {
    if (!localAudioTrackRef.current) return;
    const nextState = !isMuted;
    localAudioTrackRef.current.setEnabled(!nextState);
    setIsMuted(nextState);
    isMutedRef.current = nextState;
    if (nextState) {
      setIsSpeaking(false);
      setSpeechProbability(0);
      setRawAmplitude(0);
      if (vadInstanceRef.current && typeof vadInstanceRef.current.pause === 'function') {
        vadInstanceRef.current.pause();
      }
    } else {
      if (vadInstanceRef.current && typeof vadInstanceRef.current.start === 'function') {
        vadInstanceRef.current.start();
      }
    }
    addLog(`Microphone ${nextState ? 'Muted' : 'Unmuted'}`);
  };

  const handleStartAgent = async () => {
    try {
      setAgentStatus('STARTING');
      addLog(`Dispatching Gemini Live voice agent into '${channelName}'...`);
      const res = await fetch(`${API_BASE_URL}/api/agora/start-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_name: channelName.trim(),
          agent_uid: 9999,
          voice: selectedVoice,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setAgentId(data.agent_id);
      setAgentStatus('RUNNING');
      addLog(`✅ Gemini Live Agent joined (ID: ${data.agent_id})`);
    } catch (err: any) {
      setAgentStatus('ERROR');
      addLog(`Agent start failed: ${err.message}`);
    }
  };

  const handleStopAgent = async () => {
    try {
      setAgentStatus('STOPPING');
      addLog('Stopping Gemini Live agent...');
      const res = await fetch(`${API_BASE_URL}/api/agora/stop-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_name: channelName.trim(),
          agent_id: agentId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setAgentStatus('STOPPED');
      setAgentId(null);
      setRemoteAgentPresent(false);
      addLog('Gemini Live Agent stopped.');
    } catch (err: any) {
      setAgentStatus('ERROR');
      addLog(`Agent stop failed: ${err.message}`);
    }
  };

  return (
    <section
      aria-label="Real-Time Voice AI HUD"
      style={{
        padding: '1.25rem',
        backgroundColor: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span>🎙️ Live Voice AI & Responder Radio</span>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                backgroundColor:
                  connectionState === 'CONNECTED'
                    ? 'rgba(63, 185, 80, 0.2)'
                    : 'rgba(110, 118, 129, 0.2)',
                color: connectionState === 'CONNECTED' ? '#3fb950' : '#adbac7',
                fontWeight: 700,
              }}
            >
              {connectionState}
            </span>
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Channel: <code>{channelName}</code> • Neural VAD (Silero v5) • Gemini Live Agent
          </p>
        </div>

        {/* Radio Controls */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {connectionState === 'CONNECTED' ? (
            <>
              <button
                onClick={handleToggleMute}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: '6px',
                  border: `1px solid ${isMuted ? '#f85149' : 'var(--border)'}`,
                  backgroundColor: isMuted ? 'rgba(248, 81, 73, 0.15)' : '#21262d',
                  color: isMuted ? '#f85149' : 'var(--text-primary)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {isMuted ? '🔇 Unmute Mic' : '🎙️ Mute Mic'}
              </button>
              <button
                onClick={handleLeave}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: '6px',
                  border: '1px solid #f85149',
                  backgroundColor: 'rgba(248, 81, 73, 0.15)',
                  color: '#f85149',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={handleJoin}
              disabled={connectionState === 'JOINING' || connectionState === 'FETCHING_TOKEN'}
              style={{
                padding: '0.45rem 1rem',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: 'var(--accent-blue)',
                color: '#fff',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {connectionState === 'JOINING' ? 'Connecting...' : 'Join Radio Channel'}
            </button>
          )}
        </div>
      </div>

      {/* Voice Indicators & Agent Controller */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {/* VAD & Mic Telemetry */}
        <div
          style={{
            padding: '0.85rem',
            borderRadius: '8px',
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 700 }}>
            <span style={{ color: 'var(--text-secondary)' }}>SPEECH PROBABILITY (VAD)</span>
            <span style={{ color: isSpeaking ? '#3fb950' : 'var(--text-secondary)' }}>
              {isSpeaking ? '🗣️ ACTIVE SPEECH' : 'IDLE'} ({speechProbability}%)
            </span>
          </div>
          <div style={{ width: '100%', height: '8px', backgroundColor: '#21262d', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${speechProbability}%`,
                height: '100%',
                backgroundColor: isSpeaking ? '#3fb950' : '#58a6ff',
                transition: 'width 0.1s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.725rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
            <span>Model: <b>Silero V5 ONNX</b></span>
            <span>Mic Volume: <b>{rawAmplitude}%</b></span>
          </div>
        </div>

        {/* Gemini Live Agent Panel */}
        <div
          style={{
            padding: '0.85rem',
            borderRadius: '8px',
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
              GEMINI LIVE VOICE AGENT
            </span>
            <span
              style={{
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '0.1rem 0.4rem',
                borderRadius: '4px',
                backgroundColor: remoteAgentPresent ? 'rgba(63, 185, 80, 0.2)' : 'rgba(110, 118, 129, 0.2)',
                color: remoteAgentPresent ? '#3fb950' : '#adbac7',
              }}
            >
              {remoteAgentPresent ? '✨ IN ROOM (UID 9999)' : agentStatus}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              disabled={agentStatus === 'RUNNING'}
              style={{
                padding: '0.35rem 0.55rem',
                backgroundColor: '#0d1117',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '0.775rem',
              }}
            >
              <option value="Puck">Puck (Direct & Calm)</option>
              <option value="Charon">Charon (Authoritative)</option>
              <option value="Aoede">Aoede (Clear & Empathetic)</option>
              <option value="Fenrir">Fenrir (Crisp)</option>
            </select>

            {agentStatus === 'RUNNING' || remoteAgentPresent ? (
              <button
                onClick={handleStopAgent}
                style={{
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid #f85149',
                  backgroundColor: 'rgba(248, 81, 73, 0.15)',
                  color: '#f85149',
                  fontSize: '0.775rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Stop Agent
              </button>
            ) : (
              <button
                onClick={handleStartAgent}
                disabled={agentStatus === 'STARTING'}
                style={{
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: '#238636',
                  color: '#fff',
                  fontSize: '0.775rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {agentStatus === 'STARTING' ? 'Starting...' : 'Dispatch AI'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Voice Logs */}
      <div style={{ maxHeight: '100px', overflowY: 'auto', fontSize: '0.725rem', fontFamily: 'monospace', color: 'var(--text-secondary)', backgroundColor: '#0d1117', padding: '0.5rem 0.75rem', borderRadius: '6px' }}>
        {localLogs.length === 0 ? 'Voice radio events will appear here...' : localLogs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </section>
  );
};
