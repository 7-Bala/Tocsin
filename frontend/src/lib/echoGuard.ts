/**
 * Decides whether the utterance the microphone just picked up belongs to the
 * human operator, or is the agent's own voice coming back through the speakers.
 *
 * This has failed in BOTH directions, which is why it now lives in a pure
 * function with a test matrix instead of inline in a React callback:
 *
 *  - 2026-09-04: the guard was evaluated at SpeechRecognition result time, 1-3s
 *    after the words were spoken, by which point the agent was usually
 *    mid-reply. A full six-line incident script produced ZERO observations --
 *    every line of genuine operator speech was thrown away.
 *
 *  - 2026-09-05 (incident room-202609051125-3zuj4): the guard was moved to VAD
 *    speech-start, but its fast signal was Agora's RTM AGENT_STATE_CHANGED, and
 *    that run delivered no agent RTM events at all. The only fallback left was
 *    RTC's volume-indicator, which the SDK hard-codes to fire every 2000ms, so
 *    short agent replies finished before the guard ever learned the agent was
 *    talking. The agent's own SEV1 paging announcement was recorded as an
 *    Operator report and became an action item.
 *
 * The rule that prevents oscillating between those two failures:
 *
 *      SUPPRESSION REQUIRES POSITIVE EVIDENCE OF AGENT AUDIO.
 *
 * Absence of evidence is never enough. If no agent signal is available at all --
 * the analyser was never attached, the agent never published, RTM is dead -- the
 * utterance is attributed to the operator. Recording the agent's words by
 * mistake is a bug in the evidence record and is visible; silently discarding
 * the operator's words leaves nothing at all, and nobody notices until the run
 * is over.
 */

/**
 * Smoothed RMS above which the agent's remote track counts as actively
 * speaking.
 *
 * Provisional and deliberately conservative. It is aligned with the 0.02 floor
 * the waveform renderer already applies when it knows the agent is speaking, but
 * it has NOT been calibrated against a real device -- speaker volume, headphones
 * vs laptop speakers, and room noise all move it. Treat it as the secondary
 * signal it is: RTM agent state, when present, decides first, and a
 * mis-calibrated threshold here degrades to "attribute to operator" rather than
 * to silence.
 */
export const AGENT_RMS_SPEAKING_THRESHOLD = 0.015;

/**
 * How recently the agent's audio must have crossed the RMS threshold for that
 * alone to count as "currently speaking".
 *
 * Exists for a race the plain `agentRms` check misses: onSpeechStart reads
 * `agentRms` as one point-in-time snapshot of an exponentially SMOOTHED value.
 * At the exact instant the agent's first buffer of a fresh utterance (e.g. its
 * opening greeting) starts playing, the smoothed value can still be ramping up
 * from ~0 and read below threshold for a frame or two even though the agent is
 * genuinely, audibly mid-word. Live-reported 2026-09-05: the agent's own
 * greeting -- "Emergency coordinator active, how can I assist" -- was recorded
 * whole as an Operator observation, at the very start of a session when this
 * race is most likely (the analyser has only just attached).
 *
 * `msSinceAgentAudioObserved` tracks the RAW crossing, sampled every frame,
 * independent of the smoothing's attack lag -- so a crossing one frame before
 * onSpeechStart still counts as "recent" even if the smoothed value at the
 * exact instant of the check had not yet caught up.
 */
export const AGENT_AUDIO_RECENCY_MS = 250;

export interface EchoGuardInputs {
  /** Smoothed RMS of the agent's own remote audio track, roughly 0..1. */
  agentRms: number;
  /**
   * Whether an analyser is actually attached to the agent's track. False means
   * `agentRms` (and `msSinceAgentAudioObserved`) carry no information and must
   * not be read as silence.
   */
  agentSignalAvailable: boolean;
  /** Agora RTM AGENT_STATE_CHANGED === 'speaking'. The fastest signal, when it arrives. */
  rtmAgentSpeaking: boolean;
  /** Milliseconds since the agent's audio was last observed to stop. */
  msSinceAgentSpeechEnded: number;
  /**
   * Milliseconds since agentRms was last seen above AGENT_RMS_SPEAKING_THRESHOLD
   * at all (the raw crossing, not the smoothed snapshot). Pass a very large
   * number when the agent's audio has never crossed the threshold this session.
   */
  msSinceAgentAudioObserved: number;
  /** How long after the agent stops its audio may still be bleeding into the mic. */
  echoTailMs: number;
}

export interface EchoGuardDecision {
  attributeToOperator: boolean;
  /** Why, for the on-screen log. Suppression must always be explainable. */
  reason: string;
}

export function decideUtteranceAttribution(input: EchoGuardInputs): EchoGuardDecision {
  const {
    agentRms,
    agentSignalAvailable,
    rtmAgentSpeaking,
    msSinceAgentSpeechEnded,
    msSinceAgentAudioObserved,
    echoTailMs,
  } = input;

  if (rtmAgentSpeaking) {
    return { attributeToOperator: false, reason: 'agent is speaking (RTM state)' };
  }

  if (agentSignalAvailable && agentRms > AGENT_RMS_SPEAKING_THRESHOLD) {
    return {
      attributeToOperator: false,
      reason: `agent audio present (rms ${agentRms.toFixed(3)})`,
    };
  }

  // Catches the onset race described above the constant: the raw crossing was
  // seen a frame or two ago, but the smoothed `agentRms` read at this exact
  // instant hasn't caught up yet.
  if (agentSignalAvailable && msSinceAgentAudioObserved < AGENT_AUDIO_RECENCY_MS) {
    return {
      attributeToOperator: false,
      reason: `agent audio observed ${Math.round(msSinceAgentAudioObserved)}ms ago`,
    };
  }

  // The tail only applies when something actually observed the agent stop. A
  // never-set timestamp reads as "long ago" by construction, so this cannot
  // suppress speech that began before any agent activity.
  if (msSinceAgentSpeechEnded < echoTailMs) {
    return {
      attributeToOperator: false,
      reason: `within ${echoTailMs}ms echo tail (${Math.round(msSinceAgentSpeechEnded)}ms)`,
    };
  }

  return { attributeToOperator: true, reason: 'no agent audio detected' };
}

/** Convenience wrapper for call sites that only need the boolean. */
export function shouldAttributeToOperator(input: EchoGuardInputs): boolean {
  return decideUtteranceAttribution(input).attributeToOperator;
}
