import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Remotion project that owns the motion composition. */
export const MOTION_PROJECT_DIR = path.resolve(here, '..', '..', 'remotion');

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

function nodeArgs(script, args) {
  return [path.join(MOTION_PROJECT_DIR, 'scripts', script), ...args];
}

/**
 * Runs one of the Remotion project's scripts and streams its progress lines.
 * The composition is passed as a file: it is data for the renderer, never code
 * this worker evaluates.
 */
function runScript(script, args, { onLine, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs(script, args), {
      cwd: MOTION_PROJECT_DIR,
      env: {
        ...process.env,
        ...(process.env.REMOTION_CHROME_PATH ? { REMOTION_CHROME_PATH: process.env.REMOTION_CHROME_PATH } : {}),
      },
      signal,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

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
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      if (killed) return reject(new JobError('motion_timeout', 'The motion renderer ran out of time.'));
      const tail = (stderr || stdout).split('\n').filter(Boolean).slice(-6).join(' | ');
      return reject(new JobError('motion_render_failed', `The motion renderer failed: ${tail.slice(0, 600)}`));
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

  const total = plan.duration * plan.fps;
  await runScript(
    'render-motion.mjs',
    [
      '--composition', compositionFile,
      '--out', outFile,
      '--result', resultFile,
      ...(process.env.REMOTION_CONCURRENCY ? ['--concurrency', String(process.env.REMOTION_CONCURRENCY)] : []),
    ],
    {
      timeoutMs,
      signal,
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