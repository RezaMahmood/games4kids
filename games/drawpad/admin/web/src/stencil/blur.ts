/** Box widths whose three passes approximate a gaussian of `sigma` (Kovesi, "Fast almost-Gaussian filtering"). */
function boxWidths(sigma: number): number[] {
  const ideal = Math.sqrt(4 * sigma * sigma + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const lowerCount = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map((pass) => (pass < lowerCount ? lower : lower + 2));
}

/** One running-sum box pass along rows (`step` 1) or columns (`step` w), edge pixels clamped. */
function boxPass(src: Float32Array, w: number, h: number, r: number, alongRows: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const lines = alongRows ? h : w;
  const len = alongRows ? w : h;
  const step = alongRows ? 1 : w;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = alongRows ? line * w : line;
    const at = (k: number) => src[base + Math.min(len - 1, Math.max(0, k)) * step]!;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += at(k);
    for (let k = 0; k < len; k++) {
      out[base + k * step] = acc * norm;
      acc += at(k + r + 1) - at(k - r);
    }
  }
  return out;
}

/** Near-gaussian blur of a single float plane by three box passes each way, so the cost does not grow with sigma. */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  let out = src;
  for (const width of boxWidths(sigma)) {
    const r = (width - 1) / 2;
    if (r < 1) continue;
    out = boxPass(boxPass(out, w, h, r, true), w, h, r, false);
  }
  return out === src ? Float32Array.from(src) : out;
}
