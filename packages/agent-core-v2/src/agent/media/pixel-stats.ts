/**
 * `media` domain — sampled pixel statistics for delegated image inspection.
 *
 * Extracts ground-truth geometry and color facts from an image file so a
 * visual-model inspection — and the caller model relaying it — can report
 * exact values instead of approximations. Decodes through the shared jimp
 * path owned by `image-compress` (`decodeToJimp`), sampling a bounded number
 * of pixels rather than scanning every one, and fails soft (returns null)
 * when the file cannot be decoded or would exceed the shared decode
 * guardrails: pixel statistics are a quality enhancement on the delegated
 * `ReadMediaFile` path, never a delivery requirement.
 */

import { decodeToJimp, MAX_DECODE_PIXELS } from './image-compress';
import { normalizeImageMime } from './image-format-policy';
import { sniffImageDimensions } from './file-type';

const MAX_PIXEL_STATS_SAMPLES = 200_000;

export interface PixelStats {
  /** Decoded (display-space) width in pixels. */
  readonly width: number;
  /** Decoded (display-space) height in pixels. */
  readonly height: number;
  /** How many pixels were actually sampled for the color analysis. */
  readonly sampledPixels: number;
  /** Number of distinct RGB colors found among the sampled pixels. */
  readonly distinctColors: number;
  /** Most frequent sampled color, when at least one pixel was sampled. */
  readonly dominantColor:
    | { readonly r: number; readonly g: number; readonly b: number; readonly hex: string }
    | undefined;
  /** True when every sampled pixel shares a single color (a solid image). */
  readonly flat: boolean;
  /** True when any sampled pixel is not fully opaque (alpha < 255). */
  readonly hasAlpha: boolean;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

export async function extractPixelStats(
  bytes: Uint8Array,
  mimeType: string,
): Promise<PixelStats | null> {
  try {
    const dims = sniffImageDimensions(bytes);
    if (dims === null) return null;
    if (dims.width * dims.height > MAX_DECODE_PIXELS) return null;

    const image = await decodeToJimp(bytes, normalizeImageMime(mimeType));
    const width = image.width;
    const height = image.height;
    const bitmap = image.bitmap.data;
    const totalPixels = width * height;
    if (totalPixels === 0) return null;

    const stride = Math.max(1, Math.ceil(totalPixels / MAX_PIXEL_STATS_SAMPLES));
    const distinct = new Set<number>();
    const counts = new Map<number, number>();
    let sampled = 0;
    let hasAlpha = false;
    let dominantKey = 0;
    let dominantCount = 0;
    for (let i = 0; i < totalPixels; i += stride) {
      const offset = i * 4;
      const r = bitmap[offset]!;
      const g = bitmap[offset + 1]!;
      const b = bitmap[offset + 2]!;
      const a = bitmap[offset + 3]!;
      if (a < 255) hasAlpha = true;
      const key = (r << 16) | (g << 8) | b;
      if (!distinct.has(key)) distinct.add(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > dominantCount) {
        dominantCount = count;
        dominantKey = key;
      }
      sampled++;
    }

    const r = (dominantKey >> 16) & 0xff;
    const g = (dominantKey >> 8) & 0xff;
    const b = dominantKey & 0xff;
    return {
      width,
      height,
      sampledPixels: sampled,
      distinctColors: distinct.size,
      dominantColor: {
        r,
        g,
        b,
        hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
      },
      flat: distinct.size <= 1,
      hasAlpha,
    };
  } catch {
    return null;
  }
}
