import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

const MOTION_IN = {
  rise: { from: 46, scale: 1 },
  fade: { from: 0, scale: 1 },
  scale: { from: 0, scale: 0.9 },
  typewriter: { from: 0, scale: 1 },
};

/**
 * Word-by-word animated typography. Every word gets its own spring on a stagger,
 * so the text genuinely moves frame over frame — this is the animated-typography
 * step of the composition.
 */
export default function AnimatedText({
  text,
  delay = 0,
  motion = 'rise',
  stagger = 3,
  style,
  emphasis = [],
  emphasisColor,
  wordGap = '0.26em',
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const value = String(text || '');
  if (!value) return null;

  if (motion === 'typewriter') {
    const characters = Math.max(0, Math.round((frame - delay) * 1.35));
    const shown = value.slice(0, characters);
    return <span style={style}>{shown}{characters < value.length ? '|' : ''}</span>;
  }

  const words = value.split(/\s+/);
  const preset = MOTION_IN[motion] || MOTION_IN.rise;
  return (
    <span style={{ ...style, display: 'inline' }}>
      {words.map((word, index) => {
        const local = frame - delay - index * stagger;
        const progress = spring({ frame: local, fps, config: { damping: 200, mass: 0.6, stiffness: 120 } });
        const settle = interpolate(progress, [0, 1], [0, 1], { extrapolateRight: 'clamp' });
        const emphasised = emphasis.map((item) => String(item).toLowerCase()).includes(word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase());
        return (
          <span
            key={`${word}-${index}`}
            style={{
              display: 'inline-block',
              marginRight: wordGap,
              opacity: settle,
              transform: `translateY(${(1 - settle) * preset.from}px) scale(${interpolate(settle, [0, 1], [preset.scale, 1])})`,
              color: emphasised && emphasisColor ? emphasisColor : undefined,
            }}
          >
            {word}
          </span>
        );
      })}
    </span>
  );
}

/** Staggered block reveal used for bullet lists and cards. */
export function RevealItem({ index = 0, delay = 0, children, stagger = 5, distance = 28 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay - index * stagger, fps, config: { damping: 200, mass: 0.7 } });
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${(1 - progress) * distance}px)`,
      }}
    >
      {children}
    </div>
  );
}