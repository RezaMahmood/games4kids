import { describe, expect, it } from 'vitest';
import type { DrawingMeta, Picture, UsageToday } from '../../../../data/types';
import { initialState, journeysOpen, reduce, type Action, type State } from './state';

const picture: Picture = { id: 'p1', title: 'Balloon', kinds: ['trace'], width: 400, height: 300, createdAt: '' };
const drawing: DrawingMeta = {
  id: 'd1', pictureId: 'p1', kind: 'trace', status: 'in-progress', createdAt: '', updatedAt: '', score: null, filledRegions: null,
};
const usage = (remainingSeconds: number): UsageToday => ({ usedSeconds: 0, limitSeconds: 3600, remainingSeconds });

const run = (start: State, ...actions: Action[]) => actions.reduce(reduce, start);

describe('boot', () => {
  it('starts a child on Home with the clock not yet read', () => {
    expect(initialState).toEqual({ view: { kind: 'home' }, time: { kind: 'unknown' } });
  });
});

describe('player journey', () => {
  it('goes Home to picker to canvas and back to the same picker', () => {
    const inCanvas = run(initialState, { type: 'openPicker', mode: 'trace' }, { type: 'openCanvas', picture, drawing, returnTo: 'picker' });
    expect(inCanvas).toMatchObject({ view: { kind: 'canvas', picture, drawing } });
    expect(reduce(inCanvas, { type: 'leaveCanvas' })).toMatchObject({ view: { kind: 'picker', mode: 'trace' } });
  });

  it('returns to History when the canvas was opened from History', () => {
    const s = run(initialState, { type: 'openHistory' }, { type: 'openCanvas', picture, drawing, returnTo: 'history' }, { type: 'leaveCanvas' });
    expect(s).toMatchObject({ view: { kind: 'history' } });
  });

  it('goes Home from the picker', () => {
    expect(run(initialState, { type: 'openPicker', mode: 'pbn' }, { type: 'goHome' })).toMatchObject({ view: { kind: 'home' } });
  });

  it('ignores leaving a canvas when there is none', () => {
    expect(reduce(initialState, { type: 'leaveCanvas' })).toBe(initialState);
  });
});

describe('time limit', () => {
  it('shows minutes left rounded up and keeps the same state while the minute is unchanged', () => {
    const s = reduce(initialState, { type: 'usage', usage: usage(125) });
    expect(s).toMatchObject({ time: { kind: 'open', minutesLeft: 3 } });
    expect(reduce(s, { type: 'usage', usage: usage(121) })).toBe(s);
  });

  it('on time up routes Home from a canvas, opens the dialog and blocks journeys', () => {
    const inCanvas = run(initialState, { type: 'openPicker', mode: 'trace' }, { type: 'openCanvas', picture, drawing, returnTo: 'picker' });
    const up = reduce(inCanvas, { type: 'usage', usage: usage(0) });
    expect(up).toMatchObject({ time: { kind: 'up', dialog: true }, view: { kind: 'home' } });
    expect(journeysOpen(up)).toBe(false);
    expect(reduce(up, { type: 'openPicker', mode: 'trace' })).toBe(up);
    expect(reduce(up, { type: 'openCanvas', picture, drawing, returnTo: 'history' })).toBe(up);
    expect(reduce(up, { type: 'openHistory' })).toMatchObject({ view: { kind: 'history' } });
  });

  it('closes the dialog but keeps journeys blocked', () => {
    const up = run(initialState, { type: 'timeUp' }, { type: 'dismissTimeUp' });
    expect(up.time).toEqual({ kind: 'up', dialog: false });
    expect(journeysOpen(up)).toBe(false);
  });

  it('reopens journeys when a later poll shows time left, even after the dialog was closed', () => {
    const s = run(initialState, { type: 'timeUp' }, { type: 'dismissTimeUp' }, { type: 'usage', usage: usage(3600) });
    expect(s.time).toEqual({ kind: 'open', minutesLeft: 60 });
    expect(journeysOpen(s)).toBe(true);
  });

  it('stays up while polls still show no time left', () => {
    const up = run(initialState, { type: 'timeUp' }, { type: 'dismissTimeUp' });
    expect(reduce(up, { type: 'usage', usage: usage(0) })).toBe(up);
  });
});
