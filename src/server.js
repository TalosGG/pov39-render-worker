import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { requireBearer } from './auth.js';
import { createDb } from './db.js';
import { createStorage } from './storage.js';
import { createQueue } from './queue.js';
import { SUPPORTED_OPERATIONS, RENDER_OPERATIONS } from './jobs.js';
import { capabilities, WORKER_VERSION } from './capabilities.js';
import { ffmpegVersion } from './render/ffmpeg.js';
import { isSafeId } from './keys.js';
import { timelineVersion } from './render/timelineV2.js';
import { JobError } from './errors.js';
import { createRequests, planSummary, requestHash } from './requests.js';
import { storageRoutes } from './storageRoutes.js';
import { resolveRemotionConcurrency } from './render/motion.js';
import { resourceSnapshot } from './resources.js';
import { sweepWorkDir, sweepBundles } from './cleanup.js';

const require = createRequire(import.meta.url);
const express = require('express');

const config = loadConfig();
const db = createDb(config.databaseUrl);
const storage = createStorage(config.s3);
const queue = createQueue({ db, storage, config });

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/**
 * How this process ends is evidence, and from the outside the possibilities look
 * identical: the job is simply left `running`. So each one says what it was, in its own
 * words — a platform stop (deploy, scale, health-check restart) announces itself, and an
 * unhandled error is logged with its stack — and the row is diagnosed on the next boot.
 */
