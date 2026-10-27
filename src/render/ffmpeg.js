import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JobError } from '../errors.js';

export function run(cmd, args, { signal, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new JobError('canceled', 'The job was canceled.'));
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} exited with ${code}`), { stderr }));
    });
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(stdout);
}

export async function ffmpegVersion() {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-version']);
  return stdout.split('\n')[0].trim();
}

export async function decodesCleanly(file) {
  try {
    const { stderr } = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return !stderr.trim();
  } catch {
    return false;
  }
}

function atempoChain(speed) {
  const parts = [];
  let remaining = speed;
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  while (remaining > 2) { parts.push('atempo=2'); remaining /= 2; }
  if (Math.abs(remaining - 1) > 1e-6) parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts;
}

const srtTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/**
 * A filtergraph path: unchanged when it has nothing FFmpeg treats as syntax (every Linux
 * work path), quoted and escaped otherwise (a Windows drive colon, a quote).
 */
export function filterPath(file) {
  const value = String(file).replace(/\\/g, '/');
  return /[:'[\],;]/.test(value) ? `'${value.replace(/'/g, "'\\''").replace(/:/g, '\\:')}'` : value;
}

/** Writes the cues as SRT and returns the libass `subtitles=…` filter that burns them in. */
export async function subtitlesFilter(plan, workDir, fonts = {}) {
  const { height: h } = plan;
  const srt = plan.cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text.replace(/\r/g, '')}\n`)
    .join('\n');
  const srtPath = path.join(workDir, 'subtitles.srt');
  await fs.writeFile(srtPath, srt, 'utf8');
  const size = Math.round(h / 28);

  // Resolve the font for subtitles. If a subtitle_font_id is specified on the
  // plan or on individual cues, use the resolved font file. Otherwise fall back
  // to Noto Sans (which the worker must have installed).
  const planFontId = plan.subtitle_font_id;
  const resolvedFont = planFontId ? fonts[planFontId] : null;
  const fontName = resolvedFont?.fontFamily || 'Noto Sans';
  const fontDir = resolvedFont?.localPath ? path.dirname(resolvedFont.localPath) : null;

  // Build the subtitles filter with fontsdir if we have a resolved font file,
  // so libass can load the font even if it isn't system-installed.
  const subtitlesOpts = [`filename=${filterPath(srtPath)}`, `force_style='FontName=${fontName},FontSize=${size},Outline=2,MarginV=${Math.round(h / 12)}'`];
  if (fontDir) subtitlesOpts.push(`fontsdir=${filterPath(fontDir)}`);
  return `subtitles=${subtitlesOpts.join(':')}`;
}

/**
 * Renders the plan to an H.264 / AAC MP4 (yuv420p, faststart).
 * @param files   { [assetId]: { path, hasAudio } }
 * @param fonts   { [fontId]: { localPath, fontFamily } }  resolved font files
 * @param onProgress  0..1 of the encode
 */
export async function renderPlan(plan, files, { outFile, workDir, quality, signal, onProgress, fonts = {} }) {
  const { width: w, height: h, fps } = plan;
  const args = ['-hide_banner', '-nostdin', '-y'];
  const filters = [];
  const labels = [];
  let inputIndex = 0;

  plan.segments.forEach((segment, i) => {
    const d = segment.duration.toFixed(3);
    if (segment.type === 'gap') {
      filters.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${d},format=yuv420p,setsar=1[v${i}]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`);
    } else {
      const file = files[segment.asset];
      args.push('-ss', segment.sourceIn.toFixed(3), '-t', (segment.sourceDuration + 0.1).toFixed(3), '-i', file.path);
      const k = inputIndex++;
      const fade = segment.fadeIn > 0 ? `,fade=t=in:st=0:d=${segment.fadeIn.toFixed(3)}` : '';
      filters.push(
        `[${k}:v]setpts=(PTS-STARTPTS)/${segment.speed},fps=${fps},` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS${fade}[v${i}]`,
      );
      if (file.hasAudio) {
        const tempo = atempoChain(segment.speed);
        filters.push(
          `[${k}:a]${[...tempo, 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'].join(',')},` +
          `atrim=duration=${d},asetpts=PTS-STARTPTS,apad=whole_dur=${d}[a${i}]`,
        );
      } else {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`);
      }
    }
    labels.push(`[v${i}][a${i}]`);
  });

  filters.push(`${labels.join('')}concat=n=${plan.segments.length}:v=1:a=1[cv][ca]`);

  let videoOut = '[cv]';
  if (plan.cues.length) {
    filters.push(`[cv]${await subtitlesFilter(plan, workDir, fonts)}[sv]`);
    videoOut = '[sv]';
  }

  const master = quality === 'master';
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', videoOut, '-map', '[ca]',
    '-c:v', 'libx264', '-preset', master ? 'medium' : 'veryfast', '-crf', master ? '18' : '24',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', plan.duration.toFixed(3),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outFile,
  );

  let buffer = '';
  try {
    await run('ffmpeg', args, {
      signal,
      onStdout(text) {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (match && plan.duration > 0) onProgress(Math.min(1, Number(match[1]) / 1e6 / plan.duration));
        }
      },
    });
  } catch (error) {
    if (error instanceof JobError) throw error;
    console.error('[render] ffmpeg failed:', String(error.stderr || error.message).slice(-2000));
    throw new JobError('render_failed', 'The video encoder could not render this timeline.');
  }
}