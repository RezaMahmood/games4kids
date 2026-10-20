import type { Score } from '../../../../data/types';
import { buildScore, share } from './score';

export const TRACE_POINTS = { tracing: 35, colour: 25, coverage: 25, effort: 15 } as const;

export const OUTLINE_ALPHA_MIN = 128;
export const INK_ALPHA_MIN = 32;
export const TRACE_REACH_PX = 8;
export const COLOUR_CAP = 6;
export const COVERAGE_TARGET = 0.2;
export const STROKE_CAP = 30;
export const MIN_PIXELS_PER_COLOUR = 30;

export type TraceInput = {
  outlineAlpha: ArrayLike<number>;
  penAlpha: ArrayLike<number>;
  penColors: readonly number[];
  width: number;
  height: number;
  strokeCount: number;
};

export function scoreTrace(input: TraceInput): Score {
  const { outlineAlpha, penAlpha, width, height } = input;
  const inked = markInk(penAlpha);
  const near = dilate(inked, width, height, TRACE_REACH_PX);

  let outlinePixels = 0;
  let covered = 0;
  let inkPixels = 0;
  for (let i = 0; i < inked.length; i++) {
    inkPixels += inked[i]!;
    if ((outlineAlpha[i] ?? 0) > OUTLINE_ALPHA_MIN) {
      outlinePixels++;
      covered += near[i]!;
    }
  }

  const colours = new Set(input.penColors).size;
  return buildScore({
    tracing: TRACE_POINTS.tracing * share(covered, outlinePixels),
    colour: TRACE_POINTS.colour * share(colours, COLOUR_CAP),
    coverage: TRACE_POINTS.coverage * share(inkPixels / (width * height), COVERAGE_TARGET),
    effort: TRACE_POINTS.effort * share(input.strokeCount, STROKE_CAP),
  });
}

export type Rgb = readonly [number, number, number];

/**
 * The colours the player drew with, as packed RGB: any colour with enough solid pixels, from the palette or the colour
 * wheel. Pen strokes are solid, so their antialiased, blended edges never count as colours of their own.
 */
export function usedColours(rgba: ArrayLike<number>): number[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) continue;
    const rgb = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!;
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  return [...counts].flatMap(([rgb, n]) => (n >= MIN_PIXELS_PER_COLOUR ? [rgb] : []));
}

export function alphaOf(rgba: ArrayLike<number>): Uint8Array {
  const alpha = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return alpha;
}

function markInk(alpha: ArrayLike<number>): Uint8Array {
  const ink = new Uint8Array(alpha.length);
  for (let i = 0; i < ink.length; i++) ink[i] = alpha[i]! > INK_ALPHA_MIN ? 1 : 0;
  return ink;
}

// Square window dilation in two sliding-count passes, O(width * height) for any radius.
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const wide = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++) count += mask[row + x]!;
    for (let x = 0; x < width; x++) {
      wide[row + x] = count > 0 ? 1 : 0;
      if (x + radius + 1 < width) count += mask[row + x + radius + 1]!;
      if (x - radius >= 0) count -= mask[row + x - radius]!;
    }
  }

  const out = new Uint8Array(mask.length);
  const counts = new Int32Array(width);
  for (let y = 0; y <= Math.min(radius, height - 1); y++) {
    for (let x = 0; x < width; x++) counts[x]! += wide[y * width + x]!;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = counts[x]! > 0 ? 1 : 0;
    const add = y + radius + 1;
    const drop = y - radius;
    for (let x = 0; x < width; x++) {
      if (add < height) counts[x]! += wide[add * width + x]!;
      if (drop >= 0) counts[x]! -= wide[drop * width + x]!;
    }
  }
  return out;
}
