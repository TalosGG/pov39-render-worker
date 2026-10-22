import express from 'express';
import { UPLOAD_TYPES, newUploadKey, isUploadKey, isReadableKey, isSafeId } from './keys.js';

/**
 * Storage endpoints for the Base44 backend only (all behind Bearer auth).
 * Browsers receive nothing but single-object, short-lived signed URLs.
 */
export function storageRoutes({ storage, config }) {
  const router = express.Router();

  // A direct-to-storage upload slot bound to one new key, content type and exact size.
  router.post('/uploads', async (req, res, next) => {
    try {
      const { workspace_id: workspaceId, content_type: contentType } = req.body || {};
      const size = Number(req.body?.size);
      if (!isSafeId(workspaceId)) return res.status(400).json({ error: 'workspace_id is invalid.' });
      if (!UPLOAD_TYPES[contentType]) return res.status(400).json({ error: 'Only MP4 and MOV video can be uploaded.' });
      if (!Number.isInteger(size) || size <= 0 || size > config.maxUploadBytes) {
        return res.status(400).json({ error: 'The file size is not allowed.', max_bytes: config.maxUploadBytes });
      }
      const key = newUploadKey(workspaceId, contentType);
      const url = await storage.signedPut(key, contentType, size, config.uploadUrlTtl);
      res.json({ storage_key: key, upload_url: url, expires_in: config.uploadUrlTtl, headers: { 'Content-Type': contentType } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/objects/head', async (req, res, next) => {
    try {
      const key = req.body?.storage_key;
      if (!isUploadKey(key)) return res.status(400).json({ error: 'storage_key is invalid.' });
      const info = await storage.head(key);
      res.json(info ? { exists: true, size: info.size, content_type: info.contentType } : { exists: false });
    } catch (error) {
      next(error);
    }
  });

  router.post('/objects/sign', async (req, res, next) => {
    try {
      const key = req.body?.storage_key;
      if (!isReadableKey(key)) return res.status(400).json({ error: 'storage_key is invalid.' });
      if (!(await storage.head(key))) return res.status(404).json({ error: 'not_found' });
      const filename = String(req.body?.filename || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const ttl = Math.min(3600, Math.max(60, Number(req.body?.expires_in) || config.downloadUrlTtl));
      res.json({ url: await storage.signedGet(key, ttl, filename || undefined), expires_in: ttl });
    } catch (error) {
      next(error);
    }
  });

  return router;
}