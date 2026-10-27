# Base44 changes required for Timeline V2 rendering

The worker (`feat/timeline-v2-renderer`, worker 1.3.0) renders Timeline V2 as exported in
`BASE44_TIMELINE_V2_EXPORT_UNMODIFIED.txt`, and refuses — with a named `error_code` and a
list of every problem in `error_details` — the cases below. Until these are fixed in
Base44, real V2 jobs that hit them come back `422`. Each item names the file, the
change, and the worker behaviour it lines up with.

Verified against the export: the unmodified example timeline is refused for exactly two
reasons (`duration_mismatch` ×2, `ambiguous_speaker_zoom`); with items 3 and 4 applied it
renders and passes all ten output checks (`test/timelineV2.test.js`, `test/render.test.js`).

---

## P0-1 · Clip sources are not checked when the asset context is empty
`base44/shared/timeline.ts`, `validateTimeline()`:

```ts
if (assetIds.size > 0 && !assetIds.has(assetId)) { droppedClips += 1; continue; }
```

With `context.assets` empty, every `source_asset_id` the model wrote passes.
**Change:** fail when the context is empty, and always check:

```ts
if (!assetIds.size) return { ok: false, notes: ['No project assets were supplied to validate against.'], timeline: null, outputSpec: null };
if (!assetIds.has(assetId)) { droppedClips += 1; continue; }
```

Worker: a clip whose asset is not in `inputs.sources` is refused (`unresolved_source`).

## P0-2 · Image-card assets are never authorised or signed
`validateTimeline()` builds `source_asset_ids` from `tracks[].clips[]` only, so
`overlays[].source_asset_id` (image cards) is neither checked against the project's
assets nor passed to `signTimelineSources` — yet the exported example lists
`asset-img001` in `source_asset_ids`, which the shown validator would not produce.

**Change, in `validateTimeline()`:**
1. For `type === 'image_card'`: require `source_asset_id` to be in `assetIds` **and** that
   asset to be an image the workspace owns (`asset.kind === 'image'`); otherwise drop the
   overlay with a note (or fail — but never keep it).
2. Build `source_asset_ids` from clips **and** image-card overlays.

**Change, in `mediaPipeline/entry.ts` / `signTimelineSources`:** sign every id in
`timeline.source_asset_ids` and send each with its `kind`:

```json
{ "asset_id": "asset-img001", "storage_key": "…", "url": "https://media.base44.com/…signed…", "kind": "image", "width": 1920, "height": 1080 }
```

Worker: an image card whose asset is not in `inputs.sources` with `kind: "image"` is
refused (`missing_image_source` / `invalid_source_kind`); the file itself must decode as
PNG, JPEG or WebP ≤ 25 MB (`invalid_source`, `source_too_large`). The worker never
fetches `license_url` or any URL written into the timeline; `citation`/`license_url` are
displayed, not treated as permission. Images may also be uploaded straight to the worker
bucket: `POST /uploads` now accepts `image/jpeg`, `image/png`, `image/webp`.

## P0-3 · Speaker zoom has no representation of its own
`OVERLAY_TYPES` has no zoom type, so the example encodes the punch-in as a blank
`lower_third` with `zoom_start/zoom_end`. A lower third is a caption; whether that record
means "zoom the footage" is a guess the worker will not make.

**Change:** add `'speaker_zoom'` to `OVERLAY_TYPES`, and in the overlay mapper:

```ts
// speaker_zoom: transforms the source video itself (crop + scale around the face).
// zoom_start/zoom_end: 1–3. face_x/face_y: 0–1 relative to the output frame (default 0.5 / 0.4).
// animation: curve of the zoom over [start, end]. No text fields.
```

Stop emitting zoom values on `lower_third` (keep `zoom_start = zoom_end = 1` there).
The example's `speaker-zoom-1` becomes `"type": "speaker_zoom"`.

Worker semantics (implemented): from `start` the program picture is cropped to
`1/zoom` around (`face_x`, `face_y`) — the face at 45 % of the crop height — and scaled
back to the frame; the scale moves from `zoom_start` to `zoom_end` along `animation`
and returns to 1 at `end`. Zooms may not overlap. A `lower_third` with zoom values ≠ 1 is
refused (`ambiguous_speaker_zoom`). Until face tracking exists, Base44 should send its
best face estimate or the defaults.

## P0-4 · `duration_seconds` disagrees with the validator
The example declares `duration_seconds: 32.5` (timeline and `output_spec`); the
validator's own rule — max `end` over non-subtitle tracks — gives `32.0`.
**Change:** emit the computed value only (the shown code already does; the example and
whatever produced it do not). Worker: declared ≠ computed by more than one frame/50 ms →
`duration_mismatch`.

