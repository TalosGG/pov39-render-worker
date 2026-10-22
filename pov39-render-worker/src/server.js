import crypto from 'node:crypto';
import express from 'express';
import { loadConfig } from './config.js';
import { requireBearer } from './auth.js';
import { createDb } from './db.js';
import { createStorage } from './storage.js';
import { createQueue } from './queue.js';
import { KNOWN_OPERATIONS, SUPPORTED_OPERATIONS } from './jobs.js';
import { ffmpegVersion } from './render/ffmpeg.js';
import { checkSourceUrl } from './download.js';
import { isSafeId, belongsTo } from './keys.js';
import { storageRoutes } from './storageRoutes.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const storage = createStorage(config.s3);
const queue = createQueue({ db, storage, config });

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** Never returns inputs (they contain signed source URLs) or storage credentials. */
async function publicJob(job) {
  const outputs = [];
  if (job.status === 'succeeded' && job.output_key) {
    outputs.push({
      kind: 'video',
      storage_key: job.output_key,
      file_url: await storage.signedGet(job.output_key, config.downloadUrlTtl),
      url_expires_in: config.downloadUrlTtl,
      duration_seconds: job.output_duration || 0,
    });
  }
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
  };
}

/** Each source is either an allowlisted HTTPS link or a key under this workspace's upload prefix. */
function validateSources(sources, workspaceId) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return 'inputs.sources must map asset ids to sources.';
  for (const [assetId, value] of Object.entries(sources)) {
    if (!isSafeId(assetId)) return 'Source asset ids are invalid.';
    if (value && typeof value === 'object') {
      if (!belongsTo(value.storage_key, workspaceId)) return 'A source storage key is not valid for this workspace.';
      continue;
    }
    if (typeof value !== 'string' || value.length > 4000) return 'Every source must be an HTTPS URL or a storage key.';
    try {
      checkSourceUrl(value, config.allowedSourceHosts);
    } catch (error) {
      return error.message;
    }
  }
  return '';
}

function validateRequest(body) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  if (!KNOWN_OPERATIONS.has(body.operation)) return 'Unknown operation.';
  if (!body.inputs || typeof body.inputs !== 'object') return 'inputs must be an object.';
  if (SUPPORTED_OPERATIONS.has(body.operation)) {
    if (!body.inputs.timeline || typeof body.inputs.timeline !== 'object') return 'inputs.timeline is required.';
    if (!isSafeId(body.inputs.workspace_id)) return 'inputs.workspace_id is required.';
    const problem = validateSources(body.inputs.sources, body.inputs.workspace_id);
    if (problem) return problem;
  }
  if (body.output_spec !== undefined && (typeof body.output_spec !== 'object' || Array.isArray(body.output_spec))) {
    return 'output_spec must be an object.';
  }
  return '';
}

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
  const ok = result.database && result.storage && Boolean(result.ffmpeg);
  res.status(ok ? 200 : 503).json({ ok, ...result, active_jobs: queue.active(), concurrency: config.concurrency });
});

app.post('/jobs', auth, async (req, res, next) => {
  try {
    const problem = validateRequest(req.body);
    if (problem) return res.status(400).json({ error: problem });
    if (!SUPPORTED_OPERATIONS.has(req.body.operation)) {
      return res.status(422).json({ error: `This worker does not perform "${req.body.operation}" yet.`, error_code: 'unsupported_operation' });
    }
    const key = String(req.get('idempotency-key') || req.body.idempotency_key || '').slice(0, 200) || null;
    const { job, created } = await db.insert({
      id: crypto.randomUUID(),
      idempotencyKey: key,
      operation: req.body.operation,
      inputs: req.body.inputs,
      outputSpec: req.body.output_spec || {},
    });
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
    const problem = validateSources(req.body?.sources, job.inputs.workspace_id);
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
await db.recoverInterrupted();
queue.start();
app.listen(config.port, () => console.log(`[pov39-render-worker] listening on ${config.port}`));