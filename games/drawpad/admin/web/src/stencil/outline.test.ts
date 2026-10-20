import { describe, expect, it } from 'vitest';
import { BLOB_CENTRES, BLOB_RADIUS, disc, fill, noise, pixelAt, solid, touchingBlobs } from './fixtures';
import { makeOutline } from './outline';
import { measureOutline } from './outlineMetrics';
import { INK } from './types';

const inked = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]! > 128;

describe('makeOutline', () => {
  const circle = fill(solid(240, 240, [255, 255, 255]), disc(120, 120, 70), [40, 60, 160]);

  it('draws a ring about the edge of a filled circle and nothing else', () => {
    const out = makeOutline(circle, { detail: 0.5 });
    let ring = 0;
    for (let a = 0; a < 360; a += 2) {
      const x = Math.round(120 + 70 * Math.cos((a * Math.PI) / 180));
      const y = Math.round(120 + 70 * Math.sin((a * Math.PI) / 180));
      const near = [-3, -2, -1, 0, 1, 2, 3].some((d) => inked(out, Math.round(x + d * Math.cos((a * Math.PI) / 180)), Math.round(y + d * Math.sin((a * Math.PI) / 180))));
      if (near) ring++;
    }
    expect(ring).toBeGreaterThanOrEqual(175);

    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 240; x++) {
        if (inked(out, x, y)) expect(Math.abs(Math.hypot(x - 120, y - 120) - 70)).toBeLessThanOrEqual(5);
      }
    }
  });

  it('uses dark ink on a transparent background with lines a few pixels wide', () => {
    const out = makeOutline(circle, { detail: 0.5 });
    expect(pixelAt(out, 0, 0)[3]).toBe(0);
    expect(pixelAt(out, 120, 120)[3]).toBe(0);
    const row = Array.from({ length: 240 }, (_, x) => inked(out, x, 120));
    const start = row.indexOf(true);
    const width = row.slice(start).indexOf(false);
    expect(width).toBeGreaterThanOrEqual(2);
    expect(width).toBeLessThanOrEqual(5);
    expect(pixelAt(out, start, 120).slice(0, 3)).toEqual([INK.r, INK.g, INK.b]);
  });

  it('ignores specks and faint noise', () => {
    const rand = noise(7);
    const img = solid(240, 240, [255, 255, 255]);
    for (let n = 0; n < 40; n++) {
      const x = 5 + Math.floor(rand() * 230);
      const y = 5 + Math.floor(rand() * 230);
      img.data.set([200, 200, 200, 255], (y * 240 + x) * 4);
    }
    const out = makeOutline(img, { detail: 0.5 });
    expect(out.data.some((v, i) => i % 4 === 3 && v > 128)).toBe(false);
  });

  it('keeps more fine lines as detail goes up', () => {
    const rand = noise(3);
    const img = solid(300, 300, [255, 255, 255]);
    for (let b = 0; b < 60; b++) {
      const cx = 20 + rand() * 260;
      const cy = 20 + rand() * 260;
      fill(img, disc(cx, cy, 4 + rand() * 12), [Math.floor(rand() * 200), Math.floor(rand() * 200), Math.floor(rand() * 200)]);
    }
    const count = (detail: number) => makeOutline(img, { detail }).data.filter((v, i) => i % 4 === 3 && v > 128).length;
    expect(count(1)).toBeGreaterThan(count(0));
  });

  it('is deterministic', () => {
    expect(makeOutline(circle, { detail: 0.3 }).data).toEqual(makeOutline(circle, { detail: 0.3 }).data);
  });

  describe('on touching soft-edged blobs, one covered in stamen-like scribble', () => {
    const blobs = touchingBlobs();
    const outlines = new Map([0, 0.5, 1].map((detail) => [detail, makeOutline(blobs, { detail })]));

    it.each([0, 0.5, 1])('closes every blob into its own shape that holds paint (detail %s)', (detail) => {
      const { regionAt } = measureOutline(outlines.get(detail)!);
      const regions = BLOB_CENTRES.map(([x, y]) => regionAt(x, y));
      expect(regions.every((r) => r >= 0)).toBe(true);
      expect(new Set(regions).size).toBe(BLOB_CENTRES.length);
    });

    it.each([0, 0.5])('leaves no crumbs and almost no loose line ends (detail %s)', (detail) => {
      const { tiny, endpoints } = measureOutline(outlines.get(detail)!);
      expect(tiny).toBe(0);
      expect(endpoints).toBeLessThanOrEqual(2);
    });

    it('draws the scribbled blob as a clean shape instead of a tangle', () => {
      const out = outlines.get(0.5)!;
      const [cx, cy] = BLOB_CENTRES[2];
      let area = 0;
      let ink = 0;
      for (let y = cy - BLOB_RADIUS; y <= cy + BLOB_RADIUS; y++) {
        for (let x = cx - BLOB_RADIUS; x <= cx + BLOB_RADIUS; x++) {
          if (Math.hypot(x - cx, y - cy) >= BLOB_RADIUS - 6) continue;
          area++;
          if (inked(out, x, y)) ink++;
        }
      }
      expect(ink / area).toBeLessThan(0.1);
    });
  });
});
