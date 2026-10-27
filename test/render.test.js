/**
 * End-to-end render tests: processJob with an in-memory job store and a local "bucket",
 * on media synthesised by FFmpeg. No network, no production data, no paid service.
 * Needs ffmpeg/ffprobe and Python with Pillow (FFMPEG_BIN / FFPROBE_BIN / PYTHON_BIN).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processJob } from '../src/jobs.js';
import { probe } from '../src/render/ffmpeg.js';
import { fakeDb, fakeStorage, uploadKey } from './helpers/fakes.js';
import * as m from './helpers/media.js';

const missing = m.toolsAvailable();
const skip = missing.length ? `needs ${missing.join(', ')}` : false;

const root = path.join(process.env.WORK_DIR || os.tmpdir(), `pov39-test-${process.pid}`);
const media = path.join(root, 'media');
const work = path.join(root, 'work');
const out = path.join(root, 'out');
const WS = 'ws_test';

let storage;
const keys = {};
const config = () => ({
  workDir: work,
  maxSourceBytes: 2 * 1024 ** 3,
  maxImageBytes: 25 * 1024 ** 2,
  allowedSourceHosts: ['media.base44.com'],
  motionMinMemoryBytes: 0,
  fontResolverUrl: null,
  serviceToken: null,
});

async function runJob(operation, inputs, outputSpec = {}, { signal, db = fakeDb() } = {}) {
  const job = db.add({ operation, inputs: { workspace_id: WS, ...inputs }, output_spec: outputSpec });
  await processJob(job, { db, storage, config: config(), signal: signal || new AbortController().signal });
  return db.get(job.id);
}

const example = () => JSON.parse(fs.readFileSync(new URL('./fixtures/base44-timeline-v2-example.json', import.meta.url), 'utf8'));
function corrected() {
  const t = example();
  t.duration_seconds = 32;
  t.output_spec.duration_seconds = 32;
  t.overlays.find((o) => o.id === 'speaker-zoom-1').type = 'speaker_zoom';
  return t;
}
/** mediaPipeline `inputs.sources`: array entries naming objects in this workspace. */
const exampleSources = () => [
  { asset_id: 'asset-abc123', storage_key: keys.speaker, duration_seconds: 34, width: 1280, height: 720, kind: 'video' },
  { asset_id: 'asset-music001', storage_key: keys.music, duration_seconds: 34, kind: 'audio' },
  { asset_id: 'asset-img001', storage_key: keys.card, kind: 'image' },
];

test.before(async () => {
  if (skip) return;
  await fsp.rm(root, { recursive: true, force: true });
  for (const d of [media, work, out]) await fsp.mkdir(d, { recursive: true });
  storage = fakeStorage(path.join(root, 'bucket'));
  const files = {
    speaker: m.speaker(media), music: m.music(media), card: m.still(media), cuts: m.cuts(media), pauses: m.pauses(media),
    red: m.solid(media, 'red', 'red', 300), blue: m.solid(media, 'blue', 'blue', 600),
  };
  for (const [name, file] of Object.entries(files)) {
    keys[name] = await storage.seed(uploadKey(WS, name === 'card' ? 'png' : 'mp4'), file);
  }
});