process.on('SIGTERM', () => {
  console.log('[lifecycle] SIGTERM received — the platform is stopping this instance; a job in flight is recovered on boot');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('[lifecycle] uncaught exception:', error?.stack || error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[lifecycle] unhandled rejection:', reason instanceof Error ? reason.stack : String(reason));
  process.exit(1);
});

const { publicJob, validateSources, planTimeline, validateRequest } = createRequests({ db, storage, config });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Public liveness probe for the load balancer: reveals nothing about the service.
app.get('/health', (_req, res) => res.json({ ok: true }));

const auth = requireBearer(config.token);

app.get('/health/deep', auth, async (_req, res) => {
  const result = { database: false, storage: false, ffmpeg: '' };
  try { await db.pool.query('select 1'); result.database = true; } catch {}
  try { await storage.check(); result.storage = true; } catch {}
  try { result.ffmpeg = await ffmpegVersion(); } catch {}
  const caps = await capabilities();
  // Motion graphics are reported separately: a worker that edits footage but has no
  // browser is healthy for editing and unsuitable for "create from scratch".
  const ok = result.database && result.storage && Boolean(result.ffmpeg);
  res.status(ok ? 200 : 503).json({
    ok,
    ...result,
    version: WORKER_VERSION,
    operations: caps.operations,
    motion_ready: caps.motion.ready,
    motion: caps.motion,
    active_jobs: queue.active(),
    // How many jobs run at once, and how many frames a motion render draws at once:
    // both are limits this worker imposes on itself, so they are reported, not assumed.
    concurrency: config.concurrency,
    motion_concurrency: resolveRemotionConcurrency(),
    // The instance this is running on, measured from the container itself. A motion
    // render that cannot fit here is refused up front, which needs these numbers.
    resources: await resourceSnapshot(),
  });
});

// What this build can actually do. The app checks this before it charges anyone, so an
// incompatible renderer is refused up front instead of dispatched into a refusal.
app.get('/capabilities', auth, async (_req, res) => {
  try {
    res.json(await capabilities());
  } catch {
    res.status(500).json({ error: 'capabilities_unavailable' });
  }
});

// Timeline validation without rendering: the agent checks a plan before it asks for a render.
app.post('/timelines/validate', auth, async (req, res, next) => {
  try {
    const { timeline, output_spec: outputSpec = {}, sources = [], workspace_id: workspaceId } = req.body || {};
    if (!timeline || typeof timeline !== 'object') return res.status(400).json({ error: 'timeline is required.' });
    if (!isSafeId(workspaceId)) return res.status(400).json({ error: 'workspace_id is required.' });
    const problem = await validateSources(sources, workspaceId);
    if (problem) return res.status(400).json({ error: problem });
    try {
      const plan = planTimeline(timeline, outputSpec, sources, req.body.operation || 'render_master');
      const caps = await capabilities();
      const renderable = plan.version !== 2 || caps.timeline?.v2?.ready === true;
      res.json({ ok: true, renderable, ...(renderable ? {} : { reason: caps.timeline?.v2?.reason }), plan: planSummary(plan) });
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      res.status(422).json({ ok: false, error_code: error.code, error: error.message, error_details: error.details || [] });
    }
  } catch (error) {
    next(error);
  }
});

app.post('/jobs', auth, async (req, res, next) => {
  try {
    const refused = await validateRequest(req.body);
    if (refused) return res.status(refused.status).json(refused.body);
    if (!SUPPORTED_OPERATIONS.has(req.body.operation)) {
      return res.status(422).json({ error: `This worker does not perform "${req.body.operation}" yet.`, error_code: 'unsupported_operation' });
    }
    // Never accept work this image cannot do: the app must not charge for it.
    const caps = await capabilities();
    if (req.body.operation === 'transcribe' && !caps.analysis?.transcribe?.ready) {
      return res.status(422).json({ error: caps.analysis?.transcribe?.reason || 'Transcription is not available.', error_code: 'unsupported_operation' });
    }
    if (RENDER_OPERATIONS.has(req.body.operation) && timelineVersion(req.body.inputs.timeline) === 2 && !caps.timeline?.v2?.ready) {
      return res.status(422).json({ error: caps.timeline?.v2?.reason || 'Timeline V2 rendering is not available.', error_code: 'renderer_unavailable' });
    }
    const key = String(req.get('idempotency-key') || req.body.idempotency_key || '').slice(0, 200) || null;
    const hash = requestHash(req.body);
    const { job, created } = await db.insert({
      id: crypto.randomUUID(),
      idempotencyKey: key,
      operation: req.body.operation,
      inputs: req.body.inputs,
      outputSpec: req.body.output_spec || {},
      requestHash: hash,
    });
    if (!created && job.request_hash && job.request_hash !== hash) {
      return res.status(409).json({ error: 'This Idempotency-Key was already used for a different request.', error_code: 'idempotency_conflict', id: job.id });
    }
    if (created) queue.kick();
    res.status(created ? 202 : 200).json({ ...(await publicJob(job)), idempotent_replay: !created });
  } catch (error) {
    next(error);
  }
});

app.get('/jobs/:id', auth, async (req, res, next) => {
  try {
    const job = await db.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json(await publicJob(job));
  } catch (error) {
    next(error);
  }
});

app.post('/jobs/:id/cancel', auth, async (req, res, next) => {
  try {
    const job = await db.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (TERMINAL.has(job.status)) return res.json(await publicJob(job));
    const updated = await db.update(job.id, { status: 'canceled', completed_at: new Date() });
    queue.abort(job.id);
    res.json(await publicJob(updated));
  } catch (error) {
    next(error);
  }
});

// Fresh source links for a job whose links expired while it waited. Re-queues the same job,
// so no duplicate render is created.
app.post('/jobs/:id/sources', auth, async (req, res, next) => {
  try {
    const job = await db.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    const retryable = job.status === 'queued' || (job.status === 'failed' && job.error_code === 'source_expired');
    if (!retryable) return res.status(409).json({ error: 'This job cannot take new sources.', ...(await publicJob(job)) });
    const problem = await validateSources(req.body?.sources, job.inputs.workspace_id);
    if (problem) return res.status(400).json({ error: problem });
    const updated = await db.update(job.id, {
      inputs: { ...job.inputs, sources: req.body.sources },
      status: 'queued',
      progress: 0,
      error_code: null,
      error: null,
      completed_at: null,
    });
    queue.kick();
    res.json(await publicJob(updated));
  } catch (error) {
    next(error);
  }
});

app.use(auth, storageRoutes({ storage, config }));

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  console.error('[http]', error?.message);
  res.status(500).json({ error: 'internal_error' });
});

await db.migrate();

// What this container actually is. Printed on every boot: after a restart this line is
// the only record of the memory ceiling the host enforces, and it is what an
// out-of-memory kill is diagnosed against.
const boot = await resourceSnapshot();
console.log(
  `[boot] pov39-render-worker ${WORKER_VERSION} · cpus=${boot.cpus} · memory=${boot.memory.limit_mb || boot.memory.host_total_mb}MB limit, ${boot.memory.used_mb}MB in use · node=${boot.node} · motion concurrency=${resolveRemotionConcurrency()}`,
);

// A worker killed mid-render never cleans up after itself: the previous attempt's work
// directory and its Remotion bundle directory are still on disk, and on a small instance
// those are exactly the megabytes the next attempt needs. Nothing is running at boot.
const swept = await sweepWorkDir(config.workDir);
const bundles = await sweepBundles();
if (swept.length || bundles.length) {
  console.log(`[boot] cleared ${swept.length} leftover work dir(s), ${bundles.length} leftover bundle dir(s)`);
}

const interrupted = await db.recoverInterrupted({ ...boot, motion_concurrency: resolveRemotionConcurrency() });
if (interrupted) console.log(`[boot] ${interrupted} job(s) had been interrupted with the previous process`);

queue.start();
app.listen(config.port, () => console.log(`[pov39-render-worker] listening on ${config.port}`));