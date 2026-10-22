import fs from 'node:fs/promises';
import { probe, decodesCleanly } from './ffmpeg.js';

/** Walks top-level MP4 atoms: true when `moov` precedes `mdat` (web-streamable). */
async function moovBeforeMdat(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      await handle.read(header, 0, 16, offset);
      let atomSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (atomSize === 1) atomSize = Number(header.readBigUInt64BE(8));
      if (atomSize < 8) return false;
      offset += atomSize;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function validateOutput(file, plan) {
  const info = await probe(file);
  const video = info.streams?.find((s) => s.codec_type === 'video');
  const audio = info.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration) || 0;
  const tolerance = Math.max(0.5, plan.duration * 0.02);

  const checks = {
    container_mp4: /mp4/.test(info.format?.format_name || ''),
    has_video_stream: Boolean(video),
    video_codec_h264: video?.codec_name === 'h264',
    pixel_format_yuv420p: video?.pix_fmt === 'yuv420p',
    dimensions_match: video?.width === plan.width && video?.height === plan.height,
    has_audio_stream: Boolean(audio),
    audio_codec_aac: audio?.codec_name === 'aac',
    duration_match: Math.abs(duration - plan.duration) <= tolerance,
    faststart: await moovBeforeMdat(file),
    decodes_cleanly: await decodesCleanly(file),
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    expected: { width: plan.width, height: plan.height, fps: plan.fps, duration_seconds: Number(plan.duration.toFixed(3)) },
    actual: {
      width: video?.width || 0,
      height: video?.height || 0,
      frame_rate: video?.r_frame_rate || '',
      duration_seconds: duration,
      video_codec: video?.codec_name || '',
      audio_codec: audio?.codec_name || '',
      size_bytes: Number(info.format?.size) || 0,
      bit_rate: Number(info.format?.bit_rate) || 0,
    },
  };
}