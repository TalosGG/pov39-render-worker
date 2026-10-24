import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JobError } from '../errors.js';
import { processGroupRss } from '../resources.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Remotion project that owns the motion composition. */
export const MOTION_PROJECT_DIR = path.resolve(here, '..', '..', 'remotion');

/** How often the render's memory is written to the log, so a kill has a number before it. */
const HEARTBEAT_MS = 30000;

const ALLOWED_FPS = [24, 25, 30, 50, 60];
const MAX_SCENES = 24;
const MAX_DURATION_SECONDS = 600;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * The worker's own view of a motion composition. It never trusts the caller's
 * numbers: every value that reaches the renderer is clamped here, and the plan it
 * returns is what the finished file is validated against.
 *
 * The app-side validator (base44/shared/motion.ts) is the authority for what a
 * composition may contain; this is the second gate at the point of rendering.
 */
export function motionPlanFrom(composition) {
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)) {
    throw new JobError('invalid_composition', 'No motion composition was supplied.');
  }
  const scenes = Array.isArray(composition.scenes) ? composition.scenes.slice(0, MAX_SCENES) : [];
  if (!scenes.length) {
    throw new JobError('invalid_composition', 'A motion composition needs at least one scene.');
  }

  const meta = composition.meta || {};
  const fps = ALLOWED_FPS.includes(num(meta.fps, 0)) ? num(meta.fps, 0) : 30;
  const duration = clamp(
    scenes.reduce((sum, scene) => sum + clamp(num(scene?.duration_seconds, 3), 0.5, 60), 0),
    0.5,
    MAX_DURATION_SECONDS,
  );

  return {
    kind: 'motion',
    title: String(meta.title || 'Motion asset').slice(0, 200),
    width: even(clamp(num(meta.width, 1080), 144, 3840)),
    height: even(clamp(num(meta.height, 1920), 144, 3840)),
    fps,
    duration,
    scene_count: scenes.length,
    brand: composition.brand?.name ? String(composition.brand.name).slice(0, 80) : '',
  };
}

/**
 * How many frames the renderer may render at once.
 *
 * Remotion's own default spreads frames across as many browser tabs as the machine has
 * cores, and every tab costs hundreds of megabytes — on a small instance that alone is
 * what exhausts the container. Concurrency is therefore decided here, memory first, and
 * can only be raised deliberately through the environment.
 */
export function resolveRemotionConcurrency() {
  const explicit = Number(process.env.REMOTION_CONCURRENCY);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.min(4, Math.floor(explicit));
  return Math.max(1, Math.min(2, Math.floor((os.cpus().length || 1) / 2)));
}

function nodeArgs(script, args) {
  return [path.join(MOTION_PROJECT_DIR, 'scripts', script), ...args];
}

/**
 * Runs one of the Remotion project's scripts and streams its progress lines.
 * The composition is passed as a file: it is data for the renderer, never code
 * this worker evaluates.
 *
 * The script runs as its own process group and is torn down as a group. Killing only
 * the node process would leave its Chromium children behind, holding the memory the
 * next attempt needs — and how the process actually ended is recorded here rather than
 * guessed afterwards, which is what tells an out-of-memory kill apart from a bad render.
 */
