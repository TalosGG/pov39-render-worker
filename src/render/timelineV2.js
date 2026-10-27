import { JobError } from '../errors.js';

/**
 * The worker's reading of a Base44 Timeline V2 (`schema_version: 2`).
 *
 * Base44's `validateTimeline()` (base44/shared/timeline.ts) is the authority for what a
 * timeline may contain; this is the second gate, at the point of rendering, and it is
 * stricter on purpose. Base44 clamps and drops quietly; the worker renders only what it
 * can render exactly as written, and refuses everything else with a named reason:
 *
 *  - every clip and every image card must resolve to a source supplied with the job
 *    (Base44 skips the clip check when its asset context is empty);
 *  - the declared duration must equal the program end the validator itself computes;
 *  - an overlay may not run past the end of the program;
 *  - a clip's source range, played at its speed, must fill exactly its slot;
 *  - an overlay whose meaning is ambiguous (zoom values on a lower third) is refused
 *    instead of guessed at, and map / chart are refused until they are built.
 *
 * Nothing here is executed: the result is plain data handed to the compositor.
 */

export const SUPPORTED_SCHEMA_VERSIONS = [1, 2];
export const TRANSITIONS = ['cut', 'fade', 'dissolve', 'slide'];
export const ANIMATION_CURVES = ['easeOutCubic', 'easeInOut', 'linear'];

/** Base44 OVERLAY_TYPES, split by what this build draws. */
export const RENDERED_OVERLAYS = ['lower_third', 'pill', 'credit', 'stamp', 'image_card', 'headline', 'quote'];
export const UNRENDERED_OVERLAYS = ['map', 'chart'];
/**
 * Not in Base44 OVERLAY_TYPES yet: the source-video punch-in proposed to Base44, because
 * the current contract can only express it as a blank `lower_third` (see BASE44-PATCH.md).
 * Base44's validator drops this type today, so nothing reaches the worker with it until
 * Base44 adopts it.
 */
export const VIDEO_TRANSFORMS = ['speaker_zoom'];

export const MAX_DURATION_SECONDS = 600;
export const MIN_CLIP_SECONDS = 0.25;
export const MAX_OVERLAYS = 200;
const MAX_TOTAL_CLIPS = 320;
const ALLOWED_FPS = [24, 25, 30, 50, 60];
const PREVIEW_LONG_SIDE = 720;
const DEFAULT_ACCENT = '#d21428';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const str = (value, max) => (value === null || value === undefined ? '' : String(value).slice(0, max));
const r3 = (value) => Math.round(value * 1000) / 1000;

/** 1 for a timeline without `schema_version`, 2 for V2; anything else is refused. */
export function timelineVersion(timeline) {
  const version = timeline?.schema_version;
  if (version === undefined || version === null) return 1;
  if (finite(version) && SUPPORTED_SCHEMA_VERSIONS.includes(version)) return version;
  throw new JobError(
    'unsupported_schema_version',
    `Timeline schema_version ${str(JSON.stringify(version), 20)} is not supported by this worker (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).`,
  );
}

function outputSize(timeline, outputSpec, preview) {
  const out = { ...(timeline.output || {}), ...(timeline.output_spec || {}), ...(outputSpec || {}) };
  let width = even(clamp(num(out.width, 1080), 144, 3840));
  let height = even(clamp(num(out.height, 1920), 144, 3840));
  if (preview && Math.max(width, height) > PREVIEW_LONG_SIDE) {
    const scale = PREVIEW_LONG_SIDE / Math.max(width, height);
    width = even(width * scale);
    height = even(height * scale);
  }
  const fps = ALLOWED_FPS.includes(Number(out.fps)) ? Number(out.fps) : 30;
  return { width, height, fps, burnSubtitles: out.burn_subtitles === true, declaredOutput: num(out.duration_seconds, null) };
}

/**
 * @param timeline    the `inputs.timeline` Base44 sent
 * @param outputSpec  the job's `output_spec`
 * @param context     { sources: normalized source map (see sources.js), preview }
 * @returns           the render plan (version 2); throws JobError('invalid_timeline' | …) with every problem in `details`
 */
