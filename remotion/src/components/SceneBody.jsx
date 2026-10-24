import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import AnimatedText, { RevealItem } from './AnimatedText.jsx';
import { fontStack } from '../useBrandFonts.js';

/**
 * Renders one scene according to its declared layout and kind. Everything is
 * read from validated data: no scene can inject markup, styles or behaviour.
 */
export default function SceneBody({ scene, theme }) {
  const layout = scene?.layout || defaultLayout(scene?.kind);
  const body = {
    centered: LayoutCentered,
    lower_third: LayoutLowerThird,
    split: LayoutSplit,
    grid: LayoutGrid,
    full_text: LayoutFullText,
  }[layout] || LayoutCentered;

  const Component = body;
  return <Component scene={scene} theme={theme} />;
}

const defaultLayout = (kind) =>
  ({ cta: 'centered', logo: 'centered', stat: 'split', feature: 'grid' }[kind] || 'lower_third');

const textStyle = (theme, size, weight = 700, color) => ({
  fontFamily: fontStack(theme),
  fontSize: size,
  fontWeight: weight,
  lineHeight: 1.08,
  letterSpacing: '-0.02em',
  color: color || theme?.text || '#FFFFFF',
});

function Kicker({ scene, theme, delay = 0 }) {
  if (!scene?.kicker) return null;
  return (
    <div style={{ marginBottom: 26 }}>
      <AnimatedText
        text={scene.kicker}
        motion="fade"
        delay={delay}
        style={{
          ...textStyle(theme, 34, 600, theme?.accent || '#8FA6FF'),
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
        }}
      />
    </div>
  );
}

function Bullets({ scene, theme, delay = 12, columns = 1 }) {
  const bullets = Array.isArray(scene?.bullets) ? scene.bullets.slice(0, 6) : [];
  if (!bullets.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: columns === 2 ? '1fr 1fr' : '1fr', gap: 22, marginTop: 40 }}>
      {bullets.map((bullet, index) => (
        <RevealItem key={bullet} index={index} delay={delay}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: theme?.accent || '#8FA6FF',
                flexShrink: 0,
              }}
            />
            <span style={{ ...textStyle(theme, 36, 500, theme?.muted || '#C9D2E8'), lineHeight: 1.25 }}>{bullet}</span>
          </div>
        </RevealItem>
      ))}
    </div>
  );
}

function Cta({ scene, theme }) {
  if (!scene?.cta_label) return null;
  const frame = useCurrentFrame();
  const pulse = 1 + Math.sin(frame / 14) * 0.012;
  return (
    <RevealItem delay={26}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          marginTop: 54,
          padding: '30px 54px',
          borderRadius: 999,
          background: theme?.primary || theme?.accent || '#4763FF',
          transform: `scale(${pulse})`,
        }}
      >
        <span style={{ ...textStyle(theme, 38, 700, theme?.on_primary || '#FFFFFF') }}>{scene.cta_label}</span>
      </div>
    </RevealItem>
  );
}

function Stat({ scene, theme }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const target = Number(scene?.stat?.value);
  const suffix = scene?.stat?.suffix || '';
  if (!Number.isFinite(target)) return null;
  const progress = Math.min(1, Math.max(0, (frame - 18) / (fps * 0.9)));
  const shown = Math.round(interpolate(progress, [0, 1], [0, target]));
  return (
    <div style={{ marginTop: 46 }}>
      <span style={{ ...textStyle(theme, 190, 800, theme?.accent || '#8FA6FF'), letterSpacing: '-0.05em' }}>
        {shown}
        {suffix}
      </span>
      {scene.stat.label && (
        <p style={{ ...textStyle(theme, 34, 500, theme?.muted || '#C9D2E8'), marginTop: 10 }}>{scene.stat.label}</p>
      )}
    </div>
  );
}

function LayoutCentered({ scene, theme }) {
  return (
    <Center>
      <div style={{ textAlign: 'center', maxWidth: 900 }}>
        <Kicker scene={scene} theme={theme} />
        <h1 style={{ ...textStyle(theme, 104), margin: 0 }}>
          <AnimatedText text={scene?.headline} delay={6} motion={scene?.motion || 'rise'} emphasis={scene?.emphasis_words} emphasisColor={theme?.accent} />
        </h1>
        {scene?.subheadline && (
          <p style={{ ...textStyle(theme, 40, 400, theme?.muted || '#C9D2E8'), marginTop: 34, lineHeight: 1.35 }}>
            <AnimatedText text={scene.subheadline} delay={22} motion="fade" stagger={2} />
          </p>
        )}
        <Bullets scene={scene} theme={theme} />
        <Cta scene={scene} theme={theme} />
      </div>
    </Center>
  );
}

