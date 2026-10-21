import test from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, emptyLevelText, pointsText } from '../../games/letterjoin/play/web/board.js';

test('a day is labelled from its calendar date, whatever time zone the device is in', () => {
  assert.equal(dayLabel('2026-10-17'), 'Sat 17');
  assert.equal(dayLabel('2026-10-12'), 'Mon 12');
  assert.equal(dayLabel('2026-03-01'), 'Sun 1');
});

test('a day with no points is a dash and a day with points is the number', () => {
  assert.equal(pointsText(0), '–');
  assert.equal(pointsText(96), '96');
  assert.equal(pointsText(1234), '1,234');
});

test('an empty level says nobody has scores there yet', () => {
  assert.equal(emptyLevelText('Starter'), 'Nobody has scores in Starter yet.');
});
