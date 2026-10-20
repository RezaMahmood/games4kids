import { describe, expect, it } from 'vitest';
import { scorePbn } from './pbn';
import { COLOUR_CAP, scoreTrace, usedColours } from './trace';

const W = 200;
const H = 150;

function grid(paint: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = paint(x, y) ? 255 : 0;
  return out;
}

const verticalLine = (x0: number) => grid((x) => x >= x0 && x < x0 + 2);
const blank = () => new Uint8Array(W * H);
const input = (over: Partial<Parameters<typeof scoreTrace>[0]>) => ({
  outlineAlpha: verticalLine(100),
  penAlpha: blank(),
  penColors: [] as number[],
  width: W,
  height: H,
  strokeCount: 0,
  ...over,
});

describe('scoreTrace', () => {
  it('rewards a full trace with many colours and strokes', () => {
    const filled = grid((x) => x >= 60 && x < 160);
    const score = scoreTrace(input({ penAlpha: filled, penColors: [0, 1, 2, 3, 4, 5], strokeCount: 30 }));
    expect(score.total).toBeGreaterThanOrEqual(95);
    expect(score.stars).toBe(5);
  });

  it('gives a blank drawing the floor: zero points and one star', () => {
    const score = scoreTrace(input({}));
    expect(score.total).toBe(0);
    expect(score.stars).toBe(1);
    expect(score.breakdown).toEqual({ tracing: 0, colour: 0, coverage: 0, effort: 0 });
  });

  it('counts ink within 8px of the outline but not 12px away', () => {
    const near = scoreTrace(input({ penAlpha: verticalLine(106), strokeCount: 1 }));
    const far = scoreTrace(input({ penAlpha: verticalLine(112), strokeCount: 1 }));
    expect(near.breakdown.tracing).toBe(35);
    expect(far.breakdown.tracing).toBe(0);
  });

  it('scores tracing by the share of the outline that is covered', () => {
    const topHalf = grid((x, y) => x >= 100 && x < 102 && y < H / 2);
    const { tracing } = scoreTrace(input({ penAlpha: topHalf })).breakdown;
    expect(tracing).toBeGreaterThan(17);
    expect(tracing).toBeLessThan(21);
  });

  it('awards more for more colours, up to the cap', () => {
    const colour = (n: number) => scoreTrace(input({ penColors: Array.from({ length: n }, (_, i) => i) })).breakdown.colour!;
    expect(colour(1)).toBeLessThan(colour(3));
    expect(colour(3)).toBeLessThan(colour(COLOUR_CAP));
    expect(colour(COLOUR_CAP + 4)).toBe(colour(COLOUR_CAP));
  });

  it('ignores repeated uses of the same colour', () => {
    expect(scoreTrace(input({ penColors: [2, 2, 2] })).breakdown.colour).toBe(scoreTrace(input({ penColors: [2] })).breakdown.colour);
  });

  it('caps effort at 30 strokes and coverage at its target', () => {
    const all = grid(() => true);
    const a = scoreTrace(input({ penAlpha: all, strokeCount: 30 }));
    const b = scoreTrace(input({ penAlpha: all, strokeCount: 300 }));
    expect(b.breakdown.effort).toBe(15);
    expect(b.breakdown.coverage).toBe(25);
    expect(a.total).toBe(b.total);
  });

  it('treats a faint outline as no outline and does not divide by zero', () => {
    const score = scoreTrace(input({ outlineAlpha: grid(() => false), penAlpha: verticalLine(5) }));
    expect(score.breakdown.tracing).toBe(0);
  });
});

describe('usedColours', () => {
  const pixels = (colour: readonly number[], count: number, alpha = 255) =>
    Array.from({ length: count }, () => [...colour, alpha]).flat();

  it('lists every colour with enough solid pixels, wheel colours included, and ignores blends and strays', () => {
    const rgba = [...pixels([255, 0, 0], 50), ...pixels([0, 0, 255], 5), ...pixels([0, 255, 0], 80, 120), ...pixels([0x3d, 0xa5, 0xd9], 99)];
    expect(usedColours(rgba)).toEqual([0xff0000, 0x3da5d9]);
  });
});

describe('scorePbn', () => {
  it('gives full marks for every region painted with its own number', () => {
    const score = scorePbn({ regionsTotal: 20, regionsFilled: 20, regionsMatched: 20 });
    expect(score.total).toBe(100);
    expect(score.stars).toBe(5);
  });

  it('still scores a picture painted entirely in other colours, for painting every area', () => {
    const score = scorePbn({ regionsTotal: 10, regionsFilled: 10, regionsMatched: 0 });
    expect(score.breakdown).toEqual({ completeness: 80, matching: 0 });
    expect(score.stars).toBe(4);
  });

  it('scores both parts by share and floors a blank sheet at one star', () => {
    const half = scorePbn({ regionsTotal: 10, regionsFilled: 5, regionsMatched: 5 });
    expect(half.breakdown).toEqual({ completeness: 40, matching: 10 });
    expect(half.stars).toBe(3);
    const none = scorePbn({ regionsTotal: 10, regionsFilled: 0, regionsMatched: 0 });
    expect(none.total).toBe(0);
    expect(none.stars).toBe(1);
  });
});
