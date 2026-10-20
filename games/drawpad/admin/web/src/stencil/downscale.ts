import { MAX_EDGE, newRaster, type Raster } from './types';

type Span = { start: number; weights: Float32Array };

// Area-weighted spans: output cell i covers source [i*ratio, (i+1)*ratio).
function spans(srcLen: number, dstLen: number): Span[] {
  const ratio = srcLen / dstLen;
  return Array.from({ length: dstLen }, (_, i) => {
    const from = i * ratio;
    const to = Math.min(srcLen, (i + 1) * ratio);
    const start = Math.floor(from);
    const end = Math.min(srcLen, Math.ceil(to));
    const weights = new Float32Array(end - start);
    let sum = 0;
    for (let s = start; s < end; s++) {
      const w = Math.min(s + 1, to) - Math.max(s, from);
      weights[s - start] = w;
      sum += w;
    }
    for (let k = 0; k < weights.length; k++) weights[k]! /= sum;
    return { start, weights };
  });
}

/** Box-filters so the long edge is at most `maxEdge`, and flattens transparency onto white. */
export function downscale(img: Raster, maxEdge = MAX_EDGE): Raster {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const xs = spans(w, ow);
  const ys = spans(h, oh);

  const rows = new Float32Array(ow * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      const { start, weights } = xs[x]!;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = (y * w + start + k) * 4;
        const a = data[i + 3]! / 255;
        const wt = weights[k]!;
        r += wt * (data[i]! * a + 255 * (1 - a));
        g += wt * (data[i + 1]! * a + 255 * (1 - a));
        b += wt * (data[i + 2]! * a + 255 * (1 - a));
      }
      const o = (y * ow + x) * 3;
      rows[o] = r;
      rows[o + 1] = g;
      rows[o + 2] = b;
    }
  }

  const out = newRaster(ow, oh);
  for (let y = 0; y < oh; y++) {
    const { start, weights } = ys[y]!;
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const o = ((start + k) * ow + x) * 3;
        const wt = weights[k]!;
        r += wt * rows[o]!;
        g += wt * rows[o + 1]!;
        b += wt * rows[o + 2]!;
      }
      const i = (y * ow + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return out;
}
