import { describe, expect, it, vi } from 'vitest';
import { createAutosave, savesSettled } from './autosave';
import { decodeRegionIds, inscribedRadius, regionNear } from './regionMap';
import { clampView, fitView, MAX_ZOOM, pinchView, toPicture, zoomAbout } from './view';

const frame = { vw: 700, vh: 500, pw: 1000, ph: 800 };

describe('view', () => {
  it('fits the whole picture centred', () => {
    const v = fitView(frame);
    expect(v.scale).toBeCloseTo(0.625);
    expect(v.x).toBeCloseTo(37.5);
    expect(v.y).toBe(0);
  });

  it('keeps the picture point under the zoom anchor fixed', () => {
    const v = fitView(frame);
    const at = { x: 300, y: 200 };
    const before = toPicture(v, at.x, at.y);
    const after = toPicture(zoomAbout(v, 2, at, frame), at.x, at.y);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('cannot zoom out past fit or in past the maximum', () => {
    const v = fitView(frame);
    expect(zoomAbout(v, 0.1, { x: 0, y: 0 }, frame).scale).toBeCloseTo(v.scale);
    expect(zoomAbout(v, 100, { x: 0, y: 0 }, frame).scale).toBeCloseTo(v.scale * MAX_ZOOM);
  });

  it('keeps the picture covering the viewport when panned too far', () => {
    const zoomed = zoomAbout(fitView(frame), 3, { x: 350, y: 250 }, frame);
    const dragged = clampView({ ...zoomed, x: 999, y: 999 }, frame);
    expect(dragged.x).toBe(0);
    expect(dragged.y).toBe(0);
  });

  it('pinch zooms with the fingers and pans with their midpoint', () => {
    const start = fitView(frame);
    const from: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 300, y: 200 }, { x: 400, y: 200 }];
    const to: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 250, y: 220 }, { x: 450, y: 220 }];
    const next = pinchView(start, from, to, frame);
    expect(next.scale).toBeCloseTo(start.scale * 2);
    const under = toPicture(start, 350, 200);
    const now = toPicture(next, 350, 220);
    expect(now.x).toBeCloseTo(under.x);
    expect(now.y).toBeCloseTo(under.y);
  });
});

describe('regionMap', () => {
  const rgba = (ids: number[]) => ids.flatMap((id) => [id >> 8, id & 255, 0, 255]);

  it('decodes ids from red and green', () => {
    expect([...decodeRegionIds(rgba([0, 1, 300, 65535]))]).toEqual([0, 1, 300, 65535]);
  });

  const map = { width: 5, height: 1, ids: decodeRegionIds(rgba([7, 7, 0, 9, 9])) };

  it('snaps a tap on a boundary pixel to the nearest region', () => {
    expect(regionNear(map, 2, 0, 0)).toBe(0);
    expect(regionNear(map, 2.2, 0, 2)).toBe(7);
    expect(regionNear(map, 2.9, 0, 2)).toBe(9);
  });

  it('measures how much room a label has', () => {
    const big = { width: 21, height: 21, ids: new Uint16Array(21 * 21).fill(4) };
    expect(inscribedRadius(big, 10, 10, 50)).toBe(10);
    expect(inscribedRadius(map, 0, 0, 50)).toBe(0);
  });
});

describe('autosave', () => {
  it('debounces bursts into one write and flushes pending work immediately', async () => {
    vi.useFakeTimers();
    const write = vi.fn(() => Promise.resolve());
    const save = createAutosave(write, 500);
    save.schedule();
    vi.advanceTimersByTime(300);
    save.schedule();
    vi.advanceTimersByTime(300);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(write).toHaveBeenCalledTimes(1);
    save.schedule();
    await save.flush();
    expect(write).toHaveBeenCalledTimes(2);
    await save.flush();
    expect(write).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries on the next flush after a failed write', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const save = createAutosave(write, 500);
    save.schedule();
    await save.flush();
    await save.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('lets the next screen wait for a write that was flushed as the canvas closed', async () => {
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const save = createAutosave(write, 500);
    save.schedule();
    void save.flush();
    let settled = false;
    void savesSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await savesSettled();
    expect(settled).toBe(true);
  });
});
