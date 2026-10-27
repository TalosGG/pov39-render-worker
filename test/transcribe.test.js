/**
 * Offline transcription. Runs only where the speech model is installed (an image built
 * with WITH_ASR=1, or ASR_MODEL_DIR / ASR_VAD_MODEL pointing at local copies); elsewhere
 * it is reported as skipped — never as passed.
 *
 * ASR_TEST_AUDIO: a short local speech file (any format FFmpeg reads).
 * ASR_TEST_LANGUAGE: its language code, or "auto".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { asrStatus, transcribe } from '../src/analysis/transcribe.js';

const status = await asrStatus();
const audio = process.env.ASR_TEST_AUDIO;
const skip = !status.ready ? `speech model not installed: ${status.reason}`
  : !audio || !fs.existsSync(audio) ? 'set ASR_TEST_AUDIO to a short local speech file' : false;

test('transcribes a short file into VAD-timed segments, without word timings', { skip, timeout: 600000 }, async () => {
  const result = await transcribe(audio, { language: process.env.ASR_TEST_LANGUAGE || 'auto', signal: new AbortController().signal });
  assert.ok(result.segments.length > 0);
  let last = 0;
  for (const s of result.segments) {
    assert.ok(s.start >= last - 1e-6 && s.end > s.start && s.end - s.start <= 6.5, JSON.stringify(s));
    assert.equal(s.words, undefined);
    last = s.end;
  }
  assert.equal(result.word_timestamps, false);
  assert.ok(result.language);
  assert.ok(result.transcript.length > 0);
});

test('refuses a malformed language code before starting the model', async () => {
  await assert.rejects(transcribe('x', { language: 'english; rm' }), { code: 'invalid_request' });
});
