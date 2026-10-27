import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Local media for the render tests: synthesised with FFmpeg, never downloaded, never
 * production footage. `FFMPEG_BIN` / `FFPROBE_BIN` point at the binaries when they are
 * not on PATH.
 */
export const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
export const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
export const python = process.env.PYTHON_BIN || 'python3';

export function toolsAvailable() {
  const ok = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { timeout: 20000 }).status === 0;
    } catch {
      return false;
    }
  };
  const missing = [];
  if (!ok(ffmpeg, ['-hide_banner', '-version'])) missing.push('ffmpeg');
  if (!ok(ffprobe, ['-version'])) missing.push('ffprobe');
  if (!ok(python, ['-c', 'import PIL, numpy'])) missing.push('python3 with Pillow');
  return missing;
}

function make(file, args) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args, file], { timeout: 120000 });
  if (r.status !== 0) throw new Error(`fixture ${path.basename(file)}: ${r.stderr}`);
  return file;
}

const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

/** A 16:9 "speaker" clip with a 440 Hz tone: the aspect differs from 9:16 on purpose. */
export const speaker = (dir, seconds = 34) => make(path.join(dir, 'speaker.mp4'), [
  '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${seconds}`,
  '-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${seconds}`, ...h264, '-c:a', 'aac', '-shortest',
]);

/** A solid-colour vertical clip with its own tone (for transition and audio tests). */
export const solid = (dir, name, color, freq, seconds = 4, size = '540x960') => make(path.join(dir, `${name}.mp4`), [
  '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=30:d=${seconds}`,
  '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000:d=${seconds}`, ...h264, '-c:a', 'aac', '-shortest',
]);

/** A quiet music bed. */
export const music = (dir, seconds = 34) => make(path.join(dir, 'music.m4a'), [
  '-f', 'lavfi', '-i', `sine=f=220:r=48000:d=${seconds}`, '-c:a', 'aac',
]);

/** Tone, two seconds of silence, tone: a known pause map. */
export const pauses = (dir) => make(path.join(dir, 'pauses.m4a'), [
  '-f', 'lavfi', '-i', 'sine=f=500:r=48000:d=6', '-af', "volume=enable='between(t,2,4)':volume=0", '-c:a', 'aac',
]);

/** A still for image cards. */
export const still = (dir) => make(path.join(dir, 'card.png'), [
  '-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080', '-frames:v', '1',
]);

/** Four hard cuts between flat colours, for scene detection. */
export const cuts = (dir) => make(path.join(dir, 'cuts.mp4'), [
  '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=8',
  '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-map', '4:a', ...h264, '-c:a', 'aac',
]);

/** Mean RGB of a region of a JPEG/PNG frame, via FFmpeg (no image library on the Node side). */
export function regionColor(file, { x, y, w, h }) {
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1:flags=area,format=rgb24`,
    '-f', 'rawvideo', '-',
  ], { timeout: 30000 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

/** Mean absolute per-channel difference (0–255) of the same region in two images. */
export function regionDifference(a, b, { x, y, w, h }) {
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-i', a, '-i', b, '-filter_complex',
    `[0:v]crop=${w}:${h}:${x}:${y},format=gbrp[a];[1:v]crop=${w}:${h}:${x}:${y},format=gbrp[b];` +
    '[a][b]blend=all_mode=difference,scale=1:1:flags=area,format=rgb24',
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ], { timeout: 30000 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return (r.stdout[0] + r.stdout[1] + r.stdout[2]) / 3;
}

/** One frame of an MP4 at time t, as a PNG. */
export function frameAt(video, t, out) {
  return make(out, ['-ss', String(t), '-i', video, '-frames:v', '1']);
}

/** RMS level (dBFS) of an audio window of a file. */
export function audioLevel(file, start, seconds) {
  const r = spawnSync(ffmpeg, [
    '-v', 'info', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeout: 60000 });
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(String(r.stderr));
  return match ? Number(match[1] === '-inf' ? -200 : match[1]) : -200;
}

/** Dominant frequency (Hz) of a short audio window, via FFT-free zero crossings. */
export function toneFrequency(file, start, seconds = 0.5) {
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '48000',
    '-f', 's16le', '-',
  ], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  const samples = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings += 1;
  return crossings / 2 / (samples.length / 48000);
}
