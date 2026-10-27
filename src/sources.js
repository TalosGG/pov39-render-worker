import { JobError } from './errors.js';
import { downloadTo, checkSourceUrl } from './download.js';
import { belongsTo, isSafeId, renderJobId } from './keys.js';

const KINDS = new Set(['video', 'image', 'audio']);

/**
 * One shape for every way a job names its media:
 *
 *  - Base44 mediaPipeline (array):  [{ asset_id, storage_key, url, duration_seconds, width, height, kind }]
 *  - legacy map:                    { <asset_id>: "https://…signed…" | { storage_key } }
 *
 * Returns { [assetId]: { url, storage_key, kind, duration_seconds, width, height } } or throws.
 */
export function normalizeSources(raw) {
  const out = {};
  const add = (assetId, value) => {
    if (!isSafeId(assetId)) throw new JobError('invalid_source', 'Source asset ids are invalid.');
    if (Object.hasOwn(out, assetId)) throw new JobError('invalid_source', `Source ${assetId} is listed twice.`);
    const entry = typeof value === 'string' ? { url: value } : value;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new JobError('invalid_source', 'Every source must be an HTTPS URL or a storage key.');
    }
    const kind = entry.kind === undefined || entry.kind === null || entry.kind === '' ? 'video' : String(entry.kind);
    if (!KINDS.has(kind)) throw new JobError('invalid_source', `Source ${assetId} has an unknown kind.`);
    const duration = Number(entry.duration_seconds);
    out[assetId] = {
      url: typeof entry.url === 'string' && entry.url ? entry.url : null,
      storage_key: typeof entry.storage_key === 'string' && entry.storage_key ? entry.storage_key : null,
      kind,
      duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: Number(entry.width) || null,
      height: Number(entry.height) || null,
    };
  };

  if (Array.isArray(raw)) {
    if (raw.length > 400) throw new JobError('invalid_source', 'Too many sources.');
    for (const item of raw) add(item?.asset_id, item);
  } else if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw);
    if (entries.length > 400) throw new JobError('invalid_source', 'Too many sources.');
    for (const [assetId, value] of entries) add(assetId, value);
  } else {
    throw new JobError('invalid_source', 'inputs.sources must list the job\'s media.');
  }
  return out;
}

/**
 * Checks that each source can be read by this job without trusting the caller:
 * a storage key must sit under this workspace's upload prefix (or be the output of a
 * render this workspace owns, checked by `ownsRender`), otherwise an HTTPS link must be
 * on the allowlist. Returns '' or a safe message.
 */
export async function checkSources(sources, workspaceId, { allowedHosts, ownsRender }) {
  for (const [assetId, entry] of Object.entries(sources)) {
    if (entry.url && entry.url.length > 4000) return 'A source URL is too long.';
    if (entry.storage_key && belongsTo(entry.storage_key, workspaceId)) continue;
    const renderId = renderJobId(entry.storage_key);
    if (renderId) {
      if (await ownsRender(renderId, workspaceId)) continue;
      return `Source ${assetId} is a render this workspace does not own.`;
    }
    if (!entry.url) return `Source ${assetId} has neither a storage key in this workspace nor a link.`;
    try {
      checkSourceUrl(entry.url, allowedHosts);
    } catch (error) {
      return error.message;
    }
  }
  return '';
}

/**
 * Fetches one source to disk. Order of preference:
 *  1. The durable copy from an earlier attempt of this same job (survives expired links and restarts).
 *  2. An object in this worker's bucket: an upload under the job's workspace, or the output of a
 *     render the same workspace owns.
 *  3. A short-lived signed HTTPS link from an allowlisted origin, which is then copied for later attempts.
 */
export async function fetchSource({ job, assetId, value, file, storage, config, signal, db }) {
  const copyKey = `sources/${job.id}/${assetId}`;
  const entry = typeof value === 'string' ? { url: value } : value || {};
  const maxBytes = entry.kind === 'image' ? config.maxImageBytes : config.maxSourceBytes;

  if (job.attempts > 1 && await storage.head(copyKey)) {
    await storage.download(copyKey, file, maxBytes);
    return;
  }

  const workspaceId = job.inputs.workspace_id;
  const renderId = renderJobId(entry.storage_key);
  let fromBucket = belongsTo(entry.storage_key, workspaceId);
  if (renderId) {
    const owner = db ? await db.get(renderId).catch(() => null) : null;
    if (!owner || owner.inputs?.workspace_id !== workspaceId || owner.status !== 'succeeded') {
      throw new JobError('invalid_source', `Source for asset ${assetId} is not a finished render of this workspace.`);
    }
    fromBucket = true;
  }

  if (fromBucket) {
    try {
      await storage.download(entry.storage_key, file, maxBytes);
    } catch (error) {
      if (error?.code === 'too_large') throw new JobError('source_too_large', 'A source file exceeds the size limit.');
      throw new JobError('source_unavailable', `Source for asset ${assetId} was not found in storage.`);
    }
    return;
  }

  if (!entry.url) {
    if (entry.storage_key) throw new JobError('invalid_source', `Source for asset ${assetId} is not stored for this workspace.`);
    throw new JobError('missing_source', `No source file was provided for asset ${assetId}.`);
  }
  await downloadTo(entry.url, file, { maxBytes, allowedHosts: config.allowedSourceHosts, signal });
  await storage.put(copyKey, file, 'application/octet-stream');
}

/** Deletes the per-job source copies once a job can no longer be retried. */
export async function removeSourceCopies(job, storage) {
  let ids = [];
  try {
    ids = Object.keys(normalizeSources(job.inputs?.sources || {}));
  } catch {
    ids = [];
  }
  for (const assetId of ids) {
    await storage.remove(`sources/${job.id}/${assetId}`);
  }
}
