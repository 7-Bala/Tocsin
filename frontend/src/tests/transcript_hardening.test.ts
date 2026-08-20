/**
 * Transcript Hardening & Architecture Verification Test Suite
 * Validates:
 * 1. agoraStreamDecoder: Format parsing, error handling, speaker attribution, safety filters
 * 2. UtteranceAggregator: In-place streaming updates, atomic finalization, deduplication, reset
 * 3. Ephemeral Invariant: In-memory purity and zero leakage
 */

import assert from 'node:assert';
import { test, describe } from 'node:test';
import { decodeAgoraStreamMessage } from '../lib/agoraStreamDecoder';
import { UtteranceAggregator } from '../lib/utteranceManager';

describe('1. Agora Stream Decoder Hardening Tests', () => {
  test('decodes standard pipe-delimited Agora ConvoAI base64 partial frame', () => {
    const payloadObj = {
      text: 'Flooding reported on',
      is_final: false,
      turn_id: 'turn_user_1',
    };
    const b64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const rawFrame = `chunk_001|1|0|${b64}`;
    const payload = new Uint8Array(Buffer.from(rawFrame));

    const result = decodeAgoraStreamMessage(1234, payload);
    assert.ok(result !== null, 'Expected decoded event');
    assert.strictEqual(result.utteranceId, 'turn_user_1');
    assert.strictEqual(result.speaker, 'YOU');
    assert.strictEqual(result.text, 'Flooding reported on');
    assert.strictEqual(result.isFinal, false);
    assert.strictEqual(result.seq, 1);
  });

  test('decodes pipe-delimited Agora ConvoAI finalized frame from agent (UID 9999)', () => {
    const payloadObj = {
      text: 'Dispatching rescue boats to Sector 4 immediately.',
      is_final: true,
      turn_id: 'turn_agent_1',
      role: 'assistant',
    };
    const b64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const rawFrame = `chunk_002|2|0|${b64}`;
    const payload = new Uint8Array(Buffer.from(rawFrame));

    const result = decodeAgoraStreamMessage(9999, payload);
    assert.ok(result !== null, 'Expected decoded event');
    assert.strictEqual(result.utteranceId, 'turn_agent_1');
    assert.strictEqual(result.speaker, 'TOCSIN');
    assert.strictEqual(result.text, 'Dispatching rescue boats to Sector 4 immediately.');
    assert.strictEqual(result.isFinal, true);
  });

  test('decodes raw Base64 JSON without pipe headers', () => {
    const payloadObj = {
      content: 'Evacuate the low-lying riverbank now.',
      final: true,
      message_id: 'msg_987',
      speaker: 'TOCSIN',
    };
    const b64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const payload = new Uint8Array(Buffer.from(b64));

    const result = decodeAgoraStreamMessage(5678, payload);
    assert.ok(result !== null, 'Expected decoded event');
    assert.strictEqual(result.utteranceId, 'msg_987');
    assert.strictEqual(result.speaker, 'TOCSIN');
    assert.strictEqual(result.text, 'Evacuate the low-lying riverbank now.');
    assert.strictEqual(result.isFinal, true);
  });

  test('decodes direct JSON payload', () => {
    const rawJson = JSON.stringify({
      text: 'We need medical aid.',
      end_of_utterance: true,
      turn_id: 'turn_user_2',
    });
    const payload = new Uint8Array(Buffer.from(rawJson));

    const result = decodeAgoraStreamMessage(1002, payload);
    assert.ok(result !== null, 'Expected decoded event');
    assert.strictEqual(result.speaker, 'YOU');
    assert.strictEqual(result.text, 'We need medical aid.');
    assert.strictEqual(result.isFinal, true);
  });

  test('safely rejects malformed Base64, corrupted JSON, and empty frames without throwing', () => {
    // Corrupted Base64
    const corruptB64 = new Uint8Array(Buffer.from('chunk_bad|1|0|!!!not_base64!!!'));
    assert.strictEqual(decodeAgoraStreamMessage(1001, corruptB64), null);

    // Empty / whitespace payload
    assert.strictEqual(decodeAgoraStreamMessage(1001, new Uint8Array(Buffer.from('   '))), null);

    // Random non-JSON string
    assert.strictEqual(decodeAgoraStreamMessage(1001, new Uint8Array(Buffer.from('hello world'))), null);

    // Empty JSON object
    assert.strictEqual(decodeAgoraStreamMessage(1001, new Uint8Array(Buffer.from('{}'))), null);
  });

  test('rejects protocol leakages (pipe tokens, raw base64 string as text)', () => {
    const rawLeak = JSON.stringify({
      text: 'msg_001|2|0|eyJ0ZXh0',
      is_final: false,
    });
    const payload = new Uint8Array(Buffer.from(rawLeak));
    assert.strictEqual(decodeAgoraStreamMessage(1001, payload), null);
  });
});

