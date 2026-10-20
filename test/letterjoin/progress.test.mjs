import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCURACY_STEP, MIN_TREND_DAYS, SPEED_STEP, TREND_DAYS,
  accuracyText, dayLabel, localDayKey, speedText, summarizeDays, trendByLevel, trendOf, trendWords,
} from '../../games/letterjoin/play/web/progress.js';

const utc = (iso) => iso.slice(0, 10);
const shifted = (hours) => (iso) => new Date(Date.parse(iso) + hours * 3600_000).toISOString().slice(0, 10);

let n = 0;
const attempt = (completedAt, { score = 100, chars = 60, timeMs = 60_000, level = 'starter' } = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, activityId: 'a', level, chars, score, timeMs, completedAt,
});
const dayNo = (i) => `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`;
/** One attempt on each of the given days, in order, so the trend sees one active day per entry. */
const onDays = (shape) => shape.map((s, i) => attempt(dayNo(i), s));

test('the constants say what the brief says', () => {
  assert.deepEqual([TREND_DAYS, MIN_TREND_DAYS, ACCURACY_STEP, SPEED_STEP], [14, 4, 3, 0.1]);
});

test('no attempts means no days', () => {
  assert.deepEqual(summarizeDays([]), []);
});

test('days come newest first with the count, mean accuracy and speed of that day', () => {
  const days = summarizeDays([
    attempt('2026-10-15T09:00:00.000Z', { score: 60 }),
    attempt('2026-10-16T09:00:00.000Z', { score: 80.5 }),
    attempt('2026-10-16T09:05:00.000Z', { score: 91 }),
  ], utc);
  assert.deepEqual(days.map((d) => [d.date, d.count, d.accuracy]), [['2026-10-16', 2, 85.8], ['2026-10-15', 1, 60]]);
});

test('input order does not matter', () => {
  const rows = [attempt('2026-10-14T09:00:00.000Z'), attempt('2026-10-16T09:00:00.000Z'), attempt('2026-10-15T09:00:00.000Z')];
  assert.deepEqual(summarizeDays(rows, utc), summarizeDays([...rows].reverse(), utc));
  assert.deepEqual(summarizeDays(rows, utc).map((d) => d.date), ['2026-10-16', '2026-10-15', '2026-10-14']);
});

test('speed is total letters traced over total minutes, not the mean of each attempt\'s speed', () => {
  // 100 chars in 1 minute (100/min) and 100 chars in 4 minutes (25/min): the mean of rates is 62.5, the weighted rate 40.
  const [day] = summarizeDays([
    attempt('2026-10-16T09:00:00.000Z', { chars: 100, timeMs: 60_000 }),
    attempt('2026-10-16T10:00:00.000Z', { chars: 100, timeMs: 240_000 }),
  ], utc);
  assert.equal(day.speed, 40);
  assert.equal(day.byLevel.starter.speed, 40);
});

test('an early Finish with a near-zero score counts only the few letters traced', () => {
  const [early] = summarizeDays([attempt('2026-10-16T09:00:00.000Z', { chars: 600, score: 4, timeMs: 60_000 })], utc);
  assert.equal(early.speed, 24);
  const [perfect] = summarizeDays([attempt('2026-10-16T09:00:00.000Z', { chars: 600, score: 100, timeMs: 60_000 })], utc);
  assert.equal(perfect.speed, 600);
});

test('speed is null when the day recorded no time, and a day with some time still has a rate', () => {
  const [noTime] = summarizeDays([attempt('2026-10-16T09:00:00.000Z', { timeMs: 0 })], utc);
  assert.equal(noTime.speed, null);
  const [some] = summarizeDays([attempt('2026-10-16T09:00:00.000Z', { timeMs: 0, chars: 50 }), attempt('2026-10-16T09:01:00.000Z', { chars: 30, timeMs: 30_000 })], utc);
  assert.equal(some.speed, 160);
});

