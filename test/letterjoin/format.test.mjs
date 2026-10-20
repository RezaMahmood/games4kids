import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, formatTenths, parseDuration, shownScore, storedScore, timerLabel } from '../../games/letterjoin/play/web/format.js';

test('clock and tenths formats', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(83_999), '1:23');
  assert.equal(formatClock(3_001, { roundUp: true }), '0:04');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatTenths(83_456), '1:23.4');
  assert.equal(formatTenths(4_000), '0:04.0');
  assert.equal(timerLabel(null), 'No timer');
  assert.equal(timerLabel(120), '2:00 timer');
});

test('timer input takes m:ss or plain seconds', () => {
  assert.equal(parseDuration('1:30'), 90);
  assert.equal(parseDuration(' 90 '), 90);
  assert.equal(parseDuration('0:05'), 5);
  assert.equal(parseDuration('60:00'), 3600);
  for (const bad of ['', '1:5', '1:60', 'abc', '1.5', '-3', '1:30:00']) assert.equal(parseDuration(bad), null, bad);
});

test('the shown score is the whole number of the stored one-decimal score', () => {
  assert.equal(storedScore(92.476), 92.5);
  assert.equal(shownScore(92.476), 93, 'matches what the list shows for the stored 92.5');
  assert.equal(shownScore(92.44), 92);
});
