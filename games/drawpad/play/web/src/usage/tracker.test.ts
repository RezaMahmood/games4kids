import { describe, expect, it } from 'vitest';
import { drain, HEARTBEAT_MS, interact, MAX_BEAT_SECONDS, requeue, setVisible, startTracker, tick, type Tracker } from './tracker';

// Advances a fake clock one second at a time, ticking the tracker like the 1s interval does.
function clock(t0: Tracker, start = 0) {
  let t = t0;
  let now = start;
  return {
    get tracker() { return t; },
    get now() { return now; },
    seconds(n: number) {
      for (let i = 0; i < n; i++) {
        now += 1000;
        t = tick(t, now);
      }
    },
    interact() { t = interact(t, now); },
    visible(v: boolean) { t = setVisible(t, v); },
  };
}

const fresh = () => clock(startTracker(0, true));

describe('usage tracker', () => {
  it('counts a second per tick while the page is visible and recently used', () => {
    const c = fresh();
    c.seconds(10);
    expect(c.tracker.unsent).toBe(10);
  });

  it('stops counting after 30 seconds without interaction', () => {
    const c = fresh();
    c.seconds(60);
    expect(c.tracker.unsent).toBe(29);
  });

  it('resumes counting when the child interacts again', () => {
    const c = fresh();
    c.seconds(60);
    c.interact();
    c.seconds(10);
    expect(c.tracker.unsent).toBe(39);
  });

  it('does not count while the page is hidden, even with recent interaction', () => {
    const c = fresh();
    c.seconds(5);
    c.visible(false);
    c.seconds(20);
    expect(c.tracker.unsent).toBe(5);
  });

  it('after hidden then visible, counts again only within 30s of the last interaction', () => {
    const c = fresh();
    c.visible(false);
    c.seconds(40);
    c.visible(true);
    c.seconds(5);
    expect(c.tracker.unsent).toBe(0);
    c.interact();
    c.seconds(5);
    expect(c.tracker.unsent).toBe(5);
  });

  it('drains the unsent seconds into one beat', () => {
    const c = fresh();
    c.seconds(15);
    const [after, beat] = drain(c.tracker);
    expect(beat).toBe(15);
    expect(after.unsent).toBe(0);
    expect(drain(after)[1]).toBeNull();
  });

  it('never sends more than 90 seconds in one beat', () => {
    const [after, beat] = drain({ ...startTracker(0, true), unsent: 100 });
    expect(beat).toBe(90);
    expect(after.unsent).toBe(10);
  });

  it('beats once a minute and a minute of continuous use fits in one beat', () => {
    expect(HEARTBEAT_MS).toBe(60_000);
    const c = fresh();
    for (let i = 0; i < HEARTBEAT_MS / 1000; i++) {
      c.seconds(1);
      c.interact();
    }
    const [after, beat] = drain(c.tracker);
    expect(beat).toBe(60);
    expect(beat).toBeLessThanOrEqual(MAX_BEAT_SECONDS);
    expect(after.unsent).toBe(0);
  });

  it('puts a failed beat back', () => {
    const [after, beat] = drain({ ...startTracker(0, true), unsent: 12 });
    expect(requeue(after, beat!).unsent).toBe(12);
  });
});
