import { JobError } from '../errors.js';

export const MAX_DURATION_SECONDS = 600;
const ALLOWED_FPS = [24, 25, 30, 50, 60];
const PREVIEW_LONG_SIDE = 720;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Turns the validated POV39 timeline into a flat, sequential list of segments
 * (clips and black gaps). Video tracks are rendered in timeline order; where
 * clips overlap, a later clip starts where the previous one ends.
 */
export function buildPlan(timeline, outputSpec = {}, { preview = false } = {}) {
  if (!timeline || typeof timeline !== 'object') throw new JobError('invalid_timeline', 'The job has no timeline.');
  const out = { ...(timeline.output || {}), ...(outputSpec || {}) };

  let width = even(clamp(num(out.width, 1080), 144, 3840));
  let height = even(clamp(num(out.height, 1920), 144, 3840));
  if (preview && Math.max(width, height) > PREVIEW_LONG_SIDE) {
    const scale = PREVIEW_LONG_SIDE / Math.max(width, height);
    width = even(width * scale);
    height = even(height * scale);
  }
  const fps = ALLOWED_FPS.includes(Number(out.fps)) ? Number(out.fps) : 30;

  const clips = (Array.isArray(timeline.tracks) ? timeline.tracks : [])
    .filter((track) => track?.type === 'video')
    .flatMap((track) => (Array.isArray(track.clips) ? track.clips : []))
    .map((clip) => ({
      asset: String(clip?.source_asset_id || ''),
      sourceIn: Math.max(0, num(clip?.source_in, 0)),
      start: Math.max(0, num(clip?.start, 0)),
      end: num(clip?.end, 0),
      speed: clamp(num(clip?.speed, 1), 0.25, 4),
      transition: String(clip?.transition_in || 'cut'),
      transitionSeconds: clamp(num(clip?.transition_duration, 0.3), 0, 2),
    }))
    .filter((clip) => clip.asset && clip.end > clip.start)
    .sort((a, b) => a.start - b.start);

  if (!clips.length) throw new JobError('invalid_timeline', 'The timeline has no video clips to render.');

  const segments = [];
  let cursor = 0;
  for (const clip of clips) {
    const start = Math.max(clip.start, cursor);
    const duration = clip.end - start;
    if (duration < 0.04) continue;
    if (start - cursor > 0.04) segments.push({ type: 'gap', duration: start - cursor });
    segments.push({
      type: 'clip',
      asset: clip.asset,
      sourceIn: clip.sourceIn + (start - clip.start) * clip.speed,
      sourceDuration: duration * clip.speed,
      duration,
      speed: clip.speed,
      fadeIn: ['fade', 'dissolve'].includes(clip.transition) ? Math.min(clip.transitionSeconds, duration / 2) : 0,
    });
    cursor = clip.end;
  }

  const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  if (duration > MAX_DURATION_SECONDS) {
    throw new JobError('timeline_too_long', `Timelines are limited to ${MAX_DURATION_SECONDS} seconds.`);
  }

  const subtitles = timeline.subtitles || {};
  const cues = out.burn_subtitles && Array.isArray(subtitles.cues)
    ? subtitles.cues
        .map((cue) => ({ start: num(cue?.start, -1), end: num(cue?.end, -1), text: String(cue?.text || '').slice(0, 300) }))
        .filter((cue) => cue.start >= 0 && cue.end > cue.start && cue.text.trim())
        .slice(0, 1000)
    : [];

  // Pass through the subtitle_font_id from the timeline for font resolution
  const subtitleFontId = timeline.subtitles?.font_id || timeline.subtitle_font_id || null;

  return {
    width,
    height,
    fps,
    duration,
    segments,
    cues,
    assetIds: [...new Set(segments.filter((s) => s.type === 'clip').map((s) => s.asset))],
    subtitle_font_id: subtitleFontId,
  };
}