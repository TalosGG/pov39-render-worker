function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig() {
  const token = required('VIDEO_PROCESSING_TOKEN');
  if (token.length < 32) throw new Error('VIDEO_PROCESSING_TOKEN must be at least 32 characters');

  return {
    port: Number(process.env.PORT || 10000),
    token,
    databaseUrl: required('DATABASE_URL'),
    s3: {
      bucket: required('S3_BUCKET'),
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    },
    // Jobs run one at a time by default. Two at once on one instance multiply the
    // browser's memory — the resource a motion render actually competes for — so the
    // ceiling is enforced here instead of being left to the environment.
    concurrency: Math.min(2, Math.max(1, Number(process.env.RENDER_CONCURRENCY || 1))),
    workDir: process.env.WORK_DIR || '/tmp/pov39',
    // A motion render needs a browser to fit in memory. Below this the worker refuses
    // the job, with the measured numbers, rather than letting the host kill it.
    motionMinMemoryBytes: Math.max(0, Number(process.env.MOTION_MIN_MEMORY_MB || 1024)) * 1024 * 1024,
    maxSourceBytes: Number(process.env.MAX_SOURCE_BYTES || 2 * 1024 ** 3),
    // Image-card stills are small; a larger "image" is refused rather than decoded.
    maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 25 * 1024 ** 2),
    downloadUrlTtl: Number(process.env.DOWNLOAD_URL_TTL_SECONDS || 900),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 ** 3),
    uploadUrlTtl: Number(process.env.UPLOAD_URL_TTL_SECONDS || 1800),
    // Fail closed: only Base44 private-file links are fetched unless explicitly widened.
    allowedSourceHosts: (process.env.ALLOWED_SOURCE_HOSTS || 'media.base44.com')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    // Font resolution: the worker calls the Base44 fontManager function to resolve
    // font_id references to validated font asset URIs. If unset, the worker falls
    // back to Noto Sans for subtitles.
    fontResolverUrl: process.env.FONT_RESOLVER_URL || null,
    serviceToken: token,
  };
}