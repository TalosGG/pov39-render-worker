import fs from 'node:fs';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JobError } from './errors.js';

/** Throws unless the URL is HTTPS on an allowlisted hostname (no IPs, no ports, no credentials). */
export function checkSourceUrl(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new JobError('invalid_source', 'A source URL is not valid.');
  }
  if (parsed.protocol !== 'https:') throw new JobError('invalid_source', 'Source URLs must use HTTPS.');
  if (parsed.username || parsed.password || parsed.port) throw new JobError('invalid_source', 'A source URL is not valid.');
  const host = parsed.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw new JobError('invalid_source', 'A source file is hosted somewhere this worker does not accept.');
  if (!allowedHosts.length || !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new JobError('invalid_source', 'A source file is hosted somewhere this worker does not accept.');
  }
  return parsed;
}

/** Streams a source file to disk. Redirects are refused, so the allowlist cannot be bypassed. */
export async function downloadTo(url, dest, { maxBytes, allowedHosts, signal }) {
  const parsed = checkSourceUrl(url, allowedHosts);

  let response;
  try {
    response = await fetch(parsed, {
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new JobError('source_unavailable', 'A source file could not be downloaded.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new JobError('source_expired', 'The link to a source file has expired. A fresh link is needed.');
  }
  if (!response.ok || !response.body) {
    throw new JobError('source_unavailable', `A source file could not be downloaded (HTTP ${response.status}).`);
  }
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    throw new JobError('source_too_large', 'A source file exceeds the size limit.');
  }

  let seen = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) return callback(new JobError('source_too_large', 'A source file exceeds the size limit.'));
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body), guard, fs.createWriteStream(dest));
  return seen;
}