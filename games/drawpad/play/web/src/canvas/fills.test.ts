import { describe, expect, it } from 'vitest';
import type { PbnData } from '../../../../data/types';
import { Fills } from './fills';
import { scorePbn } from '../scoring';

const data: PbnData = {
  width: 3,
  height: 1,
  palette: ['#FF0000', '#0000FF'],
  regions: [
    { id: 1, colorIndex: 0, labelX: 0, labelY: 0 },
    { id: 2, colorIndex: 0, labelX: 1, labelY: 0 },
    { id: 3, colorIndex: 1, labelX: 2, labelY: 0 },
  ],
};
const blank = () => new Fills(data, { filledRegions: null });

describe('Fills', () => {
  it('paints any region with any number, and a region already that colour stays as it is', () => {
    const fills = blank();
    expect(fills.apply(3, { index: 0 })).toBe('painted');
    expect(fills.hexOf(3)).toBe('#FF0000');
    expect(fills.apply(3, { index: 0 })).toBe('ignored');
    expect(fills.apply(1, { index: 0 })).toBe('painted');
    expect(fills.apply(1, { index: 0 })).toBe('ignored');
    expect(fills.hexOf(1)).toBe('#FF0000');
    expect(fills.matched).toBe(1);
    expect([0, 1].map((n) => fills.remaining(n))).toEqual([1, 1]);
  });

  it('paints any region with an own colour, and repaints over numbers and own colours', () => {
    const fills = blank();
    fills.apply(1, { index: 0 });
    expect(fills.apply(3, { hex: '#3DA5D9' })).toBe('painted');
    expect(fills.apply(1, { hex: '#3DA5D9' })).toBe('repainted');
    expect(fills.apply(1, { hex: '#3DA5D9' })).toBe('ignored');
    expect(fills.apply(1, { hex: '#00AA00' })).toBe('repainted');
    expect(fills.hexOf(1)).toBe('#00AA00');
    expect(fills.hexOf(3)).toBe('#3DA5D9');
  });

  it('lets the right number take back a region painted another colour', () => {
    const fills = blank();
    fills.apply(3, { hex: '#3DA5D9' });
    expect(fills.apply(3, { index: 0 })).toBe('repainted');
    expect(fills.apply(3, { index: 1 })).toBe('repainted');
    expect(fills.hexOf(3)).toBe('#0000FF');
    expect(fills.matched).toBe(1);
    expect(fills.toPatch().customFills).toEqual({});
  });

  it('ignores taps on boundaries and unknown regions', () => {
    const fills = blank();
    expect(fills.apply(0, { hex: '#3DA5D9' })).toBe('ignored');
    expect(fills.apply(99, { index: 0 })).toBe('ignored');
    expect(fills.filled.size).toBe(0);
  });

  it('counts every painted area as painted, and only the right numbers as matching', () => {
    const fills = blank();
    fills.apply(1, { index: 0 });
    fills.apply(2, { hex: '#3DA5D9' });
    fills.apply(3, { index: 0 });
    expect(fills.filled.size).toBe(3);
    expect(fills.matched).toBe(1);
    expect([0, 1].map((n) => fills.remaining(n))).toEqual([1, 1]);
    const score = scorePbn({ regionsTotal: 3, regionsFilled: fills.filled.size, regionsMatched: fills.matched });
    expect(score.breakdown).toEqual({ completeness: 80, matching: 7 });
  });

  it('saves another number\'s colour like an own colour, so it comes back on resume', () => {
    const fills = blank();
    fills.apply(3, { index: 0 });
    expect(fills.toPatch()).toEqual({ filledRegions: [3], customFills: { 3: '#FF0000' } });
    expect(new Fills(data, fills.toPatch()).hexOf(3)).toBe('#FF0000');
  });

  it('resumes a saved drawing with its own colours, dropping regions the picture no longer has', () => {
    const fills = blank();
    fills.apply(1, { index: 0 });
    fills.apply(3, { hex: '#3DA5D9' });
    const saved = fills.toPatch();
    expect(saved).toEqual({ filledRegions: [1, 3], customFills: { 3: '#3DA5D9' } });

    const wire = JSON.parse(JSON.stringify({ filledRegions: [...saved.filledRegions, 42], customFills: { ...saved.customFills, 77: '#FFFFFF' } }));
    const resumed = new Fills(data, wire);
    expect([...resumed.filled]).toEqual([1, 3]);
    expect(resumed.hexOf(1)).toBe('#FF0000');
    expect(resumed.hexOf(3)).toBe('#3DA5D9');
    expect(resumed.toPatch()).toEqual(saved);
  });

  it('resumes an older drawing that has no own colours', () => {
    const resumed = new Fills(data, { filledRegions: [2] });
    expect(resumed.hexOf(2)).toBe('#FF0000');
    expect(resumed.toPatch()).toEqual({ filledRegions: [2], customFills: {} });
  });

  it('undoes strokes one at a time, back to the blank sheet', () => {
    const fills = blank();
    fills.apply(1, { index: 0 });
    fills.apply(3, { hex: '#123456' });
    fills.apply(3, { index: 0 });
    fills.apply(3, { index: 1 });
    expect(fills.apply(3, { index: 1 })).toBe('ignored');

    expect(fills.undo()).toBe(3);
    expect(fills.hexOf(3)).toBe('#FF0000');
    expect(fills.undo()).toBe(3);
    expect(fills.hexOf(3)).toBe('#123456');
    expect(fills.undo()).toBe(3);
    expect(fills.filled.has(3)).toBe(false);
    expect(fills.undo()).toBe(1);
    expect(fills.filled.size).toBe(0);
    expect(fills.canUndo).toBe(false);
    expect(fills.undo()).toBeUndefined();
  });
});
