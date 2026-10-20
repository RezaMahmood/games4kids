import { groupByLevel } from './activity.js';
import { shownScore } from './format.js';

/**
 * The child's overall standing, worked out from the latest result of each activity. There is no history, so
 * redoing an activity replaces its points. Every finished activity adds points, which rewards doing more.
 * @typedef {import('./api.js').ListedActivity} Listed
 * @typedef {{ activity: Listed, score: number, points: number, hard: boolean, timeMs: number, stars: number, cheer: string }} Entry
 */

/** Hard mode is harder, so its results earn this many times the points. The score itself stays 0 to 100. */
export const HARD_BONUS = 1.2;

/** @param {{ score: number, hard?: boolean }} result */
export const pointsFor = (result) => Math.round(shownScore(result.score) * (result.hard ? HARD_BONUS : 1));

/** Words for a score. Every band is a celebration, because finishing is the achievement. */
const CHEERS = [
  [90, 'Superstar!'],
  [75, 'Brilliant!'],
  [60, 'Great work!'],
  [40, 'Great effort!'],
  [0, 'You did it!'],
];
export const cheerFor = (score) => CHEERS.find(([from]) => score >= from)[1];

/** One to five stars, and never none. */
export const starsFor = (score) => Math.min(5, Math.max(1, Math.ceil(score / 20)));

/**
 * Most points first, then the quicker time, then the title, so the order is the same every time.
 * @param {Listed[]} activities
 * @returns {{ points: number, done: number, total: number, entries: Entry[], todo: Listed[] }}
 */
export function summarize(activities) {
  const playable = activities.filter((a) => a.status === 'published');
  const entries = playable
    .filter((a) => a.result)
    .map((activity) => {
      const score = shownScore(activity.result.score);
      const hard = activity.result.hard === true;
      return { activity, score, points: pointsFor(activity.result), hard, timeMs: activity.result.timeMs, stars: starsFor(score), cheer: cheerFor(score) };
    })
    .sort((a, b) => b.points - a.points || a.timeMs - b.timeMs || a.activity.title.localeCompare(b.activity.title));
  const todo = groupByLevel(playable).flatMap((group) => group.items).filter((a) => !a.result);
  return { points: entries.reduce((sum, e) => sum + e.points, 0), done: entries.length, total: playable.length, entries, todo };
}

/** What the header chip says. */
export function chipText({ points, done }) {
  return done === 0 ? 'Collect points' : `${points.toLocaleString('en-GB')} points`;
}
