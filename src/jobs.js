import fs from 'node:fs/promises';
import path from 'node:path';
import { JobError } from './errors.js';
import { fetchSource, removeSourceCopies, normalizeSources } from './sources.js';
import { buildPlan } from './render/plan.js';
import { probe, renderPlan } from './render/ffmpeg.js';
import { validateOutput } from './render/validate.js';
import { resolveFonts, extractFontIds } from './render/fonts.js';
import { renderMotion, motionPlanFrom, resolveRemotionConcurrency } from './render/motion.js';
import { timelineVersion, parseTimelineV2 } from './render/timelineV2.js';
import { renderTimelineV2, displaySize } from './render/renderV2.js';
import { mediaSummary, frameTimes, extractFrames, detectScenes, analyseAudio } from './analysis/media.js';
import { transcribe } from './analysis/transcribe.js';
import { cgroupMemory } from './resources.js';

/** Operations this worker actually performs. `subtitles` and `compile_timeline` are not implemented. */
export const SUPPORTED_OPERATIONS = new Set([
  'render_preview', 'render_master', 'render_motion', 'validate',
  'frame_extract', 'scene_detect', 'audio_analyse', 'transcribe',
]);
export const KNOWN_OPERATIONS = new Set([
  'transcribe', 'scene_detect', 'frame_extract', 'audio_analyse', 'subtitles',
  'compile_timeline', 'render_preview', 'render_master', 'render_motion', 'validate',
]);
export const RENDER_OPERATIONS = new Set(['render_preview', 'render_master', 'validate']);
export const ANALYSIS_OPERATIONS = new Set(['frame_extract', 'scene_detect', 'audio_analyse', 'transcribe']);
/** Runs alone: the speech model's memory and the renderer's do not fit side by side on a small host. */
export const EXCLUSIVE_OPERATIONS = new Set(['transcribe']);

// Progress budget: download 0–15%, encode 15–90%, validate 90–97%, upload 97–100%.
const stage = (from, to) => (fraction) => from + (to - from) * Math.min(1, Math.max(0, fraction));

const TIMEOUTS = {
  render: () => Number(process.env.RENDER_TIMEOUT_SECONDS || 3600),
  analysis: () => Number(process.env.ANALYSIS_TIMEOUT_SECONDS || 1800),
};

/** Downloads and probes every media source a plan needs; checks each against its role. */
async function fetchMedia({ job, ids, sources, dir, storage, config, signal, db, report, kinds }) {
  const files = {};
  for (const [i, assetId] of ids.entries()) {
    const entry = sources[assetId];
    if (!entry) throw new JobError('missing_source', `No source file was provided for asset ${assetId}.`);
    const file = path.join(dir, `source_${i}`);
    await fetchSource({ job, assetId, value: entry, file, storage, config, signal, db });

    let info;
    try {
      info = await probe(file);
    } catch {
      throw new JobError('invalid_source', `Source for asset ${assetId} is not a readable media file.`);
    }
    const hasVideo = info.streams?.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const hasAudio = info.streams?.some((s) => s.codec_type === 'audio');
    const need = kinds[assetId] || 'video';
    if (need === 'video' && !hasVideo) throw new JobError('invalid_source', `Source for asset ${assetId} has no video stream.`);
    if (need === 'audio' && !hasAudio) throw new JobError('invalid_source', `Source for asset ${assetId} has no audio stream.`);
    if (need === 'image') {
      const still = info.streams?.find((s) => s.codec_type === 'video');
      const ok = still && ['png', 'mjpeg', 'webp'].includes(still.codec_name) && still.width <= 12000 && still.height <= 12000;
      if (!ok) throw new JobError('invalid_source', `Image ${assetId} is not a PNG, JPEG or WebP image of a supported size.`);
    }
    files[assetId] = { path: file, hasAudio, info, display: displaySize(info), duration: Number(info.format?.duration) || 0 };
    await report?.((i + 1) / ids.length);
  }
  return files;
}

async function fontsFor(fontIds, config, jobId) {
  if (!fontIds.length || !config.fontResolverUrl || !config.serviceToken) return {};
  const result = await resolveFonts(fontIds, { appUrl: config.fontResolverUrl, serviceToken: config.serviceToken });
  if (result.errors.length) {
    // Report font resolution errors but don't fail — the renderer falls back to a default face
    console.warn('[job]', jobId, 'Font resolution errors:', JSON.stringify(result.errors));
  }
  return result.fonts;
}

