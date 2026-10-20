import { describe, expect, it } from 'vitest';
import { disc, fill, noise, pixelAt, rect, regionIdAt, solid } from './fixtures';
import { makePbn, MAX_REGIONS } from './pbn';
import { newRaster } from './types';

const RED = [217, 87, 59] as const;
const BLUE = [43, 84, 214] as const;
const GREEN = [109, 182, 91] as const;
const YELLOW = [242, 179, 61] as const;
const hex = (c: readonly number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function quadrants() {
  const img = solid(240, 160, RED);
  fill(img, rect(120, 0, 240, 80), BLUE);
  fill(img, rect(0, 80, 120, 160), GREEN);
  fill(img, rect(120, 80, 240, 160), YELLOW);
  return img;
}

describe('makePbn on solid colour blocks', () => {
  const result = makePbn(quadrants(), { colors: 4, detail: 0.5 });

  it('finds exactly one region per block with that block colour', () => {
    expect(result.pbn.regions).toHaveLength(4);
    expect([...result.pbn.palette].sort()).toEqual([RED, BLUE, GREEN, YELLOW].map(hex).sort());
    const img = quadrants();
    for (const region of result.pbn.regions) {
      expect(result.pbn.palette[region.colorIndex]).toBe(hex(pixelAt(img, region.labelX, region.labelY).slice(0, 3)));
    }
  });

  it('orders the palette from light to dark', () => {
    const lightness = result.pbn.palette.map((h) => parseInt(h.slice(1, 3), 16) * 0.3 + parseInt(h.slice(3, 5), 16) * 0.59 + parseInt(h.slice(5, 7), 16) * 0.11);
    expect(lightness).toEqual([...lightness].sort((a, b) => b - a));
  });

  it('writes the frozen regions image: id = R*256+G, B 0, A 255, boundary id 0', () => {
    const { regions } = result;
    expect([regions.width, regions.height]).toEqual([240, 160]);
    const seen = new Set<number>();
    for (let i = 0; i < 240 * 160; i++) {
      expect(regions.data[i * 4 + 2]).toBe(0);
      expect(regions.data[i * 4 + 3]).toBe(255);
      seen.add(regions.data[i * 4]! * 256 + regions.data[i * 4 + 1]!);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, ...result.pbn.regions.map((r) => r.id).sort((a, b) => a - b)]);
    expect(regionIdAt(regions, 119, 40) === 0 || regionIdAt(regions, 120, 40) === 0).toBe(true);
  });

  it('puts every label on a pixel of its own region', () => {
    for (const region of result.pbn.regions) expect(regionIdAt(result.regions, region.labelX, region.labelY)).toBe(region.id);
  });

  it('draws the numbered sheet on white at the picture size', () => {
    expect([result.preview.width, result.preview.height]).toEqual([240, 160]);
    expect(pixelAt(result.preview, 60, 20)).toEqual([255, 255, 255, 255]);
    const dark = result.preview.data.filter((v, i) => i % 4 === 0 && v < 100).length;
    expect(dark).toBeGreaterThan(200);
  });

  it('is deterministic', () => {
    const again = makePbn(quadrants(), { colors: 4, detail: 0.5 });
    expect(again.pbn).toEqual(result.pbn);
    expect(again.regions.data).toEqual(result.regions.data);
  });
});

describe('makePbn region rules', () => {
  it('uses fewer colours than asked when the picture has fewer', () => {
    const img = fill(solid(200, 100, RED), rect(100, 0, 200, 100), BLUE);
    const out = makePbn(img, { colors: 12, detail: 0.5 });
    expect(out.pbn.palette).toHaveLength(2);
    expect(out.pbn.regions).toHaveLength(2);
  });

  it('absorbs a speck of another colour into the region around it', () => {
    const img = fill(solid(200, 100, RED), rect(100, 0, 200, 100), BLUE);
    fill(img, rect(40, 40, 43, 43), GREEN);
    const out = makePbn(img, { colors: 3, detail: 0.5 });
    expect(out.pbn.regions).toHaveLength(2);
  });

  it('puts the number inside a ring shaped region, not in its hole', () => {
    const img = fill(solid(240, 240, [250, 250, 250]), disc(120, 120, 90), RED);
    fill(img, disc(120, 120, 45), YELLOW);
    const out = makePbn(img, { colors: 3, detail: 0.5 });
    expect(out.pbn.regions).toHaveLength(3);
    const ring = out.pbn.regions.find((r) => out.pbn.palette[r.colorIndex] === hex(RED))!;
    const distance = Math.hypot(ring.labelX - 120, ring.labelY - 120);
    expect(distance).toBeGreaterThan(50);
    expect(distance).toBeLessThan(85);
    expect(regionIdAt(out.regions, ring.labelX, ring.labelY)).toBe(ring.id);
  });

  it('keeps a long thin strip labelled in the middle of its length', () => {
    const img = fill(solid(300, 120, [250, 250, 250]), rect(20, 50, 280, 80), RED);
    const out = makePbn(img, { colors: 2, detail: 0.5 });
    const strip = out.pbn.regions.find((r) => out.pbn.palette[r.colorIndex] === hex(RED))!;
    expect(strip.labelX).toBeGreaterThan(100);
    expect(strip.labelX).toBeLessThan(200);
    expect(strip.labelY).toBeGreaterThanOrEqual(50);
    expect(strip.labelY).toBeLessThan(80);
  });

  it('never exceeds the region cap, however noisy the picture', () => {
    const rand = noise(11);
    const img = newRaster(320, 320);
    for (let y = 0; y < 320; y++) {
      for (let x = 0; x < 320; x++) {
        const n = (rand() - 0.5) * 120;
        img.data.set([x * 0.7 + n, y * 0.7 + n, 128 + (x - y) * 0.3 + n, 255], (y * 320 + x) * 4);
      }
    }
    const out = makePbn(img, { colors: 16, detail: 1 });
    expect(out.pbn.regions.length).toBeGreaterThan(1);
    expect(out.pbn.regions.length).toBeLessThanOrEqual(MAX_REGIONS);
    for (const region of out.pbn.regions) expect(regionIdAt(out.regions, region.labelX, region.labelY)).toBe(region.id);
  });

  it('gives fewer, bigger regions at lower detail', () => {
    const rand = noise(5);
    const img = solid(300, 300, [240, 235, 220]);
    for (let b = 0; b < 80; b++) {
      fill(img, disc(rand() * 300, rand() * 300, 6 + rand() * 20), [Math.floor(rand() * 255), Math.floor(rand() * 255), Math.floor(rand() * 255)]);
    }
    const simple = makePbn(img, { colors: 8, detail: 0 }).pbn.regions.length;
    const detailed = makePbn(img, { colors: 8, detail: 1 }).pbn.regions.length;
    expect(simple).toBeLessThan(detailed);
  });
});
