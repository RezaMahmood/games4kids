import { skeletonize } from './lines';
import { dropShortPieces, pruneSpurs, thicken } from './outline';
import { clamp, newRaster, type Raster } from './types';

/** Lightest grey that can count as ink, so a faint haze is never split off as ink when lines are few. */
const INK_MAX = 160;
/** Below this share of ink the redraw is blank, not a drawing. */
const MIN_INK = 0.0005;

/** Luminance of `img` flattened onto white, bilinearly stretched to `w` x `h`. */
function luminance(img: Raster, w: number, h: number): Float32Array {
  const { width: sw, height: sh, data } = img;
  const src = new Float32Array(sw * sh);
  for (let i = 0; i < src.length; i++) {
    const a = data[i * 4 + 3]! / 255;
    src[i] = (0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!) * a + 255 * (1 - a);
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = clamp(((y + 0.5) * sh) / h - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp(((x + 0.5) * sw) / w - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const top = src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx;
      const bottom = src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** Otsu's threshold: the grey level that best splits the histogram into two classes. */
function otsu(lum: Float32Array): number {
  const hist = new Float64Array(256);
  for (const v of lum) hist[Math.round(v)]!++;
  let total = 0;
  for (let t = 0; t < 256; t++) total += t * hist[t]!;
  let below = 0, belowSum = 0, best = 0, bestScore = -1;
  for (let t = 0; t < 256; t++) {
    below += hist[t]!;
    belowSum += t * hist[t]!;
    const above = lum.length - below;
    if (below === 0 || above === 0) continue;
    const score = below * above * (belowSum / below - (total - belowSum) / above) ** 2;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Turns an image model's line-art redraw into a standard outline the size of the picture: dark ink on
 * transparent, lines about 3px wide. The redraw is stretched to fit, since it never registers with the photo anyway.
 */
export function outlineFromRedraw(redraw: Raster, width: number, height: number): Raster {
  const w = width;
  const h = height;
  const lum = luminance(redraw, w, h);
  const threshold = Math.min(otsu(lum), INK_MAX);
  const ink = new Uint8Array(w * h);
  let inked = 0;
  for (let i = 0; i < ink.length; i++) {
    if (lum[i]! <= threshold) {
      ink[i] = 1;
      inked++;
    }
  }
  if (inked < MIN_INK * w * h) return newRaster(w, h);

  const size = clamp(Math.max(w, h) / 1024, 0.25, 1);
  const line = skeletonize(ink, w, h);
  pruneSpurs(line, w, h, Math.round(15 * size));
  dropShortPieces(line, w, h, Math.round(30 * size));
  return thicken(line, w, h);
}
