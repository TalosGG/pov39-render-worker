import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SUPPORTED_OPERATIONS } from './jobs.js';
import { COMPOSITOR } from './render/renderV2.js';
import { SUPPORTED_SCHEMA_VERSIONS, RENDERED_OVERLAYS, UNRENDERED_OVERLAYS, VIDEO_TRANSFORMS } from './render/timelineV2.js';
import { asrStatus } from './analysis/transcribe.js';

/**
 * What this worker can actually do, reported honestly.
 *
 * Footage editing (FFmpeg) and motion graphics (Remotion) fail for different reasons,
 * so the app has to be able to tell them apart *before* it charges anyone. This answers
 * "can this build render motion graphics" by looking at the image it is running in —
 * the browser, the motion project — and never by assuming.
 */

export const WORKER_VERSION = process.env.WORKER_VERSION || '1.3.0';

const CHROME_CANDIDATES = [
  process.env.REMOTION_CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

const remotionDir = path.resolve(process.cwd(), 'remotion');

function fileExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function browserVersion(binary) {
  return new Promise((resolve) => {
    if (!binary) return resolve('');
    execFile(binary, ['--version'], { timeout: 8000 }, (error, stdout) => {
      if (error) return resolve('');
      resolve(String(stdout || '').trim().split('\n')[0].slice(0, 120));
    });
  });
}

/** Runs the compositor's own self-check: Python, Pillow and RTL shaping, as installed. */
function compositorStatus() {
  return new Promise((resolve) => {
    execFile(process.env.PYTHON_BIN || 'python3', ['-I', COMPOSITOR, '--self-check'], { timeout: 20000 }, (error, stdout) => {
      if (error) return resolve({ ready: false, reason: 'The Timeline V2 compositor (Python with Pillow) is not installed in this image.' });
      try {
        const info = JSON.parse(String(stdout).trim());
        resolve({ ready: true, reason: '', python: info.python, pillow: info.pillow, rtl_shaping: info.raqm ? 'raqm' : 'fallback' });
      } catch {
        resolve({ ready: false, reason: 'The Timeline V2 compositor did not start.' });
      }
    });
  });
}

async function inspect() {
  const chromiumPath = CHROME_CANDIDATES.find(fileExists) || '';
  const renderScript = fileExists(path.join(remotionDir, 'scripts', 'render-motion.mjs'));
  const project = fileExists(path.join(remotionDir, 'src', 'index.js'));
  const packageJson = readJson(path.join(remotionDir, 'package.json'));
  const remotion = String(packageJson?.dependencies?.remotion || packageJson?.devDependencies?.remotion || '');
  const operation = SUPPORTED_OPERATIONS.has('render_motion');
  const chromium = await browserVersion(chromiumPath);

  const ready = Boolean(operation && chromiumPath && chromium && renderScript && project);
  let reason = '';
  if (!ready) {
    if (!operation) reason = 'This build does not accept motion render jobs.';
    else if (!chromiumPath) reason = 'No browser is installed in this image, so motion graphics cannot be rendered.';
    else if (!project || !renderScript) reason = 'The motion project is missing from this build.';
    else reason = 'The installed browser could not be started.';
  }

  const [compositor, asr] = await Promise.all([compositorStatus(), asrStatus()]);
  // Only what this image can actually run is listed: transcription without its model is not.
  const operations = [...SUPPORTED_OPERATIONS].filter((op) => op !== 'transcribe' || asr.ready).sort();

  return {
    version: WORKER_VERSION,
    operations,
    motion: {
      ready,
      operation: 'render_motion',
      chromium_path: chromiumPath,
      chromium,
      project: project && renderScript,
      remotion,
      reason,
    },
    timeline: {
      schema_versions: compositor.ready ? SUPPORTED_SCHEMA_VERSIONS : [1],
      v2: {
        ...compositor,
        overlays: RENDERED_OVERLAYS,
        video_transforms: VIDEO_TRANSFORMS,
        unsupported_overlays: UNRENDERED_OVERLAYS,
        transitions: ['cut', 'fade', 'dissolve', 'slide'],
        audio_tracks: 'mixed at audio.music_gain_db; source speech preserved',
      },
    },
    analysis: {
      frame_extract: { ready: true },
      scene_detect: { ready: true },
      audio_analyse: { ready: true },
      transcribe: asr,
    },
  };
}

let pending = null;

/** Cached for the life of the process: the image cannot change while it runs. */
export function capabilities() {
  if (!pending) {
    pending = inspect().catch((error) => ({
      version: WORKER_VERSION,
      operations: [...SUPPORTED_OPERATIONS].filter((op) => op !== 'transcribe').sort(),
      timeline: { schema_versions: [1], v2: { ready: false, reason: 'Capability check failed.' } },
      analysis: { transcribe: { ready: false, reason: 'Capability check failed.' } },
      motion: {
        ready: false,
        operation: 'render_motion',
        chromium_path: '',
        chromium: '',
        project: false,
        remotion: '',
        reason: `Capability check failed: ${String(error?.message || error).slice(0, 120)}`,
      },
    }));
  }
  return pending;
}