export type Raster = { data: Uint8ClampedArray; width: number; height: number };

export function newRaster(width: number, height: number): Raster {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export const INK = { r: 31, g: 36, b: 48 } as const;

export const MAX_EDGE = 1024;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
