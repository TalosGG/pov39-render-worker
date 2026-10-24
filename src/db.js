import { createRequire } from 'node:module';

// Loaded at runtime, never as a bare import: this worker's dependencies are Node
// packages, and a bare specifier here gets resolved by any browser-side module graph that
// touches the file (the app's dev server scans the repository the worker lives in).
const require = createRequire(import.meta.url);
const pg = require('pg');

const MAX_ATTEMPTS = 3;

export function createDb(url) {
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: local ? false : { rejectUnauthorized: false } });

  return {
    pool,

    async migrate() {
      await pool.query(`create table if not exists render_jobs (
        id text primary key,
        idempotency_key text unique,
        operation text not null,
        status text not null default 'queued',
        progress real not null default 0,
        inputs jsonb not null,
        output_spec jsonb not null default '{}',
        output_key text,
        output_duration real,
        validation jsonb,
        error_code text,
        error text,
        attempts int not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz
      )`);
      await pool.query('create index if not exists render_jobs_queue_idx on render_jobs (status, created_at)');
    },

    /** Inserts once per idempotency key; a repeat returns the existing job. */
    async insert({ id, idempotencyKey, operation, inputs, outputSpec }) {
      const inserted = await pool.query(
        `insert into render_jobs (id, idempotency_key, operation, inputs, output_spec)
         values ($1, $2, $3, $4, $5) on conflict (idempotency_key) do nothing returning *`,
        [id, idempotencyKey, operation, inputs, outputSpec],
      );
      if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
      const existing = await pool.query('select * from render_jobs where idempotency_key = $1', [idempotencyKey]);
      return { job: existing.rows[0], created: false };
    },

    async get(id) {
      const result = await pool.query('select * from render_jobs where id = $1', [id]);
      return result.rows[0] || null;
    },

    async update(id, fields) {
      const keys = Object.keys(fields);
      const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      const result = await pool.query(
        `update render_jobs set ${sets}, updated_at = now() where id = $1 returning *`,
        [id, ...keys.map((key) => fields[key])],
      );
      return result.rows[0];
    },

    /** Atomically claims the oldest queued job (safe with several workers on one database). */
    async claimNext() {
      const result = await pool.query(`update render_jobs
        set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()), updated_at = now()
        where id = (select id from render_jobs where status = 'queued' order by created_at for update skip locked limit 1)
        returning *`);
      return result.rows[0] || null;
    },

    /** On boot: jobs left running by a crashed process go back to the queue, up to MAX_ATTEMPTS. */
    async recoverInterrupted() {
      await pool.query(
        `update render_jobs set
           status = case when attempts >= $1 then 'failed' else 'queued' end,
           error_code = case when attempts >= $1 then 'worker_interrupted' else error_code end,
           error = case when attempts >= $1 then 'The worker stopped repeatedly while rendering this job.' else error end,
           progress = 0, updated_at = now()
         where status = 'running'`,
        [MAX_ATTEMPTS],
      );
    },
  };
}