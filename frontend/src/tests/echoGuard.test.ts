/**
 * Mic-echo attribution matrix.
 *
 * This guard has failed in both directions on consecutive days, so the suite is
 * written as a two-sided contract rather than a set of happy paths. The named
 * regression cases at the bottom reproduce each real incident.
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import {
  AGENT_RMS_SPEAKING_THRESHOLD,
  decideUtteranceAttribution,
  shouldAttributeToOperator,
} from '../lib/echoGuard';

const TAIL = 700;

/** Silent agent, analyser attached, agent last spoke long ago. */
function baseline() {
  return {
    agentRms: 0,
    agentSignalAvailable: true,
    rtmAgentSpeaking: false,
    msSinceAgentSpeechEnded: 60_000,
    echoTailMs: TAIL,
  };
}

describe('echoGuard', () => {
  test('silence from the agent means the operator is speaking', () => {
    assert.strictEqual(shouldAttributeToOperator(baseline()), true);
  });

  test('RTM reporting the agent as speaking suppresses attribution', () => {
    assert.strictEqual(
      shouldAttributeToOperator({ ...baseline(), rtmAgentSpeaking: true }),
      false
    );
  });

  test('loud agent audio suppresses attribution even when RTM says nothing', () => {
    // The 2026-09-05 case: RTM delivered no agent events whatsoever, so the
    // acoustic signal is the only thing that can catch the echo.
    assert.strictEqual(
      shouldAttributeToOperator({
        ...baseline(),
        agentRms: AGENT_RMS_SPEAKING_THRESHOLD * 4,
      }),
      false
    );
  });

  test('an utterance starting inside the echo tail is suppressed', () => {
    assert.strictEqual(
      shouldAttributeToOperator({ ...baseline(), msSinceAgentSpeechEnded: 200 }),
      false
    );
  });

  test('an utterance starting after the echo tail is the operator', () => {
    assert.strictEqual(
      shouldAttributeToOperator({ ...baseline(), msSinceAgentSpeechEnded: TAIL + 1 }),
      true
    );
  });

  test('agent audio just below the threshold does not suppress', () => {
    assert.strictEqual(
      shouldAttributeToOperator({
        ...baseline(),
        agentRms: AGENT_RMS_SPEAKING_THRESHOLD * 0.5,
      }),
      true
    );
  });

  // ── The fail-open rule ────────────────────────────────────────────────
  // Absence of a signal is not evidence of agent audio. These are the tests
  // that stop the 2026-09-04 zero-observation regression from returning.

  test('FAILS OPEN when no agent signal is available at all', () => {
    // Analyser never attached (agent never published, or attach threw). agentRms
    // is 0 but carries no information -- it must NOT be read as "agent silent",
    // nor as an excuse to suppress.
    const decision = decideUtteranceAttribution({
      ...baseline(),
      agentSignalAvailable: false,
      agentRms: 0,
    });
    assert.strictEqual(decision.attributeToOperator, true);
  });

  test('FAILS OPEN when the analyser is missing and its rms reads high as noise', () => {
    // A detached analyser's buffer is meaningless; a stale high value must not
    // silence the operator.
    assert.strictEqual(
      shouldAttributeToOperator({
        ...baseline(),
        agentSignalAvailable: false,
        agentRms: 0.9,
      }),
      true
    );
  });

  test('REGRESSION 2026-09-04: a six-line script with RTM dead keeps every line', () => {
    // Every line of a real incident script, spoken while the agent is silent and
    // RTM delivers nothing. All six must reach the record. When this suite last
    // regressed, the answer was zero.
    const script = [
      'Customers are unable to log in across multiple regions.',
      'The login API is returning HTTP 503 errors for around 40% of requests.',
      'I suspect the authentication database is overloaded.',
      'Database CPU and connection usage look normal and healthy.',
      'Login failures started shortly after the identity-service deployment.',
      'I will compare authentication error rates within ten minutes.',
    ];

    const kept = script.filter(() =>
      shouldAttributeToOperator({
        agentRms: 0,
        agentSignalAvailable: true,
        rtmAgentSpeaking: false, // RTM is dead -- no agent state ever arrives
        msSinceAgentSpeechEnded: 60_000,
        echoTailMs: TAIL,
      })
    );

    assert.strictEqual(kept.length, 6, 'operator speech must never be silently discarded');
  });

  test('REGRESSION 2026-09-05: the agent paging announcement is not operator evidence', () => {
    // "This is a confirmed active issue... categorized as sev1. I will page the
    // on-call engineer." Spoken by the agent, recorded as an Operator report,
    // and turned into action item ai-f42849e8. RTM was silent; only the acoustic
    // signal could catch it.
    const decision = decideUtteranceAttribution({
      agentRms: 0.08,
      agentSignalAvailable: true,
      rtmAgentSpeaking: false,
      msSinceAgentSpeechEnded: 0,
      echoTailMs: TAIL,
    });
    assert.strictEqual(decision.attributeToOperator, false);
    assert.match(decision.reason, /agent audio present/);
  });

  test('every decision carries a human-readable reason', () => {
    // Suppression has to be explainable on screen; a silent drop is what made
    // both regressions invisible until after the session.
    for (const overrides of [
      {},
      { rtmAgentSpeaking: true },
      { agentRms: 0.5 },
      { msSinceAgentSpeechEnded: 10 },
    ]) {
      const { reason } = decideUtteranceAttribution({ ...baseline(), ...overrides });
      assert.ok(reason && reason.length > 0, 'a decision without a reason is not debuggable');
    }
  });
});
