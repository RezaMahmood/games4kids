const pad = (n) => String(n).padStart(2, '0');

/** 83_400 ms -> "1:23" (whole seconds, rounded up so a countdown never shows 0:00 early). */
export function formatClock(ms, { roundUp = false } = {}) {
  const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** 83_456 ms -> "1:23.4" */
export function formatTenths(ms) {
  const tenths = Math.max(0, Math.floor(ms / 100));
  return `${Math.floor(tenths / 600)}:${pad(Math.floor(tenths / 10) % 60)}.${tenths % 10}`;
}

export const timerLabel = (timeLimitSec) => (timeLimitSec === null ? 'No timer' : `${formatClock(timeLimitSec * 1000)} timer`);

/** "1:30" or "90" -> 90 seconds; anything else -> null. */
export function parseDuration(text) {
  const m = /^\s*(?:(\d{1,3}):([0-5]\d)|(\d{1,5}))\s*$/.exec(text);
  if (!m) return null;
  return m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/** The stored score keeps one decimal; every screen shows the whole number of that same value. */
export const storedScore = (score) => Math.round(score * 10) / 10;
export const shownScore = (score) => Math.round(storedScore(score));
