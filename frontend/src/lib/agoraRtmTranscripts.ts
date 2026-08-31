/**
 * Agora RTM (Signaling) transcript transport.
 *
 * Per official Agora docs (docs.agora.io/en/conversational-ai/develop/transcripts),
 * live transcript data from the Conversational AI agent is delivered as Signaling
 * (RTM) channel messages, not through RTC — a separate RTM login/subscription is
 * required alongside the existing RTC voice connection. This is why
 * backend/app/api/agora.py now sends `advanced_features.enable_rtm: true` and
 * `parameters.data_channel: "rtm"` on every agent-join: once `data_channel` is set
 * to "rtm", this is the transport Agora actually uses, replacing (not
 * supplementing) whatever delivered transcripts before.
 *
 * The exact RTM message wire format is not published on the docs page itself (it
 * only says messages arrive via the toolkit's `onTranscriptUpdated` callback), so
 * this file was written by reading Agora's own reference implementation directly:
 * https://github.com/AgoraIO-Community/Conversational-AI-Demo/blob/main/Web/Scenes/VoiceAgent/src/conversational-ai-api/index.ts
 * (see `_handleRtmMessage`) and
 * .../conversational-ai-api/type.ts (see `EMessageType`, `IUserTranscription`,
 * `IAgentTranscription`). That confirms RTM channel messages are plain JSON
 * (string or UTF-8 bytes, no chunking/base64 envelope) with an `object` field of
 * `"user.transcription"` / `"assistant.transcription"` and a `text`/`final` shape —
 * exactly what agoraStreamDecoder.ts's "Pattern 3: Direct JSON string" branch
 * already parses. Rather than vendoring Agora's ~2,700-line toolkit (which itself
 * depends on the internal `@agora-js/report` package and demo-app-specific files
 * not part of the toolkit proper), this reuses the existing decoder as the parser
 * and adds only the RTM transport (login + channel subscription) on top of it.
 *
 * NOT YET LIVE-VERIFIED: login/subscribe wiring is confirmed against the official
 * SDK's TypeScript API surface and doc-fetch attempts, but no live agent session
 * has confirmed a real transcript message arrives in this shape. See
 * docs/agora/RESEARCH.md §5.
 */

import { decodeAgoraStreamMessage, DecodedStreamEvent } from './agoraStreamDecoder';

export interface RtmTranscriptSession {
  stop: () => Promise<void>;
}

export async function startRtmTranscriptSession(options: {
  appId: string;
  rtmToken: string;
  userAccount: string;
  channelName: string;
  onEvent: (event: DecodedStreamEvent) => void;
  onLog: (msg: string) => void;
}): Promise<RtmTranscriptSession> {
  const { appId, rtmToken, userAccount, channelName, onEvent, onLog } = options;

  const AgoraRTM = (await import('agora-rtm')).default;
  const client = new AgoraRTM.RTM(appId, userAccount);

  const handleMessage = (event: any) => {
    try {
      const raw = event?.message;
      if (raw === undefined || raw === null) return;

      const text: string =
        typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw as Uint8Array);
      const bytes = new TextEncoder().encode(text);
      const publisher = event?.publisher ?? 'agora_rtm';

      const decoded: DecodedStreamEvent | null = decodeAgoraStreamMessage(publisher, bytes);
      if (!decoded || !decoded.text) return;
      onEvent(decoded);
    } catch (err: any) {
      onLog(`⚠️ [RTM Decoder Error] ${err?.message || 'RTM frame decoding issue'}`);
    }
  };

  client.addEventListener('message', handleMessage);

  await client.login({ token: rtmToken });
  onLog(`📡 RTM signaling login succeeded (user_account: ${userAccount})`);

  await client.subscribe(channelName, { withMessage: true });
  onLog(`📡 RTM subscribed to transcript channel '${channelName}'`);

  return {
    stop: async () => {
      try {
        client.removeEventListener('message', handleMessage);
        await client.unsubscribe(channelName);
        await client.logout();
      } catch (err: any) {
        onLog(`RTM teardown warning: ${err?.message || err}`);
      }
    },
  };
}
