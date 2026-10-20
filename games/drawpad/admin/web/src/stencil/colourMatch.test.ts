import { describe, expect, it } from 'vitest';
import { painted, resample } from './colourMatch';
import type { PbnResult } from './pbn';
import type { Raster } from './types';

function fill(width: number, height: number, rgb: (x: number, y: number) => number[]): Raster {
  const img: Raster = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) img.data.set([...rgb(x, y), 255], (y * width + x) * 4);
  return img;
}

const halves = (width: number, height: number) => fill(width, height, (x) => (x < width / 2 ? [200, 40, 40] : [40, 60, 200]));

describe('resample', () => {
  it('stretches to the new size keeping each half its colour', () => {
    const out = resample(halves(4, 2), 8, 6);
    expect([out.width, out.height]).toEqual([8, 6]);
    expect([...out.data.subarray(0, 4)]).toEqual([200, 40, 40, 255]);
    expect([...out.data.subarray((5 * 8 + 7) * 4, (5 * 8 + 7) * 4 + 4)]).toEqual([40, 60, 200, 255]);
  });
});

describe('painted', () => {
  it('paints each region with its palette colour and the boundary in dark ink', () => {
    const regions = fill(3, 1, (x) => [0, x === 1 ? 0 : x === 0 ? 1 : 2, 0]);
    const pbn = { width: 3, height: 1, palette: ['#FF0000', '#00FF00'], regions: [{ id: 1, colorIndex: 1, labelX: 0, labelY: 0 }, { id: 2, colorIndex: 0, labelX: 2, labelY: 0 }] };
    const out = painted({ pbn, regions, preview: regions } as PbnResult);
    expect([...out.data]).toEqual([0, 255, 0, 255, 40, 44, 56, 255, 255, 0, 0, 255]);
  });
});