export function parseTimelineV2(timeline, outputSpec = {}, { sources = {}, preview = false } = {}) {
  const problems = [];
  const notes = [];
  const fail = (code, path, message) => problems.push({ code, path, message });

  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
    throw new JobError('invalid_timeline', 'The job has no timeline.');
  }
  if (timelineVersion(timeline) !== 2) throw new JobError('unsupported_schema_version', 'parseTimelineV2 needs schema_version 2.');

  const { width, height, fps, burnSubtitles, declaredOutput } = outputSize(timeline, outputSpec, preview);
  // A frame, or 50 ms: Base44 rounds every time to 1 ms, the encoder to one frame.
  const tol = Math.max(0.05, 1 / fps);
  const scale = width / 1080; // overlay pixel values are authored against a 1080-wide frame

  const sourceOf = (assetId) => (Object.hasOwn(sources, assetId) ? sources[assetId] : null);

  // ---- tracks -------------------------------------------------------------------------
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
  const videoClips = [];
  const audioClips = [];
  let totalClips = 0;

  const readClip = (rawClip, path, kinds) => {
    totalClips += 1;
    const asset = str(rawClip?.source_asset_id, 64);
    const source = asset ? sourceOf(asset) : null;
    if (!asset) return fail('invalid_clip', path, 'A clip has no source_asset_id.');
    if (!source) return fail('unresolved_source', path, `Clip source ${asset} was not supplied with the job.`);
    if (!kinds.includes(source.kind)) {
      return fail('invalid_source_kind', path, `Clip source ${asset} is a ${source.kind}, not ${kinds.join(' or ')}.`);
    }

    const start = num(rawClip?.start, NaN);
    const end = num(rawClip?.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return fail('invalid_clip', path, 'Clip start/end must be numbers ≥ 0.');
    if (end - start < MIN_CLIP_SECONDS - 1e-6) return fail('invalid_clip', path, `Clips must last at least ${MIN_CLIP_SECONDS} s.`);

    const speed = num(rawClip?.speed, 1);
    if (speed < 0.25 || speed > 4) return fail('invalid_clip', path, 'Clip speed must be between 0.25 and 4.');

    const sourceIn = num(rawClip?.source_in, 0);
    if (sourceIn < 0) return fail('invalid_clip', path, 'source_in must be ≥ 0.');
    // Without source_out the slot defines the range; with it, the two must agree.
    const sourceOut = num(rawClip?.source_out, sourceIn + (end - start) * speed);
    if (sourceOut <= sourceIn) return fail('invalid_clip', path, 'source_out must be after source_in.');
    const played = (sourceOut - sourceIn) / speed;
    if (Math.abs(played - (end - start)) > tol) {
      return fail(
        'clip_time_mismatch', path,
        `Source ${r3(sourceIn)}–${r3(sourceOut)} s at speed ${speed} plays ${r3(played)} s, but the clip slot is ${r3(end - start)} s.`,
      );
    }
    const known = num(source.duration_seconds, null);
    if (known && sourceOut > known + tol) {
      return fail('source_range_out_of_bounds', path, `Clip reads to ${r3(sourceOut)} s but source ${asset} is ${r3(known)} s long.`);
    }

    const transition = TRANSITIONS.includes(rawClip?.transition_in) ? rawClip.transition_in : 'cut';
    if (rawClip?.transition_in !== undefined && rawClip.transition_in !== transition) {
      return fail('invalid_transition', path, `Transition "${str(rawClip.transition_in, 20)}" is not one of ${TRANSITIONS.join(', ')}.`);
    }
    const transitionSeconds = transition === 'cut' ? 0 : num(rawClip?.transition_duration, 0.4);
    if (transitionSeconds < 0 || transitionSeconds > 2 || transitionSeconds > end - start) {
      return fail('invalid_transition', path, 'transition_duration must be between 0 and 2 s and no longer than the clip.');
    }

    return {
      id: str(rawClip?.id, 64),
      asset,
      start: r3(start),
      end: r3(end),
      sourceIn: r3(sourceIn),
      sourceOut: r3(sourceOut),
      speed,
      transition,
      transitionSeconds: r3(transitionSeconds),
    };
  };

  tracks.forEach((track, t) => {
    const path = `tracks[${t}]`;
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    if (track?.type === 'video') {
      clips.forEach((clip, c) => { const v = readClip(clip, `${path}.clips[${c}]`, ['video']); if (v) videoClips.push(v); });
    } else if (track?.type === 'audio') {
      clips.forEach((clip, c) => { const a = readClip(clip, `${path}.clips[${c}]`, ['audio', 'video']); if (a) audioClips.push(a); });
    } else if (track?.type === 'subtitle') {
      if (clips.length) notes.push(`${path}: subtitle-track clips are ignored; cues come from timeline.subtitles.`);
    } else if (track?.type === 'overlay' || track?.type === 'title') {
      // Base44 accepts clips on these tracks but defines no rendering for them. Overlays
      // live in timeline.overlays; a clip here would silently vanish, so it is refused.
      if (clips.length) fail('unsupported_track', path, `Clips on a "${track.type}" track have no defined rendering; use timeline.overlays.`);
    } else {
      fail('unsupported_track', path, `Track type "${str(track?.type, 20)}" is not a Timeline V2 track type.`);
    }
  });
  if (totalClips > MAX_TOTAL_CLIPS) fail('invalid_timeline', 'tracks', `Timelines are limited to ${MAX_TOTAL_CLIPS} clips.`);
  if (!videoClips.length && !problems.length) fail('invalid_timeline', 'tracks', 'The timeline has no video clips to render.');

  videoClips.sort((a, b) => a.start - b.start);
  for (let i = 1; i < videoClips.length; i += 1) {
    if (videoClips[i].start < videoClips[i - 1].end - tol) {
      fail('clip_overlap', `clip ${videoClips[i].id || i}`, 'Video clips overlap; this worker renders one picture at a time (transitions overlap by design, clips do not).');
    }
  }

  // ---- duration: the validator's own rule (max end over non-subtitle tracks) -----------
  const programEnd = Math.max(0, ...videoClips.map((c) => c.end), ...audioClips.map((c) => c.end));
  const duration = r3(programEnd);
  if (duration > MAX_DURATION_SECONDS) fail('timeline_too_long', 'duration_seconds', `Timelines are limited to ${MAX_DURATION_SECONDS} seconds.`);
  for (const [path, declared] of [['timeline.duration_seconds', num(timeline.duration_seconds, null)], ['output_spec.duration_seconds', declaredOutput]]) {
    if (declared !== null && videoClips.length && Math.abs(declared - duration) > tol) {
      fail('duration_mismatch', path, `Declared ${declared} s, but the tracks end at ${duration} s.`);
    }
  }

  // ---- overlays -------------------------------------------------------------------------
  const rawOverlays = Array.isArray(timeline.overlays) ? timeline.overlays : [];
  if (timeline.overlays !== undefined && !Array.isArray(timeline.overlays)) fail('invalid_overlay', 'overlays', 'overlays must be an array.');
  if (rawOverlays.length > MAX_OVERLAYS) fail('invalid_overlay', 'overlays', `At most ${MAX_OVERLAYS} overlays are allowed.`);

  const overlays = [];
  const zooms = [];
  const fontIds = new Set();
  rawOverlays.slice(0, MAX_OVERLAYS).forEach((ov, i) => {
    const path = `overlays[${i}]${ov?.id ? ` (${str(ov.id, 64)})` : ''}`;
    const type = ov?.type;
    if (UNRENDERED_OVERLAYS.includes(type)) return fail('unsupported_overlay', path, `Overlay type "${type}" is not rendered by this worker yet.`);
    if (!RENDERED_OVERLAYS.includes(type) && !VIDEO_TRANSFORMS.includes(type)) {
      return fail('unsupported_overlay', path, `Overlay type "${str(type, 20)}" is unknown.`);
    }

    const start = num(ov?.start, NaN);
    const end = num(ov?.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return fail('invalid_overlay', path, 'Overlay start/end must be numbers with 0 ≤ start < end.');
    }
    if (start >= duration || end > duration + tol) {
      return fail('overlay_out_of_range', path, `Overlay runs ${r3(start)}–${r3(end)} s, outside the ${duration} s program.`);
    }

    const zoomStart = num(ov?.zoom_start, 1);
    const zoomEnd = num(ov?.zoom_end, 1);
    const title = str(ov?.title, 200).trim();
    const subtitle = str(ov?.subtitle, 200).trim();
    const body = str(ov?.text, 400).trim();
    const curve = ANIMATION_CURVES.includes(ov?.animation) ? ov.animation : 'easeOutCubic';
    const animation = clamp(num(ov?.animation_duration, 0.45), 0.1, 2);

    if (type === 'speaker_zoom') {
      if (zoomStart < 1 || zoomEnd < 1 || zoomStart > 3 || zoomEnd > 3) {
        return fail('invalid_zoom', path, 'Speaker zoom scales must be between 1 and 3.');
      }
      zooms.push({
        id: str(ov?.id, 64),
        start: r3(start),
        end: r3(Math.min(end, duration)),
        zoom_start: zoomStart,
        zoom_end: zoomEnd,
        // Safe default until face tracking exists: the face sits in the upper-middle.
        face_x: clamp(num(ov?.face_x, 0.5), 0, 1),
        face_y: clamp(num(ov?.face_y, 0.4), 0, 1),
        curve,
      });
      return;
    }

    // Zoom values on a lower third are how the current contract smuggles a speaker zoom
    // (sample `speaker-zoom-1`). Rendering it as a caption would drop the zoom; zooming
    // the footage would be a guess. Neither is done.
    if (type === 'lower_third' && (zoomStart !== 1 || zoomEnd !== 1)) {
      return fail(
        'ambiguous_speaker_zoom', path,
        title ? 'A lower third carries zoom values; zoom is not a lower-third property.'
          : 'A blank lower third with zoom values is not a renderable overlay. A source-video zoom needs its own overlay type (proposed: "speaker_zoom").',
      );
    }

    const need = {
      lower_third: title,
      pill: title,
      headline: title,
      quote: body,
      credit: body || str(ov?.citation, 300).trim(),
      stamp: body || str(ov?.replacement, 200).trim(),
      image_card: true,
    }[type];
    if (!need) return fail('invalid_overlay', path, `A ${type} overlay has no text to show.`);

    const accent = /^#[0-9a-fA-F]{6}$/.test(str(ov?.accent_color, 7)) ? ov.accent_color : DEFAULT_ACCENT;
    const fontId = str(ov?.font_id, 64);
    if (fontId) fontIds.add(fontId);

    const overlay = {
      id: str(ov?.id, 64) || `${type}-${i + 1}`,
      type,
      start: r3(start),
      end: r3(Math.min(end, duration)),
      title,
      subtitle,
      text: body,
      replacement: str(ov?.replacement, 200).trim(),
      citation: str(ov?.citation, 300).trim(),
      x: clamp(num(ov?.x, 0.5), 0, 1),
      y: clamp(num(ov?.y, 0.5), 0, 1),
      width: Math.round(clamp(num(ov?.width, 800), 100, 2000) * scale),
      accent,
      font_id: fontId,
      curve,
      animation,
    };

    if (type === 'image_card') {
      const asset = str(ov?.source_asset_id, 64);
      const source = asset ? sourceOf(asset) : null;
      // An image is used only when Base44 signed it into this job, never from a URL the
      // model wrote; a citation or license URL is not permission (it is never fetched).
      if (!asset) return fail('missing_image_source', path, 'An image card has no source_asset_id.');
      if (!source) return fail('missing_image_source', path, `Image ${asset} was not supplied with the job.`);
      if (source.kind !== 'image') return fail('invalid_source_kind', path, `Image card source ${asset} is a ${source.kind}, not an image.`);
      if (zoomStart < 0.5 || zoomEnd < 0.5 || zoomStart > 3 || zoomEnd > 3) {
        return fail('invalid_zoom', path, 'Image card zoom must be between 0.5 and 3.');
      }
      const crop = ov?.crop && typeof ov.crop === 'object' ? {
        x: Math.max(0, num(ov.crop.x, 0)),
        y: Math.max(0, num(ov.crop.y, 0)),
        w: Math.max(10, num(ov.crop.w, 100)),
        h: Math.max(10, num(ov.crop.h, 100)),
      } : null;
      Object.assign(overlay, { asset, crop, zoom_start: zoomStart, zoom_end: zoomEnd });
    }
    overlays.push(overlay);
  });

  zooms.sort((a, b) => a.start - b.start);
  for (let i = 1; i < zooms.length; i += 1) {
    if (zooms[i].start < zooms[i - 1].end - 1e-6) fail('invalid_zoom', `speaker_zoom ${zooms[i].id || i}`, 'Speaker zooms overlap.');
  }

  // ---- subtitles ------------------------------------------------------------------------
  const cues = burnSubtitles && Array.isArray(timeline.subtitles?.cues)
    ? timeline.subtitles.cues
        .map((cue) => ({ start: num(cue?.start, -1), end: num(cue?.end, -1), text: str(cue?.text, 300) }))
        .filter((cue) => cue.start >= 0 && cue.end > cue.start && cue.text.trim())
        .map((cue) => ({ ...cue, end: Math.min(cue.end, duration) }))
        .filter((cue) => cue.start < duration)
        .slice(0, 400)
    : [];

  if (problems.length) {
    const error = new JobError(
      problems[0].code,
      `The timeline cannot be rendered: ${problems.length} problem(s). First: ${problems[0].path}: ${problems[0].message}`,
    );
    error.details = problems.slice(0, 50);
    throw error;
  }

  // ---- render plan ----------------------------------------------------------------------
  // Clips and black gaps, in program order; a clip's transition plays over its first
  // `transitionSeconds`, so every overlay timestamp stays where Base44 put it.
  const segments = [];
  let cursor = 0;
  for (const clip of videoClips) {
    if (clip.start - cursor > 0.001) segments.push({ type: 'gap', start: r3(cursor), end: clip.start });
    const previous = segments[segments.length - 1];
    let transition = clip.transition;
    // A dissolve or slide needs a picture to leave; after a gap or at the start it is a fade.
    if ((transition === 'dissolve' || transition === 'slide') && (!previous || previous.type !== 'clip' || previous.end < clip.start - 0.001)) {
      notes.push(`clip ${clip.id || clip.asset}: ${transition} has no preceding clip and renders as a fade from black.`);
      transition = 'fade';
    }
    segments.push({ type: 'clip', ...clip, transition });
    cursor = clip.end;
  }
  if (duration - cursor > 0.001) segments.push({ type: 'gap', start: r3(cursor), end: duration });

  // An outgoing clip keeps playing under the next clip's dissolve/slide.
  segments.forEach((segment, i) => {
    if (segment.type !== 'clip') return;
    const next = segments[i + 1];
    segment.tail = next?.type === 'clip' && ['dissolve', 'slide'].includes(next.transition) ? next.transitionSeconds : 0;
  });

  const music = audioClips.map((clip) => ({ ...clip, gainDb: clamp(num(timeline.audio?.music_gain_db, -14), -30, 0) }));
  const images = [...new Set(overlays.filter((o) => o.type === 'image_card').map((o) => o.asset))];

  return {
    version: 2,
    width,
    height,
    fps,
    duration,
    frames: Math.round(duration * fps),
    segments,
    zooms,
    overlays,
    music,
    cues,
    assetIds: [...new Set(videoClips.map((c) => c.asset))],
    audioAssetIds: [...new Set(music.map((c) => c.asset))],
    imageAssetIds: images,
    fontIds: [...fontIds],
    subtitle_font_id: timeline.subtitles?.font_id || null,
    notes,
  };
}
