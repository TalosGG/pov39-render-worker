#!/usr/bin/env node
/**
 * Generates the neutral audio bed shipped with the motion renderer.
 *
 * The bed is a very quiet, slowly modulated low-frequency pad with no melody: it
 * exists so a rendered MP4 always carries a valid AAC track instead of a silent
 * video with no audio stream. Replace it per asset by pointing
 * `composition.audio` at licensed music (see the worker README).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'public', 'bed-neutral.wav');

const SAMPLE_RATE = 48000;
const SECONDS = 6;
const CHANNELS = 1;
const BITS = 16;
const samples = SAMPLE_RATE * SECONDS;
const dataBytes = samples * CHANNELS * (BITS / 8);

const buffer = Buffer.alloc(44 + dataBytes);
buffer.write('RIFF', 0, 'latin1');
buffer.writeUInt32LE(36 + dataBytes, 4);
buffer.write('WAVE', 8, 'latin1');
buffer.write('fmt ', 12, 'latin1');
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(CHANNELS, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS / 8), 28);
buffer.writeUInt16LE(CHANNELS * (BITS / 8), 32);
buffer.writeUInt16LE(BITS, 34);
buffer.write('data', 36, 'latin1');
buffer.writeUInt32LE(dataBytes, 40);

for (let i = 0; i < samples; i += 1) {
  const t = i / SAMPLE_RATE;
  const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / SECONDS);
  const value =
    Math.sin(2 * Math.PI * 110 * t) * 0.55 +
    Math.sin(2 * Math.PI * 165 * t) * 0.25 +
    Math.sin(2 * Math.PI * 220 * t) * 0.12;
  const sample = value * 0.02 * (0.6 + 0.4 * swell);
  buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
}

await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, buffer);
console.log(JSON.stringify({ file: target, bytes: buffer.length, seconds: SECONDS, sample_rate: SAMPLE_RATE }, null, 2));