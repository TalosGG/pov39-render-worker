import { processJob, EXCLUSIVE_OPERATIONS } from './jobs.js';

/**
 * Pulls queued jobs from the database, up to `concurrency` at a time. An exclusive job
 * (transcription) only starts on an idle worker, and nothing starts beside it.
 */
export function createQueue({ db, storage, config }) {
  const running = new Map();
  const exclusive = [...EXCLUSIVE_OPERATIONS];

  async function tick() {
    while (running.size < config.concurrency) {
      if ([...running.values()].some((entry) => EXCLUSIVE_OPERATIONS.has(entry.operation))) return;
      const job = await db.claimNext({ exclude: running.size ? exclusive : [] });
      if (!job) return;
      const controller = new AbortController();
      running.set(job.id, { controller, operation: job.operation });
      processJob(job, { db, storage, config, signal: controller.signal })
        .catch((error) => console.error('[queue] job crashed', job.id, error?.message))
        .finally(() => {
          running.delete(job.id);
          kick();
        });
      if (EXCLUSIVE_OPERATIONS.has(job.operation)) return;
    }
  }

  function kick() {
    tick().catch((error) => console.error('[queue] tick failed', error?.message));
  }

  return {
    kick,
    active: () => running.size,
    abort(id) {
      running.get(id)?.controller.abort();
    },
    start() {
      setInterval(kick, 5000).unref();
      kick();
    },
  };
}
