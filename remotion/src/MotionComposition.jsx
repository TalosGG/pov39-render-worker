import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import Background from './components/Background.jsx';
import SceneFrame from './components/SceneFrame.jsx';
import { useBrandFonts, fontStack } from './useBrandFonts.js';
import { sceneFrames } from './format.js';

const BED = 'bed-neutral.wav';

/**
 * The POV39 motion composition. It receives one validated composition object and
 * renders it: animated scenes, animated typography, brand lockup and a progress
 * line. No scene can supply code, markup or CSS — only the fields the validator
 * accepts.
 */
export default function MotionComposition({ composition }) {
  const { fps } = useVideoConfig();
  useBrandFonts(composition?.theme?.fonts);

  const theme = composition?.theme || {};
  const scenes = Array.isArray(composition?.scenes) ? composition.scenes : [];
  const audio = composition?.audio || {};

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background || '#0B0B0F' }}>
      <Background theme={theme} />

      {audio.enabled !== false && (
        <Audio src={staticFile(audio.file || BED)} loop volume={Number.isFinite(Number(audio.volume)) ? Number(audio.volume) : 0.4} />
      )}

      {scenes.map((scene, index) => {
        const from = scenes.slice(0, index).reduce((sum, item) => sum + sceneFrames(item, fps), 0);
        return (
          <Sequence key={scene?.id || `scene-${index}`} from={from} durationInFrames={sceneFrames(scene, fps)}>
            <SceneFrame scene={scene} theme={theme} />
          </Sequence>
        );
      })}

      <BrandLockup theme={theme} brand={composition?.brand} />
      <ProgressLine theme={theme} />
    </AbsoluteFill>
  );
}

function BrandLockup({ theme, brand }) {
  const frame = useCurrentFrame();
  const opacity = Math.min(1, Math.max(0, (frame - 8) / 14));
  const label = brand?.name || theme?.brand_name || '';
  if (!label && !brand?.logo_url) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 78,
        left: 96,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        opacity,
      }}
    >
      {brand?.logo_url ? (
        <Img src={brand.logo_url} style={{ height: 54, objectFit: 'contain' }} />
      ) : null}
      {label ? (
        <span
          style={{
            fontFamily: fontStack(theme),
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: theme?.muted || 'rgba(255,255,255,0.72)',
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

function ProgressLine({ theme }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 0;
  return (
    <div style={{ position: 'absolute', left: 96, right: 96, bottom: 74 }}>
      <div style={{ height: 5, borderRadius: 99, background: 'rgba(255,255,255,0.12)' }}>
        <div
          style={{
            height: 5,
            width: `${Math.max(0.01, progress) * 100}%`,
            borderRadius: 99,
            background: theme?.accent || '#8FA6FF',
          }}
        />
      </div>
    </div>
  );
}