import crypto from 'node:crypto';
import { KNOWN_OPERATIONS, SUPPORTED_OPERATIONS, ANALYSIS_OPERATIONS } from './jobs.js';
import { isSafeId } from './keys.js';
import { normalizeSources, checkSources } from './sources.js';
import { timelineVersion, parseTimelineV2 } from './render/timelineV2.js';
import { buildPlan } from './render/plan.js';
import { JobError } from './errors.js';

/**
 * Request validation and response shaping for the HTTP API, kept apart from the server
 * so they can be tested against the exact Base44 payloads without a database or bucket.
 * `db` needs only `get`, `storage` only `signedGet`.
 */
export function createRequests({ db, storage, config }) {
  const sign = (key) => storage.signedGet(key, config.downloadUrlTtl);

  /** Frame stills with short-lived links (frame_extract output, or a V2 render's preview stills). */
  async function signedFrames(set) {
    if (!set?.frames) return null;
    return {
      frames: await Promise.all(set.frames.map(async (f) => ({ ...f, file_url: await sign(f.storage_key) }))),
      contact_sheet: set.contact_sheet_key ? { storage_key: set.contact_sheet_key, file_url: await sign(set.contact_sheet_key) } : null,
    };
  }

  /** Never returns inputs (they contain signed source URLs) or storage credentials. */
  async function publicJob(job) {
    const outputs = [];
    const result = job.result || {};
    const extra = {};
    if (job.status === 'succeeded' && job.output_key) {
      outputs.push({
        kind: 'video',
        storage_key: job.output_key,
        file_url: await sign(job.output_key),
        url_expires_in: config.downloadUrlTtl,
        duration_seconds: job.output_duration || 0,
      });
    }
    if (job.status === 'succeeded') {
      const stills = await signedFrames(result.preview || (job.operation === 'frame_extract' ? result : null));
      if (stills) {
        outputs.push({ kind: 'frames', frames: stills.frames, contact_sheet: stills.contact_sheet, url_expires_in: config.downloadUrlTtl });
        if (job.operation === 'frame_extract') extra.frames = stills.frames;
        else extra.preview_frames = stills.frames;
      }
      if (result.media) extra.media = result.media;
      if (job.operation === 'transcribe') {
        Object.assign(extra, {
          transcript: result.transcript || '',
          language: result.language || '',
          language_source: result.language_source || '',
          segments: result.segments || [],
          word_timestamps: false,
        });
      }
      if (job.operation === 'scene_detect') Object.assign(extra, { scenes: result.scenes || [], scene_threshold: result.threshold });
      if (job.operation === 'audio_analyse') extra.audio_profile = result.audio_profile || {};
    }
    if (job.status === 'failed' && Array.isArray(result.errors)) extra.error_details = result.errors;
    return {
      id: job.id,
      operation: job.operation,
      status: job.status,
      progress: job.progress,
      outputs,
      validation: job.validation || {},
      error_code: job.error_code || '',
      error: job.error || '',
      attempts: job.attempts,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      ...extra,
    };
  }

  /** Whether a finished render belongs to this workspace (a render can be inspected or re-cut by its owner). */
  async function ownsRender(jobId, workspaceId) {
    const owner = await db.get(jobId).catch(() => null);
    return Boolean(owner && owner.status === 'succeeded' && owner.inputs?.workspace_id === workspaceId);
  }

  /**
   * Each source is a key under this workspace's upload prefix, a finished render this
   * workspace owns, or an allowlisted HTTPS link. Accepts the Base44 array shape and the
   * legacy map. Returns '' or a safe message.
   */
  async function validateSources(sources, workspaceId) {
    let normalized;
    try {
      normalized = normalizeSources(sources);
    } catch (error) {
      return error.message;
    }
    return checkSources(normalized, workspaceId, { allowedHosts: config.allowedSourceHosts, ownsRender });
  }

  /**
   * The worker's verdict on a timeline before any media is touched: V2 is parsed against
   * the job's own sources (every clip and image must resolve), V1 through the V1 planner.
   * Throws JobError with every problem in `details`.
   */
  function planTimeline(timeline, outputSpec, sources, operation) {
    const version = timelineVersion(timeline);
    const preview = operation === 'render_preview';
    if (version === 2) return parseTimelineV2(timeline, outputSpec, { sources: normalizeSources(sources || []), preview });
    return { version: 1, ...buildPlan(timeline, outputSpec, { preview }) };
  }

  /** Returns null or { status, body } describing why the request is refused. */
  async function validateRequest(body) {
    const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
    if (!body || typeof body !== 'object') return bad('Body must be a JSON object.');
    if (!KNOWN_OPERATIONS.has(body.operation)) return bad('Unknown operation.');
    if (!body.inputs || typeof body.inputs !== 'object') return bad('inputs must be an object.');
    if (body.output_spec !== undefined && (typeof body.output_spec !== 'object' || Array.isArray(body.output_spec))) {
      return bad('output_spec must be an object.');
    }
    if (!SUPPORTED_OPERATIONS.has(body.operation)) return null;

    if (body.operation === 'render_motion') {
      // Motion graphics are rendered from a composition: no timeline, no sources.
      const composition = body.inputs.composition;
      if (!composition || typeof composition !== 'object' || Array.isArray(composition)) return bad('inputs.composition is required.');
      if (!Array.isArray(composition.scenes) || !composition.scenes.length) return bad('inputs.composition needs at least one scene.');
      if (JSON.stringify(composition).length > 200000) return bad('inputs.composition is too large.');
      if (!isSafeId(body.inputs.workspace_id)) return bad('inputs.workspace_id is required.');
      return null;
    }

    if (!isSafeId(body.inputs.workspace_id)) return bad('inputs.workspace_id is required.');
    const problem = await validateSources(body.inputs.sources, body.inputs.workspace_id);
    if (problem) return bad(problem);

    if (ANALYSIS_OPERATIONS.has(body.operation)) {
      if (body.inputs.asset_id !== undefined && !isSafeId(body.inputs.asset_id)) return bad('inputs.asset_id is invalid.');
      if (body.inputs.params !== undefined && (typeof body.inputs.params !== 'object' || Array.isArray(body.inputs.params))) {
        return bad('inputs.params must be an object.');
      }
      return null;
    }

    if (!body.inputs.timeline || typeof body.inputs.timeline !== 'object') return bad('inputs.timeline is required.');
    try {
      planTimeline(body.inputs.timeline, body.output_spec, body.inputs.sources, body.operation);
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      return bad(error.message, 422, { error_code: error.code, error_details: error.details || [] });
    }
    return null;
  }

  return { publicJob, validateSources, planTimeline, validateRequest };
}

