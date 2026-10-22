import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENCE, QUESTION_KINDS, offeredChoices } from '../../games/timedetectives/data/content.ts';
import { POINTS, questionPoints } from '../../games/timedetectives/data/score.ts';
import * as page from '../../games/timedetectives/play/web/rules.js';

test('the page and the server share the question kinds, the confidence table and the points', () => {
  assert.deepEqual(page.QUESTION_KINDS, QUESTION_KINDS);
  assert.deepEqual(page.CONFIDENCE, CONFIDENCE);
  assert.deepEqual(page.POINTS, POINTS);
});

test('the page marks a question and offers choices the way the server does', () => {
  const question = { kind: 'who', answer: 'Vikings', decoys: ['Romans', 'Normans', 'Saxons'], hint: 'Ships.' };
  for (const tries of [['Vikings'], ['Romans', 'Vikings'], ['Romans', 'Normans'], []]) {
    for (const hint of [false, true]) assert.equal(page.questionPoints({ tries, hint }, 'Vikings'), questionPoints({ tries, hint }, 'Vikings'), JSON.stringify({ tries, hint }));
  }
  for (const confidence of Object.keys(CONFIDENCE)) assert.deepEqual(page.offeredChoices(question, confidence), offeredChoices(question, confidence));
});
