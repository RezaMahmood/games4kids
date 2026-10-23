import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksFor, FAIL_AT, judge, UNSURE_AT } from '../../games/timedetectives/admin/api/check.ts';
import { ROUND } from './lindisfarne.ts';

const checks = checksFor(ROUND);
const passing = Object.fromEntries(
	checks.map(({ id }) => [id, id.endsWith('_answer') ? { type: 'choice', probabilities: { supports: 1 } } : /_decoy_/.test(id) ? { type: 'choice', probabilities: { supports: 0 } } : { type: 'noul', noul: 0 }]),
);
const withBrief = (noul: number) => ({ ...passing, who_brief: { type: 'noul', noul } });

test('a round has an answer, three decoy, brief and hint check for each of its three questions', () => {
	assert.equal(checks.length, 18);
	assert.deepEqual(judge(checks, passing), { fails: [], unsure: [] });
});

test('a probability is a failure from FAIL_AT, unsure from UNSURE_AT, and a pass below', () => {
	assert.equal(judge(checks, withBrief(UNSURE_AT - 0.01)).unsure.length, 0);
	assert.equal(judge(checks, withBrief(UNSURE_AT)).unsure.length, 1);
	assert.equal(judge(checks, withBrief(FAIL_AT - 0.01)).fails.length, 0);
	assert.equal(judge(checks, withBrief(FAIL_AT)).fails.length, 1);
});

test('an answer the story does not support fails, and an answer that is missing or the wrong kind is not a pass', () => {
	assert.deepEqual(judge(checks, { ...passing, when_answer: { type: 'choice', probabilities: { supports: 0.1 } } }).fails, ['the story never says the when answer "AD 793"']);
	assert.throws(() => judge(checks, { ...passing, who_hint: undefined }));
	assert.throws(() => judge(checks, { ...passing, who_hint: { type: 'choice', probabilities: { supports: 0 } } }));
	assert.throws(() => judge(checks, { ...passing, who_hint: { type: 'noul', noul: 2 } }));
});
