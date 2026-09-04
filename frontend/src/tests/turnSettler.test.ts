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

  test('destroy() cancels pending timers so a mid-debounce turn never fires after teardown', () => {
    const settled: SettledTurn[] = [];
    const clock = fakeClock();
    const settler = new TurnSettler({
      stableMs: 700,
      onSettled: (turn) => settled.push(turn),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    settler.ingest('9999:turn_1', 'Still speaking when the session ends', false, false, 'assistant.transcription');
    assert.strictEqual(clock.pendingCount(), 1);

    settler.destroy();
    assert.strictEqual(clock.pendingCount(), 0, 'destroy must clear the pending timer');

    clock.fireAll(); // no-op: nothing left to fire
    assert.strictEqual(settled.length, 0, 'a turn cancelled by destroy() must never settle');
  });
});
