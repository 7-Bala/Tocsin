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
import { TurnSettler } from './turnSettler';

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

  onLog('RTM: loading agora-rtm SDK module...');
  const AgoraRTM = (await import('agora-rtm')).default;
  onLog(`RTM: SDK loaded (v${AgoraRTM.VERSION}), creating client as '${userAccount}'...`);
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

  onLog('RTM: logging in...');
  await withTimeout(rtmClient.login({ token: rtmToken }), 'RTM login');
  onLog(`RTM signaling login succeeded (identity: ${userAccount})`);

  const { AgoraVoiceAI, AgoraVoiceAIEvents, TranscriptHelperMode } = await import(
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
  onLog('ConvoAI toolkit initialized (rtc + rtm engines attached)');

  // ── Handlers MUST be registered before subscribeMessage() ────────────────

  // TRANSCRIPT_UPDATED carries the full history every time, and each turn's
  // text arrives as a live-growing stream (ASR/LLM tokens appended one at a
  // time) long before item.status ever reaches END -- confirmed live
  // 2026-09-04, the first session with working RTM delivery at all: a single
  // six-line conversation produced 30 near-identical hypotheses, each just a
  // few more words than the last, because every intermediate growth step of
  // one spoken sentence was being forwarded and ingested as its own complete
  // observation. See turnSettler.ts for the debounce this now goes through --
  // one settled event per turn, not one per growth step.
  const STABLE_MS = 2000;

  // `item.turn_id` is NOT a stable identifier for one spoken sentence in this
  // toolkit version -- confirmed live 2026-09-05: one sentence produced THREE
  // separate database rows, each the full cumulative text so far ("The
  // login", "The login API is returning...", "The login API is returning...
  // for about forty percent of requests."), because each growth snapshot
  // arrived under a DIFFERENT turn_id. TurnSettler debounces per key, so each
  // new turn_id looked like a brand-new, never-before-seen turn and its full
  // text was forwarded immediately instead of being merged as growth. The
  // second sentence in that same run never completed at all, for the same
  // reason: its final growth arrived under yet another fresh turn_id whose
  // 2000ms timer was still pending when the session ended.
  //
  // Correlate by uid + recency instead: any item for the same uid arriving
  // within STABLE_MS of the previous one is the same logical utterance
  // regardless of what turn_id Agora assigns it; a gap that long is a
  // genuine new utterance, so it gets a fresh key. `settle()`'s own
  // startsWith check (turnSettler.ts) is the backstop that keeps two real,
  // back-to-back sentences from the same speaker from being merged even if
  // this map somehow reused a key.
  const lastKeyForUid = new Map<string, string>();
  const lastIngestAtForUid = new Map<string, number>();

  let seq = 0;
  const settler = new TurnSettler({
    // 700ms was SHORTER than the real inter-token gap (~1s, measured from the
    // 2026-09-05 Scenario B run), so every growth step went quiet long enough to
    // settle and was forwarded as its own observation -- 115 of them for ~10
    // spoken sentences. The debounce has to exceed the worst gap, not the
    // median. isFinal is now always false (see below), so this is the ONLY
    // path anything settles through -- there is no faster path to add
    // latency back against.
    stableMs: STABLE_MS,
    onSettled: ({ key, text, isUser, objectType }) => {
      lastKeyForUid.delete(key.split(':')[0]); // let the next item start a fresh key
      onEvent({
        utteranceId: key,
        speaker: isUser ? 'YOU' : 'TOCSIN',
        text,
        isFinal: true,
        seq: seq++,
        rawType: objectType ?? 'transcript',
      });
    },
  });

  // TRANSCRIPT_UPDATED re-delivers the FULL history on every emission -- not
  // just when something changed. Confirmed live 2026-09-06: the callback
  // fired every ~200ms continuously for the entire session, re-sending
  // already-completed turns with status=END every single time, 40+ seconds
  // after they were actually spoken. Treating each of those as a fresh final
  // event (the uid+recency key above still applies to them) minted a new key
  // and re-forwarded the whole old sentence as if it were new content --
  // caught by the backend's 30-second dedup window most of the time, but
  // slipping through as a "fresh" duplicate every ~30s, which is what
  // produced the progressively-truncated repeat hypotheses on the
  // whiteboard. A turn_id whose text is byte-identical to what was already
  // seen for it is pure redelivery noise, not new speech -- skip it before it
  // ever reaches the debounce logic below.
  const lastSeenTextForTurnId = new Map<string, string>();

  ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items: any[]) => {
    for (const item of items ?? []) {
      const text: string = (item?.text ?? '').trim();
      if (!text) continue;

      const turnIdKey = `${item?.uid}:${item?.turn_id}`;
      if (lastSeenTextForTurnId.get(turnIdKey) === text) continue;
      lastSeenTextForTurnId.set(turnIdKey, text);

      const rawUid = String(item?.uid);
      const now = Date.now();
      const lastAt = lastIngestAtForUid.get(rawUid) ?? 0;
      let key = lastKeyForUid.get(rawUid);
      if (!key || now - lastAt > STABLE_MS) {
        key = `${rawUid}:${now}`;
        lastKeyForUid.set(rawUid, key);
      }
      lastIngestAtForUid.set(rawUid, now);

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

      // Confirmed live 2026-09-06, in a brand-new room with no prior state:
      // item.status reports END on EVERY growth segment of a still-growing
      // sentence, not just its true end -- "The login API is" / "...is
      // returning" / "...returning HTTP five" each carried status END on
      // their own, so the isFinal path fired settle() immediately for each,
      // producing 7 rows for one sentence despite the uid+recency key fix
      // above (which only helps when growth is debounced, not when every
      // step self-reports as final). This is the exact same lesson already
      // learned for Deepgram (see deepgram.py / commit 74a9377): an
      // upstream ASR's own "final" claim is not trustworthy as a settle
      // signal. Never trust it here either -- isFinal is hardcoded false for
      // every RTM turn, user and agent alike, so settling always goes
      // through the STABLE_MS silence debounce below, not this fast path.
      settler.ingest(key, text, false, isUser, objectType);
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
    onLog(`[Agent pipeline error] ${error?.type ?? 'unknown'} (${error?.code}): ${error?.message}`);
  });

  ai.on(AgoraVoiceAIEvents.DEBUG_LOG, (msg: string) => {
    onLog(`[toolkit] ${msg}`);
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
  onLog(`ConvoAI listeners bound for '${channelName}'`);

  await withTimeout(
    rtmClient.subscribe(channelName, { withMessage: true, withPresence: true }),
    'RTM subscribe'
  );
  onLog(`RTM channel '${channelName}' subscribed — awaiting agent transcripts`);

  return {
    stop: async () => {
      // A turn still mid-debounce when the session ends must not fire after
      // teardown -- onEvent's page-side handler may reference state (refs,
      // the incident id) that's already been torn down by handleLeave.
      settler.destroy();
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