/** Clip ranges checked against what the files really are, not what Base44 recorded. */
function checkRanges(plan, files) {
  const tol = Math.max(0.05, 1 / plan.fps);
  for (const clip of [...plan.segments.filter((s) => s.type === 'clip'), ...plan.music]) {
    const duration = files[clip.asset]?.duration || 0;
    if (duration && clip.sourceOut > duration + tol) {
      throw new JobError('source_range_out_of_bounds', `A clip reads to ${clip.sourceOut} s but source ${clip.asset} is ${Math.round(duration * 1000) / 1000} s long.`);
    }
  }
}

/** Stills from the finished file, at the moments overlays are fully on screen. */
function previewTimes(plan) {
  const times = new Set();
  for (const o of [...plan.overlays, ...plan.zooms]) {
    times.add(Math.round(Math.min(o.end - 0.05, o.start + Math.max(0.7, (o.end - o.start) / 2)) * 100) / 100);
    if (times.size >= 8) break;
  }
  if (!times.size) [0.25, 0.5, 0.75].forEach((f) => times.add(Math.round(plan.duration * f * 100) / 100));
  return [...times].filter((t) => t >= 0 && t < plan.duration).sort((a, b) => a - b);
}

async function uploadFrames(job, frames, sheet, storage) {
  const out = [];
  for (const frame of frames) {
    const key = `frames/${job.id}/f_${String(frame.index).padStart(3, '0')}.jpg`;
    await storage.put(key, frame.file, 'image/jpeg');
    out.push({ index: frame.index, time: frame.time, storage_key: key });
  }
  let contact = null;
  if (sheet) {
    contact = `frames/${job.id}/contact.jpg`;
    await storage.put(contact, sheet, 'image/jpeg');
  }
  return { frames: out, contact_sheet_key: contact };
}

