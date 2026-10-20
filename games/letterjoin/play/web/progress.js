// Pure: no DOM, no network. The server returns raw attempts because "which day" depends on the viewer's time zone.
import { LEVELS } from './activity.js';

/** How many of the most recent active days the trend looks at. */
export const TREND_DAYS = 14;
/** Fewer active days than this in the window and there is no trend to report. */
export const MIN_TREND_DAYS = 4;
/** Accuracy must move by at least this many points between the two halves. */
export const ACCURACY_STEP = 3;
/** Speed must move by at least this fraction (0.1 is 10 percent) of the older half's speed. */
export const SPEED_STEP = 0.1;

// Absorbs float noise so a change of exactly the step counts as reaching it.
const EPSILON = 1e-9;
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const pad = (n) => String(n).padStart(2, '0');

/**
 * One finished attempt as the API returns it. level and chars were copied from the activity when it was saved.
 * @typedef {{ id: string, activityId: string, level: import('./activity.js').Level, chars: number, score: number, timeMs: number, completedAt: string }} Attempt
 * @typedef {{ count: number, accuracy: number, speed: number | null }} Metrics accuracy is the mean score; speed is letters traced per minute
 * @typedef {{ date: string, count: number, accuracy: number, speed: number | null, byLevel: Partial<Record<import('./activity.js').Level, Metrics>> }} Day
 * @typedef {'improving' | 'steady' | 'worsening' | 'not-enough-data'} MetricVerdict
 * @typedef {{ verdict: MetricVerdict, delta: number | null }} MetricTrend accuracy delta in points, speed delta as a fraction of the older half
 * @typedef {{ verdict: 'improving' | 'steady' | 'worsening' | 'mixed' | 'not-enough-data', accuracy: MetricTrend, speed: MetricTrend }} Trend
 */

/** The viewer's local calendar day for an ISO timestamp, as YYYY-MM-DD. */
export function localDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Accuracy is the plain mean of the scores. Speed is a weighted rate, total letters traced over total minutes,
 * so one slow long attempt weighs more than a quick short one, and it is null when no time was recorded.
 * An attempt traced chars * score / 100 letters, so an early Finish with a low score is not counted as the whole activity.
 */
function aggregate(attempts) {
  const totalMs = attempts.reduce((sum, a) => sum + a.timeMs, 0);
  const traced = attempts.reduce((sum, a) => sum + (a.chars * a.score) / 100, 0);
  return {
    count: attempts.length,
    accuracy: attempts.reduce((sum, a) => sum + a.score, 0) / attempts.length,
    speed: totalMs > 0 ? traced / (totalMs / 60000) : null,
  };
}

/** @returns {Metrics} */
function shown(attempts) {
  const { count, accuracy, speed } = aggregate(attempts);
  return { count, accuracy: round(accuracy, 1), speed: speed === null ? null : round(speed, 1) };
}

