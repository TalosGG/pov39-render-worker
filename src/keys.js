import crypto from 'node:crypto';

/**
 * Object key rules. Only these shapes are ever read or written, so a caller can
 * never point the worker at another prefix, another tenant or a path trick.
 */
const ID = '[A-Za-z0-9_-]{1,64}';
export const UPLOAD_KEY = new RegExp(`^uploads/${ID}/[0-9a-f-]{36}/original\\.(mp4|mov)$`);
export const RENDER_KEY = new RegExp(`^renders/${ID}/output\\.mp4$`);

export const UPLOAD_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

export function isSafeId(value) {
  return typeof value === 'string' && new RegExp(`^${ID}$`).test(value);
}

export function newUploadKey(workspaceId, contentType) {
  const ext = UPLOAD_TYPES[contentType];
  if (!ext || !isSafeId(workspaceId)) return null;
  return `uploads/${workspaceId}/${crypto.randomUUID()}/original.${ext}`;
}

export function isUploadKey(key) {
  return typeof key === 'string' && UPLOAD_KEY.test(key);
}

export function isReadableKey(key) {
  return typeof key === 'string' && (UPLOAD_KEY.test(key) || RENDER_KEY.test(key));
}

/** True when the upload key lives under this workspace's prefix. */
export function belongsTo(key, workspaceId) {
  return isUploadKey(key) && key.startsWith(`uploads/${workspaceId}/`);
}