import fs from 'node:fs/promises';
import path from 'node:path';
import { JobError } from './errors.js';
import { fetchSource, removeSourceCopies } from './sources.js';
import { buildPlan } from './render/plan.js';
import { probe, renderPlan } from './render/ffmpeg.js';
import { validateOutput } from './render/validate.js';
import { resolveFonts, extractFontIds } from './render/fonts.js';
import { renderMotion, motionPlanFrom, resolveRemotionConcurrency } from './render/motion.js';
import { cgroupMemory } from './resources.js';

/** Operations this worker actually performs. Analysis operations are not implemented yet. */
export const SUPPORTED_OPERATIONS = new Set(['render_preview', 'render_master', 'render_motion', 'validate']);
export const KNOWN_OPERATIONS = new Set([
  'transcribe', 'scene_detect', 'frame_extract', 'audio_analyse', 'subtitles',
  'compile_timeline', 'render_preview', 'render_master', 'render_motion', 'validate',
]);

// Progress budget: download 0–15%, encode 15–90%, validate 90–97%, upload 97–100%.
const stage = (from, to) => (fraction) => from + (to - from) * Math.min(1, Math.max(0, fraction));

export async function processJob(job, { db, storage, config, signal }) {
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

  // What the motion renderer's own process did — kept for the failed row, where it is
  // the difference between "the browser was killed" and "the file was wrong".
  let motionEvidence = null;

  try {
    if (!SUPPORTED_OPERATIONS.has(job.operation)) {
      throw new JobError('unsupported_operation', `This worker does not perform "${job.operation}" yet.`);
    }

    // A motion job carries a composition instead of a timeline: no source media
    // to download, no FFmpeg plan — the composition is the whole render.
    const isMotion = job.operation === 'render_motion';
    const plan = isMotion
      ? motionPlanFrom(job.inputs.composition)
      : buildPlan(job.inputs.timeline, job.output_spec, { preview: job.operation === 'render_preview' });
    const sources = job.inputs.sources || {};

    const files = {};
    const download = stage(0, 0.15);
    for (const [i, assetId] of (isMotion ? [] : plan.assetIds).entries()) {
      const url = sources[assetId];
      if (!url) throw new JobError('missing_source', `No source file was provided for asset ${assetId}.`);
      const file = path.join(dir, `source_${i}`);
      await fetchSource({ job, assetId, value: url, file, storage, config, signal });

      let info;
      try {
        info = await probe(file);
      } catch {
        throw new JobError('invalid_source', `Source for asset ${assetId} is not a readable media file.`);
      }
      if (!info.streams?.some((s) => s.codec_type === 'video')) {
        throw new JobError('invalid_source', `Source for asset ${assetId} has no video stream.`);
      }
      files[assetId] = { path: file, hasAudio: info.streams.some((s) => s.codec_type === 'audio') };
      await report(download((i + 1) / plan.assetIds.length), true);
    }

    // Resolve font_id references to local font files before rendering
    const fontIds = isMotion ? [] : extractFontIds(plan);
    let fonts = {};
    if (fontIds.length && config.fontResolverUrl && config.serviceToken) {
      const result = await resolveFonts(fontIds, {
        appUrl: config.fontResolverUrl,
        serviceToken: config.serviceToken,
      });
      fonts = result.fonts;
      if (result.errors.length) {
        // Report font resolution errors but don't fail — the renderer falls back to Noto Sans
        console.warn('[job]', job.id, 'Font resolution errors:', JSON.stringify(result.errors));
      }
    }

    const outFile = path.join(dir, 'output.mp4');
    const encode = stage(0.15, 0.9);

    // Motion graphics render in Remotion; every other operation is the FFmpeg pipeline.
    let motion = null;
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
    } else {
      await renderPlan(plan, files, {
        outFile,
        workDir: dir,
        quality: job.operation === 'render_master' ? 'master' : 'preview',
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

    const key = `renders/${job.id}/output.mp4`;
    await storage.put(key, outFile, 'video/mp4');
    return finish({
      status: 'succeeded',
      progress: 1,
      output_key: key,
      output_duration: validation.actual.duration_seconds,
      validation,
      diagnostics: motionEvidence,
      error_code: null,
      error: null,
      completed_at: new Date(),
    });
  } catch (error) {
    const current = await db.get(job.id);
    if (signal.aborted || current?.status === 'canceled') {
      return finish({ status: 'canceled', diagnostics: motionEvidence, completed_at: new Date() });
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