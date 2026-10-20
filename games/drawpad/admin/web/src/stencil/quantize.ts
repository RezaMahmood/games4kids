import { newRaster, type Raster } from './types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edge-preserving smoothing: neighbours count less the further they differ in colour. */
export function bilateral(img: Raster, radius: number, rangeSigma: number, passes: number): Raster {
  const { width: w, height: h } = img;
  const side = radius * 2 + 1;
  const spatial = new Float32Array(side * side);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial[(dy + radius) * side + dx + radius] = Math.exp(-(dx * dx + dy * dy) / (2 * (radius / 1.5) ** 2));
    }
  }
  const range = new Float32Array(766);
  for (let d = 0; d < range.length; d++) range[d] = Math.exp(-((d / 3) ** 2) / (2 * rangeSigma * rangeSigma));

  let src = img;
  for (let pass = 0; pass < passes; pass++) {
    const out = newRaster(w, h);
    const s = src.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = (y * w + x) * 4;
        const r0 = s[c]!, g0 = s[c + 1]!, b0 = s[c + 2]!;
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const n = (yy * w + xx) * 4;
            const r = s[n]!, g = s[n + 1]!, b = s[n + 2]!;
            const wt = spatial[(dy + radius) * side + dx + radius]! * range[Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)]!;
            sr += wt * r;
            sg += wt * g;
            sb += wt * b;
            sw += wt;
          }
        }
        out.data[c] = sr / sw;
        out.data[c + 1] = sg / sw;
        out.data[c + 2] = sb / sw;
        out.data[c + 3] = 255;
      }
    }
    src = out;
  }
  return src;
}

const toLinear = new Float32Array(256).map((_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear[r]!, lg = toLinear[g]!, lb = toLinear[b]!;
  const fx = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const fy = labF(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = labF((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function toLab(img: Raster): Float32Array {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToLab(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
    lab[i * 3] = l;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }
  return lab;
}

const dist2 = (a: Float32Array, i: number, c: Float32Array, j: number) =>
  (a[i]! - c[j]!) ** 2 + (a[i + 1]! - c[j + 1]!) ** 2 + (a[i + 2]! - c[j + 2]!) ** 2;

function nearest(lab: Float32Array, i: number, centres: Float32Array, k: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < k; c++) {
    const d = dist2(lab, i, centres, c * 3);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** k-means++ seeding then Lloyd iterations on an evenly strided sample of pixels. Seeded, so the same image gives the same palette. */
function fitCentres(lab: Float32Array, k: number, rng: () => number): Float32Array {
  const stride = Math.max(1, Math.ceil(lab.length / 3 / 40000));
  const sample: number[] = [];
  for (let p = 0; p < lab.length / 3; p += stride) sample.push(p * 3);

  const centres = new Float32Array(k * 3);
  const setCentre = (c: number, at: number) => centres.set(lab.subarray(at, at + 3), c * 3);
  setCentre(0, sample[Math.floor(rng() * sample.length)]!);
  const d2 = new Float64Array(sample.length).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let s = 0; s < sample.length; s++) {
      d2[s] = Math.min(d2[s]!, dist2(lab, sample[s]!, centres, (c - 1) * 3));
      total += d2[s]!;
    }
    let target = rng() * total;
    let pick = sample.length - 1;
    for (let s = 0; s < sample.length; s++) {
      target -= d2[s]!;
      if (target <= 0) {
        pick = s;
        break;
      }
    }
    setCentre(c, sample[pick]!);
  }

  const owner = new Int32Array(sample.length).fill(-1);
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    const sum = new Float64Array(k * 3);
    const count = new Float64Array(k);
    for (let s = 0; s < sample.length; s++) {
      const c = nearest(lab, sample[s]!, centres, k);
      if (c !== owner[s]) moved = true;
      owner[s] = c;
      count[c]! += 1;
      for (let a = 0; a < 3; a++) sum[c * 3 + a]! += lab[sample[s]! + a]!;
    }
    if (!moved) break;
    for (let c = 0; c < k; c++) {
      if (!count[c]) continue;
      for (let a = 0; a < 3; a++) centres[c * 3 + a] = sum[c * 3 + a]! / count[c]!;
    }
  }
  return centres;
}

/** Colour cluster index per pixel. Clusters that attract no pixels are simply never used. */
export function quantize(lab: Float32Array, k: number, seed = 1): Uint8Array {
  const centres = fitCentres(lab, k, mulberry32(seed));
  const n = lab.length / 3;
  const labels = new Uint8Array(n);
  for (let p = 0; p < n; p++) labels[p] = nearest(lab, p * 3, centres, k);
  return labels;
}

/** Majority vote in a 3x3 window removes single-pixel colour noise along cluster borders. */
export function majority(labels: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(labels.length);
  const votes = new Uint8Array(k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      votes.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          votes[labels[yy * w + xx]!]! += 1;
        }
      }
      const own = labels[y * w + x]!;
      let best = own;
      for (let c = 0; c < k; c++) if (votes[c]! > votes[best]!) best = c;
      out[y * w + x] = best;
    }
  }
  return out;
}