function runScript(script, args, { onLine, signal, timeoutMs, sample }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new JobError('motion_canceled', 'The motion render was stopped.'));
    }

    const child = spawn(process.execPath, nodeArgs(script, args), {
      cwd: MOTION_PROJECT_DIR,
      env: {
        ...process.env,
        ...(process.env.REMOTION_CHROME_PATH ? { REMOTION_CHROME_PATH: process.env.REMOTION_CHROME_PATH } : {}),
      },
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let killedBy = '';
    let peakBytes = 0;
    let settled = false;
    let lastHeartbeat = Date.now();

    const killGroup = (reason) => {
      if (killedBy) return;
      killedBy = reason;
      // Negative pid: the whole group, so Chromium dies with the script that opened it.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    };

    const timer = timeoutMs ? setTimeout(() => killGroup('timeout'), timeoutMs) : null;
    const onAbort = () => killGroup('aborted');
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const sampler = sample
      ? setInterval(() => {
          processGroupRss(child.pid)
            .then((bytes) => {
              if (bytes > peakBytes) peakBytes = bytes;
              // A heart line in the log. If the host kills this process, the last number
              // printed before it vanished is what says whether it ran out of room.
              if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
                lastHeartbeat = Date.now();
                console.log(`[motion] render process group rss=${Math.round(bytes / 1024 / 1024)}MB peak=${Math.round(peakBytes / 1024 / 1024)}MB`);
              }
            })
            .catch(() => {});
        }, 2000)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (sampler) clearInterval(sampler);
      signal?.removeEventListener?.('abort', onAbort);
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onLine) text.split('\n').filter(Boolean).forEach((line) => onLine(line.trim()));
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onLine) text.split('\n').filter(Boolean).forEach((line) => onLine(line.trim()));
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanup();

      const exit = {
        code: Number.isFinite(code) ? code : null,
        signal: signalName || '',
        killed_by: killedBy || (signalName ? 'signal' : ''),
        peak_rss_mb: Math.round(peakBytes / 1024 / 1024),
      };

      if (code === 0) return resolve({ stdout, stderr, exit });
      if (killedBy === 'timeout') {
        const error = new JobError('motion_timeout', 'The motion renderer ran out of time.');
        error.exit = exit;
        return reject(error);
      }
      if (killedBy === 'aborted') {
        const error = new JobError('motion_canceled', 'The motion render was stopped.');
        error.exit = exit;
        return reject(error);
      }
      const tail = (stderr || stdout).split('\n').filter(Boolean).slice(-6).join(' | ');
      const error = new JobError('motion_render_failed', `The motion renderer failed: ${tail.slice(0, 600)}`);
      error.exit = exit;
      return reject(error);
    });
  });
}

/**
 * Renders one motion composition to a finished MP4 and verifies the result
 * independently: the renderer's own report is not trusted for the pixel check,
 * a real FFmpeg pass re-reads the file and proves the frames actually move.
 */
export async function renderMotion(composition, { outFile, workDir, signal, onProgress }) {
  const plan = motionPlanFrom(composition);
  const compositionFile = path.join(workDir, 'composition.json');
  const resultFile = path.join(workDir, 'motion-result.json');
  const verifyFile = path.join(workDir, 'motion-verify.json');

  await fs.writeFile(compositionFile, JSON.stringify(composition, null, 2));
  const timeoutMs = Number(process.env.REMOTION_TIMEOUT_SECONDS || 1800) * 1000;
  const concurrency = resolveRemotionConcurrency();

  const total = plan.duration * plan.fps;
  const run = await runScript(
    'render-motion.mjs',
    [
      '--composition', compositionFile,
      '--out', outFile,
      '--result', resultFile,
      '--concurrency', String(concurrency),
    ],
    {
      timeoutMs,
      signal,
      sample: true,
      onLine: (line) => {
        const frames = /\[motion\] (\d+)\/(\d+) frames/.exec(line);
        if (frames && onProgress) onProgress(Number(frames[1]) / Number(frames[2]));
      },
    },
  );

  const render = JSON.parse(await fs.readFile(resultFile, 'utf8')).valueOf();

  await runScript(
    'verify-motion.mjs',
    [
      '--file', outFile,
      '--duration', String(plan.duration),
      '--width', String(plan.width),
      '--height', String(plan.height),
      '--report', verifyFile,
    ],
    { timeoutMs: 300000, signal },
  );

  const verification = JSON.parse(await fs.readFile(verifyFile, 'utf8'));
  if (!verification.passed) {
    throw new JobError('motion_verification_failed', 'The rendered motion file did not pass the pixel and decoder checks.');
  }
  if (onProgress) onProgress(1);

  return {
    plan,
    concurrency,
    exit: run.exit,
    engine: { engine: 'remotion', package: '@remotion/renderer', composition_id: 'POV39Motion', frames: render.duration_in_frames },
    render,
    verification: {
      passed: verification.passed,
      checks: verification.checks,
      frame_comparisons: verification.frame_comparisons,
      duration_seconds: verification.duration_seconds,
      video_codec: verification.video_codec,
      audio_codec: verification.audio_codec,
    },
    total_frames: Math.round(total),
  };
}