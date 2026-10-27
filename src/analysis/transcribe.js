import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobError } from '../errors.js';
import { cgroupMemory } from '../resources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'transcribe.py');

const ffmpegBin = () => process.env.FFMPEG_BIN || 'ffmpeg';
const pythonBin = () => process.env.ASR_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';
export const asrModelDir = () => process.env.ASR_MODEL_DIR || '/opt/asr/sherpa-onnx-whisper-turbo';
export const asrVadModel = () => process.env.ASR_VAD_MODEL || '/opt/asr/silero_vad.onnx';
/** Whisper-turbo int8 holds ~1.0–1.5 GB while decoding; below this the job is refused. */
export const asrMinMemoryMb = () => Math.max(0, Number(process.env.ASR_MIN_MEMORY_MB || 2048));

const MODEL_FILES = ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt'];
const LANGUAGE = /^[a-z]{2,3}$/;

/** Whether this image can transcribe: model files, VAD model and the Python module. */
export function asrStatus() {
  return new Promise((resolve) => {
    const dir = asrModelDir();
    const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (!fs.existsSync(asrVadModel())) missing.push('silero_vad.onnx');
    if (missing.length) {
      return resolve({ ready: false, reason: `Speech model files are not installed in this image (${missing.join(', ')}).` });
    }
    execFile(pythonBin(), ['-c', 'import sherpa_onnx, numpy; print(sherpa_onnx.__version__)'], { timeout: 20000 }, (error, stdout) => {
      if (error) return resolve({ ready: false, reason: 'The sherpa-onnx Python module is not installed in this image.' });
      resolve({ ready: true, reason: '', engine: `sherpa-onnx ${String(stdout).trim()}`, model: 'whisper-turbo int8', vad: 'silero' });
    });
  });
}

/**
 * Transcribes a media file offline. FFmpeg decodes to 16 kHz mono float32 and streams it
 * into the recognizer process; segments arrive as the recognizer produces them.
 * Returns { language, language_source, segments: [{start,end,text}], transcript, … }.
 */
export async function transcribe(file, { language = '', signal, threads = 2 } = {}) {
  const lang = String(language || '').toLowerCase();
  if (lang && lang !== 'auto' && !LANGUAGE.test(lang)) throw new JobError('invalid_request', 'language must be an ISO 639-1 code or "auto".');

  const memory = await cgroupMemory();
  if (memory.limit_bytes && memory.limit_mb < asrMinMemoryMb()) {
    throw new JobError(
      'insufficient_memory',
      `Transcription was not started: this host has ${memory.limit_mb} MB of memory and the speech model needs at least ${asrMinMemoryMb()} MB. Nothing was transcribed.`,
    );
  }

  const decoder = spawn(ffmpegBin(), ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recognizer = spawn(pythonBin(), ['-I', SCRIPT, asrModelDir(), asrVadModel(), lang || 'auto', String(Math.max(1, Math.min(8, threads)))], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  decoder.stdout.pipe(recognizer.stdin);
  recognizer.stdin.on('error', () => {});

  const segments = [];
  let done = null;
  let buffer = '';
  let err = '';
  recognizer.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); });
  recognizer.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.segment && segments.length < 5000) segments.push(msg.segment);
        if (msg.done) done = msg.done;
      } catch {
        // a non-JSON line (a library warning) is not a result
      }
    }
  });

  const kill = () => {
    decoder.kill('SIGKILL');
    try { if (process.platform !== 'win32') process.kill(-recognizer.pid, 'SIGKILL'); else recognizer.kill('SIGKILL'); } catch { /* gone */ }
  };
  signal?.addEventListener('abort', kill, { once: true });
  const exit = (child) => new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error }));
    child.on('close', (code) => resolve({ code }));
  });
  const [dec, rec] = await Promise.all([exit(decoder), exit(recognizer)]);
  signal?.removeEventListener('abort', kill);
  if (signal?.aborted) throw new JobError('canceled', 'The job was canceled.');
  if (dec.code !== 0) throw new JobError('invalid_source', 'The source has no decodable audio.');
  if (rec.code !== 0 || !done) {
    console.error('[transcribe] recognizer failed:', rec.code, err.slice(-1500));
    throw new JobError('transcription_failed', 'The speech recognizer could not transcribe this file.');
  }
  return {
    ...done,
    segments,
    transcript: segments.map((s) => s.text).join(' ').trim(),
  };
}
