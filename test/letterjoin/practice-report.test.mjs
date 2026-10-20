import test from 'node:test';
import assert from 'node:assert/strict';
import { cellFor, dayLabel, goalText, totalText } from '../../games/letterjoin/admin/web/practice-report.js';

test('a day is labelled from its calendar date, whatever time zone the admin is in', () => {
  assert.equal(dayLabel('2026-10-17'), 'Sat 17');
  assert.equal(dayLabel('2026-10-12'), 'Mon 12');
  assert.equal(dayLabel('2026-03-01'), 'Sun 1');
});

test('a cell shows whole minutes rounded down, and a tick only when the goal was really reached', () => {
  assert.deepEqual(cellFor(0, 15), { text: '–', met: false, title: 'No practice' });
  assert.equal(cellFor(20, 15).text, '<1');
  assert.equal(cellFor(125, 15).text, '2');
  assert.equal(cellFor(15 * 60 - 1, 15).text, '14', 'one second short is not a tick');
  assert.equal(cellFor(15 * 60 - 1, 15).met, false);
  assert.deepEqual(cellFor(15 * 60, 15), { text: '✓ 15', met: true, title: '15 min 00 s, goal reached' });
  assert.equal(cellFor(20 * 60 + 5, 15).text, '✓ 20');
  assert.equal(cellFor(3600, 0).met, false, 'with no goal nothing is reached');
  assert.equal(cellFor(3600, 0).text, '60');
});

test('totals and the goal line read plainly', () => {
  assert.equal(totalText(0), '0 min');
  assert.equal(totalText(5400), '90 min');
  assert.match(goalText(0), /Set one in Settings/);
  assert.match(goalText(15), /15 minutes a day/);
  assert.match(goalText(1), /1 minute a day/);
});
