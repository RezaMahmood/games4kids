import { describe, expect, it } from 'vitest';
import { noise, solid } from './fixtures';
import { measureOutline } from './outlineMetrics';
import { outlineFromRedraw } from './redraw';
import { INK, type Raster } from './types';

const W = 1536;
const H = 1024;

/** What an image model hands back: navy line art of uneven weight on white, a faint grey haze, and speckle. */
function redrawnRectangle(): Raster {
  const rand = noise(5);
  const img = solid(W, H, [255, 255, 255]);
  const set = (x: number, y: number, v: readonly [number, number, number]) => img.data.set([...v, 255], (y * W + x) * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const haze = Math.round(28 * Math.exp(-(((x - 400) / 350) ** 2) - ((y - 700) / 250) ** 2) + rand() * 6);
      set(x, y, [255 - haze, 255 - haze, 255 - haze]);
      const qx = Math.max(Math.abs(x - W / 2) - (500 - 120), 0);
      const qy = Math.max(Math.abs(y - H / 2) - (320 - 120), 0);
      const edge = Math.hypot(qx, qy) - 120 + Math.min(0, Math.max(Math.abs(x - W / 2) - 380, Math.abs(y - H / 2) - 200));
      const weight = 6 + 18 * (x / W);
      if (Math.abs(edge) <= weight / 2) set(x, y, rand() < 0.02 ? [255, 255, 255] : [28, 36, 70]);
    }
  }
  for (let n = 0; n < 4000; n++) {
    const x = Math.floor(rand() * (W - 1));
    const y = Math.floor(rand() * (H - 1));
    const v = Math.floor(rand() * 90);
    set(x, y, [v, v, v + 20]);
    if (rand() < 0.3) {
      set(x + 1, y, [v, v, v + 20]);
      set(x, y + 1, [v, v, v + 20]);
      set(x + 1, y + 1, [v, v, v + 20]);
    }
  }
  return img;
}

describe('outlineFromRedraw', () => {
  const out = outlineFromRedraw(redrawnRectangle(), 700, 420);

  it('stretches the redraw to the picture size', () => {
    expect([out.width, out.height, out.data.length]).toEqual([700, 420, 700 * 420 * 4]);
  });

  it('keeps the drawn shape as one closed area and drops the speckle and haze', () => {
    const metrics = measureOutline(out);
    expect(metrics.tiny).toBe(0);
    expect(metrics.components).toBe(1);
    expect(metrics.enclosed).toBe(1);
    expect(metrics.regionAt(350, 210)).toBeGreaterThanOrEqual(0);
    expect(metrics.regionAt(5, 5)).toBe(-1);
  });

  it('draws in the classic outline format: ink colour, opaque lines, transparent paper, lines a few pixels wide', () => {
    for (let i = 0; i < out.data.length; i += 4) {
      const alpha = out.data[i + 3]!;
      expect(alpha === 0 || alpha === 255).toBe(true);
      if (alpha) expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([INK.r, INK.g, INK.b]);
    }
    const row = Array.from({ length: 700 }, (_, x) => out.data[(210 * 700 + x) * 4 + 3]! > 0);
    const start = row.indexOf(true);
    const width = row.slice(start).indexOf(false);
    expect(width).toBeGreaterThanOrEqual(2);
    expect(width).toBeLessThanOrEqual(5);
  });

  it('keeps a few thin lines as ink and a broad grey haze as paper', () => {
    const img = solid(1024, 1024, [255, 255, 255]);
    for (let y = 0; y < 1024; y++) {
      for (let x = 0; x < 1024; x++) {
        if (x < 512) img.data.set([218, 218, 218], (y * 1024 + x) * 4);
        if (Math.abs(Math.hypot(x - 512, y - 512) - 300) <= 1.5) img.data.set([28, 36, 70], (y * 1024 + x) * 4);
      }
    }
    const ring = outlineFromRedraw(img, 512, 512);
    expect(measureOutline(ring).enclosed).toBe(1);
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) if (ring.data[(y * 512 + x) * 4 + 3]) expect(Math.abs(Math.hypot(x - 256, y - 256) - 150)).toBeLessThanOrEqual(4);
    }
  });

  it('gives an empty outline for a blank redraw instead of failing', () => {
    const blank = outlineFromRedraw(solid(1024, 1024, [250, 250, 250]), 300, 300);
    expect([blank.width, blank.height]).toEqual([300, 300]);
    expect(blank.data.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  });
});
