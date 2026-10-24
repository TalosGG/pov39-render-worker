import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SUPPORTED_OPERATIONS } from './jobs.js';

/**
 * What this worker can actually do, reported honestly.
 *
 * Footage editing (FFmpeg) and motion graphics (Remotion) fail for different reasons,
 * so the app has to be able to tell them apart *before* it charges anyone. This answers
 * "can this build render motion graphics" by looking at the image it is running in —
 * the browser, the motion project — and never by assuming.
 */

export const WORKER_VERSION = process.env.WORKER_VERSION || '1.2.0';

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

  return {
    version: WORKER_VERSION,
    operations: [...SUPPORTED_OPERATIONS].sort(),
    motion: {
      ready,
      operation: 'render_motion',
      chromium_path: chromiumPath,
      chromium,
      project: project && renderScript,
      remotion,
      reason,
    },
  };
}

let pending = null;

/** Cached for the life of the process: the image cannot change while it runs. */
export function capabilities() {
  if (!pending) {
    pending = inspect().catch((error) => ({
      version: WORKER_VERSION,
      operations: [...SUPPORTED_OPERATIONS].sort(),
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