/**
 * Offline engine self-test (no database, storage or network): synthesises source clips
 * with FFmpeg, then
 *  1. V1: renders a timeline with a gap, a fade, a speed change and burned Hebrew/English
 *     subtitles;
 *  2. V2: renders a Timeline V2 with every rendered overlay type, a speaker zoom, a
 *     dissolve, a music bed and an image card through the compositor;
 * and validates both MP4s.
 *   docker run --rm pov39-render-worker npm run selftest
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPlan } from './render/plan.js';
import { renderPlan, probe } from './render/ffmpeg.js';
import { validateOutput } from './render/validate.js';
import { parseTimelineV2 } from './render/timelineV2.js';
import { renderTimelineV2, displaySize } from './render/renderV2.js';
import { normalizeSources } from './sources.js';

const dir = path.join(process.env.SELFTEST_DIR || os.tmpdir(), 'pov39-selftest');
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

const make = (name, extra, seconds = '6') => {
  const file = path.join(dir, name);
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-v', 'error', '-y', ...extra, ...(seconds ? ['-t', seconds] : []), file]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return file;
};
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const a = make('a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', ...h264, '-c:a', 'aac']);
const b = make('b.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=s=640x640:r=25', ...h264]);

// ---- 1. V1
const timeline = {
  tracks: [{ type: 'video', clips: [
    { source_asset_id: 'A', source_in: 0, start: 0, end: 3 },
    { source_asset_id: 'B', source_in: 1, start: 3.5, end: 6, transition_in: 'fade', transition_duration: 0.5, speed: 1.5 },
  ] }],
  subtitles: { cues: [{ start: 0.2, end: 2.8, text: 'POV39 שלום' }, { start: 3.6, end: 5.8, text: 'Brand-ready' }] },
  output: { width: 1080, height: 1920, fps: 30, burn_subtitles: true },
};

const plan = buildPlan(timeline);
const outFile = path.join(dir, 'out.mp4');
let last = 0;
await renderPlan(plan, { A: { path: a, hasAudio: true }, B: { path: b, hasAudio: false } }, {
  outFile, workDir: dir, quality: 'preview', signal: new AbortController().signal,
  onProgress: (p) => { last = p; },
});
const validation = await validateOutput(outFile, plan);

// ---- 2. V2
const speaker = make('speaker.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', ...h264, '-c:a', 'aac'], '10');
const music = make('music.m4a', ['-f', 'lavfi', '-i', 'sine=f=220:r=48000', '-c:a', 'aac'], '10');
const still = make('card.png', ['-f', 'lavfi', '-i', 'smptehdbars=s=1600x900', '-frames:v', '1'], '');
const v2 = {
  schema_version: 2,
  duration_seconds: 8,
  tracks: [
    { id: 'v', type: 'video', clips: [
      { id: 'c1', source_asset_id: 'spk', source_in: 0, source_out: 4, start: 0, end: 4, transition_in: 'fade', transition_duration: 0.3, speed: 1 },
      { id: 'c2', source_asset_id: 'spk', source_in: 4.5, source_out: 8.5, start: 4, end: 8, transition_in: 'dissolve', transition_duration: 0.4, speed: 1 },
    ] },
    { id: 'a', type: 'audio', clips: [{ id: 'm', source_asset_id: 'bed', source_in: 0, source_out: 8, start: 0, end: 8, transition_in: 'fade', transition_duration: 0.5, speed: 1 }] },
  ],
  overlays: [
    { id: 'lt', type: 'lower_third', start: 0.3, end: 3, title: 'Jane Doe', subtitle: 'מנכ״לית', x: 0.5, y: 0.82 },
    { id: 'pl', type: 'pill', start: 1, end: 3, title: '10 YEARS', x: 0.5, y: 0.15 },
    { id: 'zm', type: 'speaker_zoom', start: 4.5, end: 7.5, zoom_start: 1, zoom_end: 1.15, face_x: 0.5, face_y: 0.4, animation: 'easeInOut' },
    { id: 'ic', type: 'image_card', start: 3, end: 5, source_asset_id: 'img', citation: 'Source: test pattern', width: 900 },
    { id: 'cr', type: 'credit', start: 3.2, end: 5, text: 'Source: test pattern', x: 0.92, y: 0.08, width: 400 },
    { id: 'hl', type: 'headline', start: 5, end: 6.5, title: 'Building the future', x: 0.5, y: 0.3, width: 1000 },
    { id: 'qt', type: 'quote', start: 6.5, end: 8, text: 'A quote that wraps across lines.', citation: 'Jane Doe', x: 0.5, y: 0.45, width: 900 },
    { id: 'st', type: 'stamp', start: 6.5, end: 8, text: '18,000', replacement: '17,000', x: 0.5, y: 0.2, width: 800 },
  ],
  audio: { music_gain_db: -14 },
  subtitles: { language: 'en', cues: [{ start: 0.5, end: 3.5, text: 'Ten years ago.' }, { start: 4, end: 7.5, text: 'שלום, POV39' }] },
  output_spec: { width: 1080, height: 1920, fps: 30, burn_subtitles: true, duration_seconds: 8 },
};
const sources = normalizeSources([
  { asset_id: 'spk', url: 'https://media.base44.com/x', kind: 'video' },
  { asset_id: 'bed', url: 'https://media.base44.com/y', kind: 'audio' },
  { asset_id: 'img', url: 'https://media.base44.com/z', kind: 'image' },
]);
const planV2 = parseTimelineV2(v2, v2.output_spec, { sources });
const files = {};
for (const [id, file] of [['spk', speaker], ['bed', music]]) {
  const info = await probe(file);
  files[id] = { path: file, hasAudio: info.streams.some((s) => s.codec_type === 'audio'), display: displaySize(info) };
}
const outV2 = path.join(dir, 'out_v2.mp4');
const engine = await renderTimelineV2(planV2, files, { img: still }, {
  outFile: outV2, workDir: dir, quality: 'preview', signal: new AbortController().signal, onProgress: () => {},
});
const validationV2 = await validateOutput(outV2, planV2);

console.log(JSON.stringify({ v1: { final_progress: last, ...validation }, v2: { engine, ...validationV2 } }, null, 2));
process.exit(validation.passed && validationV2.passed ? 0 : 1);
