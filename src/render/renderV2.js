import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobError } from '../errors.js';
import { filterPath } from './ffmpeg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const COMPOSITOR = path.join(here, 'v2', 'compose.py');

const ffmpegBin = () => process.env.FFMPEG_BIN || 'ffmpeg';
const pythonBin = () => process.env.PYTHON_BIN || 'python3';
const threads = () => Math.max(1, Math.min(8, Number(process.env.FFMPEG_THREADS || 2)));

function atempoChain(speed) {
  const parts = [];
  let remaining = speed;
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  while (remaining > 2) { parts.push('atempo=2'); remaining /= 2; }
  if (Math.abs(remaining - 1) > 1e-6) parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts;
}

/** Display size of a probed video stream (a 90° rotation swaps width and height). */
export function displaySize(info) {
  const video = info?.streams?.find((s) => s.codec_type === 'video');
  if (!video) return null;
  const rotation = Number(video.tags?.rotate || video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  const swap = Math.abs(rotation) % 180 === 90;
  return { width: swap ? video.height : video.width, height: swap ? video.width : video.height };
}

/**
 * The compositor's input: the validated plan plus the local files the worker fetched.
 * Only worker-chosen paths are written into it — never anything from the timeline.
 */
export function compositorPlan(plan, files, images, fonts, reportPath) {
  const aspect = plan.width / plan.height;
  return {
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: plan.duration,
    frames: plan.frames,
    threads: threads(),
    report: reportPath,
    segments: plan.segments.map((segment) => {
      if (segment.type !== 'clip') return segment;
      const file = files[segment.asset];
      const size = file.display;
      const exact = size && Math.abs(size.width / size.height - aspect) / aspect < 0.01;
      return { ...segment, file: file.path, fit: exact ? 'exact' : 'blur' };
    }),
    zooms: plan.zooms,
    overlays: plan.overlays,
    images,
    fonts: Object.fromEntries(Object.entries(fonts).map(([id, font]) => [id, font.localPath])),
  };
}

/**
 * Audio: the original sound of every clip, in place on the program timeline (each at its
 * own speed, cross-faded under dissolves and slides), plus any music-bed clips at the
 * timeline's music gain, over silence for the full duration. Nothing is resynthesised.
 */
export function audioGraph(plan, files, firstInput) {
  const inputs = [];
  const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${plan.duration.toFixed(3)}[abed]`];
  const mixes = ['[abed]'];
  let index = firstInput;

  const place = (clip, { extraSeconds = 0, gainDb = 0, fadeIn = 0, fadeOut = 0, label }) => {
    const play = clip.end - clip.start + extraSeconds;
    const k = index++;
    inputs.push('-ss', clip.sourceIn.toFixed(3), '-t', (play * clip.speed + 0.1).toFixed(3), '-i', files[clip.asset].path);
    const chain = [
      ...atempoChain(clip.speed),
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=duration=${play.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
    ];
    if (gainDb) chain.push(`volume=${gainDb}dB`);
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, play - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    const delay = Math.round(clip.start * 1000);
    if (delay > 0) chain.push(`adelay=${delay}|${delay}`);
    filters.push(`[${k}:a]${chain.join(',')}[${label}]`);
    mixes.push(`[${label}]`);
  };

  plan.segments.forEach((segment, i) => {
    if (segment.type !== 'clip' || !files[segment.asset]?.hasAudio) return;
    const crossIn = ['dissolve', 'slide'].includes(segment.transition) ? segment.transitionSeconds : 0;
    place(segment, { extraSeconds: segment.tail, fadeIn: crossIn, fadeOut: segment.tail, label: `av${i}` });
  });
  plan.music.forEach((clip, i) => {
    if (!files[clip.asset]?.hasAudio) return;
    place(clip, {
      gainDb: clip.gainDb,
      fadeIn: clip.transition === 'cut' ? 0 : clip.transitionSeconds,
      fadeOut: Math.min(0.5, (clip.end - clip.start) / 4),
      label: `am${i}`,
    });
  });

  // normalize=0: each source keeps its own level; the speech is not turned down to make room.
  filters.push(`${mixes.join('')}amix=inputs=${mixes.length}:duration=first:normalize=0,alimiter=limit=0.97[aout]`);
  return { inputs, filters };
}

const assTime = (seconds) => {
  const cs = Math.round(seconds * 100);
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
};

/**
 * Burned subtitles as ASS with PlayRes = the output size, so sizes are real pixels.
 * (SRT through libass is laid out on a 288-line canvas and scaled up, which makes a
 * pixel font size several times too large.) A cue that shares the screen with a
 * lower-third zone overlay is lifted above it, per cue, instead of being drawn over it.
 * Braces and backslashes are removed from cue text: no ASS override tag from a timeline
 * ever reaches libass.
 */
export async function assSubtitles(plan, workDir, fonts = {}) {
  const { width: w, height: h } = plan;
  const resolved = plan.subtitle_font_id ? fonts[plan.subtitle_font_id] : null;
  const fontName = String(resolved?.fontFamily || 'Noto Sans').replace(/[,{}\\\n\r]/g, '');
  const size = Math.round(h / 28);
  const base = Math.round(h / 12);
  const lowZone = plan.overlays.filter((o) => o.y >= 0.6 && ['lower_third', 'pill', 'credit', 'stamp', 'quote', 'headline'].includes(o.type));
  const events = plan.cues.map((cue) => {
    const covering = lowZone.filter((o) => o.start < cue.end && o.end > cue.start);
    // Lift above the highest such overlay (its centre minus ~9 % of the frame for its height).
    const lift = covering.length ? Math.round(h * (1 - Math.min(...covering.map((o) => o.y)) + 0.09)) : base;
    const text = cue.text.replace(/[{}\\]/g, '').replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,${Math.min(lift, Math.round(h * 0.7))},,${text}`;
  });
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Encoding -1: libass picks each line's base direction from its text (Hebrew cues read RTL).
    `Style: Default,${fontName},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(h / 480))},0,2,${Math.round(w / 14)},${Math.round(w / 14)},${base},-1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
  const file = path.join(workDir, 'subtitles.ass');
  await fs.writeFile(file, ass, 'utf8');
  const fontDir = resolved?.localPath ? `:fontsdir=${filterPath(path.dirname(resolved.localPath))}` : '';
  return `subtitles=filename=${filterPath(file)}${fontDir}`;
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Renders a Timeline V2 plan: compose.py draws every frame and streams raw RGB into an
 * FFmpeg encoder this function builds — so the encoder's arguments, the subtitles and
 * the audio mix are decided here, by the worker, and never by the compositor.
 *
 * @param files   { [assetId]: { path, hasAudio, display } }  (video and audio sources)
 * @param images  { [assetId]: path }                         (image-card stills)
 * @param fonts   { [fontId]: { localPath, fontFamily } }
 */
export async function renderTimelineV2(plan, files, images, { outFile, workDir, quality, signal, onProgress, fonts = {} }) {
  const reportPath = path.join(workDir, 'compose-report.json');
  const planPath = path.join(workDir, 'compose-plan.json');
  await fs.writeFile(planPath, JSON.stringify(compositorPlan(plan, files, images, fonts, reportPath)), 'utf8');

  const { width: w, height: h, fps } = plan;
  const audio = audioGraph(plan, files, 1);
  const filters = [...audio.filters];
  filters.push(plan.cues.length ? `[0:v]${await assSubtitles(plan, workDir, fonts)}[vout]` : '[0:v]null[vout]');

  const master = quality === 'master';
  const args = [
    '-hide_banner', '-nostdin', '-y', '-threads', String(threads()),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0',
    ...audio.inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', master ? 'medium' : 'veryfast', '-crf', master ? '18' : '24',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', plan.duration.toFixed(3),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outFile,
  ];

  const detached = process.platform !== 'win32';
  const encoder = spawn(ffmpegBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], detached });
  const composer = spawn(pythonBin(), ['-I', COMPOSITOR, planPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    env: { ...process.env, FFMPEG_BIN: ffmpegBin(), PYTHONUNBUFFERED: '1' },
  });
  composer.stdout.pipe(encoder.stdin);
  encoder.stdin.on('error', () => {}); // a dead encoder is reported by its exit code

  let encErr = '';
  let compErr = '';
  encoder.stderr.on('data', (chunk) => { encErr = (encErr + chunk).slice(-6000); });
  composer.stderr.on('data', (chunk) => { compErr = (compErr + chunk).slice(-6000); });
  let buffer = '';
  encoder.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match && plan.duration > 0) onProgress?.(Math.min(1, Number(match[1]) / 1e6 / plan.duration));
    }
  });

  const exit = (child) => new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, signal: null, error }));
    child.on('close', (code, sig) => resolve({ code, signal: sig }));
  });
  const abort = () => { killTree(composer); killTree(encoder); };
  signal?.addEventListener('abort', abort, { once: true });

  const [composed, encoded] = await Promise.all([exit(composer), exit(encoder)]);
  signal?.removeEventListener('abort', abort);
  if (signal?.aborted) throw new JobError('canceled', 'The job was canceled.');

  if (composed.code !== 0 || encoded.code !== 0) {
    if (composed.error?.code === 'ENOENT') throw new JobError('renderer_unavailable', 'The Timeline V2 compositor (Python) is not installed in this worker.');
    console.error('[render-v2] compositor:', composed.code, compErr.slice(-2000));
    console.error('[render-v2] encoder:', encoded.code, encErr.slice(-2000));
    throw new JobError('render_failed', 'The Timeline V2 renderer could not render this timeline.');
  }

  let report = {};
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    report = {};
  }
  return { engine: 'pov39-compose-v2', fonts: report.fonts || {}, rtl_shaping: report.raqm ? 'raqm' : 'fallback', notes: plan.notes };
}

/** Renders a handful of stills straight from the compositor (no encode) — used by tests and previews. */
export async function composeStills(plan, files, images, times, outDir, fonts = {}) {
  const planPath = path.join(outDir, 'compose-plan.json');
  await fs.writeFile(planPath, JSON.stringify(compositorPlan(plan, files, images, fonts, null)), 'utf8');
  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-I', COMPOSITOR, planPath, '--preview', times.join(','), outDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, FFMPEG_BIN: ffmpegBin() },
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`compose.py exited ${code}: ${err.slice(-1500)}`))));
  });
  return times.map((t) => path.join(outDir, `frame_${String(Math.round(t * 1000)).padStart(7, '0')}.jpg`));
}
