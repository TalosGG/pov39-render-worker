import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * Brand background: a base gradient plus slow-drifting accent glows. Purely
 * declarative — the pattern, colours and intensity all come from the validated
 * composition's theme.
 */
export default function Background({ theme, seed = 0 }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const background = theme?.background || '#0B0B0F';
  const accent = theme?.accent || '#4763FF';
  const primary = theme?.primary || accent;
  const pattern = theme?.pattern || 'glow';
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;

  const drift = (offset, speed) => Math.sin((frame / (30 / speed)) + offset) * 6;

  return (
    <AbsoluteFill style={{ backgroundColor: background }}>
      <AbsoluteFill
        style={{
          background: `linear-gradient(160deg, ${background} 0%, ${shade(background, accent, 0.18)} 55%, ${background} 100%)`,
        }}
      />
      {pattern !== 'solid' && (
        <>
          <Glow color={primary} cx={`${50 + drift(0, 0.5)}%`} cy={`${22 + drift(1.4, 0.35)}%`} size={1100} opacity={0.5} />
          <Glow color={accent} cx={`${18 + drift(2.1, 0.4)}%`} cy={`${78 + drift(0.6, 0.3)}%`} size={900} opacity={0.42} />
        </>
      )}
      {pattern === 'grid' && <Grid color={theme?.muted || '#FFFFFF'} offset={progress * 60} />}
      {pattern === 'rays' && <Rays color={accent} progress={progress} />}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(120% 80% at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      <span style={{ display: 'none' }}>{seed}</span>
    </AbsoluteFill>
  );
}

function Glow({ color, cx, cy, size, opacity }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        width: size,
        height: size,
        transform: 'translate(-50%, -50%)',
        borderRadius: '50%',
        opacity,
        background: `radial-gradient(circle, ${withAlpha(color, 0.55)} 0%, ${withAlpha(color, 0)} 68%)`,
      }}
    />
  );
}

function Grid({ color, offset }) {
  const lines = [];
  for (let i = -2; i < 16; i += 1) {
    lines.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${(i * 140 + offset) % 1920}px`,
          height: 1,
          background: withAlpha(color, 0.06),
        }}
      />,
    );
  }
  return <AbsoluteFill>{lines}</AbsoluteFill>;
}

function Rays({ color, progress }) {
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${-20 + i * 34 + progress * 10}%`,
            top: '-30%',
            width: 220,
            height: '160%',
            transform: `rotate(${12 + i * 4}deg)`,
            background: `linear-gradient(180deg, ${withAlpha(color, 0)} 0%, ${withAlpha(color, 0.22)} 45%, ${withAlpha(color, 0)} 100%)`,
          }}
        />
      ))}
    </AbsoluteFill>
  );
}

function withAlpha(hex, alpha) {
  const rgb = parseHex(hex);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function shade(baseHex, otherHex, amount) {
  const a = parseHex(baseHex);
  const b = parseHex(otherHex);
  const mixed = a.map((channel, i) => Math.round(channel + (b[i] - channel) * amount));
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

function parseHex(hex) {
  const value = String(hex || '#000000').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.padEnd(6, '0').slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return [0, 0, 0];
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}