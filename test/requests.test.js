/**
 * The HTTP contract against the exact Base44 payloads (mediaPipeline `render_master`
 * inputs and the documented GET /jobs response fields). No database or bucket needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequests, planSummary, requestHash } from '../src/requests.js';

const config = { allowedSourceHosts: ['media.base44.com'], downloadUrlTtl: 900 };
const jobs = new Map([['job_ws1', { status: 'succeeded', inputs: { workspace_id: 'ws1' } }]]);
const api = createRequests({
  db: { get: async (id) => jobs.get(id) || null },
  storage: { signedGet: async (key) => `https://signed.invalid/${key}` },
  config,
});

const example = () => JSON.parse(fs.readFileSync(new URL('./fixtures/base44-timeline-v2-example.json', import.meta.url), 'utf8'));
function corrected() {
  const t = example();
  t.duration_seconds = 32;
  t.output_spec.duration_seconds = 32;
  t.overlays.find((o) => o.id === 'speaker-zoom-1').type = 'speaker_zoom';
  return t;
}

/** base44/functions/mediaPipeline/entry.ts — the documented render_master body. */
function base44Body(timeline) {
  return {
    operation: 'render_master',
    inputs: {
      timeline,
      workspace_id: 'ws1',
      source_asset_ids: timeline.source_asset_ids,
      sources: [
        { asset_id: 'asset-abc123', storage_key: 'b44/a.mp4', url: 'https://media.base44.com/a?sig=x', duration_seconds: 45.2, width: 1920, height: 1080, kind: 'video' },
        { asset_id: 'asset-music001', storage_key: 'b44/m.m4a', url: 'https://media.base44.com/m?sig=x', duration_seconds: 40, kind: 'audio' },
        { asset_id: 'asset-img001', storage_key: 'b44/i.jpg', url: 'https://media.base44.com/i?sig=x', width: 1920, height: 1080, kind: 'image' },
      ],
      project_id: 'proj1',
      timeline_version_id: 'tv1',
    },
    output_spec: { ...timeline.output_spec },
  };
}

test('the documented Base44 render_master body is accepted (with the contract corrections)', async () => {
  assert.equal(await api.validateRequest(base44Body(corrected())), null);
});

test('the unmodified Base44 example is answered 422 with every problem listed', async () => {
  const refused = await api.validateRequest(base44Body(example()));
  assert.equal(refused.status, 422);
  assert.ok(['duration_mismatch', 'ambiguous_speaker_zoom'].includes(refused.body.error_code));
  assert.deepEqual(new Set(refused.body.error_details.map((d) => d.code)), new Set(['duration_mismatch', 'ambiguous_speaker_zoom']));
});

test('Base44 array sources: a link off the allowlist or an unknown kind is refused (400)', async () => {
  const body = base44Body(corrected());
  body.inputs.sources[2].url = 'https://images.example.com/hero.jpg';
  assert.equal((await api.validateRequest(body)).status, 400);
  const kind = base44Body(corrected());
  kind.inputs.sources[0].kind = 'shell';
  assert.equal((await api.validateRequest(kind)).status, 400);
});

test('a missing image source is a 422 timeline problem, not a silent drop', async () => {
  const body = base44Body(corrected());
  body.inputs.sources = body.inputs.sources.filter((s) => s.asset_id !== 'asset-img001');
  const refused = await api.validateRequest(body);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error_code, 'missing_image_source');
});

test('unsupported schema versions are refused by name', async () => {
  const body = base44Body({ ...corrected(), schema_version: 3 });
  const refused = await api.validateRequest(body);
  assert.deepEqual([refused.status, refused.body.error_code], [422, 'unsupported_schema_version']);
});

