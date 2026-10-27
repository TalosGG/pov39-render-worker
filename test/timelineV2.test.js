import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTimelineV2, timelineVersion } from '../src/render/timelineV2.js';
import { normalizeSources, checkSources } from '../src/sources.js';
import { buildPlan } from '../src/render/plan.js';

/** The Base44 example, exactly as exported (BASE44_TIMELINE_V2_EXPORT_UNMODIFIED.txt). */
const example = () => JSON.parse(fs.readFileSync(new URL('./fixtures/base44-timeline-v2-example.json', import.meta.url), 'utf8'));

/** The mediaPipeline `inputs.sources` shape, for the example's three assets. */
const sourcesArray = () => [
  { asset_id: 'asset-abc123', storage_key: 'base44/private/a.mp4', url: 'https://media.base44.com/a?sig=1', duration_seconds: 45.2, width: 1920, height: 1080, kind: 'video' },
  { asset_id: 'asset-music001', url: 'https://media.base44.com/m?sig=1', duration_seconds: 40, kind: 'audio' },
  { asset_id: 'asset-img001', url: 'https://media.base44.com/i?sig=1', kind: 'image' },
];

/** The example with only the contract corrections requested from Base44 applied. */
function corrected() {
  const t = example();
  t.duration_seconds = 32;
  t.output_spec.duration_seconds = 32;
  t.overlays.find((o) => o.id === 'speaker-zoom-1').type = 'speaker_zoom';
  return t;
}

const parse = (t, sources = sourcesArray(), spec = t.output_spec) => parseTimelineV2(t, spec, { sources: normalizeSources(sources) });
const codes = (fn) => {
  try {
    fn();
  } catch (error) {
    return (error.details || [{ code: error.code }]).map((d) => d.code);
  }
  return [];
};

test('schema_version: absent → V1, 2 → V2, anything else is refused by name', () => {
  assert.equal(timelineVersion({ tracks: [] }), 1);
  assert.equal(timelineVersion({ schema_version: 2 }), 2);
  for (const v of [3, 0, '2', 2.5, 'v2', {}]) {
    assert.throws(() => timelineVersion({ schema_version: v }), { code: 'unsupported_schema_version' }, String(v));
  }
});

test('the unmodified Base44 example is refused for exactly its documented inconsistencies', () => {
  const found = codes(() => parse(example()));
  assert.deepEqual(new Set(found), new Set(['duration_mismatch', 'ambiguous_speaker_zoom']));
  // both declared durations (timeline and output_spec) say 32.5 while the tracks end at 32.0
  assert.equal(found.filter((c) => c === 'duration_mismatch').length, 2);
});

test('the corrected example parses into the expected render plan', () => {
  const plan = parse(corrected());
  assert.equal(plan.version, 2);
  assert.deepEqual([plan.width, plan.height, plan.fps, plan.duration, plan.frames], [1080, 1920, 30, 32, 960]);
  assert.deepEqual(plan.segments.map((s) => [s.type, s.transition, s.start, s.end, s.tail]), [
    ['clip', 'fade', 0, 8, 0.4],
    ['clip', 'dissolve', 8, 21.5, 0.4],
    ['clip', 'dissolve', 21.5, 32, 0],
  ]);
  assert.deepEqual(plan.zooms.map((z) => [z.start, z.end, z.zoom_start, z.zoom_end, z.face_x, z.face_y]), [[8.5, 21.5, 1, 1.15, 0.5, 0.4]]);
  assert.deepEqual(plan.overlays.map((o) => o.type).sort(), ['credit', 'headline', 'image_card', 'lower_third', 'pill']);
  assert.deepEqual(plan.music.map((m) => [m.asset, m.gainDb]), [['asset-music001', -14]]);
  assert.deepEqual(plan.imageAssetIds, ['asset-img001']);
  assert.equal(plan.cues.length, 6);
  assert.deepEqual(plan.fontIds.sort(), ['inter-regular', 'oswald-bold', 'playfair-bold']);
});

test('fails closed on unresolved media — even when Base44 had no asset context', () => {
  const t = corrected();
  assert.ok(codes(() => parse(t, sourcesArray().filter((s) => s.asset_id !== 'asset-abc123'))).includes('unresolved_source'));
  assert.ok(codes(() => parse(t, [])).includes('unresolved_source'));
});

test('image cards need an authorised image source; a license URL is not one', () => {
  const noImage = sourcesArray().filter((s) => s.asset_id !== 'asset-img001');
  assert.ok(codes(() => parse(corrected(), noImage)).includes('missing_image_source'));

  const asVideo = sourcesArray().map((s) => (s.asset_id === 'asset-img001' ? { ...s, kind: 'video' } : s));
  assert.ok(codes(() => parse(corrected(), asVideo)).includes('invalid_source_kind'));

  const t = corrected();
  t.overlays.find((o) => o.type === 'image_card').source_asset_id = '';
  assert.ok(codes(() => parse(t)).includes('missing_image_source'));
});

test('map and chart are refused until they are rendered; unknown types are refused', () => {
  for (const type of ['map', 'chart', 'sparkle', 'speaker-zoom']) {
    const t = corrected();
    t.overlays.push({ id: 'x', type, start: 1, end: 2, title: 'x' });
    assert.ok(codes(() => parse(t)).includes('unsupported_overlay'), type);
  }
});

test('overlays may not run past the program', () => {
  const t = corrected();
  t.overlays.push({ id: 'late', type: 'pill', start: 30, end: 40, title: 'LATE' });
  assert.ok(codes(() => parse(t)).includes('overlay_out_of_range'));
  const t2 = corrected();
  t2.overlays.push({ id: 'after', type: 'pill', start: 33, end: 34, title: 'AFTER' });
  assert.ok(codes(() => parse(t2)).includes('overlay_out_of_range'));
});

