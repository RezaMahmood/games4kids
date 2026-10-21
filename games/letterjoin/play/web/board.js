// Pure: no DOM, no network.

/** `2026-10-17` -> `Sat 17`, read as a plain calendar date so the device's time zone cannot move it. */
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A day with no points shows a dash, so the points stand out. */
export const pointsText = (points) => (points === 0 ? '–' : points.toLocaleString('en-GB'));

export const emptyLevelText = (levelLabel) => `Nobody has scores in ${levelLabel} yet.`;
