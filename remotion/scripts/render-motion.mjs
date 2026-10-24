#!/usr/bin/env node
/**
 * Renders one validated POV39 motion composition to H.264/AAC MP4.
 *
 * Usage (the worker calls exactly this):
 *   node scripts/render-motion.mjs --composition composition.json --out out.mp4 [--public <dir>]
 *
 * The composition file is DATA. This script never evaluates it, never accepts a
 * script path, and never runs shell from it — it is passed to the composition as
 * input props.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

import { resolveChromium } from './local-chromium.mjs';

const args = readArgs(process.argv.slice(2));
if (!args.composition || !args.out) {
  console.error('Usage: node scripts/render-motion.mjs --composition <file.json> --out <file.mp4> [--public <dir>]');
  process.exit(2);
}

/**
 * The browser to render with: REMOTION_CHROME_PATH / --chrome, a Chrome already
 * on the host, or the self-contained Chromium the worker unpacks for itself.
 * Its support libraries are put on LD_LIBRARY_PATH for the browser process only.
 */
const browser = await resolveChromium(typeof args.chrome === 'string' ? args.chrome : undefined);
if (browser?.libDir) {
  process.env.LD_LIBRARY_PATH = [browser.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

function chromiumOptions() {
  return {
    gl: 'swangle',
    ...(browser?.executablePath ? { executablePath: browser.executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--font-render-hinting=none',
      ...(browser?.args || []),
    ],
  };
}

const composition = JSON.parse(await fs.readFile(path.resolve(String(args.composition)), 'utf8'));
const outputLocation = path.resolve(String(args.out));
const publicDir = path.resolve(String(args.public || path.join(projectRoot, 'public')));
const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pov39-motion-bundle-'));
const stillFrame = args.still === undefined || args.still === true ? null : Number(args.still);

const started = Date.now();
try {
  console.log('[motion] bundling composition');
  const serveUrl = await bundle({
    entryPoint: path.join(projectRoot, 'src', 'index.js'),
    publicDir,
    outDir: bundleDir,
    onProgress: (percent) => {
      if (percent % 25 === 0) console.log(`[motion] bundle ${percent}%`);
    },
  });

  if (chromiumOptions().executablePath) {
    console.log(`[motion] browser: ${chromiumOptions().executablePath}`);
  } else {
    console.log('[motion] ensuring browser');
    await ensureBrowser();
  }

  const resolved = await selectComposition({
    serveUrl,
    id: 'POV39Motion',
    inputProps: { composition },
  });

  if (stillFrame !== null) {
    await renderStill({
      composition: resolved,
      serveUrl,
      output: outputLocation,
      inputProps: { composition },
      frame: Math.max(0, Math.min(stillFrame, resolved.durationInFrames - 1)),
      chromiumOptions: chromiumOptions(),
    });
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
    console.log(`[motion] still frame ${stillFrame} -> ${outputLocation}`);
    process.stdout.write(`POV39_MOTION_STILL ${JSON.stringify({ output: outputLocation, frame: stillFrame, width: resolved.width, height: resolved.height })}\n`);
    process.exit(0);
  }

  console.log(`[motion] rendering ${resolved.durationInFrames} frames at ${resolved.width}x${resolved.height} ${resolved.fps}fps`);

  await renderMedia({
    composition: resolved,
    serveUrl,
    codec: 'h264',
    audioCodec: 'aac',
    outputLocation,
    inputProps: { composition },
    crf: Number(args.crf) || 23,
    pixelFormat: 'yuv420p',
    concurrency: Number(args.concurrency) || null,
    chromiumOptions: chromiumOptions(),
    onProgress: ({ renderedFrames, encodedFrames }) => {
      const done = Math.max(renderedFrames, encodedFrames);
      if (done % 90 === 0 && done > 0) console.log(`[motion] ${done}/${resolved.durationInFrames} frames`);
    },
  });

  const bytes = await fs.readFile(outputLocation);
  const result = {
    output: outputLocation,
    size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    width: resolved.width,
    height: resolved.height,
    fps: resolved.fps,
    duration_in_frames: resolved.durationInFrames,
    duration_seconds: Number((resolved.durationInFrames / resolved.fps).toFixed(3)),
    scenes: Array.isArray(composition?.scenes) ? composition.scenes.length : 0,
    render_ms: Date.now() - started,
  };
  console.log(`[motion] done in ${(result.render_ms / 1000).toFixed(1)}s -> ${outputLocation} (${(bytes.length / 1024).toFixed(0)} KiB)`);

  if (args.result) await fs.writeFile(path.resolve(String(args.result)), JSON.stringify(result, null, 2));
  process.stdout.write(`POV39_MOTION_RESULT ${JSON.stringify(result)}\n`);
} finally {
  await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
}