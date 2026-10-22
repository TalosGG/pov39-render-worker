import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Private S3-compatible bucket (Cloudflare R2 or AWS S3). Objects are never public. */
export function createStorage(c) {
  const client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  const Bucket = c.bucket;

  return {
    async put(key, file, contentType) {
      const { size } = await fs.promises.stat(file);
      await client.send(new PutObjectCommand({
        Bucket, Key: key, Body: fs.createReadStream(file), ContentLength: size, ContentType: contentType,
        ServerSideEncryption: c.endpoint ? undefined : 'AES256',
      }));
      return { key, size };
    },

    /** Streams an object to disk with a size cap. */
    async download(key, dest, maxBytes) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (Number(out.ContentLength || 0) > maxBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
      await pipeline(out.Body instanceof Readable ? out.Body : Readable.fromWeb(out.Body), fs.createWriteStream(dest));
    },

    /** Returns { size, contentType } or null when the object does not exist. */
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(out.ContentLength || 0), contentType: out.ContentType || '' };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return null;
        throw error;
      }
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key })).catch(() => {});
    },

    /** Short-lived read URL, returned only to the authenticated Base44 backend. */
    signedGet(key, ttlSeconds, filename) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentDisposition: filename ? `attachment; filename="${filename}"` : undefined,
      }), { expiresIn: ttlSeconds });
    },

    /** Short-lived upload URL bound to one key, type and exact size. */
    signedPut(key, contentType, size, ttlSeconds) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: size }), {
        expiresIn: ttlSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
    },

    async check() {
      await client.send(new HeadBucketCommand({ Bucket }));
    },
  };
}