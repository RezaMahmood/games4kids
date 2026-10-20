import test from 'node:test';
import assert from 'node:assert/strict';
import { HARD_BONUS, cheerFor, chipText, pointsFor, starsFor, summarize } from '../../games/letterjoin/play/web/scoreboard.js';

const at = (title, result, status = 'published', level = 'explorer', order = 0) => ({ id: title, title, status, level, order, updatedAt: '2026-01-01T00:00:00.000Z', result });
const r = (score, timeMs) => ({ score, timeMs });

test('every score gets a cheer and at least one star, so no result feels like a failure', () => {
  for (const score of [0, 1, 39.9, 40, 59, 60, 74, 75, 89, 90, 100]) {
    assert.ok(cheerFor(score).length > 0, `cheer at ${score}`);
    assert.ok(starsFor(score) >= 1 && starsFor(score) <= 5, `stars at ${score}`);
  }
  assert.equal(starsFor(0), 1);
  assert.equal(starsFor(100), 5);
  assert.equal(cheerFor(95), 'Superstar!');
  assert.equal(cheerFor(10), 'You did it!');
  assert.ok(!/try again|bad|wrong|fail/i.test(['0', '30', '50', '70', '80', '95'].map((s) => cheerFor(Number(s))).join(' ')));
});

test('the overall score is the sum of the latest scores, shown as whole numbers, and counts only published activities', () => {
  const s = summarize([at('a', r(80.4, 1000)), at('b', r(55.5, 2000)), at('c', null), at('draft', r(100, 1), 'draft')]);
  assert.equal(s.points, 80 + 56);
  assert.equal(s.done, 2);
  assert.equal(s.total, 3, 'drafts are not counted');
  assert.deepEqual(s.todo.map((a) => a.title), ['c']);
});

test('the scoreboard lists best scores first, then the quicker time, then title', () => {
  const s = summarize([at('slow', r(90, 9000)), at('low', r(20, 1000)), at('fast', r(90, 1000)), at('alpha', r(90, 9000)), at('top', r(100, 5000))]);
  assert.deepEqual(s.entries.map((e) => e.activity.title), ['top', 'fast', 'alpha', 'slow', 'low']);
  assert.ok(s.entries.every((e) => e.cheer && e.stars >= 1));
});

test('what is left to do follows the level order, easiest first', () => {
  const s = summarize([at('c1', null, 'published', 'champion', 0), at('s1', null, 'published', 'starter', 5), at('e1', r(70, 1), 'published', 'explorer', 1), at('s0', null, 'published', 'starter', 2)]);
  assert.deepEqual(s.todo.map((a) => a.title), ['s0', 's1', 'c1']);
});

test('the header chip invites the child to start, then shows their points', () => {
  assert.equal(chipText({ points: 0, done: 0 }), 'Collect points');
  assert.equal(chipText({ points: 1240, done: 12 }), '1,240 points');
  assert.equal(chipText({ points: 0, done: 1 }), '0 points');
});

test('an empty list is a valid starting point', () => {
  assert.deepEqual(summarize([]), { points: 0, done: 0, total: 0, entries: [], todo: [] });
});

test('a hard mode result earns 1.2 times the points, while its score stays the same', () => {
  assert.equal(HARD_BONUS, 1.2);
  assert.equal(pointsFor({ score: 85 }), 85);
  assert.equal(pointsFor({ score: 85, hard: true }), 102);
  assert.equal(pointsFor({ score: 100, hard: true }), 120, 'the bonus can take one result past 100 points');
  const s = summarize([at('traced', r(90, 1000)), at('written', { score: 80, timeMs: 5000, hard: true })]);
  assert.equal(s.points, 90 + 96);
  assert.deepEqual(s.entries.map((e) => [e.activity.title, e.score, e.points, e.hard]), [['written', 80, 96, true], ['traced', 90, 90, false]], 'ranked by points');
});
