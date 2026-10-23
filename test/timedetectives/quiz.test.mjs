import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, isDone, phase, shuffled, tap } from '../../games/timedetectives/play/web/quiz.js';

test('a right first tap ends the question, and later taps change nothing', () => {
  const right = tap(fresh(), 'Vikings', 'Vikings');
  assert.deepEqual([phase(right, 'Vikings'), right.tries], ['right', ['Vikings']]);
  assert.equal(tap(right, 'Romans', 'Vikings'), right);
});

test('a wrong tap asks for another go, the same wrong choice twice counts once, and a second wrong one ends it', () => {
  const once = tap(fresh(), 'Romans', 'Vikings');
  assert.equal(phase(once, 'Vikings'), 'retry');
  assert.equal(isDone(once, 'Vikings'), false);
  assert.equal(tap(once, 'Romans', 'Vikings'), once);
  const twice = tap(once, 'Normans', 'Vikings');
  assert.deepEqual([phase(twice, 'Vikings'), isDone(twice, 'Vikings')], ['missed', true]);
  assert.equal(tap(twice, 'Vikings', 'Vikings'), twice, 'no third try');
  assert.equal(phase(tap(once, 'Vikings', 'Vikings'), 'Vikings'), 'right');
});

test('shuffling keeps every choice and leaves the original alone', () => {
  const choices = ['a', 'b', 'c', 'd'];
  const mixed = shuffled(choices, () => 0);
  assert.deepEqual([...mixed].sort(), choices);
  assert.notDeepEqual(mixed, choices);
  assert.deepEqual(choices, ['a', 'b', 'c', 'd']);
});
