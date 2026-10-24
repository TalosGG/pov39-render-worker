/**
 * Font resolution module for the render worker.
 *
 * Resolves font_id references from edit plans to actual font files
 * that can be used by FFmpeg's libass subtitles filter.
 *
 * This module fetches font files from the Base44 app's fontManager function
 * (which validates workspace access) and downloads them to a local temp directory
 * for FFmpeg to use via the `fontsdir` option in the subtitles filter.
 *
 * SECURITY: Font files are only fetched from trusted private storage (media.base44.com)
 * using bearer token authentication. User-supplied font filenames or metadata are
 * never executed as shell commands. Font files are never installed globally.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { JobError } from '../errors.js';

const FONT_CACHE_DIR = path.join(process.env.WORK_DIR || '/tmp', 'font-cache');

/**
 * Ensure the font cache directory exists.
 */
async function ensureCacheDir() {
  await fs.mkdir(FONT_CACHE_DIR, { recursive: true });
  return FONT_CACHE_DIR;
}

/**
 * Resolve a list of font_ids to local font file paths.
 *
 * @param {string[]} fontIds - Array of font_id strings (e.g. 'cat:uuid', 'custom:uuid')
 * @param {object} options
 * @param {string} options.appUrl - Base44 app URL for the fontManager function
 * @param {string} options.serviceToken - Bearer token for authentication
 * @returns {Promise<object>} Map of font_id → { localPath, fontFamily, source }
 */
export async function resolveFonts(fontIds, { appUrl, serviceToken }) {
  if (!fontIds || !fontIds.length) return { fonts: {}, errors: [] };

  await ensureCacheDir();
  const fonts = {};
  const errors = [];

  // Deduplicate
  const uniqueIds = [...new Set(fontIds.filter(Boolean))];

  for (const fontId of uniqueIds) {
    try {
      // Call the Base44 fontManager function to resolve the font_id
      const response = await fetch(`${appUrl}/functions/fontManager`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({
          action: 'resolve',
          font_ids: [fontId],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        errors.push({ font_id: fontId, error: `Resolution failed: HTTP ${response.status}` });
        continue;
      }

      const data = await response.json();
      const resolved = data.resolved?.[0];

      if (!resolved) {
        const err = data.errors?.[0];
        errors.push({ font_id: fontId, error: err?.error || 'Font not found' });
        continue;
      }

      // Download the font file from private storage
      const assetUrl = resolved.asset_uri;
      if (!assetUrl) {
        errors.push({ font_id: fontId, error: 'No asset URI for font' });
        continue;
      }

      // Fetch the font file
      const fontResponse = await fetch(assetUrl, {
        headers: { 'Authorization': `Bearer ${serviceToken}` },
        signal: AbortSignal.timeout(30000),
      });

      if (!fontResponse.ok) {
        errors.push({ font_id: fontId, error: `Font download failed: HTTP ${fontResponse.status}` });
        continue;
      }

      const buffer = Buffer.from(await fontResponse.arrayBuffer());

      // Validate: check magic bytes (TTF or OTF)
      const isTTF = buffer.length >= 4 &&
        (buffer.readUInt32BE(0) === 0x00010000 || buffer.readUInt32BE(0) === 0x74727565);
      const isOTF = buffer.length >= 4 &&
        buffer.toString('ascii', 0, 4) === 'OTTO';

      if (!isTTF && !isOTF) {
        errors.push({ font_id: fontId, error: 'Downloaded file is not a valid TTF/OTF font' });
        continue;
      }

      // Write to cache with a safe filename (hash, never user-supplied name)
      const safeName = `${crypto.createHash('sha256').update(fontId).digest('hex').slice(0, 16)}.${isOTF ? 'otf' : 'ttf'}`;
      const localPath = path.join(FONT_CACHE_DIR, safeName);
      await fs.writeFile(localPath, buffer);

      fonts[fontId] = {
        localPath,
        fontFamily: resolved.font_family,
        source: resolved.source,
      };
    } catch (error) {
      errors.push({ font_id: fontId, error: String(error?.message || error) });
    }
  }

  return { fonts, errors };
}

/**
 * Extract all font_ids from a render plan.
 * Looks at subtitle cues and any text overlay elements.
 */
export function extractFontIds(plan) {
  const ids = new Set();

  if (plan?.cues) {
    for (const cue of plan.cues) {
      if (cue.subtitle_font_id) ids.add(cue.subtitle_font_id);
      if (cue.font_id) ids.add(cue.font_id);
    }
  }

  if (plan?.segments) {
    for (const segment of plan.segments) {
      if (segment.text_overlays) {
        for (const overlay of segment.text_overlays) {
          if (overlay.font_id) ids.add(overlay.font_id);
        }
      }
    }
  }

  if (plan?.subtitle_font_id) {
    ids.add(plan.subtitle_font_id);
  }

  return [...ids];
}

/**
 * Returns the font directory path for FFmpeg's fontsdir option.
 */
export function getFontDir() {
  return FONT_CACHE_DIR;
}