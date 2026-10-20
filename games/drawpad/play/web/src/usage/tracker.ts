export const IDLE_MS = 30_000;
export const HEARTBEAT_MS = 60_000;
export const MAX_BEAT_SECONDS = 90;

export type Tracker = {
  visible: boolean;
  lastInteraction: number;
  unsent: number;
};

export function startTracker(now: number, visible: boolean): Tracker {
  return { visible, lastInteraction: now, unsent: 0 };
}

export const interact = (t: Tracker, now: number): Tracker => ({ ...t, lastInteraction: now });

export const setVisible = (t: Tracker, visible: boolean): Tracker => (t.visible === visible ? t : { ...t, visible });

export const isRunning = (t: Tracker, now: number): boolean => t.visible && now - t.lastInteraction < IDLE_MS;

export const tick = (t: Tracker, now: number): Tracker => (isRunning(t, now) ? { ...t, unsent: t.unsent + 1 } : t);

export function drain(t: Tracker): [Tracker, number | null] {
  if (t.unsent === 0) return [t, null];
  const seconds = Math.min(t.unsent, MAX_BEAT_SECONDS);
  return [{ ...t, unsent: t.unsent - seconds }, seconds];
}

export const requeue = (t: Tracker, seconds: number): Tracker => ({ ...t, unsent: t.unsent + seconds });
