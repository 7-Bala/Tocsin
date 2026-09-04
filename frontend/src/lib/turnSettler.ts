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

export class TurnSettler {
  private readonly emitted = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly setTimeoutFn: NonNullable<TurnSettlerOptions['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<TurnSettlerOptions['clearTimeoutFn']>;

  constructor(private readonly opts: TurnSettlerOptions) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /** Feed one TRANSCRIPT_UPDATED item's current state for a turn key. */
  ingest(key: string, text: string, isFinal: boolean, isUser: boolean, objectType: string | undefined): void {
    if (this.emitted.get(key) === text) return; // exact repeat of what was already settled

    const existing = this.timers.get(key);
    if (existing) this.clearTimeoutFn(existing);

    if (isFinal) {
      this.settle(key, text, isUser, objectType);
      return;
    }

    this.timers.set(
      key,
      this.setTimeoutFn(() => this.settle(key, text, isUser, objectType), this.opts.stableMs)
    );
  }

  private settle(key: string, text: string, isUser: boolean, objectType: string | undefined): void {
    this.timers.delete(key);
    this.emitted.set(key, text);
    this.opts.onSettled({ key, text, isUser, objectType });
  }

  /** Cancel every pending timer. Call on session teardown. */
  destroy(): void {
    for (const timer of this.timers.values()) this.clearTimeoutFn(timer);
    this.timers.clear();
  }
}
