/**
 * Debounces Agora ConvoAI's live-growing transcript stream down to one event
 * per turn.
 *
 * TRANSCRIPT_UPDATED delivers each turn's text incrementally as it is spoken
 * (ASR/LLM tokens appended one at a time), long before `item.status` ever
 * reaches END. Live-reported 2026-09-04, the first session with working RTM
 * transcript delivery at all: a single six-line conversation produced 30
 * near-identical hypotheses (and matching duplicate action items and timeline
 * entries), each just a few more words than the last, because every
 * intermediate growth step of one spoken sentence was ingested as its own
 * complete observation.
 *
 * A turn is forwarded to `onSettled` exactly once: immediately if Agora marks
 * it final, otherwise after `stableMs` of no further growth for that turn key
 * (belt-and-suspenders, in case `status` delivery is itself unreliable on some
 * pipeline/model combination). Whichever path fires first cancels the other.
 */
export interface SettledTurn {
  key: string;
  text: string;
  isUser: boolean;
  objectType: string | undefined;
}

export interface TurnSettlerOptions {
  stableMs: number;
  onSettled: (turn: SettledTurn) => void;
  /** Injectable for tests; defaults to the real timer functions. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * A settled turn that only extends what was already emitted for its key is not
 * a new sentence -- it is the tail of one we forwarded too early. Emitting the
 * whole grown string again would duplicate the part already on the record, so
 * only the suffix is forwarded, and only when it carries enough to stand as its
 * own utterance. Anything shorter is absorbed silently: a trailing " up." on
 * the record is worse than nothing at all.
 */
const MIN_SUFFIX_CHARS = 40;
const MIN_TERMINATED_SUFFIX_CHARS = 12;

function isSubstantialSuffix(suffix: string): boolean {
  const trimmed = suffix.trim();
  if (trimmed.length >= MIN_SUFFIX_CHARS) return true;
  return trimmed.length >= MIN_TERMINATED_SUFFIX_CHARS && /[.!?]$/.test(trimmed);
}

interface PendingTurn {
  text: string;
  isUser: boolean;
  objectType: string | undefined;
}

export class TurnSettler {
  private readonly emitted = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingTurn>();
  private readonly setTimeoutFn: NonNullable<TurnSettlerOptions['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<TurnSettlerOptions['clearTimeoutFn']>;

  constructor(private readonly opts: TurnSettlerOptions) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /** Feed one TRANSCRIPT_UPDATED item's current state for a turn key. */
  ingest(key: string, text: string, isFinal: boolean, isUser: boolean, objectType: string | undefined): void {
    const alreadyEmitted = this.emitted.get(key);
    if (alreadyEmitted === text) return; // exact repeat of what was already settled

    const existing = this.timers.get(key);
    if (existing) this.clearTimeoutFn(existing);

    // Growth arriving AFTER this key already settled means the debounce fired
    // mid-sentence -- the speaker paused for longer than stableMs. Re-arm rather
    // than forwarding immediately, so the rest of the sentence can finish
    // arriving before anything else is emitted.
    this.pending.set(key, { text, isUser, objectType });

    if (isFinal) {
      this.settle(key);
      return;
    }

    this.timers.set(key, this.setTimeoutFn(() => this.settle(key), this.opts.stableMs));
  }

  private settle(key: string): void {
    this.timers.delete(key);
    const turn = this.pending.get(key);
    if (!turn) return;
    this.pending.delete(key);

    const alreadyEmitted = this.emitted.get(key);
    this.emitted.set(key, turn.text);

    // Only the part not already on the record is forwarded. A revision that is
    // not an extension (ASR rewriting "forty" to "40%") falls through to the
    // full-text path, since we cannot tell which half changed.
    if (alreadyEmitted !== undefined && turn.text.startsWith(alreadyEmitted)) {
      const suffix = turn.text.slice(alreadyEmitted.length).trim();
      if (!isSubstantialSuffix(suffix)) return;
      this.opts.onSettled({ key, text: suffix, isUser: turn.isUser, objectType: turn.objectType });
      return;
    }

    this.opts.onSettled({ key, text: turn.text, isUser: turn.isUser, objectType: turn.objectType });
  }

  /**
   * Flush every pending turn, then cancel outstanding timers. Call on session
   * teardown. Flushing rather than dropping matters more the larger stableMs
   * gets: the last thing said before leaving the room is always mid-debounce,
   * and silently discarding it loses the end of every conversation.
   */
  destroy(): void {
    for (const timer of this.timers.values()) this.clearTimeoutFn(timer);
    this.timers.clear();
    for (const key of [...this.pending.keys()]) this.settle(key);
    this.pending.clear();
  }
}