function LayoutLowerThird({ scene, theme }) {
  return (
    <Absolute>
      <div style={{ position: 'absolute', left: 96, right: 96, bottom: 320 }}>
        <div style={{ width: 120, height: 8, borderRadius: 99, background: theme?.accent || '#8FA6FF', marginBottom: 34 }} />
        <Kicker scene={scene} theme={theme} />
        <h1 style={{ ...textStyle(theme, 92), margin: 0 }}>
          <AnimatedText text={scene?.headline} delay={4} motion={scene?.motion || 'rise'} emphasis={scene?.emphasis_words} emphasisColor={theme?.accent} />
        </h1>
        {scene?.subheadline && (
          <p style={{ ...textStyle(theme, 38, 400, theme?.muted || '#C9D2E8'), marginTop: 30, lineHeight: 1.35 }}>
            <AnimatedText text={scene.subheadline} delay={20} motion="fade" stagger={2} />
          </p>
        )}
        <Bullets scene={scene} theme={theme} />
        <Cta scene={scene} theme={theme} />
      </div>
    </Absolute>
  );
}

function LayoutFullText({ scene, theme }) {
  return (
    <Center>
      <div style={{ maxWidth: 940 }}>
        <Kicker scene={scene} theme={theme} />
        <h1 style={{ ...textStyle(theme, 74, 600), margin: 0, lineHeight: 1.24 }}>
          <AnimatedText text={scene?.headline} delay={6} motion={scene?.motion || 'typewriter'} />
        </h1>
        <Bullets scene={scene} theme={theme} />
        <Cta scene={scene} theme={theme} />
      </div>
    </Center>
  );
}

function LayoutSplit({ scene, theme }) {
  const isStat = scene?.kind === 'stat' || Number.isFinite(Number(scene?.stat?.value));
  return (
    <Center>
      <div style={{ display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: 60, alignItems: 'center', width: '100%', padding: '0 96px' }}>
        <div>
          <Kicker scene={scene} theme={theme} />
          <h1 style={{ ...textStyle(theme, 82), margin: 0 }}>
            <AnimatedText text={scene?.headline} delay={4} motion={scene?.motion || 'rise'} emphasis={scene?.emphasis_words} emphasisColor={theme?.accent} />
          </h1>
          {scene?.subheadline && (
            <p style={{ ...textStyle(theme, 36, 400, theme?.muted || '#C9D2E8'), marginTop: 28, lineHeight: 1.35 }}>
              <AnimatedText text={scene.subheadline} delay={18} motion="fade" stagger={2} />
            </p>
          )}
          <Bullets scene={scene} theme={theme} />
        </div>
        <div>
          {isStat ? (
            <Stat scene={scene} theme={theme} />
          ) : (
            <RevealItem delay={14}>
              <div
                style={{
                  borderRadius: 32,
                  padding: 40,
                  border: `1px solid ${theme?.border || 'rgba(255,255,255,0.14)'}`,
                  background: theme?.surface || 'rgba(255,255,255,0.05)',
                }}
              >
                <span style={{ ...textStyle(theme, 34, 500, theme?.muted || '#C9D2E8'), lineHeight: 1.4 }}>
                  {scene?.subheadline || scene?.headline}
                </span>
              </div>
            </RevealItem>
          )}
        </div>
      </div>
      <Cta scene={scene} theme={theme} />
    </Center>
  );
}

function LayoutGrid({ scene, theme }) {
  return (
    <Center>
      <div style={{ width: '100%', padding: '0 96px', textAlign: 'center' }}>
        <Kicker scene={scene} theme={theme} />
        <h1 style={{ ...textStyle(theme, 88), margin: 0 }}>
          <AnimatedText text={scene?.headline} delay={4} motion={scene?.motion || 'rise'} emphasis={scene?.emphasis_words} emphasisColor={theme?.accent} />
        </h1>
        <Bullets scene={scene} theme={theme} delay={16} columns={2} />
        <Cta scene={scene} theme={theme} />
      </div>
    </Center>
  );
}

function Center({ children }) {
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 40px' }}>{children}</div>;
}

function Absolute({ children }) {
  return <div style={{ position: 'absolute', inset: 0 }}>{children}</div>;
}