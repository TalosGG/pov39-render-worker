import crypto from 'node:crypto';

const digest = (value) => crypto.createHash('sha256').update(value).digest();

/** Constant-time Bearer token check. Never logs or echoes the token. */
export function requireBearer(token) {
  const expected = digest(token);
  return (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const received = digest(match ? match[1].trim() : '');
    if (!match || !crypto.timingSafeEqual(expected, received)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}