describe('2. Utterance Aggregator & Streaming Invariant Tests', () => {
  test('streaming partial sequence updates activePartial in place and does not append to finalized list', () => {
    const aggregator = new UtteranceAggregator();

    // Delta 1
    const res1 = aggregator.ingest({
      utteranceId: 'turn_1',
      speaker: 'YOU',
      text: 'I cannot',
      isFinal: false,
      seq: 1,
      rawType: 'speech',
    });
    assert.strictEqual(res1.finalized.length, 0);
    assert.ok(res1.partial !== null);
    assert.strictEqual(res1.partial.text, 'I cannot');

    // Delta 2
    const res2 = aggregator.ingest({
      utteranceId: 'turn_1',
      speaker: 'YOU',
      text: 'I cannot hear you',
      isFinal: false,
      seq: 2,
      rawType: 'speech',
    });
    assert.strictEqual(res2.finalized.length, 0);
    assert.ok(res2.partial !== null);
    assert.strictEqual(res2.partial.text, 'I cannot hear you');

    // Delta 3
    const res3 = aggregator.ingest({
      utteranceId: 'turn_1',
      speaker: 'YOU',
      text: 'I cannot hear you clearly.',
      isFinal: false,
      seq: 3,
      rawType: 'speech',
    });
    assert.strictEqual(res3.finalized.length, 0);
    assert.strictEqual(res3.partial?.text, 'I cannot hear you clearly.');

    // Final Frame: commits exactly ONE clean item to finalized list and clears partial
    const resFinal = aggregator.ingest({
      utteranceId: 'turn_1',
      speaker: 'YOU',
      text: 'I cannot hear you clearly. Please repeat.',
      isFinal: true,
      seq: 4,
      rawType: 'speech',
    });
    assert.strictEqual(resFinal.finalized.length, 1);
    assert.strictEqual(resFinal.partial, null);
    assert.strictEqual(resFinal.finalized[0].id, 'turn_1');
    assert.strictEqual(resFinal.finalized[0].text, 'I cannot hear you clearly. Please repeat.');
    assert.strictEqual(resFinal.finalized[0].speaker, 'YOU');
  });

  test('duplicate final frames are idempotent and do not duplicate transcript items', () => {
    const aggregator = new UtteranceAggregator();

    const finalEvent = {
      utteranceId: 'turn_dup_1',
      speaker: 'TOCSIN' as const,
      text: 'Rescue unit dispatched.',
      isFinal: true,
      seq: 1,
      rawType: 'speech',
    };

    aggregator.ingest(finalEvent);
    assert.strictEqual(aggregator.getFinalized().length, 1);

    // Ingest duplicate final frame
    aggregator.ingest(finalEvent);
    assert.strictEqual(aggregator.getFinalized().length, 1);
    assert.strictEqual(aggregator.getFinalized()[0].text, 'Rescue unit dispatched.');
  });

  test('handles multi-turn dialogue with distinct speakers correctly', () => {
    const aggregator = new UtteranceAggregator();

    // Turn 1 by User
    aggregator.ingest({
      utteranceId: 'user_turn_1',
      speaker: 'YOU',
      text: 'What is the river level at Sector 4?',
      isFinal: true,
      seq: 1,
      rawType: 'speech',
    });

    // Turn 2 by Tocsin
    aggregator.ingest({
      utteranceId: 'agent_turn_2',
      speaker: 'TOCSIN',
      text: 'Telemetry shows the river level is at 4.2 meters, exceeding flood threshold.',
      isFinal: true,
      seq: 2,
      rawType: 'speech',
    });

    const finalized = aggregator.getFinalized();
    assert.strictEqual(finalized.length, 2);
    assert.strictEqual(finalized[0].speaker, 'YOU');
    assert.strictEqual(finalized[0].text, 'What is the river level at Sector 4?');
    assert.strictEqual(finalized[1].speaker, 'TOCSIN');
    assert.strictEqual(finalized[1].text, 'Telemetry shows the river level is at 4.2 meters, exceeding flood threshold.');
  });

  test('reset() completely purges all in-memory finalized and partial state', () => {
    const aggregator = new UtteranceAggregator();

    aggregator.ingest({
      utteranceId: 'turn_1',
      speaker: 'YOU',
      text: 'Test message',
      isFinal: true,
      seq: 1,
      rawType: 'speech',
    });
    aggregator.ingest({
      utteranceId: 'turn_2',
      speaker: 'TOCSIN',
      text: 'Partial speech...',
      isFinal: false,
      seq: 2,
      rawType: 'speech',
    });

    assert.strictEqual(aggregator.getFinalized().length, 1);
    assert.ok(aggregator.getPartial() !== null);

    // Call reset
    aggregator.reset();
    assert.strictEqual(aggregator.getFinalized().length, 0);
    assert.strictEqual(aggregator.getPartial(), null);
  });
});
