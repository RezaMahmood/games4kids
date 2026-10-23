import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksFor, FAIL_AT, judge, UNSURE_AT } from '../../games/timedetectives/admin/api/check.ts';
import { FIELD_REFS } from '../../games/timedetectives/data/round.ts';
import { ROUND } from './lindisfarne.ts';

const checks = checksFor(ROUND);
const passing = Object.fromEntries(
	checks.map(({ id }) => [id, id.endsWith('_answer') ? { type: 'choice', probabilities: { supports: 1 } } : /_decoy_/.test(id) ? { type: 'choice', probabilities: { supports: 0 } } : { type: 'noul', noul: 0 }]),
);
const withBrief = (noul: number) => ({ ...passing, who_brief: { type: 'noul', noul } });

test('a round has an answer, three decoy, brief and hint check for each of its three questions', () => {
	assert.equal(checks.length, 18);
	assert.deepEqual(judge(checks, passing), []);
});

test('a probability is a sure finding from FAIL_AT, an unsure one from UNSURE_AT, and none below', () => {
	const brief = (sure: boolean) => [{ field: 'brief', problem: 'give away the answer to "Who is it?"', sure }];
	assert.deepEqual(judge(checks, withBrief(UNSURE_AT - 0.01)), []);
	assert.deepEqual(judge(checks, withBrief(UNSURE_AT)), brief(false));
	assert.deepEqual(judge(checks, withBrief(FAIL_AT - 0.01)), brief(false));
	assert.deepEqual(judge(checks, withBrief(FAIL_AT)), brief(true));
});

test('each finding names the form field that holds the words it is about', () => {
	const all = Object.fromEntries(checks.map(({ id }) => [id, id.endsWith('_answer') ? { type: 'choice', probabilities: { supports: 0 } } : /_decoy_/.test(id) ? { type: 'choice', probabilities: { supports: 1 } } : { type: 'noul', noul: 1 }]));
	assert.deepEqual(new Set(judge(checks, all).map(({ field }) => field)), new Set(FIELD_REFS.filter((field) => field !== 'full')));
});

test('an answer the story does not support fails, and an answer that is missing or the wrong kind is not a pass', () => {
	assert.deepEqual(judge(checks, { ...passing, when_answer: { type: 'choice', probabilities: { supports: 0.1 } } }), [{ field: 'when-answer', problem: 'be missing from the story', sure: true }]);
	assert.throws(() => judge(checks, { ...passing, who_hint: undefined }));
	assert.throws(() => judge(checks, { ...passing, who_hint: { type: 'choice', probabilities: { supports: 0 } } }));
	assert.throws(() => judge(checks, { ...passing, who_hint: { type: 'noul', noul: 2 } }));
});
