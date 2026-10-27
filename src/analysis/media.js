import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JobError } from '../errors.js';
import { run } from '../render/ffmpeg.js';

/**
 * Media analysis for the agent: what a file is, what it looks like at given moments,
 * where its shots change and how its sound behaves. Every call streams through FFmpeg
 * (seek, decode, discard), so a long source never has to fit in memory, and every
 * argument is a number or a worker-owned path — nothing from a request reaches a shell.
 */

const ffmpegBin = () => process.env.FFMPEG_BIN || 'ffmpeg';

export const MAX_FRAMES = 60;
const MAX_SCENES = 500;
const MAX_SILENCES = 1000;

const fpsOf = (rate) => {
  const [n, d] = String(rate || '0/1').split('/').map(Number);
  return d ? Math.round((n / d) * 1000) / 1000 : 0;
};

/** The parts of an ffprobe report the agent needs, and nothing that identifies storage. */
export function mediaSummary(info) {
  const video = info?.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = info?.streams?.find((s) => s.codec_type === 'audio');
  const rotation = Number(video?.tags?.rotate || video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  const swap = Math.abs(rotation) % 180 === 90;
  return {
    duration_seconds: Number(info?.format?.duration) || 0,
    container: String(info?.format?.format_name || ''),
    size_bytes: Number(info?.format?.size) || 0,
    bit_rate: Number(info?.format?.bit_rate) || 0,
    video: video ? {
      codec: video.codec_name || '',
      width: video.width || 0,
      height: video.height || 0,
      display_width: (swap ? video.height : video.width) || 0,
      display_height: (swap ? video.width : video.height) || 0,
      rotation,
      fps: fpsOf(video.avg_frame_rate || video.r_frame_rate),
      pix_fmt: video.pix_fmt || '',
    } : null,
    audio: audio ? {
      codec: audio.codec_name || '',
      sample_rate: Number(audio.sample_rate) || 0,
      channels: audio.channels || 0,
    } : null,
  };
}

/** The timestamps to sample: explicit ones, or an even spread / fixed interval. */
export function frameTimes(params, duration) {
  const last = Math.max(0, duration - 0.05);
  if (Array.isArray(params.timestamps) && params.timestamps.length) {
    const times = params.timestamps.map(Number).filter((t) => Number.isFinite(t) && t >= 0);
    if (times.length !== params.timestamps.length) throw new JobError('invalid_request', 'timestamps must be numbers ≥ 0.');
    if (times.length > MAX_FRAMES) throw new JobError('invalid_request', `At most ${MAX_FRAMES} frames per job.`);
    const outside = times.find((t) => t > duration + 0.05);
    if (outside !== undefined) throw new JobError('invalid_request', `Timestamp ${outside} s is past the end of the ${duration.toFixed(2)} s source.`);
    return times.map((t) => Math.min(t, last));
  }
  const interval = Number(params.interval_seconds);
  if (Number.isFinite(interval) && interval > 0) {
    if (interval < 0.5) throw new JobError('invalid_request', 'interval_seconds must be at least 0.5.');
    const times = [];
    for (let t = interval / 2; t < duration && times.length < MAX_FRAMES; t += interval) times.push(Math.min(t, last));
    return times;
  }
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.round(Number(params.count) || 12)));
  return Array.from({ length: count }, (_, i) => Math.min(last, ((i + 0.5) / count) * duration));
}

/**
 * One JPEG per timestamp (fast input seek, one decoded frame each), plus an optional
 * contact sheet — the single image a vision model reads for "what happens in this clip".
 */
