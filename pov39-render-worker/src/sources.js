import { JobError } from './errors.js';
import { downloadTo } from './download.js';
import { belongsTo } from './keys.js';

/**
 * Fetches one source to disk. Order of preference:
 *  1. The durable copy from an earlier attempt of this same job (survives expired links and restarts).
 *  2. An original uploaded straight to this worker's bucket ({ storage_key }), checked against the job's workspace.
 *  3. A short-lived signed HTTPS link from an allowlisted origin, which is then copied for later attempts.
 */
export async function fetchSource({ job, assetId, value, file, storage, config, signal }) {
  const copyKey = `sources/${job.id}/${assetId}`;

  if (job.attempts > 1 && await storage.head(copyKey)) {
    await storage.download(copyKey, file, config.maxSourceBytes);
    return;
  }

  if (value && typeof value === 'object') {
    const key = value.storage_key;
    if (!belongsTo(key, job.inputs.workspace_id)) {
      throw new JobError('invalid_source', `Source for asset ${assetId} is not stored for this workspace.`);
    }
    try {
      await storage.download(key, file, config.maxSourceBytes);
    } catch (error) {
      if (error?.code === 'too_large') throw new JobError('source_too_large', 'A source file exceeds the size limit.');
      throw new JobError('source_unavailable', `Source for asset ${assetId} was not found in storage.`);
    }
    return;
  }

  if (typeof value !== 'string') throw new JobError('missing_source', `No source file was provided for asset ${assetId}.`);
  await downloadTo(value, file, { maxBytes: config.maxSourceBytes, allowedHosts: config.allowedSourceHosts, signal });
  await storage.put(copyKey, file, 'application/octet-stream');
}

/** Deletes the per-job source copies once a job can no longer be retried. */
export async function removeSourceCopies(job, storage) {
  for (const assetId of Object.keys(job.inputs?.sources || {})) {
    await storage.remove(`sources/${job.id}/${assetId}`);
  }
}