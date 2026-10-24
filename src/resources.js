import fs from 'node:fs/promises';
import os from 'node:os';

/**
 * What the container this worker runs in actually has.
 *
 * A motion render is limited by the browser's memory, not by its CPU, so the worker
 * measures its own memory ceiling and its own usage instead of assuming either. The
 * cgroup files are the only place that carries the limit the host actually enforces;
 * the kernel's own numbers are reported alongside them so a limit of "the whole host"
 * can be told apart from a real container limit.
 */

const PAGE_SIZE = 4096;

async function readFirst(paths) {
  for (const target of paths) {
    try {
      const value = (await fs.readFile(target, 'utf8')).trim();
      if (value) return value;
    } catch {
      // The file does not exist on this kernel or cgroup version: try the next one.
    }
  }
  return '';
}

function parseBytes(value) {
  if (!value || value === 'max') return 0;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** Memory this container may use, what it is using now, and the highest it has reached. */
export async function cgroupMemory() {
  const limit = parseBytes(await readFirst([
    '/sys/fs/cgroup/memory.max', // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
  ]));
  const used = parseBytes(await readFirst([
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  ]));
  const peak = parseBytes(await readFirst([
    '/sys/fs/cgroup/memory.peak',
    '/sys/fs/cgroup/memory/memory.max_usage_in_bytes',
  ]));

  const hostTotal = os.totalmem();
  const bounded = limit && limit < hostTotal * 0.9;

  return {
    limit_bytes: bounded ? limit : 0,
    limit_mb: bounded ? Math.round(limit / 1024 / 1024) : 0,
    used_mb: Math.round(used / 1024 / 1024),
    peak_mb: peak ? Math.round(peak / 1024 / 1024) : 0,
    host_total_mb: Math.round(hostTotal / 1024 / 1024),
    host_free_mb: Math.round(os.freemem() / 1024 / 1024),
  };
}

/**
 * Resident memory of a whole process group: the renderer script and every Chromium it
 * spawned. The parent's own RSS says nothing about what the browser costs, and the
 * browser is what the host kills the container for.
 */
export async function processGroupRss(pid) {
  if (!pid) return 0;
  const entries = await fs.readdir('/proc').catch(() => []);
  const sizes = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          // 0 state · 1 ppid · 2 pgrp · … · 21 rss (pages)
          if (Number(fields[2]) !== pid) return 0;
          return Number(fields[21]) * PAGE_SIZE;
        } catch {
          return 0;
        }
      }),
  );
  return sizes.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

/** What this worker is running on, for the health endpoint and the boot log. */
export async function resourceSnapshot() {
  return {
    cpus: os.cpus().length,
    node: process.version,
    worker_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    memory: await cgroupMemory(),
  };
}