test('accuracy and speed are rounded to one decimal', () => {
  const [day] = summarizeDays([
    attempt('2026-10-16T09:00:00.000Z', { score: 70, chars: 10, timeMs: 30_000 }),
    attempt('2026-10-16T09:01:00.000Z', { score: 71, chars: 10, timeMs: 30_000 }),
    attempt('2026-10-16T09:02:00.000Z', { score: 71, chars: 7, timeMs: 30_000 }),
  ], utc);
  assert.equal(day.accuracy, 70.7);
  assert.equal(day.speed, 12.7);
  const [thirds] = summarizeDays([attempt('2026-10-16T09:00:00.000Z', { chars: 10, timeMs: 30_000 }), attempt('2026-10-16T09:01:00.000Z', { chars: 10, timeMs: 60_000 })], utc);
  assert.equal(thirds.speed, 13.3);
});

test('each day splits by level with its own count, accuracy and speed, and leaves out levels not used', () => {
  const [day] = summarizeDays([
    ...Array.from({ length: 10 }, (_, i) => attempt(`2026-10-16T09:${String(i).padStart(2, '0')}:00.000Z`, { score: 90, chars: 40, timeMs: 60_000, level: 'starter' })),
    attempt('2026-10-16T11:00:00.000Z', { score: 50, chars: 100, timeMs: 120_000, level: 'champion' }),
  ], utc);
  assert.deepEqual(Object.keys(day.byLevel), ['starter', 'champion']);
  assert.deepEqual(day.byLevel.starter, { count: 10, accuracy: 90, speed: 36 });
  assert.deepEqual(day.byLevel.champion, { count: 1, accuracy: 50, speed: 25 });
  assert.equal(day.count, 11);
  assert.equal(day.accuracy, 86.4);
});

test('levels always list in starter, explorer, champion order', () => {
  const [day] = summarizeDays(['champion', 'explorer', 'starter'].map((level, i) => attempt(`2026-10-16T09:0${i}:00.000Z`, { level })), utc);
  assert.deepEqual(Object.keys(day.byLevel), ['starter', 'explorer', 'champion']);
});

test('the day is the viewer\'s day: the same attempts fall on different days in different zones', () => {
  const rows = [attempt('2026-10-16T23:30:00.000Z'), attempt('2026-10-17T00:30:00.000Z')];
  assert.deepEqual(summarizeDays(rows, utc).map((d) => [d.date, d.count]), [['2026-10-17', 1], ['2026-10-16', 1]]);
  assert.deepEqual(summarizeDays(rows, shifted(2)).map((d) => [d.date, d.count]), [['2026-10-17', 2]], 'UTC+2: both after midnight');
  assert.deepEqual(summarizeDays(rows, shifted(-5)).map((d) => [d.date, d.count]), [['2026-10-16', 2]], 'UTC-5: both before midnight');
  assert.deepEqual(summarizeDays(rows, shifted(-0.5)).map((d) => d.date), ['2026-10-17', '2026-10-16'], 'a half hour behind UTC still splits them');
});

test('trends use the viewer\'s day too', () => {
  // Four pairs that straddle UTC midnight make five days in UTC (the middle ones hold two) but only four at UTC-5.
  const rows = [];
  for (let d = 1; d <= 4; d++) {
    rows.push(attempt(`2026-10-0${d}T23:30:00.000Z`), attempt(`2026-10-0${d + 1}T00:30:00.000Z`));
  }
  assert.equal(trendOf(rows, utc).verdict, 'steady', 'five UTC days');
  assert.equal(trendOf(rows, shifted(-5)).verdict, 'steady', 'four days at UTC-5');
  assert.equal(trendOf(rows.slice(0, 6), shifted(-5)).verdict, 'not-enough-data', 'three days at UTC-5');
});

