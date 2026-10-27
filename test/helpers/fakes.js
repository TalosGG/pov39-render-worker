import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** In-memory stand-in for the Postgres job store (the subset processJob uses). */
export function fakeDb() {
  const rows = new Map();
  return {
    rows,
    add(job) {
      const row = { status: 'running', attempts: 1, progress: 0, output_spec: {}, ...job, id: job.id || crypto.randomUUID() };
      rows.set(row.id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ? { ...rows.get(id) } : null;
    },
    async update(id, fields) {
      const row = { ...rows.get(id), ...fields };
      rows.set(id, row);
      return { ...row };
    },
  };
}

/** A private bucket on local disk: keys map to files under `root`. */
export function fakeStorage(root) {
  const file = (key) => path.join(root, ...key.split('/'));
  return {
    root,
    async seed(key, source) {
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.copyFile(source, file(key));
      return key;
    },
    async put(key, src) {
      await fs.mkdir(path.dirname(file(key)), { recursive: true });
      await fs.copyFile(src, file(key));
      return { key };
    },
    async download(key, dest, maxBytes) {
      const stat = await fs.stat(file(key)).catch(() => null);
      if (!stat) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (stat.size > maxBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
      await fs.copyFile(file(key), dest);
    },
    async head(key) {
      const stat = await fs.stat(file(key)).catch(() => null);
      return stat ? { size: stat.size, contentType: '' } : null;
    },
    async remove(key) {
      await fs.rm(file(key), { force: true });
    },
    async exists(key) {
      return Boolean(await this.head(key));
    },
    local: file,
    signedGet: async (key) => `https://signed.invalid/${key}`,
  };
}

export const uploadKey = (workspace, ext = 'mp4') => `uploads/${workspace}/${crypto.randomUUID()}/original.${ext}`;
