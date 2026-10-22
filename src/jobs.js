import fs from 'node:fs/promises';
import path from 'node:path';
import { JobError } from './errors.js';
import { fetchSource, removeSourceCopies } from './sources.js';
import { buildPlan } from './render/plan.js';
import { probe, renderPlan } from './render/ffmpeg.js';
import { validateOutput } from './render/validate.js';

/** Operations this worker actually performs. Analysis operations are not implemented yet. */
export const SUPPORTED_OPERATIONS = new Set(['render_preview', 'render_master', 'validate']);
export const KNOWN_OPERATIONS = new Set([
  'transcribe', 'scene_detect', 'frame_extract', 'audio_analyse', 'subtitles',
  'compile_timeline', 'render_preview', 'render_master', 'validate',
]);

// Progress budget: download 0–15%, encode 15–90%, validate 90–97%, upload 97–100%.
const stage = (from, to) => (fraction) => from + (to - from) * Math.min(1, Math.max(0, fraction));

export async function processJob(job, { db, storage, config, signal }) {
  const dir = path.join(config.workDir, job.id);
  await fs.mkdir(dir, { recursive: true });

  let lastWrite = 0;
  const report = async (value, force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 1500) return;
    lastWrite = now;
    await db.update(job.id, { progress: Number(value.toFixed(4)) });
  };

  try {
    if (!SUPPORTED_OPERATIONS.has(job.operation)) {
      throw new JobError('unsupported_operation', `This worker does not perform "${job.operation}" yet.`);
    }

    const plan = buildPlan(job.inputs.timeline, job.output_spec, { preview: job.operation === 'render_preview' });
    const sources = job.inputs.sources || {};

    const files = {};
    const download = stage(0, 0.15);
    for (const [i, assetId] of plan.assetIds.entries()) {
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

    const outFile = path.join(dir, 'output.mp4');
    const encode = stage(0.15, 0.9);
    await renderPlan(plan, files, {
      outFile,
      workDir: dir,
      quality: job.operation === 'render_master' ? 'master' : 'preview',
      signal,
      onProgress: (fraction) => report(encode(fraction)).catch(() => {}),
    });
    await report(0.9, true);

    const validation = await validateOutput(outFile, plan);
    await report(0.97, true);
    if (!validation.passed) {
      return db.update(job.id, {
        status: 'failed',
        validation,
        error_code: 'validation_failed',
        error: 'The rendered file did not pass validation.',
        completed_at: new Date(),
      });
    }

    const key = `renders/${job.id}/output.mp4`;
    await storage.put(key, outFile, 'video/mp4');
    return db.update(job.id, {
      status: 'succeeded',
      progress: 1,
      output_key: key,
      output_duration: validation.actual.duration_seconds,
      validation,
      error_code: null,
      error: null,
      completed_at: new Date(),
    });
  } catch (error) {
    const current = await db.get(job.id);
    if (signal.aborted || current?.status === 'canceled') {
      return db.update(job.id, { status: 'canceled', completed_at: new Date() });
    }
    const safe = error instanceof JobError;
    if (!safe) console.error('[job]', job.id, error?.stack || error);
    return db.update(job.id, {
      status: 'failed',
      error_code: safe ? error.code : 'internal_error',
      error: safe ? error.message : 'Rendering failed because of an internal worker error.',
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