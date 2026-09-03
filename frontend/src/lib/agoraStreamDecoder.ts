/**
 * Protocol decoder for Agora ConvoAI Stream Messages.
 * Decodes real-time speech transcription payloads from Gemini Live / Agora agents.
 *
 * UNVERIFIED AGAINST OFFICIAL AGORA DOCS (see docs/agora/RESEARCH.md §5): the three
 * frame patterns below were derived from observed traffic, not from a fetched Agora
 * documentation page. The one official page found that discusses transcript delivery
 * (docs.agora.io/en/conversational-ai/develop/transcripts) describes transcripts
 * arriving via "Signaling channel messages" through toolkit callbacks, and explicitly
 * does not document a raw wire format. Treat the patterns below as best-effort/
 * empirical, not a documented contract — any frame that doesn't match one of them is
 * intentionally discarded (returns null) rather than guessed at, and callers (see
 * VoiceHUD.tsx) must treat a null/empty result as "ignore this frame", never render
 * partial or garbage output for it.
 *
 * Agora ConvoAI Stream Message Protocol (empirical, not doc-confirmed):
 *  - Frame format: `<message_id>|<sequence_no>|<flags_or_total>|<base64_payload>`
 *  - Or direct Base64 JSON: `eyJy...`
 *  - Or direct JSON string: `{"text": "...", ...}`
 *
 * Guarantees that:
 *  1. Stable utterance IDs are extracted for precise turn/utterance correlation.
 *  2. isFinal accurately differentiates streaming deltas from finalized speech.
 *  3. Only clean, human-readable text is returned.
 *  4. Raw base64, protocol pipes, and binary noise are completely rejected.
 *  5. Any unrecognized payload shape fails safe: returns null rather than throwing
 *     or emitting best-guess text.
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    // Determine speaker
    const isAgent =
      Number(msgUid) === 9999 ||
      parsed.object === 'assistant.transcription' ||
      parsed.role === 'assistant' ||
      parsed.role === 'model' ||
      parsed.speaker === 'TOCSIN' ||
      parsed.speaker === 'agent' ||
      parsed.sender === 'assistant' ||
      parsed.name === 'agent' ||
      Boolean(parsed.serverContent?.modelTurn);

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
    } else if (parsed.serverContent) {
      const modelParts = parsed.serverContent.modelTurn?.parts;
      if (Array.isArray(modelParts)) {
        text = modelParts.map((p: any) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join(' ');
      }
      const userParts = parsed.serverContent.userTurn?.parts;
      if (Array.isArray(userParts)) {
        text = userParts.map((p: any) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join(' ');
      }
    } else if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
      const choice = parsed.choices[0];
      if (choice.delta?.content) text = choice.delta.content;
      else if (choice.message?.content) text = choice.message.content;
      else if (choice.text) text = choice.text;
    }

    text = text.trim();

    // Guard against leaking base64 or protocol tokens as text
    if (!text || text.includes('|') || text.startsWith('eyJy') || text.startsWith('eyJ')) {
      return null;
    }

    // Determine finality:
    // Agora ConvoAI provides `is_final` (bool / 0/1), `final`, `end_of_turn`, or `end_of_utterance`.
    // In assistant.transcription: Agora sends `turn_status`: 0 = IN_PROGRESS, 1 = END, 2 = INTERRUPTED.
    // In user.transcription: Agora provides `final: true`.
    let isFinal = false;
    if (parsed.is_final === true || parsed.is_final === 1 || parsed.is_final === 'true') {
      isFinal = true;
    } else if (parsed.final === true || parsed.final === 1 || parsed.final === 'true') {
      isFinal = true;
    } else if (
      parsed.turn_status === 1 ||
      parsed.turn_status === '1' ||
      parsed.turn_status === 'END' ||
      parsed.turn_status === 'end' ||
      parsed.turn_status === 2 ||
      parsed.turn_status === '2' ||
      parsed.turn_status === 'INTERRUPTED'
    ) {
      isFinal = true;
    } else if (parsed.end_of_turn === true || parsed.end_of_utterance === true) {
      isFinal = true;
    } else if (parsed.turnComplete === true || parsed.turn_complete === true || parsed.serverContent?.turnComplete === true) {
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
