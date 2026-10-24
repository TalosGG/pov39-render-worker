import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import SceneBody from './SceneBody.jsx';
import { sceneFrames } from '../format.js';

const TRANSITIONS = ['fade', 'slide', 'wipe', 'cut'];

/**
 * Scene wrapper: applies the scene's declared transition in and out. The
 * transition set is a fixed enum — a composition can choose one, never define
 * its own.
 */
export default function SceneFrame({ scene, theme }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const total = sceneFrames(scene, fps);
  const transition = TRANSITIONS.includes(scene?.transition?.type) ? scene.transition.type : 'fade';
  const transitionFrames = Math.max(1, Math.round(Math.min(1.2, Number(scene?.transition?.duration_seconds) || 0.5) * fps));

  const enter = interpolate(frame, [0, transitionFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const exit = interpolate(frame, [total - transitionFrames, total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const presence = Math.min(enter, exit);

  const style = { opacity: 1 };
  if (transition === 'fade') style.opacity = presence;
  if (transition === 'slide') {
    style.opacity = Math.min(1, presence * 1.6);
    style.transform = `translateX(${interpolate(enter, [0, 1], [110, 0]) + interpolate(exit, [0, 1], [0, -110])}px)`;
  }
  if (transition === 'wipe') {
    style.clipPath = `inset(0 ${interpolate(Math.min(enter, exit), [0, 1], [100, 0])}% 0 0)`;
  }

  return (
    <AbsoluteFill style={style}>
      <SceneBody scene={scene} theme={theme} />
    </AbsoluteFill>
  );
}