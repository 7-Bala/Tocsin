/**
 * Agora ConvoAI transcript transport — official client toolkit.
 *
 * HISTORY / WHY THIS WAS REWRITTEN
 * --------------------------------
 * This file previously hand-rolled the transport: RTM login, then
 * `client.subscribe(channel, { withMessage: true })`, then a bespoke decoder
 * (agoraStreamDecoder.ts) applied to the raw `message` event. That was written
 * by reading Agora's Conversational-AI-Demo app, because the docs page
 * (docs.agora.io/en/conversational-ai/develop/transcripts) documents the
 * *callback* but never publishes the wire format. It concluded, from one demo
 * file, that "RTM channel messages are plain JSON (string or UTF-8 bytes, no
 * chunking/base64 envelope)".
 *
 * That assumption is not safe, and the hand-rolled path never once delivered a
 * transcript in live testing across both pipelines (gemini_live and
 * composed_tools) — see docs/agora/RESEARCH.md §9 and TODO.md P0. Agora ships
 * an official client SDK for exactly this job, `agora-agent-client-toolkit`,
 * which owns the real protocol: message-type dispatch, turn assembly, and
 * multi-part CHUNK reassembly (a fragmented transport the hand-rolled decoder
 * had no concept of, and which would silently produce nothing).
 *
 * So the transport is now the official toolkit. agoraStreamDecoder.ts is left
 * in place and still unit-tested: it remains the decoder for the legacy RTC
 * stream-message fallback path in voice-test/page.tsx.
 *
 * CONTRACT NOTES (verified against node_modules/agora-agent-client-toolkit
 * v2.9.1 dist/index.d.ts, not against the docs, which are stale on two points):
 *   - Config takes `rtmEngine` DIRECTLY. The published docs show
 *     `rtmConfig: { rtmEngine }`; that shape is wrong for 2.9.1.
 *   - `init()` is async and the class is a singleton — `destroy()` before
 *     re-initializing, or the second `init()` silently replaces the first.
 *   - Handlers must be registered BEFORE `subscribeMessage()`, otherwise
 *     messages already in flight are dropped.
 *   - TRANSCRIPT_UPDATED delivers the COMPLETE history on every emission, not a
 *     delta. Callers that append would duplicate the entire conversation on each
 *     event, so this module diffs against what it has already emitted and
 *     forwards only genuinely new or changed turns.
 *   - The toolkit needs the SAME RTC client the page already joined with; it
 *     does not create or join one itself.
 */

import type { DecodedStreamEvent } from './agoraStreamDecoder';

export interface RtmTranscriptSession {
  stop: () => Promise<void>;
}