## P1-5 · `TIMELINE_SCHEMA` does not declare what the validator emits
`TIMELINE_SCHEMA` omits `schema_version`, `overlays`, `output_spec`, `source_asset_ids`
and clip `duration`. **Change:** add them (`overlays: { type: 'array', items: OVERLAY_SCHEMA }`,
`schema_version: { const: 2 }`) so the model is prompted with the real contract.

## P1-6 · Overlay end is not bounded by the program
The mapper clamps `start ≥ 0` but not `end ≤ durationSeconds`.
**Change:** after computing `durationSeconds`, drop overlays with `start ≥ durationSeconds`
and set `end = min(end, durationSeconds)`. Worker: `overlay_out_of_range` otherwise.

## P1-7 · Clip source range and speed are clamped independently
`speed` is clamped to 0.25–4 and `source_out` to the asset length separately, so
`(source_out − source_in) / speed` can differ from `end − start`.
**Change:** enforce the invariant after clamping — recompute `end = start + (source_out − source_in) / speed`
(or drop the clip). Worker: off by more than one frame/50 ms → `clip_time_mismatch`; reads
past the probed file → `source_range_out_of_bounds`.

## P1-8 · Operations declared vs. operations available
`OPERATIONS` lists `transcribe`, `subtitles`, `compile_timeline`, …; what a worker can do
is only what `GET /capabilities` lists. **Change:** gate every dispatch on
`capabilities.operations` (and for V2 renders on `capabilities.timeline.schema_versions`
including `2`), before charging. This build lists `render_master`, `render_preview`,
`render_motion`, `validate`, `frame_extract`, `scene_detect`, `audio_analyse`, and
`transcribe` only on an image built with the speech model. `subtitles` and
`compile_timeline` are not implemented (`422 unsupported_operation`).

## P1-9 · Map and chart overlays
`map` and `chart` are in `OVERLAY_TYPES` but have no data contract (no geometry, no
series). The worker refuses them (`unsupported_overlay`). Either remove them from
`OVERLAY_TYPES` for now, or specify their data fields before they are built.

## Also: tracks the worker refuses
Clips on `overlay` or `title` tracks have no defined rendering (`unsupported_track`);
overlays belong in `timeline.overlays`. Clips on `subtitle` tracks are ignored (cues come
from `timeline.subtitles.cues`). Clips on `audio` tracks are mixed at
`audio.music_gain_db` under the original speech — their assets must be signed with
`kind: "audio"` (or `"video"` with an audio stream).

---

## New and changed worker endpoints Base44 can use

| Endpoint | Change |
|---|---|
| `POST /jobs` | `inputs.sources` may be the mediaPipeline **array** (was: object map only — every real V2 dispatch was a `400`). V2 timelines are checked before queueing: `422` with `error_code` + `error_details[]`. A reused `Idempotency-Key` with a different request → `409 idempotency_conflict`. |
| `POST /timelines/validate` | **New.** `{ timeline, output_spec, sources, workspace_id }` → `{ ok, renderable, plan: { duration_seconds, overlays, speaker_zooms, transitions, required_assets, … } }` or `422 { error_code, error_details }`. No media is fetched. |
| `GET /jobs/:id` | Adds `preview_frames` (signed stills of the finished V2 render where overlays are on screen), `media`, and per operation `frames`, `scenes`, `audio_profile`, `transcript`/`language`/`segments` (`word_timestamps: false`), and `error_details` on failure. |
| `GET /capabilities` | Adds `timeline` (`schema_versions`, V2 overlay list, `ready`/`reason`) and `analysis` (per-operation `ready`/`reason`). |
| `POST /uploads` | Accepts JPEG/PNG/WebP (≤ 25 MB) for image cards. |

Analysis job body (`frame_extract`, `scene_detect`, `audio_analyse`, `transcribe`):

```json
{ "operation": "frame_extract",
  "inputs": { "workspace_id": "ws", "asset_id": "asset-abc123",
              "sources": [{ "asset_id": "asset-abc123", "url": "https://media.base44.com/…", "kind": "video" }],
              "params": { "timestamps": [0, 5.5, 20], "width": 540, "contact_sheet": true } } }
```

`params`: `frame_extract` — `timestamps[]` (≤ 60) | `interval_seconds` (≥ 0.5) | `count`;
`width` ≤ 1080. `scene_detect` — `threshold` 0.05–0.9 (default 0.3). `audio_analyse` —
`noise_db`, `min_silence_seconds`. `transcribe` — `language` (ISO 639-1 or `auto`).
To inspect a finished render, pass `{ "asset_id": "out", "storage_key": "renders/<job>/output.mp4" }`;
only the workspace that rendered it may.

Output key: renders stay at `renders/<job id>/output.mp4` (the export expects
`renders/<project>/<timeline version>/master.mp4`). Base44 must read `outputs[].storage_key`
rather than construct the key.
