/**
 * TurnSettler regression suite.
 *
 * Root cause it guards against, live-reported 2026-09-04 (the first session
 * with working Agora RTM transcript delivery at all): TRANSCRIPT_UPDATED
 * delivers each turn's text as a live-growing stream, well before
 * item.status ever reaches END. Without debouncing, every growth step of one
 * spoken sentence was ingested as its own complete observation -- a single
 * six-line conversation produced 30 near-identical hypotheses (and matching
 * duplicate action items and timeline entries) from what should have been a
 * handful of real utterances.
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { SettledTurn, TurnSettler } from '../lib/turnSettler';

/** A fake scheduler so tests run instantly and control time deterministically. */
function fakeClock() {
  let idCounter = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimeoutFn: (fn: () => void) => {
      const id = ++idCounter;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    },
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    pendingCount: () => pending.size,
  };
}

describe('TurnSettler', () => {
  test('a growing transcript for one turn key settles exactly once', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 700,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Same growth pattern observed live: each update is a longer prefix of
    // the same sentence, status never reaches END until the very end.
    settler.ingest('9999:turn_1', 'That correlation strongly suggests', false, false, 'assistant.transcription');
    settler.ingest('9999:turn_1', 'That correlation strongly suggests a deployment-related', false, false, 'assistant.transcription');
    settler.ingest('9999:turn_1', 'That correlation strongly suggests a deployment-related issue.', false, false, 'assistant.transcription');

    // Nothing should be forwarded yet -- each new growth step re-armed the
    // debounce timer instead of letting the earlier one fire.
    assert.strictEqual(settled.length, 0, 'must not forward partial growth steps');
    assert.strictEqual(clock.pendingCount(), 1, 'exactly one pending timer, not one per update');

    clock.fireAll();

    assert.strictEqual(settled.length, 1, 'exactly one event for the whole turn');
    assert.strictEqual(settled[0].text, 'That correlation strongly suggests a deployment-related issue.');
    assert.strictEqual(settled[0].key, '9999:turn_1');
  });

  test('an explicit final status settles immediately without waiting for the debounce', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 700,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('9999:turn_1', 'Partial text', false, false, 'assistant.transcription');
    settler.ingest('9999:turn_1', 'Partial text, now complete.', true, false, 'assistant.transcription');

    assert.strictEqual(settled.length, 1, 'final status must settle right away');
    assert.strictEqual(settled[0].text, 'Partial text, now complete.');
    assert.strictEqual(clock.pendingCount(), 0, 'the superseded debounce timer must be cancelled, not left pending');
  });

  test('a later exact repeat of an already-settled turn is not re-emitted', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 700,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('9999:turn_1', 'Final sentence.', true, false, 'assistant.transcription');
    // Agora re-delivers the same final text again (TRANSCRIPT_UPDATED resends
    // full history on every emission) -- must not double-count it.
    settler.ingest('9999:turn_1', 'Final sentence.', true, false, 'assistant.transcription');

    assert.strictEqual(settled.length, 1, 'an exact repeat of a settled turn must be ignored');
  });

  test('two distinct turns (operator then agent) settle independently', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 700,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('0:turn_1', 'The login API is returning errors.', true, true, 'user.transcription');
    settler.ingest('9999:turn_2', 'I see the correlation with the deployment.', true, false, 'assistant.transcription');

    assert.strictEqual(settled.length, 2);
    assert.strictEqual(settled[0].isUser, true);
    assert.strictEqual(settled[1].isUser, false);
  });

  // This test previously asserted the opposite -- that destroy() drops a
  // mid-debounce turn. That expectation encoded a data-loss bug: the last thing
  // said before leaving the room is ALWAYS mid-debounce, so every conversation
  // lost its final utterance, and raising stableMs to 2000ms widens that window.
  test('destroy() flushes pending turns instead of dropping the final utterance', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 2000,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('9999:turn_1', 'Still speaking when the session ends', false, false, 'assistant.transcription');
    assert.strictEqual(clock.pendingCount(), 1);

    settler.destroy();
    assert.strictEqual(clock.pendingCount(), 0, 'destroy must clear the pending timer');
    assert.strictEqual(settled.length, 1, 'the in-flight turn must be flushed, not discarded');
    assert.strictEqual(settled[0].text, 'Still speaking when the session ends');

    clock.fireAll(); // no-op: the timer was cleared
    assert.strictEqual(settled.length, 1, 'flushing must not also let the timer fire a duplicate');
  });

  // ── Regression suite for the 2026-09-05 Scenario B run ──────────────────
  // 115 observations were recorded for ~10 spoken sentences. stableMs was 700ms
  // while the real inter-token gap was ~1s, so every growth step settled; and
  // suppression compared only for EXACT equality, so a turn that kept growing
  // after settling re-emitted the whole sentence again, one word longer.

  test('growth after a settle emits only the new suffix, never the whole sentence again', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 2000,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('0:turn_1', 'That does not hold up.', false, true, 'user.transcription');
    clock.fireAll(); // speaker paused longer than stableMs -- settles early
    assert.strictEqual(settled.length, 1);

    // ...then carries on with the same sentence.
    settler.ingest(
      '0:turn_1',
      'That does not hold up. Request volume is about twenty percent below normal for this hour.',
      false,
      true,
      'user.transcription'
    );
    clock.fireAll();

    assert.strictEqual(settled.length, 2, 'the continuation is one further event');
    assert.strictEqual(
      settled[1].text,
      'Request volume is about twenty percent below normal for this hour.',
      'only the part not already on the record may be forwarded'
    );
  });

  test('a trivial trailing fragment after a settle is absorbed, not recorded', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 2000,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('0:turn_1', "That doesn't hold", false, true, 'user.transcription');
    clock.fireAll();
    settler.ingest('0:turn_1', "That doesn't hold up", false, true, 'user.transcription');
    clock.fireAll();

    assert.strictEqual(settled.length, 1, 'a two-word tail must not become its own observation');
  });

  test('the real Scenario B growth trace collapses to one observation per sentence', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 2000,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Verbatim from the observations table of incident room-202609051125-3zuj4:
    // one spoken sentence delivered as 13 growing partials, each of which became
    // its own observation, its own claim, and its own LLM call.
    const growth = [
      'Platform team confirmed',
      'Platform team confirmed that the auto service',
      'Platform team confirmed that the auto service bots are crash',
      'Platform team confirmed that the order service bots are cross looking.',
      'Platform team confirmed that the order service bots are cross looking. They are getting',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and restarting',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and restarting roughly every ninety',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and restarting roughly every ninety seconds. Nothing is still',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and restarting roughly every ninety seconds. Nothing is staying up long enough',
      'Platform team confirmed that the order service bots are cross looking. They are getting OOM killed and restarting roughly every ninety seconds. Nothing is staying up long enough to serve traffic.',
    ];
    for (const step of growth) {
      settler.ingest('0:turn_3', step, false, true, 'user.transcription');
    }
    clock.fireAll();

    assert.strictEqual(settled.length, 1, `13 growth steps must settle once, got ${settled.length}`);
    assert.match(settled[0].text, /to serve traffic\.$/, 'the settled text must be the complete sentence');
  });
});