test('analysis requests: sources checked, params must be an object', async () => {
  const ok = { operation: 'frame_extract', inputs: { workspace_id: 'ws1', asset_id: 'a', sources: [{ asset_id: 'a', url: 'https://media.base44.com/a' }], params: { count: 6 } } };
  assert.equal(await api.validateRequest(ok), null);
  assert.equal((await api.validateRequest({ ...ok, inputs: { ...ok.inputs, params: [1] } })).status, 400);
  // a finished render can be inspected by the workspace that owns it, and only by it
  const own = { operation: 'frame_extract', inputs: { workspace_id: 'ws1', sources: [{ asset_id: 'r', storage_key: 'renders/job_ws1/output.mp4' }] } };
  assert.equal(await api.validateRequest(own), null);
  const other = { operation: 'frame_extract', inputs: { workspace_id: 'ws2', sources: [{ asset_id: 'r', storage_key: 'renders/job_ws1/output.mp4' }] } };
  assert.equal((await api.validateRequest(other)).status, 400);
});

test('unimplemented operations pass validation and are refused later as unsupported', async () => {
  assert.equal(await api.validateRequest({ operation: 'compile_timeline', inputs: {} }), null);
  assert.equal((await api.validateRequest({ operation: 'shell', inputs: {} })).status, 400);
});

test('request fingerprint ignores signed links but not the timeline', () => {
  const a = base44Body(corrected());
  const b = base44Body(corrected());
  b.inputs.sources.forEach((s) => { s.url += '&renewed=1'; });
  assert.equal(requestHash(a), requestHash(b));
  const c = base44Body(corrected());
  c.inputs.timeline.overlays[0].title = 'Someone else';
  assert.notEqual(requestHash(a), requestHash(c));
});

test('plan summary for the agent: what will be rendered and which assets it needs', () => {
  const summary = planSummary(api.planTimeline(corrected(), corrected().output_spec, base44Body(corrected()).inputs.sources, 'render_master'));
  assert.equal(summary.schema_version, 2);
  assert.equal(summary.duration_seconds, 32);
  assert.deepEqual(summary.required_assets, { video: ['asset-abc123'], audio: ['asset-music001'], image: ['asset-img001'] });
  assert.equal(summary.speaker_zooms, 1);
});

test('GET /jobs shape: documented fields, signed outputs, no inputs or source links', async () => {
  const render = await api.publicJob({
    id: 'j1', operation: 'render_master', status: 'succeeded', progress: 1, attempts: 1,
    inputs: { sources: [{ url: 'https://media.base44.com/secret?sig=1' }] },
    output_key: 'renders/j1/output.mp4', output_duration: 32, validation: { passed: true },
    result: { preview: { frames: [{ index: 0, time: 3, storage_key: 'frames/j1/f_000.jpg' }], contact_sheet_key: 'frames/j1/contact.jpg' } },
  });
  assert.equal(JSON.stringify(render).includes('secret'), false);
  assert.equal(render.inputs, undefined);
  assert.deepEqual(render.outputs.map((o) => o.kind), ['video', 'frames']);
  assert.equal(render.outputs[0].duration_seconds, 32);
  assert.equal(render.preview_frames[0].file_url, 'https://signed.invalid/frames/j1/f_000.jpg');

  const transcript = await api.publicJob({
    id: 'j2', operation: 'transcribe', status: 'succeeded', progress: 1, attempts: 1,
    result: { transcript: 'ciao', language: 'it', language_source: 'detected', segments: [{ start: 0.39, end: 3.17, text: 'ciao' }], media: { duration_seconds: 5 } },
  });
  assert.deepEqual([transcript.transcript, transcript.language, transcript.word_timestamps], ['ciao', 'it', false]);
  assert.deepEqual(transcript.segments, [{ start: 0.39, end: 3.17, text: 'ciao' }]);

  const failed = await api.publicJob({
    id: 'j3', operation: 'render_master', status: 'failed', error_code: 'missing_image_source', error: 'x',
    result: { errors: [{ code: 'missing_image_source', path: 'overlays[3]', message: 'x' }] },
  });
  assert.equal(failed.error_details[0].path, 'overlays[3]');
  assert.deepEqual(failed.outputs, []);
});
