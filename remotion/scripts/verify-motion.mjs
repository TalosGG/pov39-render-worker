#!/usr/bin/env node
/**
 * Independent verification of a rendered motion asset.
 *
 * This does not trust the renderer: it re-reads the finished MP4 with a real
 * FFmpeg binary and checks container, codecs, dimensions, duration, faststart,
 * a full clean decode, and — most importantly — that the actual pixels change
 * over time (frames are decoded at several timestamps and compared).
 *
 * Usage: node scripts/verify-motion.mjs --file out.mp4 --duration 15 [--width 1080 --height 1920]
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const tryRequire = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

/** FFMPEG_PATH → system ffmpeg → @ffmpeg-installer → ffmpeg-static. */
function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    tryRequire('@ffmpeg-installer/ffmpeg')?.path,
    tryRequire('ffmpeg-static'),
  ].filter((value) => typeof value === 'string' && value);
  const found = candidates.find((value) => existsSync(value));
  if (!found) throw new Error('No FFmpeg binary found: set FFMPEG_PATH or install ffmpeg.');
  return found;
}

const ffmpegPath = resolveFfmpeg();

const here = path.dirname(fileURLToPath(import.meta.url));

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const run = (bin, args, { allowFailure = false } = {}) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(error);
      else resolve({ stdout, stderr, code: error?.code || 0 });
    });
  });

const args = readArgs(process.argv.slice(2));
if (!args.file) {
  console.error('Usage: node scripts/verify-motion.mjs --file <file.mp4> --duration <seconds>');
  process.exit(2);
}

const file = path.resolve(String(args.file));
const expectedDuration = Number(args.duration) || 0;
const expectedWidth = Number(args.width) || 1080;
const expectedHeight = Number(args.height) || 1920;

const probe = await run(ffmpegPath, ['-hide_banner', '-i', file], { allowFailure: true });
const info = probe.stderr.toString('latin1');

const durationMatch = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(info);
const durationSeconds = durationMatch
  ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
  : 0;
const videoLine = /Stream #\d+:\d+.*?: Video: ([a-z0-9]+).*?, (\d+)x(\d+)/.exec(info);
const audioLine = /Stream #\d+:\d+.*?: Audio: ([a-z0-9]+)/.exec(info);
const stat = await fs.stat(file);

// Full decode: an empty error log means every frame decoded.
const decode = await run(ffmpegPath, ['-v', 'error', '-i', file, '-f', 'null', '-'], { allowFailure: true });
const decodeErrors = decode.stderr.toString('utf8').trim();

// moov before mdat => faststart
async function moovBeforeMdat(target) {
  const handle = await fs.open(target, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      await handle.read(header, 0, 16, offset);
      let atomSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (atomSize === 1) atomSize = Number(header.readBigUInt64BE(8));
      if (atomSize < 8) return false;
      offset += atomSize;
    }
    return false;
  } finally {
    await handle.close();
  }
}

// Frames: decode small grey frames at several timestamps and compare pixels.
const timestamps = [0.3, expectedDuration * 0.35, expectedDuration * 0.7, Math.max(0.5, expectedDuration - 0.4)].filter(
  (t) => t > 0 && t < (durationSeconds || expectedDuration + 1),
);
const frames = [];
for (const t of timestamps) {
  const out = path.join('/tmp', `pov39-frame-${t.toFixed(2)}.gray`);
  await run(ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=48:48', '-f', 'rawvideo', '-pix_fmt', 'gray', out]);
  const bytes = await fs.readFile(out);
  frames.push({ t, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}

const meanDiff = (a, b) => {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / length;
};

const comparisons = [];
for (let i = 0; i < frames.length - 1; i += 1) {
  comparisons.push({
    from: frames[i].t,
    to: frames[i + 1].t,
    mean_pixel_difference: Number(meanDiff(frames[i].bytes, frames[i + 1].bytes).toFixed(2)),
    distinct: frames[i].sha256 !== frames[i + 1].sha256,
  });
}
const firstLast = frames.length > 1 ? meanDiff(frames[0].bytes, frames[frames.length - 1].bytes) : 0;

const checks = {
  file_exists: stat.size > 0,
  container_mp4: /Input #0, mov,mp4/.test(info) || /format_name/.test(info),
  video_codec_h264: videoLine?.[1] === 'h264',
  audio_codec_aac: audioLine?.[1] === 'aac',
  dimensions_match: Number(videoLine?.[2]) === expectedWidth && Number(videoLine?.[3]) === expectedHeight,
  duration_match: expectedDuration > 0 ? Math.abs(durationSeconds - expectedDuration) <= Math.max(0.3, expectedDuration * 0.02) : durationSeconds > 0,
  faststart: await moovBeforeMdat(file),
  decodes_cleanly: decodeErrors === '',
  frames_change_over_time: comparisons.every((item) => item.distinct && item.mean_pixel_difference > 1.5),
};

const report = {
  file,
  size_bytes: stat.size,
  sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'),
  duration_seconds: Number(durationSeconds.toFixed(3)),
  expected_duration_seconds: expectedDuration,
  video_codec: videoLine?.[1] || '',
  audio_codec: audioLine?.[1] || '',
  width: Number(videoLine?.[2]) || 0,
  height: Number(videoLine?.[3]) || 0,
  decode_errors: decodeErrors,
  frame_comparisons: comparisons,
  first_to_last_mean_pixel_difference: Number(firstLast.toFixed(2)),
  frame_hashes: frames.map((item) => ({ t: item.t, sha256: item.sha256.slice(0, 16) })),
  checks,
  passed: Object.values(checks).every(Boolean),
};

if (args.report) await fs.writeFile(path.resolve(String(args.report)), JSON.stringify(report, null, 2));
process.stdout.write(`POV39_MOTION_VERIFY ${JSON.stringify(report)}\n`);
process.exit(report.passed ? 0 : 1);