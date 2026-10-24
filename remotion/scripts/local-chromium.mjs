import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/**
 * Resolves a Chromium for Remotion on hosts where no browser is installed.
 *
 * Order of preference:
 *   1. REMOTION_CHROME_PATH / --chrome — what the Docker image and CI use.
 *   2. a Chrome already on the host.
 *   3. the self-contained Chromium from @sparticuz/chromium, with the shared
 *      libraries it needs unpacked next to it.
 *
 * Only the browser-support libraries are put on LD_LIBRARY_PATH (never libc or
 * libm), so the host's own C library stays in charge.
 */
const CACHE_DIR = process.env.POV39_CHROMIUM_DIR || '/tmp/pov39-chromium';

const SYSTEM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

// Browser support libraries only. libc/libm/libpthread/libdl are deliberately
// left out: the host's glibc must win.
const SUPPORT_LIBS = [
  'libnspr4.so', 'libnss3.so', 'libnssutil3.so', 'libplc4.so', 'libplds4.so',
  'libsmime3.so', 'libfreebl3.so', 'libfreeblpriv3.so', 'libsoftokn3.so',
  'libsqlite3.so.0', 'libaudit.so.1', 'libexpat.so.1', 'libuuid.so.1',
];

const exists = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function unpackSupportLibs(binDir) {
  const tarballs = ['al2023.tar.br', 'al2.tar.br']
    .map((name) => path.join(binDir, name))
    .filter((file) => fs.existsSync(file));
  if (!tarballs.length) return null;

  const libDir = path.join(CACHE_DIR, 'lib');
  const stamp = path.join(libDir, '.ready');
  if (fs.existsSync(stamp)) return libDir;

  fs.mkdirSync(libDir, { recursive: true });
  const staged = path.join(CACHE_DIR, `stage-${process.pid}`);
  fs.mkdirSync(staged, { recursive: true });
  try {
    for (const tarball of tarballs) {
      const raw = zlib.brotliDecompressSync(fs.readFileSync(tarball));
      const archive = path.join(staged, 'libs.tar');
      fs.writeFileSync(archive, raw);
      execFileSync('tar', ['-xf', archive, '-C', staged]);
      fs.rmSync(archive, { force: true });
    }
    for (const name of SUPPORT_LIBS) {
      const found = [path.join(staged, 'lib', name), path.join(staged, name)].find((file) => fs.existsSync(file));
      if (found) fs.copyFileSync(found, path.join(libDir, name));
    }
    fs.writeFileSync(stamp, new Date().toISOString());
    return libDir;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

export async function resolveChromium(explicitPath) {
  const preferred = explicitPath || process.env.REMOTION_CHROME_PATH;
  if (preferred && fs.existsSync(preferred)) return { executablePath: preferred, libDir: null, args: [] };

  const system = SYSTEM_CANDIDATES.find(exists);
  if (system) return { executablePath: system, libDir: null, args: [] };

  let packaged;
  try {
    packaged = require('@sparticuz/chromium');
  } catch {
    return null;
  }
  const executablePath = await packaged.executablePath();
  const binDir = path.join(path.dirname(require.resolve('@sparticuz/chromium/package.json')), 'bin');
  return { executablePath, libDir: unpackSupportLibs(binDir), args: packaged.args || [] };
}