export async function startRtmTranscriptSession(options: {
  appId: string;
  rtmToken: string;
  /**
   * RTM login identity. Must match the subject the RTM token was minted for --
   * the toolkit's own init() example notes this is "often String(rtcUid)", and
   * a mismatch surfaces as a generic conversation-start failure rather than a
   * clear auth error.
   */
  userAccount: string;
  channelName: string;
  /** The already-joined RTC client. The toolkit attaches to it; it will not join for you. */
  rtcClient: any;
  onEvent: (event: DecodedStreamEvent) => void;
  onLog: (msg: string) => void;
  /** Optional: agent lifecycle state (idle/listening/thinking/speaking) for the HUD. */
  onAgentState?: (state: string) => void;
}): Promise<RtmTranscriptSession> {
  const {
    appId,
    rtmToken,
    userAccount,
    channelName,
    rtcClient,
    onEvent,
    onLog,
    onAgentState,
  } = options;

  onLog('📡 RTM: loading agora-rtm SDK module...');
  const AgoraRTM = (await import('agora-rtm')).default;
  onLog(`📡 RTM: SDK loaded (v${AgoraRTM.VERSION}), creating client as '${userAccount}'...`);
  const rtmClient = new AgoraRTM.RTM(appId, userAccount);

  // login()/subscribe() have no timeout of their own -- a blocked RTM WSS
  // connection (firewall, network policy) hangs forever with no error, which is
  // exactly what made this path undiagnosable before. A hard timeout turns a
  // silent hang into a visible, logged failure.
  const withTimeout = <T,>(promise: Promise<T>, label: string, ms = 10000): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${ms}ms (no response -- likely network/firewall blocking the RTM WSS connection)`
              )
            ),
          ms
        )
      ),
    ]);

  onLog('📡 RTM: logging in...');
  await withTimeout(rtmClient.login({ token: rtmToken }), 'RTM login');
  onLog(`📡 RTM signaling login succeeded (identity: ${userAccount})`);

  const { AgoraVoiceAI, AgoraVoiceAIEvents, TranscriptHelperMode, TurnStatus } = await import(
    'agora-agent-client-toolkit'
  );

  // Singleton: a previous session's instance would otherwise be silently
  // replaced, leaving its handlers attached to a dead RTM client.
  try {
    AgoraVoiceAI.getInstance()?.destroy();
  } catch {
    /* not initialized yet -- expected on first run */
  }

  const ai = await AgoraVoiceAI.init({
    rtcEngine: rtcClient,
    rtmEngine: rtmClient,
    renderMode: TranscriptHelperMode.AUTO,
    enableLog: true,
  });
  onLog('📡 ConvoAI toolkit initialized (rtc + rtm engines attached)');

  // ── Handlers MUST be registered before subscribeMessage() ────────────────

  // TRANSCRIPT_UPDATED carries the full history every time. Emit only what is
  // new or has changed since the last emission, keyed by speaker+turn, so the
  // page's append-style consumer stays correct.
  const emitted = new Map<string, string>();
  let seq = 0;

  ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items: any[]) => {
    for (const item of items ?? []) {
      const text: string = (item?.text ?? '').trim();
      if (!text) continue;

      const key = `${item?.uid}:${item?.turn_id}`;
      if (emitted.get(key) === text) continue;
      emitted.set(key, text);

      // metadata.object is authoritative for who spoke. Fallback matches Agora's
      // own official quickstart (agent-quickstart-nextjs/lib/conversation.ts):
      // uid === "0" is the toolkit's SENTINEL for local-user speech, not a real
      // RTC uid to compare against our own identity -- comparing it to
      // userAccount (as this file previously did) would misattribute every
      // local turn to the agent, since "0" never equals a real uid.
      const objectType: string | undefined = item?.metadata?.object;
      const isUser =
        objectType === 'user.transcription' ||
        (objectType === undefined && String(item?.uid) === '0');

      onEvent({
        utteranceId: key,
        speaker: isUser ? 'YOU' : 'TOCSIN',
        text,
        isFinal: item?.status === TurnStatus.END || item?.status === TurnStatus.INTERRUPTED,
        seq: seq++,
        rawType: objectType ?? 'transcript',
      });
    }
  });

  if (onAgentState) {
    ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_uid: string, event: any) => {
      onAgentState(event?.state ?? 'unknown');
    });
  }

  // Surface pipeline errors instead of failing silently. Requires
  // parameters.enable_error_message: true on the agent join payload.
  ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (_uid: string, error: any) => {
    onLog(`⚠️ [Agent pipeline error] ${error?.type ?? 'unknown'} (${error?.code}): ${error?.message}`);
  });

  ai.on(AgoraVoiceAIEvents.DEBUG_LOG, (msg: string) => {
    onLog(`🔍 [toolkit] ${msg}`);
  });

  // Bind the toolkit's listeners FIRST, then open the transport. Verified
  // against dist/index.js v2.9.1: subscribeMessage() only calls bindRtcEvents()
  // / bindRtmEvents() and stores the channel name -- the string ".subscribe("
  // appears ZERO times in the entire bundle. The toolkit therefore never joins
  // the RTM channel itself, and a client that relies on it alone registers
  // handlers on a channel it was never subscribed to, receiving nothing for
  // ever. The RTM channel subscription below is what actually makes messages
  // flow, and it matches the documented requirement to "subscribe the RTM
  // client to the same channel name you passed to the agent's
  // properties.channel".
  ai.subscribeMessage(channelName);
  onLog(`📡 ConvoAI listeners bound for '${channelName}'`);

  await withTimeout(
    rtmClient.subscribe(channelName, { withMessage: true, withPresence: true }),
    'RTM subscribe'
  );
  onLog(`📡 RTM channel '${channelName}' subscribed — awaiting agent transcripts`);

  return {
    stop: async () => {
      try {
        ai.unsubscribe();
        ai.destroy();
      } catch (err: any) {
        onLog(`Toolkit teardown warning: ${err?.message || err}`);
      }
      try {
        await rtmClient.unsubscribe(channelName);
        await rtmClient.logout();
      } catch (err: any) {
        onLog(`RTM teardown warning: ${err?.message || err}`);
      }
    },
  };
}