export function planSummary(plan) {
  if (plan.version !== 2) {
    return { schema_version: 1, width: plan.width, height: plan.height, fps: plan.fps, duration_seconds: plan.duration, segments: plan.segments.length, burned_cues: plan.cues.length };
  }
  return {
    schema_version: 2,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration_seconds: plan.duration,
    clips: plan.segments.filter((s) => s.type === 'clip').length,
    gaps: plan.segments.filter((s) => s.type === 'gap').length,
    transitions: plan.segments.filter((s) => s.type === 'clip' && s.transition !== 'cut').map((s) => s.transition),
    overlays: plan.overlays.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] || 0) + 1 }), {}),
    speaker_zooms: plan.zooms.length,
    music_clips: plan.music.length,
    burned_cues: plan.cues.length,
    required_assets: { video: plan.assetIds, audio: plan.audioAssetIds, image: plan.imageAssetIds },
    notes: plan.notes,
  };
}

/**
 * What a request asks for, without the signed links (they change on every retry): a
 * reused Idempotency-Key with a different request is a conflict, not a replay.
 */
export function requestHash(body) {
  let sources = [];
  try {
    sources = Object.entries(normalizeSources(body.inputs?.sources || {}))
      .map(([id, s]) => [id, s.storage_key || '', s.kind]).sort();
  } catch {
    sources = [];
  }
  const { sources: _omit, ...inputs } = body.inputs || {};
  return crypto.createHash('sha256').update(JSON.stringify([body.operation, inputs, body.output_spec || {}, sources])).digest('hex');
}