export async function extractFrames(file, times, { dir, width = 540, contactSheet = true, signal }) {
  const w = Math.max(64, Math.min(1080, Math.round(Number(width) || 540) & ~1));
  const frames = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(dir, `f_${String(i).padStart(3, '0')}.jpg`);
    await run(ffmpegBin(), [
      '-v', 'error', '-nostdin', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', `scale=${w}:-2`, '-q:v', '3', out,
    ], { signal });
    frames.push({ index: i, time: Math.round(t * 1000) / 1000, file: out });
  }
  let sheet = null;
  if (contactSheet && frames.length > 1) {
    const cols = Math.min(6, frames.length);
    const rows = Math.ceil(frames.length / cols);
    sheet = path.join(dir, 'contact.jpg');
    const cell = Math.min(w, 270);
    await run(ffmpegBin(), [
      '-v', 'error', '-nostdin', '-y', '-start_number', '0', '-i', path.join(dir, 'f_%03d.jpg'),
      '-vf', `scale=${cell}:-2,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', '-q:v', '3', sheet,
    ], { signal });
  }
  return { frames, sheet };
}

function streamStderr(args, { signal, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let buffer = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(onLine);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (buffer) onLine(buffer);
      if (signal?.aborted) return reject(new JobError('canceled', 'The job was canceled.'));
      if (code !== 0) return reject(new JobError('analysis_failed', 'The media could not be analysed.'));
      resolve();
    });
  });
}

/** Shot boundaries from FFmpeg's scene score, decoded at low resolution. */
export async function detectScenes(file, duration, { threshold = 0.3, signal } = {}) {
  const thr = Math.min(0.9, Math.max(0.05, Number(threshold) || 0.3));
  const cuts = [];
  let pending = null;
  await streamStderr([
    '-hide_banner', '-nostdin', '-i', file, '-an', '-sn',
    '-vf', `scale=320:-2,select='gt(scene,${thr})',metadata=print`, '-f', 'null', '-',
  ], {
    signal,
    onLine(line) {
      const time = /pts_time:([\d.]+)/.exec(line);
      if (time) pending = Number(time[1]);
      const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
      if (score && pending !== null && cuts.length < MAX_SCENES) {
        cuts.push({ time: Math.round(pending * 1000) / 1000, score: Math.round(Number(score[1]) * 1000) / 1000 });
        pending = null;
      }
    },
  });
  const bounds = [0, ...cuts.map((c) => c.time), duration];
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    if (bounds[i + 1] - bounds[i] < 0.04) continue;
    scenes.push({
      index: scenes.length,
      start: Math.round(bounds[i] * 1000) / 1000,
      end: Math.round(bounds[i + 1] * 1000) / 1000,
      cut_score: i === 0 ? null : cuts[i - 1].score,
    });
  }
  return { threshold: thr, scenes, cuts };
}

/**
 * Loudness (EBU R128) and the pause map: the silences an editor cuts on. Speech ratio
 * is the share of the file that is not silence.
 */
export async function analyseAudio(file, duration, { noiseDb = -35, minSilence = 0.25, signal } = {}) {
  const n = Math.min(-10, Math.max(-70, Number(noiseDb) || -35));
  const d = Math.min(5, Math.max(0.1, Number(minSilence) || 0.25));
  const silences = [];
  let open = null;
  const profile = { integrated_lufs: null, loudness_range_lu: null, true_peak_dbfs: null };
  let summary = false;
  await streamStderr([
    '-hide_banner', '-nostdin', '-i', file, '-vn', '-sn',
    '-af', `silencedetect=n=${n}dB:d=${d},ebur128=peak=true`, '-f', 'null', '-',
  ], {
    signal,
    onLine(line) {
      const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (s) open = Math.max(0, Number(s[1]));
      const e = /silence_end:\s*([\d.]+)/.exec(line);
      if (e && open !== null && silences.length < MAX_SILENCES) {
        silences.push({ start: Math.round(open * 1000) / 1000, end: Math.round(Number(e[1]) * 1000) / 1000 });
        open = null;
      }
      if (/Summary:/.test(line)) summary = true;
      if (!summary) return;
      const i = /^\s*I:\s*(-?[\d.]+) LUFS/.exec(line);
      if (i) profile.integrated_lufs = Number(i[1]);
      const lra = /^\s*LRA:\s*(-?[\d.]+) LU/.exec(line);
      if (lra) profile.loudness_range_lu = Number(lra[1]);
      const peak = /^\s*Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(line);
      if (peak) profile.true_peak_dbfs = peak[1] === '-inf' ? null : Number(peak[1]);
    },
  });
  if (open !== null && silences.length < MAX_SILENCES) silences.push({ start: Math.round(open * 1000) / 1000, end: Math.round(duration * 1000) / 1000 });
  const silent = silences.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  return {
    ...profile,
    silence_threshold_db: n,
    min_silence_seconds: d,
    silences,
    speech_ratio: duration > 0 ? Math.round(Math.max(0, 1 - silent / duration) * 1000) / 1000 : 0,
  };
}

export async function removeQuietly(target) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}