export async function processJob(job, { db, storage, config, signal: cancelSignal }) {
  const dir = path.join(config.workDir, job.id);
  await fs.mkdir(dir, { recursive: true });

  let lastWrite = 0;
  let finished = false;
  const inFlight = new Set();

  const report = (value, force = false) => {
    if (finished) return Promise.resolve();
    const now = Date.now();
    if (!force && now - lastWrite < 1500) return Promise.resolve();
    lastWrite = now;
    const write = db.update(job.id, { progress: Number(value.toFixed(4)) })
      .catch(() => {})
      .finally(() => inFlight.delete(write));
    inFlight.add(write);
    return write;
  };

  /**
   * Writes the terminal row, and stops progress reporting before it does: a progress
   * tick still in flight when the render finishes would otherwise land afterwards and
   * leave a finished job showing a partial figure.
   */
  const finish = async (fields) => {
    finished = true;
    await Promise.allSettled([...inFlight]);
    return db.update(job.id, fields);
  };

  // A job that runs past its budget is stopped like a cancel, and failed as a timeout.
  const budget = (ANALYSIS_OPERATIONS.has(job.operation) ? TIMEOUTS.analysis() : TIMEOUTS.render()) * 1000;
  const timeout = AbortSignal.timeout(Math.max(10000, budget));
  const signal = AbortSignal.any([cancelSignal, timeout]);

  // What the motion renderer's own process did — kept for the failed row, where it is
  // the difference between "the browser was killed" and "the file was wrong".
  let motionEvidence = null;

  try {
    if (!SUPPORTED_OPERATIONS.has(job.operation)) {
      throw new JobError('unsupported_operation', `This worker does not perform "${job.operation}" yet.`);
    }

    if (ANALYSIS_OPERATIONS.has(job.operation)) {
      const result = await analyse(job, { dir, db, storage, config, signal, report });
      return finish({
        status: 'succeeded',
        progress: 1,
        result,
        error_code: null,
        error: null,
        completed_at: new Date(),
      });
    }

    // A motion job carries a composition instead of a timeline: no source media
    // to download, no FFmpeg plan — the composition is the whole render.
    const isMotion = job.operation === 'render_motion';
    const sources = isMotion ? {} : normalizeSources(job.inputs.sources || {});
    const version = isMotion ? 0 : timelineVersion(job.inputs.timeline);
    const preview = job.operation === 'render_preview';
    const plan = isMotion
      ? motionPlanFrom(job.inputs.composition)
      : version === 2
        ? parseTimelineV2(job.inputs.timeline, job.output_spec, { sources, preview })
        : buildPlan(job.inputs.timeline, job.output_spec, { preview });

    const download = stage(0, 0.15);
    const kinds = {};
    let fetchIds = isMotion ? [] : plan.assetIds;
    if (version === 2) {
      plan.audioAssetIds.forEach((id) => { if (!kinds[id]) kinds[id] = 'audio'; });
      plan.assetIds.forEach((id) => { kinds[id] = 'video'; });
      plan.imageAssetIds.forEach((id) => { kinds[id] = 'image'; });
      fetchIds = [...new Set([...plan.assetIds, ...plan.audioAssetIds, ...plan.imageAssetIds])];
    }
    const files = await fetchMedia({
      job, ids: fetchIds, sources, dir, storage, config, signal, db, kinds,
      report: (fraction) => report(download(fraction), true),
    });
    if (version === 2) checkRanges(plan, files);

    // Resolve font_id references to local font files before rendering
    const fontIds = isMotion ? [] : version === 2 ? [...plan.fontIds, plan.subtitle_font_id].filter(Boolean) : extractFontIds(plan);
    const fonts = await fontsFor(fontIds, config, job.id);

    const outFile = path.join(dir, 'output.mp4');
    const encode = stage(0.15, 0.9);
    const quality = job.operation === 'render_master' ? 'master' : 'preview';

    // Motion graphics render in Remotion; V2 timelines in the compositor; V1 in the FFmpeg pipeline.
    let motion = null;
    let engine = null;
    if (isMotion) {
      // Safe limit: a motion render needs a browser, and a container too small to hold
      // one is refused here — with the measured numbers — instead of being crashed into
      // by the host, attempt after attempt, until the job gives up.
      const memory = await cgroupMemory();
      if (memory.limit_bytes && memory.limit_bytes < config.motionMinMemoryBytes) {
        throw new JobError(
          'insufficient_memory',
          `This render was stopped before it started: the render host has ${memory.limit_mb} MB of memory and a motion render needs at least ${Math.round(config.motionMinMemoryBytes / (1024 * 1024))} MB. Nothing was rendered.`,
        );
      }
      motion = await renderMotion(job.inputs.composition, {
        outFile,
        workDir: dir,
        signal,
        onProgress: (fraction) => report(encode(fraction)).catch(() => {}),
      });
      motionEvidence = {
        mode: 'motion',
        concurrency: motion.concurrency,
        exit: motion.exit,
        host_memory: memory,
      };
    } else if (version === 2) {
      const images = Object.fromEntries(plan.imageAssetIds.map((id) => [id, files[id].path]));
      engine = await renderTimelineV2(plan, files, images, {
        outFile,
        workDir: dir,
        quality,
        signal,
        onProgress: (fraction) => report(encode(fraction)).catch(() => {}),
        fonts,
      });
    } else {
      await renderPlan(plan, files, {
        outFile,
        workDir: dir,
        quality,
        signal,
        onProgress: (fraction) => report(encode(fraction)).catch(() => {}),
        fonts,
      });
    }
    await report(0.9, true);

    const validation = await validateOutput(outFile, plan);
    if (motion) {
      validation.mode = 'motion';
      validation.engine = motion.engine;
      validation.motion = motion.verification;
      validation.exit = motion.exit;
      validation.concurrency = motion.concurrency;
    }
    let result = null;
    if (engine) {
      validation.schema_version = 2;
      validation.engine = engine;
      validation.rendered = {
        overlays: plan.overlays.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] || 0) + 1 }), {}),
        speaker_zooms: plan.zooms.length,
        transitions: plan.segments.filter((s) => s.type === 'clip' && s.transition !== 'cut').map((s) => s.transition),
        music_clips: plan.music.length,
        burned_cues: plan.cues.length,
      };
    }
    await report(0.97, true);
    if (!validation.passed) {
      return finish({
        status: 'failed',
        validation,
        diagnostics: motionEvidence,
        error_code: 'validation_failed',
        error: 'The rendered file did not pass validation.',
        completed_at: new Date(),
      });
    }

    // Output inspection: stills of the finished file where the overlays are on screen.
    if (engine) {
      const stillsDir = path.join(dir, 'stills');
      await fs.mkdir(stillsDir, { recursive: true });
      const { frames, sheet } = await extractFrames(outFile, previewTimes(plan), { dir: stillsDir, width: 540, signal });
      result = { preview: await uploadFrames(job, frames, sheet, storage) };
    }

    const key = `renders/${job.id}/output.mp4`;
    await storage.put(key, outFile, 'video/mp4');
    return finish({
      status: 'succeeded',
      progress: 1,
      output_key: key,
      output_duration: validation.actual.duration_seconds,
      validation,
      result,
      diagnostics: motionEvidence,
      error_code: null,
      error: null,
      completed_at: new Date(),
    });
  } catch (error) {
    const current = await db.get(job.id);
    if (cancelSignal.aborted || current?.status === 'canceled') {
      return finish({ status: 'canceled', diagnostics: motionEvidence, completed_at: new Date() });
    }
    if (timeout.aborted) {
      return finish({
        status: 'failed',
        error_code: 'timeout',
        error: `The job did not finish within ${Math.round(budget / 1000)} seconds and was stopped.`,
        diagnostics: motionEvidence,
        completed_at: new Date(),
      });
    }
    const safe = error instanceof JobError;
    if (!safe) console.error('[job]', job.id, error?.stack || error);

    // How the renderer's process ended travels with the failure, so the row says
    // whether the browser was killed (signal, exit code) or the file was bad.
    const evidence = error?.exit
      ? { ...(motionEvidence || { mode: 'motion' }), exit: error.exit }
      : motionEvidence;

    return finish({
      status: 'failed',
      error_code: safe ? error.code : 'internal_error',
      error: safe ? error.message : 'Rendering failed because of an internal worker error.',
      ...(safe && error.details ? { result: { errors: error.details } } : {}),
      ...(evidence
        ? {
            validation: {
              mode: evidence.mode || 'motion',
              exit: evidence.exit || null,
              concurrency: evidence.concurrency || resolveRemotionConcurrency(),
              host_memory: evidence.host_memory || null,
            },
          }
        : {}),
      diagnostics: evidence,
      completed_at: new Date(),
    });
  } finally {
    // Durable source copies are kept only while the job can still be retried
    // (an interrupted run, or an expired link that Base44 will refresh).
    const latest = await db.get(job.id).catch(() => null);
    if (latest && latest.status !== 'running' && latest.error_code !== 'source_expired') {
      await removeSourceCopies(job, storage);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Analysis jobs: one source (`inputs.asset_id`, default the only source), one result.
 * Every result carries `media` — the inspection of the file itself.
 */
async function analyse(job, { dir, db, storage, config, signal, report }) {
  const sources = normalizeSources(job.inputs.sources || {});
  const ids = Object.keys(sources);
  const assetId = job.inputs.asset_id || (ids.length === 1 ? ids[0] : null);
  if (!assetId || !sources[assetId]) throw new JobError('missing_source', 'inputs.asset_id must name one of the job\'s sources.');
  const params = job.inputs.params && typeof job.inputs.params === 'object' ? job.inputs.params : {};

  const need = job.operation === 'transcribe' || job.operation === 'audio_analyse' ? 'audio' : 'video';
  const files = await fetchMedia({
    job, ids: [assetId], sources, dir, storage, config, signal, db, kinds: { [assetId]: need },
    report: (f) => report(0.2 * f, true),
  });
  const file = files[assetId];
  const media = mediaSummary(file.info);
  const duration = media.duration_seconds;
  if (!duration) throw new JobError('invalid_source', `Source ${assetId} has no measurable duration.`);
  await report(0.25, true);

  if (job.operation === 'frame_extract') {
    const times = frameTimes(params, duration);
    const framesDir = path.join(dir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });
    const { frames, sheet } = await extractFrames(file.path, times, {
      dir: framesDir, width: params.width, contactSheet: params.contact_sheet !== false, signal,
    });
    await report(0.85, true);
    return { asset_id: assetId, media, ...(await uploadFrames(job, frames, sheet, storage)) };
  }
  if (job.operation === 'scene_detect') {
    return { asset_id: assetId, media, ...(await detectScenes(file.path, duration, { threshold: params.threshold, signal })) };
  }
  if (job.operation === 'audio_analyse') {
    return { asset_id: assetId, media, audio_profile: await analyseAudio(file.path, duration, { noiseDb: params.noise_db, minSilence: params.min_silence_seconds, signal }) };
  }
  // transcribe
  const transcript = await transcribe(file.path, { language: params.language, signal, threads: Number(process.env.ASR_THREADS || 2) });
  return { asset_id: assetId, media, ...transcript };
}
