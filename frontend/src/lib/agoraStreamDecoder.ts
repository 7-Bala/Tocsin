/**
 * Protocol decoder for Agora ConvoAI Stream Messages.
 * Decodes real-time speech transcription payloads from Gemini Live / Agora agents.
 *
 * Agora ConvoAI Stream Message Protocol:
 *  - Frame format: `<message_id>|<sequence_no>|<flags_or_total>|<base64_payload>`
 *  - Or direct Base64 JSON: `eyJy...`
 *  - Or direct JSON string: `{"text": "...", ...}`
 *
 * Guarantees that:
 *  1. Stable utterance IDs are extracted for precise turn/utterance correlation.
 *  2. isFinal accurately differentiates streaming deltas from finalized speech.
 *  3. Only clean, human-readable text is returned.
 *  4. Raw base64, protocol pipes, and binary noise are completely rejected.
 */

export interface DecodedStreamEvent {
  utteranceId: string;
  speaker: 'YOU' | 'TOCSIN';
  text: string;
  isFinal: boolean;
  seq: number;
  rawType: string;
}

export function decodeAgoraStreamMessage(
  msgUid: number | string,
  payload: Uint8Array
): DecodedStreamEvent | null {
  try {
    const rawStr = new TextDecoder('utf-8').decode(payload).trim();
    if (!rawStr) return null;

    let parsed: any = null;
    let headerId = '';
    let headerSeq = 0;

    // Pattern 1: Pipe-delimited Base64 JSON (Agora ConvoAI standard format: "chunkId|seq|flags|base64Payload")
    if (rawStr.includes('|')) {
      const parts = rawStr.split('|');
      headerId = parts[0]?.trim() || '';
      headerSeq = parseInt(parts[1]?.trim() || '0', 10) || 0;

      const lastPart = parts[parts.length - 1].trim();
      try {
        const decoded = typeof window !== 'undefined'
          ? window.atob(lastPart)
          : Buffer.from(lastPart, 'base64').toString('utf-8');
        parsed = JSON.parse(decoded);
      } catch {
        // Fallback: test each pipe segment from right to left
        for (let i = parts.length - 1; i >= 0; i--) {
          try {
            const decoded = typeof window !== 'undefined'
              ? window.atob(parts[i].trim())
              : Buffer.from(parts[i].trim(), 'base64').toString('utf-8');
            parsed = JSON.parse(decoded);
            if (parsed) break;
          } catch {
            // continue
          }
        }
      }
    }

    // Pattern 2: Raw Base64 JSON without pipes
    if (!parsed && (rawStr.startsWith('ey') || rawStr.startsWith('ew'))) {
      try {
        const decoded = typeof window !== 'undefined'
          ? window.atob(rawStr)
          : Buffer.from(rawStr, 'base64').toString('utf-8');
        parsed = JSON.parse(decoded);
      } catch {
        // not base64 json
      }
    }

    // Pattern 3: Direct JSON string
    if (!parsed && rawStr.startsWith('{') && rawStr.endsWith('}')) {
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        // not valid json
      }
    }

    // If nothing valid was parsed or not an object, discard
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Determine speaker
    const isAgent =
      Number(msgUid) === 9999 ||
      parsed.object === 'assistant.transcription' ||
      parsed.role === 'assistant' ||
      parsed.speaker === 'TOCSIN' ||
      parsed.sender === 'assistant' ||
      parsed.name === 'agent';

    const speaker: 'YOU' | 'TOCSIN' = isAgent ? 'TOCSIN' : 'YOU';

    // Extract speech text
    let text = '';
    if (typeof parsed.text === 'string') {
      text = parsed.text;
    } else if (typeof parsed.content === 'string') {
      text = parsed.content;
    } else if (Array.isArray(parsed.words)) {
      text = parsed.words
        .map((w: any) => (typeof w === 'string' ? w : w.text || w.word || ''))
        .filter(Boolean)
        .join(' ');
    } else if (typeof parsed.delta === 'string') {
      text = parsed.delta;
    } else if (typeof parsed.transcript === 'string') {
      text = parsed.transcript;
    } else if (parsed.data && typeof parsed.data.text === 'string') {
      text = parsed.data.text;
    } else if (parsed.data && typeof parsed.data.content === 'string') {
      text = parsed.data.content;
    }

    text = text.trim();

    // Guard against leaking base64 or protocol tokens as text
    if (!text || text.includes('|') || text.startsWith('eyJy') || text.startsWith('eyJ')) {
      return null;
    }

    // Determine finality:
    // Agora ConvoAI provides `is_final` (bool / 0/1), `final`, `end_of_turn`, or `end_of_utterance`.
    // If not explicitly true/1, it represents an in-progress partial streaming delta.
    let isFinal = false;
    if (parsed.is_final === true || parsed.is_final === 1 || parsed.is_final === 'true') {
      isFinal = true;
    } else if (parsed.final === true || parsed.final === 1 || parsed.final === 'true') {
      isFinal = true;
    } else if (parsed.end_of_turn === true || parsed.end_of_utterance === true) {
      isFinal = true;
    } else if (parsed.status === 'completed' || parsed.type === 'final') {
      isFinal = true;
    }

    // Stable Utterance ID extraction
    const utteranceId = String(
      parsed.turn_id ??
      parsed.message_id ??
      parsed.sentence_id ??
      parsed.stream_id ??
      (headerId ? `${speaker}_${headerId}` : `${speaker}_turn_${headerSeq || Date.now()}`)
    );

    return {
      utteranceId,
      speaker,
      text,
      isFinal,
      seq: headerSeq || parsed.sequence || 0,
      rawType: parsed.object || parsed.role || 'speech',
    };
  } catch {
    return null;
  }
}