/** @returns {Map<string, Attempt[]>} oldest day first */
function groupByDay(attempts, dayOf) {
  const days = new Map();
  for (const attempt of attempts) {
    const key = dayOf(attempt.completedAt);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(attempt);
  }
  return new Map([...days].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * One entry per day the child used the app, newest first.
 * @param {Attempt[]} attempts
 * @param {(iso: string) => string} [dayOf]
 * @returns {Day[]}
 */
export function summarizeDays(attempts, dayOf = localDayKey) {
  return [...groupByDay(attempts, dayOf)].reverse().map(([date, group]) => ({
    date,
    ...shown(group),
    byLevel: Object.fromEntries(LEVELS
      .map((level) => [level, group.filter((a) => a.level === level)])
      .filter(([, matching]) => matching.length > 0)
      .map(([level, matching]) => [level, shown(matching)])),
  }));
}

const noData = { verdict: /** @type {const} */ ('not-enough-data'), delta: null };

function verdictOf(delta, step) {
  if (delta >= step - EPSILON) return 'improving';
  if (delta <= -step + EPSILON) return 'worsening';
  return 'steady';
}

function overall(accuracy, speed) {
  const verdicts = [accuracy.verdict, speed.verdict];
  const better = verdicts.includes('improving');
  const worse = verdicts.includes('worsening');
  if (better && worse) return 'mixed';
  return better ? 'improving' : worse ? 'worsening' : 'steady';
}

/**
 * Compares the older and the newer half of the last TREND_DAYS active days. With an odd number of days the
 * newer half gets the extra one. A metric that cannot be measured (no recorded time) says so and does not
 * vote. Level is not accounted for here: use trendByLevel when the mix of levels varies.
 * @param {Attempt[]} attempts
 * @param {(iso: string) => string} [dayOf]
 * @returns {Trend}
 */
export function trendOf(attempts, dayOf = localDayKey) {
  const days = [...groupByDay(attempts, dayOf).values()].slice(-TREND_DAYS);
  if (days.length < MIN_TREND_DAYS) return { verdict: 'not-enough-data', accuracy: noData, speed: noData };
  const split = Math.floor(days.length / 2);
  const older = aggregate(days.slice(0, split).flat());
  const newer = aggregate(days.slice(split).flat());

  const accuracyDelta = newer.accuracy - older.accuracy;
  const accuracy = { verdict: verdictOf(accuracyDelta, ACCURACY_STEP), delta: round(accuracyDelta, 1) };
  const measurable = older.speed !== null && older.speed > 0 && newer.speed !== null;
  const speedDelta = measurable ? (newer.speed - older.speed) / older.speed : null;
  const speed = measurable ? { verdict: verdictOf(speedDelta, SPEED_STEP), delta: round(speedDelta, 3) } : noData;
  return { verdict: overall(accuracy, speed), accuracy, speed };
}

/**
 * A champion day scores lower than a starter one, so a single trend over a changing mix can mislead. This runs
 * trendOf on each level on its own, for the levels that have at least one attempt.
 * @param {Attempt[]} attempts
 * @param {(iso: string) => string} [dayOf]
 * @returns {Partial<Record<import('./activity.js').Level, Trend>>}
 */
export function trendByLevel(attempts, dayOf = localDayKey) {
  return Object.fromEntries(LEVELS
    .map((level) => [level, attempts.filter((a) => a.level === level)])
    .filter(([, matching]) => matching.length > 0)
    .map(([level, matching]) => [level, trendOf(matching, dayOf)]));
}

/** "2026-10-16" -> "Fri Oct 16" in the viewer's locale. */
export function dayLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const accuracyText = (accuracy) => accuracy.toFixed(1);
export const speedText = (speed) => (speed === null ? 'no time recorded' : `${speed.toFixed(1)} chars/min`);

const VERDICT_WORDS = {
  improving: 'Improving',
  steady: 'Steady',
  worsening: 'Getting worse',
  mixed: 'Mixed: one measure is up and the other is down',
  'not-enough-data': `Not enough data yet: needs ${MIN_TREND_DAYS} days of tracing`,
};

/** The verdict and each measure's change, in plain words. */
export function trendWords(trend) {
  const change = (name, { verdict, delta }, unit) => {
    if (verdict === 'not-enough-data') return `${name}: not measured`;
    return `${name}: ${verdict === 'steady' ? 'about the same' : `${delta > 0 ? 'up' : 'down'} ${unit(Math.abs(delta))}`}`;
  };
  if (trend.verdict === 'not-enough-data') return { headline: VERDICT_WORDS['not-enough-data'], accuracy: '', speed: '' };
  return {
    headline: VERDICT_WORDS[trend.verdict],
    accuracy: change('Accuracy', trend.accuracy, (points) => `${points.toFixed(1)} points`),
    speed: change('Speed', trend.speed, (fraction) => `${Math.round(fraction * 100)}%`),
  };
}
