/**
 * Frame/format maths for the POV39 motion composition.
 *
 * The composition is DATA, never code: this module is the only place that turns
 * scene durations into frame counts, and it clamps everything so a malformed
 * composition degrades instead of breaking the renderer.
 */

export const ALLOWED_FPS = [24, 25, 30, 50, 60];
export const DEFAULT_FPS = 30;
export const MAX_DURATION_SECONDS = 600;
export const MAX_SCENES = 24;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

export function sceneFrames(scene, fps) {
  const seconds = clamp(num(scene?.duration_seconds, 3), 0.5, 60);
  return Math.max(1, Math.round(seconds * fps));
}

/** Total frame count for a validated composition. */
export function durationInFrames(composition) {
  const fps = resolveFps(composition);
  const scenes = Array.isArray(composition?.scenes) ? composition.scenes.slice(0, MAX_SCENES) : [];
  const frames = scenes.reduce((sum, scene) => sum + sceneFrames(scene, fps), 0);
  return Math.max(1, Math.min(Math.round(MAX_DURATION_SECONDS * fps), frames));
}

export function resolveFps(composition) {
  const value = num(composition?.meta?.fps, DEFAULT_FPS);
  return ALLOWED_FPS.includes(value) ? value : DEFAULT_FPS;
}

export function resolveFormat(composition) {
  const out = composition?.meta?.output || composition?.meta || {};
  return {
    width: even(clamp(num(out.width, 1080), 144, 3840)),
    height: even(clamp(num(out.height, 1920), 144, 3840)),
    fps: resolveFps(composition),
  };
}

export function compositionDurationSeconds(composition) {
  const scenes = Array.isArray(composition?.scenes) ? composition.scenes : [];
  return scenes.reduce((sum, scene) => sum + clamp(num(scene?.duration_seconds, 3), 0.5, 60), 0);
}