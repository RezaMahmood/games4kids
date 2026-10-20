/** How the admin's "Practice" table shows a child's day. Pure, so the rules are tested. */

const pad = (n) => String(n).padStart(2, '0');

/** `2026-10-17` -> `Sat 17`, read as a plain calendar date so the admin's time zone cannot move it. */
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * One cell: whole minutes, rounded down so 14 minutes 59 never looks like a met goal of 15.
 * @param {number} seconds @param {number} goalMinutes 0 when there is no goal
 * @returns {{ text: string, met: boolean, title: string }}
 */
export function cellFor(seconds, goalMinutes) {
  const minutes = Math.floor(seconds / 60);
  const met = goalMinutes > 0 && seconds >= goalMinutes * 60;
  const text = seconds === 0 ? '–' : met ? `✓ ${minutes}` : minutes === 0 ? '<1' : String(minutes);
  return { text, met, title: seconds === 0 ? 'No practice' : `${minutes} min ${pad(seconds % 60)} s${met ? ', goal reached' : ''}` };
}

/** @param {number} seconds */
export const totalText = (seconds) => `${Math.floor(seconds / 60)} min`;

/** @param {number} goalMinutes */
export const goalText = (goalMinutes) => (goalMinutes === 0
  ? 'No daily goal is set, so there is nothing to reach. Set one in Settings.'
  : `Goal: ${goalMinutes} ${goalMinutes === 1 ? 'minute' : 'minutes'} a day. A tick means the child reached it.`);
