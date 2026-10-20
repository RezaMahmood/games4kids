import { describe, expect, it } from 'vitest';
import { downscale } from './downscale';
import { pixelAt, solid } from './fixtures';
import { newRaster } from './types';

describe('downscale', () => {
  it('keeps the long edge at 1024 or less and the aspect ratio', () => {
    const out = downscale(solid(3000, 1500, [10, 20, 30]));
    expect([out.width, out.height]).toEqual([1024, 512]);
    expect(pixelAt(out, 500, 200)).toEqual([10, 20, 30, 255]);
  });

  it('leaves a small image the same size', () => {
    const out = downscale(solid(300, 200, [1, 2, 3]));
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it('averages the pixels it merges', () => {
    const img = newRaster(2048, 2);
    for (let i = 0; i < 2048 * 2; i++) img.data.set(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const out = downscale(img);
    expect(out.width).toBe(1024);
    expect(pixelAt(out, 10, 0)[0]).toBeGreaterThanOrEqual(127);
    expect(pixelAt(out, 10, 0)[0]).toBeLessThanOrEqual(128);
  });

  it('puts transparent pixels on white', () => {
    expect(pixelAt(downscale(newRaster(4, 4)), 1, 1)).toEqual([255, 255, 255, 255]);
  });
});
