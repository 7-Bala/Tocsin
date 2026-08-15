'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type ConnectionState =
  | 'DISCONNECTED'
  | 'FETCHING_TOKEN'
  | 'JOINING'
  | 'CONNECTED'
  | 'ERROR';

export default function VoiceTestPage() {
  const [channelName, setChannelName] = useState('tocsin-emergency-room');
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('DISCONNECTED');
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [tokenDetails, setTokenDetails] = useState<{
    uid?: number | string;
    channel?: string;
    expiresIn?: number;
  } | null>(null);

  const rtcClientRef = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const audioIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${msg}`, ...prev.slice(0, 49)]);
  }, []);

  const handleLeave = useCallback(async () => {
    if (audioIntervalRef.current) {
      clearInterval(audioIntervalRef.current);
      audioIntervalRef.current = null;
    }
    setAudioLevel(0);

    if (localAudioTrackRef.current) {
      localAudioTrackRef.current.stop();
      localAudioTrackRef.current.close();
      localAudioTrackRef.current = null;
    }

    if (rtcClientRef.current) {
      try {
        await rtcClientRef.current.leave();
        addLog('Left Agora voice channel.');
      } catch (e: any) {
        addLog(`Leave warning: ${e.message}`);
      }
      rtcClientRef.current = null;
    }

    setConnectionState('DISCONNECTED');
    setTokenDetails(null);
  }, [addLog]);

  useEffect(() => {
    addLog('Voice test diagnostic console ready.');
    return () => {
      handleLeave();
    };
  }, [addLog, handleLeave]);

  const handleJoin = async () => {
    if (!channelName.trim()) {
      addLog('Error: Channel name cannot be empty.');
      return;
    }

    try {
      setConnectionState('FETCHING_TOKEN');
      addLog(`Requesting RTC token from backend for channel '${channelName}'...`);

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
        throw new Error(errData.detail || `Token request failed with HTTP ${tokenRes.status}`);
      }

      const { token, app_id, channel_name, uid, expires_in_seconds } =
        await tokenRes.json();

      setTokenDetails({
        uid,
        channel: channel_name,
        expiresIn: expires_in_seconds,
      });
      addLog(`Token issued successfully for App ID '${app_id.slice(0, 8)}...'. Initializing Agora client...`);

      setConnectionState('JOINING');

      // Dynamically import AgoraRTC to support SSR safety
      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
      AgoraRTC.setLogLevel(1); // 1 = WARNING

      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtcClientRef.current = client;

      // Handle remote audio subscriptions
      client.on('user-published', async (user, mediaType) => {
        addLog(`Remote participant joined: UID ${user.uid} (${mediaType})`);
        await client.subscribe(user, mediaType);
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
          addLog(`Playing audio track from remote UID ${user.uid}`);
        }
      });

      client.on('user-unpublished', (user, mediaType) => {
        addLog(`Remote participant unpublished: UID ${user.uid} (${mediaType})`);
      });

      client.on('user-left', (user, reason) => {
        addLog(`Remote participant left: UID ${user.uid} (${reason})`);
      });

      // Join channel with token
      await client.join(app_id, channel_name, token, uid);
      addLog(`Joined Agora RTC channel '${channel_name}' as UID ${uid}`);

      // Create and publish local microphone audio track
      addLog('Capturing local microphone stream...');
      const localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: 'speech_standard',
        AEC: true,
        ANS: true,
        AGC: true,
      });
      localAudioTrackRef.current = localAudioTrack;

      await client.publish([localAudioTrack]);
      addLog('Local microphone published to channel successfully.');

      setConnectionState('CONNECTED');
      setIsMuted(false);

      // Audio volume level monitor
      audioIntervalRef.current = setInterval(() => {
        if (localAudioTrackRef.current && !localAudioTrackRef.current.isMuted) {
          const level = Math.round(localAudioTrackRef.current.getVolumeLevel() * 100);
          setAudioLevel(level);
        } else {
          setAudioLevel(0);
        }
      }, 100);
    } catch (err: any) {
      addLog(`Join Error: ${err.message || err}`);
      setConnectionState('ERROR');
      handleLeave();
    }
  };

  const handleToggleMute = () => {
    if (!localAudioTrackRef.current) return;
    const nextState = !isMuted;
    localAudioTrackRef.current.setEnabled(!nextState);
    setIsMuted(nextState);
    addLog(`Microphone ${nextState ? 'Muted' : 'Unmuted'}`);
  };

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        padding: '2rem 1.5rem',
      }}
    >
      <header
        style={{
          width: '100%',
          maxWidth: '800px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
        }}
      >
        <Link
          href="/"
          style={{
            color: 'var(--accent-blue)',
            textDecoration: 'none',
            fontSize: '0.9rem',
            fontWeight: 600,
          }}
        >
          ← Back to Dashboard
        </Link>
        <span
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          Milestone 4 • Sub-step 2
        </span>
      </header>

      <section
        style={{
          width: '100%',
          maxWidth: '800px',
          padding: '2rem',
          borderRadius: '16px',
          border: '1px solid var(--border)',
          backgroundColor: 'var(--card-bg)',
          boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1.5rem',
            borderBottom: '1px solid var(--border)',
            paddingBottom: '1rem',
          }}
        >
          <div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                marginBottom: '0.25rem',
              }}
            >
              Agora RTC Voice Channel Test
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Verifies human browser audio connection and token authorization.
            </p>
          </div>

          <div
            style={{
              padding: '0.4rem 0.85rem',
              borderRadius: '9999px',
              fontSize: '0.85rem',
              fontWeight: 600,
              backgroundColor:
                connectionState === 'CONNECTED'
                  ? 'rgba(63, 185, 80, 0.15)'
                  : connectionState === 'ERROR'
                  ? 'rgba(248, 81, 73, 0.15)'
                  : connectionState === 'DISCONNECTED'
                  ? 'rgba(173, 186, 199, 0.1)'
                  : 'rgba(88, 166, 255, 0.15)',
              color:
                connectionState === 'CONNECTED'
                  ? 'var(--accent-green)'
                  : connectionState === 'ERROR'
                  ? 'var(--accent-red)'
                  : connectionState === 'DISCONNECTED'
                  ? 'var(--text-secondary)'
                  : 'var(--accent-blue)',
              border: `1px solid ${
                connectionState === 'CONNECTED'
                  ? 'rgba(63, 185, 80, 0.3)'
                  : connectionState === 'ERROR'
                  ? 'rgba(248, 81, 73, 0.3)'
                  : 'var(--border)'
              }`,
            }}
          >
            ● {connectionState}
          </div>
        </div>

        {/* Channel Configuration */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="channel-input"
            style={{
              display: 'block',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: '0.5rem',
            }}
          >
            CHANNEL NAME
          </label>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <input
              id="channel-input"
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              disabled={connectionState !== 'DISCONNECTED' && connectionState !== 'ERROR'}
              style={{
                flex: 1,
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                backgroundColor: 'rgba(0, 0, 0, 0.35)',
                color: 'var(--text-primary)',
                fontSize: '1rem',
                fontFamily: 'monospace',
              }}
            />
            {connectionState === 'CONNECTED' ? (
              <button
                type="button"
                onClick={handleLeave}
                style={{
                  padding: '0.75rem 1.5rem',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: 'var(--accent-red)',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  cursor: 'pointer',
                }}
              >
                Leave Channel
              </button>
            ) : (
              <button
                type="button"
                onClick={handleJoin}
                disabled={connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING'}
                style={{
                  padding: '0.75rem 1.5rem',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor:
                    connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING'
                      ? 'var(--border)'
                      : 'var(--accent-blue)',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '0.95rem',
                  cursor:
                    connectionState === 'FETCHING_TOKEN' || connectionState === 'JOINING'
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {connectionState === 'FETCHING_TOKEN'
                  ? 'Authorizing...'
                  : connectionState === 'JOINING'
                  ? 'Connecting...'
                  : 'Join Voice Channel'}
              </button>
            )}
          </div>
        </div>

        {/* Live Audio Controls & VU Meter */}
        {connectionState === 'CONNECTED' && (
          <div
            style={{
              padding: '1.25rem',
              borderRadius: '10px',
              border: '1px solid var(--border)',
              backgroundColor: 'rgba(0, 0, 0, 0.25)',
              marginBottom: '1.5rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                  }}
                >
                  MICROPHONE VU METER
                </span>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Assigned UID: {tokenDetails?.uid} • Token TTL: {tokenDetails?.expiresIn}s
                </div>
              </div>

              <button
                type="button"
                onClick={handleToggleMute}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  backgroundColor: isMuted
                    ? 'rgba(248, 81, 73, 0.2)'
                    : 'rgba(63, 185, 80, 0.2)',
                  color: isMuted ? 'var(--accent-red)' : 'var(--accent-green)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {isMuted ? '🔇 Unmute Mic' : '🎙 Mic Active'}
              </button>
            </div>

            {/* Audio level meter bar */}
            <div
              style={{
                width: '100%',
                height: '10px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '5px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, audioLevel * 2)}%`,
                  height: '100%',
                  backgroundColor:
                    audioLevel > 50 ? 'var(--accent-red)' : 'var(--accent-green)',
                  transition: 'width 0.08s ease-out',
                }}
              />
            </div>
          </div>
        )}

        {/* Live Diagnostics Console */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                letterSpacing: '0.05em',
                color: 'var(--text-secondary)',
              }}
            >
              LIVE DIAGNOSTIC LOGS
            </span>
            <button
              type="button"
              onClick={() => setLogs([])}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Clear
            </button>
          </div>

          <div
            style={{
              padding: '1rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              backgroundColor: '#050810',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              height: '160px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column-reverse',
              color: 'var(--text-primary)',
            }}
          >
            {logs.map((log, i) => (
              <div
                key={i}
                style={{
                  marginBottom: '0.35rem',
                  lineHeight: '1.4',
                  color: log.includes('Error')
                    ? 'var(--accent-red)'
                    : log.includes('successfully') || log.includes('Joined')
                    ? 'var(--accent-green)'
                    : 'var(--text-secondary)',
                }}
              >
                {log}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
