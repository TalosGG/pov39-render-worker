import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Remove what a previous run left behind.
 *
 * A worker that is killed mid-render never reaches its own cleanup, so that attempt's
 * temporary directory and its Remotion bundle directory stay on disk — and on a small
 * instance those are exactly the hundreds of megabytes that decide whether the next
 * attempt fits. On boot nothing is running, so everything under the work directory and
 * every finished bundle directory can go; a re-queued job re-downloads what it needs.
 */

export async function sweepWorkDir(workDir) {
  const entries = await fs.readdir(workDir).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    try {
      await fs.rm(path.join(workDir, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // A directory that cannot be removed is reported by its absence, not by failing boot.
    }
  }
  return removed;
}

/** Remotion bundle directories land in the system temp directory, not the work directory. */
export async function sweepBundles() {
  const prefix = 'pov39-motion-bundle-';
  const entries = await fs.readdir(os.tmpdir()).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Same again: a stale bundle is worth less than a worker that boots.
    }
  }
  return removed;
}