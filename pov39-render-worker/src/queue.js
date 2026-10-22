import { processJob } from './jobs.js';

/** Pulls queued jobs from the database, up to `concurrency` at a time. */
export function createQueue({ db, storage, config }) {
  const running = new Map();

  async function tick() {
    while (running.size < config.concurrency) {
      const job = await db.claimNext();
      if (!job) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      processJob(job, { db, storage, config, signal: controller.signal })
        .catch((error) => console.error('[queue] job crashed', job.id, error?.message))
        .finally(() => {
          running.delete(job.id);
          kick();
        });
    }
  }

  function kick() {
    tick().catch((error) => console.error('[queue] tick failed', error?.message));
  }

  return {
    kick,
    active: () => running.size,
    abort(id) {
      running.get(id)?.abort();
    },
    start() {
      setInterval(kick, 5000).unref();
      kick();
    },
  };
}