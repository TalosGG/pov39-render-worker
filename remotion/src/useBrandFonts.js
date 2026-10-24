import React, { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';

/**
 * Registers the brand's @font-face rules before the first frame is captured.
 * `theme.fonts` is [{ family, weights: [{ weight, style, url, format }] }]; the
 * worker downloads those files into the project's public folder, so `url` is a
 * bundle-relative path. No fonts means the composition renders with the system
 * stack instead of failing.
 */
export function useBrandFonts(fonts) {
  const [handle] = useState(() => delayRender('brand-fonts'));
  const key = JSON.stringify(fonts || []);

  useEffect(() => {
    const list = Array.isArray(fonts) ? fonts : [];
    try {
      if (list.length) {
        const css = list
          .flatMap((font) =>
            (Array.isArray(font?.weights) ? font.weights : []).map(
              (w) =>
                `@font-face{font-family:'${font.family}';font-style:${w?.style || 'normal'};font-weight:${w?.weight || 400};` +
                `src:url('${w?.url}') format('${w?.format || 'woff2'}');font-display:block;}`,
            ),
          )
          .join('\n');
        const style = document.createElement('style');
        style.id = 'pov39-brand-fonts';
        style.textContent = css;
        document.head.appendChild(style);
      }

      const families = list.map((font) => font?.family).filter(Boolean);
      const loading = families.length
        ? Promise.all(families.map((family) => document.fonts.load(`400 16px "${family}"`).catch(() => null)))
        : Promise.resolve([]);

      loading.then(() => document.fonts.ready).then(() => continueRender(handle)).catch(() => continueRender(handle));
    } catch {
      continueRender(handle);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Font stack for a role, falling back to a clean system stack. */
export function fontStack(theme) {
  const families = [];
  if (theme?.font_heading_family) families.push(`'${theme.font_heading_family}'`);
  if (theme?.font_body_family) families.push(`'${theme.font_body_family}'`);
  families.push('Inter', 'Helvetica Neue', 'Arial', 'sans-serif');
  return Array.from(new Set(families)).join(', ');
}