import { newRaster, type Raster } from './types';

export type Rgb = readonly [number, number, number];

export function solid(width: number, height: number, colour: Rgb): Raster {
  const img = newRaster(width, height);
  for (let i = 0; i < width * height; i++) img.data.set([...colour, 255], i * 4);
  return img;
}

export function fill(img: Raster, inside: (x: number, y: number) => boolean, colour: Rgb): Raster {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) if (inside(x, y)) img.data.set([...colour, 255], (y * img.width + x) * 4);
  }
  return img;
}

export const rect = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

export const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

export function pixelAt(img: Raster, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

export function regionIdAt(regions: Raster, x: number, y: number): number {
  const [r, g] = pixelAt(regions, x, y);
  return r! * 256 + g!;
}

export const BLOB_CENTRES = [[90, 150], [170, 150], [250, 150], [330, 150]] as const;
export const BLOB_RADIUS = 46;

/**
 * Four overlapping discs in a row on pale paper, like petals: soft edges, a faint soft shadow, sensor
 * noise, and the third disc covered in short cream strokes like the stamens of a flower.
 */
export function touchingBlobs(): Raster {
  const w = 420;
  const h = 300;
  const rand = noise(11);
  const img = solid(w, h, [236, 234, 238]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const shade = 24 * Math.exp(-(((x - 215) / 170) ** 2) - ((y - 185) / 70) ** 2);
      for (let c = 0; c < 3; c++) img.data[(y * w + x) * 4 + c]! -= shade;
    }
  }
  const colours: Rgb[] = [[205, 70, 130], [232, 170, 200], [226, 205, 60], [190, 60, 120]];
  BLOB_CENTRES.forEach(([cx, cy], b) => fill(img, disc(cx, cy, BLOB_RADIUS), colours[b]!));
  const [sx, sy] = BLOB_CENTRES[2];
  for (let n = 0; n < 260; n++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * (BLOB_RADIUS - 6);
    const x0 = sx + r * Math.cos(a);
    const y0 = sy + r * Math.sin(a);
    const t = rand() * Math.PI;
    for (let s = 0; s < 7; s++) fill(img, disc(x0 + s * Math.cos(t), y0 + s * Math.sin(t), 0.9), [245, 236, 200]);
  }
  // Soft edges from a plain 5x5 mean, so the fixture does not lean on the blur the outline itself uses.
  const sharp = Uint8ClampedArray.from(img.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const grain = (rand() - 0.5) * 10;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += sharp[(Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4 + c]!;
        img.data[(y * w + x) * 4 + c] = sum / 25 + grain;
      }
    }
  }
  return img;
}

/** Deterministic pseudo-random bytes so noisy fixtures never flake. */
export function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
