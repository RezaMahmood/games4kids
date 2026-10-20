import type { PbnResult } from './pbn';
import type { Raster } from './types';

const BOUNDARY_RGB = [40, 44, 56] as const;

/** Nearest-neighbour stretch of `src` to `width` x `height`. */
export function resample(src: Raster, width: number, height: number): Raster {
  const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width));
      const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height));
      out.data.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return out;
}

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** The picture painted with each region's palette colour, boundaries in dark ink: what a finished page looks like. */
export function painted({ regions, pbn }: PbnResult): Raster {
  const byId = new Map(pbn.regions.map((r) => [r.id, hexRgb(pbn.palette[r.colorIndex]!)]));
  const out = { ...regions, data: new Uint8ClampedArray(regions.data) };
  for (let i = 0; i < regions.width * regions.height; i++) {
    const id = (regions.data[i * 4]! << 8) | regions.data[i * 4 + 1]!;
    out.data.set([...(byId.get(id) ?? BOUNDARY_RGB), 255], i * 4);
  }
  return out;
}