test('a clip whose source range at its speed does not fill its slot is refused', () => {
  const t = corrected();
  t.tracks[0].clips[1].speed = 2; // 13.5 s of source at 2x plays 6.75 s in a 13.5 s slot
  assert.ok(codes(() => parse(t)).includes('clip_time_mismatch'));

  const ok = corrected();
  Object.assign(ok.tracks[0].clips[1], { speed: 2, source_in: 8.5, source_out: 35.5 }); // 27 s at 2x = 13.5 s
  assert.equal(parse(ok, sourcesArray()).segments[1].speed, 2);
});

test('a clip that reads past its source is refused', () => {
  const short = sourcesArray().map((s) => (s.asset_id === 'asset-abc123' ? { ...s, duration_seconds: 20 } : s));
  assert.ok(codes(() => parse(corrected(), short)).includes('source_range_out_of_bounds'));
});

test('overlapping video clips, blank captions and bad zooms are refused', () => {
  const t = corrected();
  t.tracks[0].clips[1].start = 6; t.tracks[0].clips[1].source_in = 6.5;
  assert.ok(codes(() => parse(t)).includes('clip_overlap'));

  const blank = corrected();
  blank.overlays.push({ id: 'b', type: 'lower_third', start: 1, end: 2, title: '' });
  assert.ok(codes(() => parse(blank)).includes('invalid_overlay'));

  const zoom = corrected();
  zoom.overlays.find((o) => o.type === 'speaker_zoom').zoom_end = 5;
  assert.ok(codes(() => parse(zoom)).includes('invalid_zoom'));

  const titled = corrected();
  Object.assign(titled.overlays[0], { zoom_start: 1, zoom_end: 1.2 });
  assert.ok(codes(() => parse(titled)).includes('ambiguous_speaker_zoom'));
});

test('clips on overlay/title tracks have no defined rendering and are refused', () => {
  const t = corrected();
  t.tracks.push({ id: 'o', type: 'overlay', clips: [{ source_asset_id: 'asset-img001', start: 1, end: 2 }] });
  assert.ok(codes(() => parse(t)).includes('unsupported_track'));
});

test('every problem is reported at once, with a path', () => {
  const t = example();
  t.overlays.push({ id: 'm', type: 'map', start: 1, end: 2 });
  try {
    parse(t);
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error.details.length >= 4);
    for (const d of error.details) assert.ok(d.code && d.path && d.message);
  }
});

test('preview output is capped at 720 on the long side', () => {
  const plan = parseTimelineV2(corrected(), corrected().output_spec, { sources: normalizeSources(sourcesArray()), preview: true });
  assert.deepEqual([plan.width, plan.height], [406, 720]);
});

test('Base44 array sources and legacy map sources normalise to one shape', () => {
  const fromArray = normalizeSources(sourcesArray());
  assert.equal(fromArray['asset-img001'].kind, 'image');
  assert.equal(fromArray['asset-abc123'].duration_seconds, 45.2);
  const fromMap = normalizeSources({ A: 'https://media.base44.com/a', B: { storage_key: 'uploads/ws/x/original.mp4' } });
  assert.deepEqual([fromMap.A.url, fromMap.A.kind, fromMap.B.storage_key], ['https://media.base44.com/a', 'video', 'uploads/ws/x/original.mp4']);
  assert.throws(() => normalizeSources([{ asset_id: '../x', url: 'https://media.base44.com/a' }]), { code: 'invalid_source' });
  assert.throws(() => normalizeSources([{ asset_id: 'a', url: 'x' }, { asset_id: 'a', url: 'y' }]), { code: 'invalid_source' });
  assert.throws(() => normalizeSources([{ asset_id: 'a', kind: 'script' }]), { code: 'invalid_source' });
});

test('source checks: own uploads, owned renders and allowlisted links only', async () => {
  const allow = { allowedHosts: ['media.base44.com'], ownsRender: async (id, ws) => id === 'job_1' && ws === 'ws_1' };
  const key = 'uploads/ws_1/0b3f1a52-1111-4a2b-9c3d-123456789abc/original.mp4';
  assert.equal(await checkSources(normalizeSources([{ asset_id: 'a', storage_key: key }]), 'ws_1', allow), '');
  assert.match(await checkSources(normalizeSources([{ asset_id: 'a', storage_key: key }]), 'ws_2', allow), /neither/);
  assert.equal(await checkSources(normalizeSources([{ asset_id: 'a', storage_key: 'renders/job_1/output.mp4' }]), 'ws_1', allow), '');
  assert.match(await checkSources(normalizeSources([{ asset_id: 'a', storage_key: 'renders/job_1/output.mp4' }]), 'ws_2', allow), /does not own/);
  assert.match(await checkSources(normalizeSources([{ asset_id: 'a', url: 'https://evil.com/x' }]), 'ws_1', allow), /accept/);
  // A foreign storage key with a valid signed link falls back to the link (Base44's own storage).
  assert.equal(await checkSources(normalizeSources(sourcesArray()), 'ws_1', allow), '');
});

test('V1 timelines still go through the V1 planner unchanged', () => {
  const v1 = {
    tracks: [{ type: 'video', clips: [{ source_asset_id: 'A', start: 0, end: 3 }, { source_asset_id: 'B', start: 3.5, end: 6, transition_in: 'fade' }] }],
    output: { width: 1080, height: 1920, fps: 30 },
  };
  assert.equal(timelineVersion(v1), 1);
  const plan = buildPlan(v1);
  assert.deepEqual(plan.segments.map((s) => s.type), ['clip', 'gap', 'clip']);
  assert.equal(plan.duration, 6);
});