test('localDayKey groups by the zone the process runs in', () => {
  const was = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(localDayKey('2026-10-16T12:30:00.000Z'), '2026-10-17');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(localDayKey('2026-10-16T05:30:00.000Z'), '2026-10-15');
    assert.equal(localDayKey('2026-10-16T07:30:00.000Z'), '2026-10-16');
    process.env.TZ = 'UTC';
    assert.equal(localDayKey('2026-01-02T00:00:00.000Z'), '2026-01-02');
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test('dayLabel reads like "Fri Oct 16"', () => {
  assert.match(dayLabel('2026-10-16'), /Fri/);
  assert.match(dayLabel('2026-10-16'), /16/);
  assert.match(dayLabel('2026-10-16'), /Oct/);
});

test('fewer than four active days is not enough data, however many attempts there are', () => {
  const crowded = Array.from({ length: 30 }, (_, i) => attempt(`2026-10-0${1 + (i % 3)}T12:00:00.000Z`, { score: i }));
  assert.deepEqual(trendOf(crowded, utc), { verdict: 'not-enough-data', accuracy: { verdict: 'not-enough-data', delta: null }, speed: { verdict: 'not-enough-data', delta: null } });
  assert.equal(trendOf([], utc).verdict, 'not-enough-data');
  assert.equal(trendOf(onDays([{}, {}, {}, {}]), utc).verdict, 'steady', 'exactly four days is enough');
});

test('the same scores and speeds are steady', () => {
  const trend = trendOf(onDays(Array(8).fill({})), utc);
  assert.deepEqual(trend, { verdict: 'steady', accuracy: { verdict: 'steady', delta: 0 }, speed: { verdict: 'steady', delta: 0 } });
});

test('accuracy up, speed flat is improving; accuracy down, speed flat is worsening', () => {
  // The chars are chosen so every attempt traces 60 letters, which keeps the speed flat.
  const up = trendOf(onDays([{ score: 60, chars: 100 }, { score: 60, chars: 100 }, { score: 80, chars: 75 }, { score: 80, chars: 75 }]), utc);
  assert.deepEqual([up.verdict, up.accuracy, up.speed.verdict], ['improving', { verdict: 'improving', delta: 20 }, 'steady']);
  const down = trendOf(onDays([{ score: 80, chars: 75 }, { score: 80, chars: 75 }, { score: 60, chars: 100 }, { score: 60, chars: 100 }]), utc);
  assert.deepEqual([down.verdict, down.accuracy.verdict, down.accuracy.delta, down.speed.verdict], ['worsening', 'worsening', -20, 'steady']);
});

test('speed up (faster tracing) with steady accuracy is improving, and slower is worsening', () => {
  const faster = trendOf(onDays([{ timeMs: 60_000 }, { timeMs: 60_000 }, { timeMs: 30_000 }, { timeMs: 30_000 }]), utc);
  assert.deepEqual([faster.verdict, faster.speed.verdict, faster.speed.delta, faster.accuracy.verdict], ['improving', 'improving', 1, 'steady']);
  const slower = trendOf(onDays([{ timeMs: 30_000 }, { timeMs: 30_000 }, { timeMs: 60_000 }, { timeMs: 60_000 }]), utc);
  assert.deepEqual([slower.verdict, slower.speed.verdict, slower.speed.delta], ['worsening', 'worsening', -0.5]);
});

test('one measure up and the other down is mixed', () => {
  const trend = trendOf(onDays([{ score: 60, timeMs: 60_000 }, { score: 60, timeMs: 60_000 }, { score: 90, timeMs: 120_000 }, { score: 90, timeMs: 120_000 }]), utc);
  assert.deepEqual([trend.verdict, trend.accuracy.verdict, trend.speed.verdict], ['mixed', 'improving', 'worsening']);
  const other = trendOf(onDays([{ score: 90, timeMs: 120_000 }, { score: 90, timeMs: 120_000 }, { score: 60, timeMs: 60_000 }, { score: 60, timeMs: 60_000 }]), utc);
  assert.deepEqual([other.verdict, other.accuracy.verdict, other.speed.verdict], ['mixed', 'worsening', 'improving']);
});

test('one measure moving with the other steady beats steady: improving needs no worsening', () => {
  const trend = trendOf(onDays([{ score: 50, chars: 120 }, { score: 50, chars: 120 }, { score: 75, chars: 80 }, { score: 75, chars: 80 }]), utc);
  assert.deepEqual([trend.verdict, trend.accuracy.verdict, trend.speed.verdict], ['improving', 'improving', 'steady']);
});

test('accuracy must move by 3 points: exactly 3 counts, just under does not', () => {
  const at = (delta) => trendOf(onDays([{ score: 70 }, { score: 70 }, { score: 70 + delta }, { score: 70 + delta }]), utc);
  assert.equal(at(3).accuracy.verdict, 'improving');
  assert.equal(at(-3).accuracy.verdict, 'worsening');
  assert.equal(at(2.9).accuracy.verdict, 'steady');
  assert.equal(at(-2.9).accuracy.verdict, 'steady');
  assert.equal(at(3).accuracy.delta, 3);
});

test('the 3 point step holds for awkward floats', () => {
  const rows = onDays([{ score: 80.1 }, { score: 80.1 }, { score: 83.1 }, { score: 83.1 }]);
  assert.equal(trendOf(rows, utc).accuracy.verdict, 'improving');
  assert.equal(trendOf([...rows].reverse().map((a, i) => ({ ...a, completedAt: dayNo(i) })), utc).accuracy.verdict, 'worsening');
});

test('speed must move by 10 percent of the older speed: exactly 10 counts, just under does not', () => {
  // The older half runs 100 chars/min.
  const at = (newerChars) => trendOf(onDays([{ chars: 100 }, { chars: 100 }, { chars: newerChars }, { chars: newerChars }]), utc).speed;
  assert.deepEqual(at(110), { verdict: 'improving', delta: 0.1 });
  assert.equal(at(109).verdict, 'steady');
  assert.deepEqual(at(90), { verdict: 'worsening', delta: -0.1 });
  assert.equal(at(91).verdict, 'steady');
});

test('the halves are aggregated over all their attempts, so a busy day weighs more than a quiet one', () => {
  const rows = [
    attempt(dayNo(0), { score: 50 }), attempt(dayNo(1), { score: 50 }),
    // The newer half: one day with nine attempts at 90 and one with a single attempt at 10: 82 overall, not 50.
    ...Array.from({ length: 9 }, () => attempt(dayNo(2), { score: 90 })), attempt(dayNo(3), { score: 10 }),
  ];
  const { accuracy } = trendOf(rows, utc);
  assert.deepEqual(accuracy, { verdict: 'improving', delta: 32 });
});

test('speed uses total letters traced over total time in each half', () => {
  const rows = [
    attempt(dayNo(0), { chars: 100, timeMs: 60_000 }), attempt(dayNo(1), { chars: 100, timeMs: 240_000 }),
    attempt(dayNo(2), { chars: 100, timeMs: 60_000 }), attempt(dayNo(3), { chars: 100, timeMs: 240_000 }),
  ];
  const { speed } = trendOf(rows, utc);
  assert.deepEqual(speed, { verdict: 'steady', delta: 0 });
});

test('only the last 14 active days count, and gaps between days do not matter', () => {
  const old = Array.from({ length: 6 }, (_, i) => attempt(`2026-08-0${i + 1}T12:00:00.000Z`, { score: 10 }));
  const recent = Array.from({ length: 14 }, (_, i) => attempt(dayNo(i), { score: 80 }));
  assert.equal(trendOf([...old, ...recent], utc).verdict, 'steady', 'the old low scores fall outside the window');
  const gappy = [attempt('2026-01-01T12:00:00.000Z', { score: 50 }), attempt('2026-03-01T12:00:00.000Z', { score: 50 }), attempt('2026-07-01T12:00:00.000Z', { score: 80 }), attempt('2026-10-01T12:00:00.000Z', { score: 80 })];
  assert.equal(trendOf(gappy, utc).verdict, 'improving');
});

test('with an odd number of days the newer half takes the extra day', () => {
  // Five days: older = days 1-2, newer = days 3-5. Scores 50 50 | 60 60 60 -> up 10. (If the older half had three, 50 50 60 | 60 60 would be up 6.7.)
  const trend = trendOf(onDays([{ score: 50 }, { score: 50 }, { score: 60 }, { score: 60 }, { score: 60 }]), utc);
  assert.equal(trend.accuracy.delta, 10);
});

test('a speed that cannot be measured does not vote and is reported as such', () => {
  const noTime = trendOf(onDays([{ timeMs: 0, score: 60 }, { timeMs: 0, score: 60 }, { timeMs: 0, score: 80 }, { timeMs: 0, score: 80 }]), utc);
  assert.deepEqual(noTime.speed, { verdict: 'not-enough-data', delta: null });
  assert.equal(noTime.verdict, 'improving');
  const newerOnly = trendOf(onDays([{ timeMs: 0 }, { timeMs: 0 }, {}, {}]), utc);
  assert.deepEqual(newerOnly.speed, { verdict: 'not-enough-data', delta: null });
  assert.equal(newerOnly.verdict, 'steady');
});

test('trendByLevel judges each level on its own and skips levels with no attempts', () => {
  // The mix shifts toward champion, so the overall score drops, but each level is steady.
  const rows = [
    ...[0, 1, 2, 3].map((i) => attempt(dayNo(i), { score: 90, level: 'starter' })),
    ...[2, 3].flatMap((i) => [attempt(dayNo(i), { score: 50, level: 'champion' }), attempt(dayNo(i), { score: 50, level: 'champion' }), attempt(dayNo(i), { score: 50, level: 'champion' })]),
  ];
  assert.equal(trendOf(rows, utc).verdict, 'worsening', 'the overall number is dragged down by the mix');
  const byLevel = trendByLevel(rows, utc);
  assert.deepEqual(Object.keys(byLevel), ['starter', 'champion']);
  assert.equal(byLevel.starter.verdict, 'steady');
  assert.equal(byLevel.champion.verdict, 'not-enough-data', 'only two champion days');
});

test('trendByLevel finds an improving level inside a steady whole', () => {
  const rows = [
    ...[0, 1, 2, 3].map((i) => attempt(dayNo(i), { score: i < 2 ? 60 : 80, level: 'explorer' })),
    ...[0, 1, 2, 3].map((i) => attempt(dayNo(i), { score: 80, level: 'starter' })),
  ];
  const byLevel = trendByLevel(rows, utc);
  assert.equal(byLevel.explorer.verdict, 'improving');
  assert.equal(byLevel.starter.verdict, 'steady');
  assert.equal('champion' in byLevel, false);
  assert.deepEqual(trendByLevel([], utc), {});
});

test('words for the page', () => {
  const up = trendWords(trendOf(onDays([{ score: 60, chars: 100, timeMs: 60_000 }, { score: 60, chars: 100, timeMs: 60_000 }, { score: 64.2, chars: 100, timeMs: 53_500 }, { score: 64.2, chars: 100, timeMs: 53_500 }]), utc));
  assert.deepEqual(up, { headline: 'Improving', accuracy: 'Accuracy: up 4.2 points', speed: 'Speed: up 20%' });
  const down = trendWords(trendOf(onDays([{ score: 80, chars: 75 }, { score: 80, chars: 75 }, { score: 60, chars: 100 }, { score: 60, chars: 100 }]), utc));
  assert.deepEqual([down.headline, down.accuracy, down.speed], ['Getting worse', 'Accuracy: down 20.0 points', 'Speed: about the same']);
  assert.match(trendWords(trendOf([], utc)).headline, /Not enough data/);
  assert.equal(trendWords(trendOf(onDays(Array(4).fill({ timeMs: 0 })), utc)).speed, 'Speed: not measured');
  assert.match(trendWords({ verdict: 'mixed', accuracy: { verdict: 'improving', delta: 5 }, speed: { verdict: 'worsening', delta: -0.2 } }).headline, /^Mixed/);
  assert.deepEqual([accuracyText(85.5), accuracyText(60), speedText(40), speedText(null)], ['85.5', '60.0', '40.0 chars/min', 'no time recorded']);
});
