/**
 * Offline engine self-test (no database, storage or network): synthesises two
 * source clips with FFmpeg, renders a timeline with a gap, a fade, a speed change
 * and burned Hebrew/English subtitles, then validates the MP4.
 *   docker run --rm pov39-render-worker npm run selftest
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPlan } from './render/plan.js';
import { renderPlan } from './render/ffmpeg.js';
import { validateOutput } from './render/validate.js';

const dir = '/tmp/pov39-selftest';
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

const make = (name, extra) => {
  const file = path.join(dir, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...extra, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return file;
};
const a = make('a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-c:a', 'aac']);
const b = make('b.mp4', ['-f', 'lavfi', '-i', 'mandelbrot=s=640x640:r=25']);

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
console.log(JSON.stringify({ final_progress: last, ...validation }, null, 2));
process.exit(validation.passed ? 0 : 1);