test.after(async () => {
  if (!process.env.KEEP_TEST_MEDIA) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

const outputFile = (job) => storage.local(job.output_key);
const stills = {};
function still(job, t, tag) {
  const file = path.join(out, `${tag}_${t}.png`);
  if (!stills[file]) stills[file] = m.frameAt(outputFile(job), t, file);
  return stills[file];
}

let full;
let control;
test('Timeline V2: the corrected Base44 example renders to a valid MP4', { skip, timeout: 600000 }, async () => {
  full = await runJob('render_preview', { timeline: corrected(), sources: exampleSources() }, corrected().output_spec);
  assert.equal(full.status, 'succeeded', `${full.error_code}: ${full.error} ${JSON.stringify(full.result?.errors || '')}`);
  assert.equal(full.validation.passed, true, JSON.stringify(full.validation.checks));
  for (const [check, ok] of Object.entries(full.validation.checks)) assert.equal(ok, true, check);
  assert.deepEqual([full.validation.actual.width, full.validation.actual.height], [406, 720]);
  assert.ok(Math.abs(full.validation.actual.duration_seconds - 32) < 0.05);
  assert.equal(full.validation.schema_version, 2);
  assert.deepEqual(full.validation.rendered.overlays, { lower_third: 1, pill: 1, image_card: 1, credit: 1, headline: 1 });
  assert.equal(full.validation.rendered.speaker_zooms, 1);
  assert.deepEqual(full.validation.rendered.transitions, ['fade', 'dissolve', 'dissolve']);
  // output inspection: stills of the finished file were extracted and stored
  assert.ok(full.result.preview.frames.length >= 5);
  for (const f of full.result.preview.frames) assert.ok(await storage.exists(f.storage_key), f.storage_key);
  assert.ok(await storage.exists(full.result.preview.contact_sheet_key));

  // the same timeline with no overlays, zooms or subtitles: the reference picture
  const bare = corrected();
  bare.overlays = [];
  bare.output_spec.burn_subtitles = false;
  control = await runJob('render_preview', { timeline: bare, sources: exampleSources() }, bare.output_spec);
  assert.equal(control.status, 'succeeded', control.error);
});

test('overlays appear at their timestamps, in their positions, and nowhere else', { skip, timeout: 120000 }, () => {
  assert.ok(full && control, 'render test must run first');
  const W = 406;
  const H = 720;
  const box = (cx, cy, w, h) => ({ x: Math.round(cx * W - w / 2), y: Math.round(cy * H - h / 2), w, h });
  const diff = (t, region) => m.regionDifference(still(full, t, 'full'), still(control, t, 'ctrl'), region);

  // pill "10 YEARS" (2.0–5.0, y 0.15): solid accent #d21428 in the band above its text
  const [r, g, b] = m.regionColor(still(full, 3.5, 'full'), { x: 188, y: 88, w: 30, h: 3 });
  assert.ok(r > 150 && g < 90 && b < 100, `pill colour ${[r, g, b]}`);
  assert.ok(diff(1.0, box(0.5, 0.15, 60, 24)) < 6, 'pill visible before its start');

  // lower third (0.5–5.5, y 0.85)
  // (sampled just above its centre, clear of the subtitle line below it)
  assert.ok(diff(3.0, box(0.5, 0.84, 80, 16)) > 25, 'lower third missing at 3.0 s');
  assert.ok(diff(7.0, box(0.5, 0.84, 80, 16)) < 6, 'lower third still visible at 7.0 s');

  // image card (10–14, centre) and its credit (10.2–14, top right)
  assert.ok(diff(12.0, box(0.5, 0.5, 120, 60)) > 25, 'image card missing at 12 s');
  assert.ok(diff(12.0, box(0.85, 0.08, 40, 14)) > 15, 'credit missing at 12 s');
  assert.ok(diff(14.6, box(0.85, 0.08, 40, 14)) < 8, 'credit still visible after 14 s');

  // headline (21.5–26, y 0.3)
  assert.ok(diff(23.0, box(0.5, 0.3, 160, 30)) > 20, 'headline missing at 23 s');

  // with nothing scheduled, the picture is the control picture (subtitles aside)
  assert.ok(diff(7.0, box(0.5, 0.4, 200, 200)) < 4, 'unexpected change at 7.0 s');
});

test('speaker zoom transforms the source footage itself', { skip, timeout: 120000 }, () => {
  assert.ok(full && control, 'render test must run first');
  const center = { x: 103, y: 200, w: 200, h: 200 };
  // 20 s is inside speaker-zoom-1 (8.5–21.5, 1.0 → 1.15): the whole picture is scaled
  const zoomed = m.regionDifference(still(full, 20.0, 'full'), still(control, 20.0, 'ctrl'), center);
  assert.ok(zoomed > 10, `picture not transformed under the zoom (diff ${zoomed})`);
  // 7.0 s is before it: identical
  assert.ok(m.regionDifference(still(full, 7.0, 'full'), still(control, 7.0, 'ctrl'), center) < 4);
});

test('the source audio is preserved, with the music bed mixed under it', { skip, timeout: 120000 }, () => {
  assert.ok(full, 'render test must run first');
  const file = outputFile(full);
  const freq = m.toneFrequency(file, 15, 0.5);
  assert.ok(freq > 400 && freq < 480, `speech tone at ${freq} Hz`);
  const src = m.audioLevel(storage.local(keys.speaker), 15, 2);
  const got = m.audioLevel(file, 15, 2);
  assert.ok(Math.abs(got - src) < 3, `level ${got} dB vs source ${src} dB`);
});

test('dissolve, slide and fade transitions blend the right pictures', { skip, timeout: 300000 }, async () => {
  const sources = [
    { asset_id: 'red', storage_key: keys.red, duration_seconds: 4, kind: 'video' },
    { asset_id: 'blue', storage_key: keys.blue, duration_seconds: 4, kind: 'video' },
  ];
  const timeline = (transition) => ({
    schema_version: 2,
    duration_seconds: 4,
    tracks: [{ id: 'v', type: 'video', clips: [
      { id: 'a', source_asset_id: 'red', source_in: 0, source_out: 2, start: 0, end: 2, transition_in: 'fade', transition_duration: 0.6, speed: 1 },
      { id: 'b', source_asset_id: 'blue', source_in: 0, source_out: 2, start: 2, end: 4, transition_in: transition, transition_duration: 0.6, speed: 1 },
    ] }],
    overlays: [],
    output_spec: { width: 540, height: 960, fps: 30, duration_seconds: 4 },
  });
  const dissolve = await runJob('render_preview', { timeline: timeline('dissolve'), sources }, timeline('dissolve').output_spec);
  assert.equal(dissolve.status, 'succeeded', dissolve.error);
  const whole = { x: 100, y: 100, w: 200, h: 400 };
  const color = (job, t, tag, region = whole) => m.regionColor(still(job, t, tag), region);
  const [r0] = color(dissolve, 0.2, 'dis');
  assert.ok(r0 < 200 && r0 > 20, `fade-in from black at 0.2 s gives red ${r0}`);
  const mid = color(dissolve, 2.3, 'dis');
  assert.ok(mid[0] > 70 && mid[2] > 70, `dissolve midpoint ${mid}`);
  assert.ok(color(dissolve, 1.5, 'dis')[0] > 200 && color(dissolve, 3.5, 'dis')[2] > 200);
  // audio follows the picture: 300 Hz on the red clip, 600 Hz on the blue clip
  assert.ok(Math.abs(m.toneFrequency(outputFile(dissolve), 1.0) - 300) < 30);
  assert.ok(Math.abs(m.toneFrequency(outputFile(dissolve), 3.2) - 600) < 40);

  const slide = await runJob('render_preview', { timeline: timeline('slide'), sources }, timeline('slide').output_spec);
  assert.equal(slide.status, 'succeeded', slide.error);
  const W = slide.validation.actual.width;
  const left = color(slide, 2.3, 'sl', { x: 4, y: 300, w: 20, h: 40 });
  const right = color(slide, 2.3, 'sl', { x: W - 24, y: 300, w: 20, h: 40 });
  assert.ok(left[0] > 200 && left[2] < 60, `slide: left still red ${left}`);
  assert.ok(right[2] > 200 && right[0] < 60, `slide: right already blue ${right}`);
});

test('unauthorised and invalid media fail closed with a named error', { skip, timeout: 120000 }, async () => {
  const foreign = await storage.seed(uploadKey('ws_other', 'png'), storage.local(keys.card));
  const stolen = exampleSources().map((s) => (s.asset_id === 'asset-img001' ? { ...s, storage_key: foreign } : s));
  const a = await runJob('render_preview', { timeline: corrected(), sources: stolen }, corrected().output_spec);
  assert.deepEqual([a.status, a.error_code], ['failed', 'invalid_source']);

  // a video posing as an image: refused by content, not by its declared kind
  const fake = exampleSources().map((s) => (s.asset_id === 'asset-img001' ? { ...s, storage_key: keys.cuts } : s));
  const b = await runJob('render_preview', { timeline: corrected(), sources: fake }, corrected().output_spec);
  assert.deepEqual([b.status, b.error_code], ['failed', 'invalid_source']);
  // and an "image" over the image size cap is refused before it is decoded
  const huge = exampleSources().map((s) => (s.asset_id === 'asset-img001' ? { ...s, storage_key: keys.speaker } : s));
  const b2 = await runJob('render_preview', { timeline: corrected(), sources: huge }, corrected().output_spec);
  assert.deepEqual([b2.status, b2.error_code], ['failed', 'source_too_large']);

  const short = exampleSources().map((s) => (s.asset_id === 'asset-abc123' ? { ...s, storage_key: keys.red, duration_seconds: null } : s));
  const c = await runJob('render_preview', { timeline: corrected(), sources: short }, corrected().output_spec);
  assert.deepEqual([c.status, c.error_code], ['failed', 'source_range_out_of_bounds']);

  const d = await runJob('render_preview', { timeline: example(), sources: exampleSources() }, example().output_spec);
  assert.equal(d.status, 'failed');
  assert.ok(['duration_mismatch', 'ambiguous_speaker_zoom'].includes(d.error_code));
  assert.ok(d.result.errors.length >= 3);

  // nothing is left behind by a failed job
  assert.deepEqual(fs.readdirSync(work), []);
});

test('cancel stops the renderer and cleans up', { skip, timeout: 120000 }, async () => {
  const controller = new AbortController();
  const db = fakeDb();
  setTimeout(() => controller.abort(), 2500);
  const row = await runJob('render_master', { timeline: corrected(), sources: exampleSources() }, corrected().output_spec, { signal: controller.signal, db });
  assert.equal(row.status, 'canceled');
  assert.deepEqual(fs.readdirSync(work), []);
});

test('V1 regression: a V1 timeline (legacy map and Base44 array sources) renders as before', { skip, timeout: 300000 }, async () => {
  const timeline = {
    tracks: [{ type: 'video', clips: [
      { source_asset_id: 'A', source_in: 0, start: 0, end: 3 },
      { source_asset_id: 'B', source_in: 0.5, start: 3.5, end: 6, transition_in: 'fade', transition_duration: 0.5, speed: 1.5 },
    ] }],
    output: { width: 540, height: 960, fps: 30 },
  };
  for (const sources of [
    { A: { storage_key: keys.speaker }, B: { storage_key: keys.blue } },
    [{ asset_id: 'A', storage_key: keys.speaker }, { asset_id: 'B', storage_key: keys.blue }],
  ]) {
    const row = await runJob('render_master', { timeline, sources });
    assert.equal(row.status, 'succeeded', row.error);
    assert.equal(row.validation.passed, true, JSON.stringify(row.validation.checks));
    assert.equal(row.validation.schema_version, undefined);
    assert.equal(row.result, null);
    const info = await probe(outputFile(row));
    assert.equal(Math.round(Number(info.format.duration)), 6);
  }
});

test('frame_extract: timestamped stills and a contact sheet', { skip, timeout: 120000 }, async () => {
  const row = await runJob('frame_extract', {
    asset_id: 'clip', sources: [{ asset_id: 'clip', storage_key: keys.speaker }], params: { timestamps: [0, 5.5, 20, 33.9], width: 320 },
  });
  assert.equal(row.status, 'succeeded', row.error);
  assert.deepEqual(row.result.frames.map((f) => f.time), [0, 5.5, 20, 33.9]);
  assert.equal(row.result.media.video.width, 1280);
  assert.equal(row.result.media.audio.codec, 'aac');
  const first = storage.local(row.result.frames[0].storage_key);
  assert.equal((await probe(first)).streams[0].width, 320);
  assert.ok(await storage.exists(row.result.contact_sheet_key));

  const past = await runJob('frame_extract', { sources: [{ asset_id: 'clip', storage_key: keys.speaker }], params: { timestamps: [99] } });
  assert.deepEqual([past.status, past.error_code], ['failed', 'invalid_request']);
});

test('scene_detect finds the hard cuts', { skip, timeout: 120000 }, async () => {
  const row = await runJob('scene_detect', { sources: [{ asset_id: 'c', storage_key: keys.cuts }] });
  assert.equal(row.status, 'succeeded', row.error);
  const cuts = row.result.cuts.map((c) => c.time);
  assert.equal(cuts.length, 3, JSON.stringify(row.result.cuts));
  [2, 4, 6].forEach((t, i) => assert.ok(Math.abs(cuts[i] - t) < 0.1, `cut ${i} at ${cuts[i]}`));
  assert.equal(row.result.scenes.length, 4);
});

test('audio_analyse returns loudness and the pause map', { skip, timeout: 120000 }, async () => {
  const row = await runJob('audio_analyse', { sources: [{ asset_id: 'p', storage_key: keys.pauses, kind: 'audio' }] });
  assert.equal(row.status, 'succeeded', row.error);
  const p = row.result.audio_profile;
  assert.equal(p.silences.length, 1, JSON.stringify(p.silences));
  assert.ok(Math.abs(p.silences[0].start - 2) < 0.1 && Math.abs(p.silences[0].end - 4) < 0.1);
  assert.ok(Number.isFinite(p.integrated_lufs));
  assert.ok(Math.abs(p.speech_ratio - 0.667) < 0.05);
});
