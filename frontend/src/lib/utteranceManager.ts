/**
 * In-Memory Ephemeral Utterance Aggregator.
 *
 * Manages live conversation transcripts during an active session:
 * - Aggregates incoming partial streaming deltas into an active utterance.
 * - Commits exactly ONE clean transcript line per finalized utterance.
 * - Prevents streaming duplicate/fragment lines (e.g. "I", "I cannot", "I cannot hear").
 * - Zero persistence (strictly ephemeral; reset on page reload, channel join/leave, or clear).
 */

import type { DecodedStreamEvent } from './agoraStreamDecoder';

export interface FinalizedUtterance {
  id: string;
  timeStr: string;
  speaker: 'YOU' | 'TOCSIN';
  text: string;
}

export interface ActivePartialUtterance {
  utteranceId: string;
  speaker: 'YOU' | 'TOCSIN';
  text: string;
}

export class UtteranceAggregator {
  // Ordered map of finalized completed utterances
  private finalizedUtterances: Map<string, FinalizedUtterance> = new Map();

  // Currently streaming partial utterance (if any)
  private currentPartial: ActivePartialUtterance | null = null;

  /**
   * Process an inbound decoded Agora ConvoAI stream event.
   * Returns the updated list of finalized utterances and the currently streaming partial.
   */
  public ingest(event: DecodedStreamEvent): {
    finalized: FinalizedUtterance[];
    partial: ActivePartialUtterance | null;
  } {
    const { utteranceId, speaker, text, isFinal } = event;
    const timeStr = new Date().toLocaleTimeString();

    if (isFinal) {
      // Commit as finalized clean utterance
      this.finalizedUtterances.set(utteranceId, {
        id: utteranceId,
        timeStr,
        speaker,
        text,
      });

      // If the current partial matches this utterance, clear it
      if (this.currentPartial && this.currentPartial.utteranceId === utteranceId) {
        this.currentPartial = null;
      }
    } else {
      // In-progress streaming delta: update the active partial in place (never append to finalized list)
      this.currentPartial = {
        utteranceId,
        speaker,
        text,
      };
    }

    return {
      finalized: Array.from(this.finalizedUtterances.values()),
      partial: this.currentPartial,
    };
  }

  /**
   * Returns all completed, finalized utterances for the current session.
   */
  public getFinalized(): FinalizedUtterance[] {
    return Array.from(this.finalizedUtterances.values());
  }

  /**
   * Returns the active streaming partial utterance (if any).
   */
  public getPartial(): ActivePartialUtterance | null {
    return this.currentPartial;
  }

  /**
   * Reset all in-memory transcript state for a fresh session.
   */
  public reset(): void {
    this.finalizedUtterances.clear();
    this.currentPartial = null;
  }
}
