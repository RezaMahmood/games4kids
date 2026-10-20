import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, parseHex } from './colour';

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

describe('colour', () => {
  it('round-trips every colour on a 15-step RGB grid exactly', () => {
    const misses: string[] = [];
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const c = hex(r, g, b);
          if (hsvToHex(hexToHsv(c)) !== c) misses.push(c);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it('maps the primaries and secondaries to their hues', () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe('#FF0000');
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe('#FFFF00');
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00FF00');
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe('#0000FF');
    expect(hexToHsv('#00FFFF')).toEqual({ h: 180, s: 1, v: 1 });
    expect(hexToHsv('#FF00FF')).toEqual({ h: 300, s: 1, v: 1 });
  });

  it('gives greys, black and white zero saturation whatever the hue', () => {
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#FFFFFF')).toEqual({ h: 0, s: 0, v: 1 });
    expect(hexToHsv('#808080')).toEqual({ h: 0, s: 0, v: 128 / 255 });
    expect(hsvToHex({ h: 213, s: 0, v: 1 })).toBe('#FFFFFF');
    expect(hsvToHex({ h: 97, s: 0.8, v: 0 })).toBe('#000000');
    expect(hsvToHex({ h: 300, s: 0, v: 0.5 })).toBe('#808080');
  });

  it('is continuous across the hue seam at red', () => {
    expect(hsvToHex({ h: 359.9, s: 1, v: 1 })).toBe('#FF0000');
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#FF0000');
    expect(hexToHsv('#FF0001').h).toBeGreaterThan(359);
    expect(hexToHsv('#FF0100').h).toBeLessThan(1);
  });

  it('reads typed hex with or without a hash, short or long', () => {
    expect(parseHex('#3da5d9')).toBe('#3DA5D9');
    expect(parseHex(' 3DA5D9 ')).toBe('#3DA5D9');
    expect(parseHex('#fc0')).toBe('#FFCC00');
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#GGGGGG')).toBeNull();
  });
});
