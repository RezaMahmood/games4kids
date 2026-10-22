import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Confidence } from '../../games/timedetectives/data/content.ts';
import { parseAttemptInput, scoreAttempt, type AnswerLog } from '../../games/timedetectives/data/score.ts';
import { ROUND } from './lindisfarne.ts';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const perfect: AnswerLog[] = [
	{ kind: 'who', tries: ['Vikings'], hint: false },
	{ kind: 'where', tries: ['Lindisfarne'], hint: false },
	{ kind: 'when', tries: ['AD 793'], hint: false },
];
/** Wrong then right (5), right first with the hint (7), right first (10): 22 before the bonus. */
const mixed: AnswerLog[] = [
	{ kind: 'who', tries: ['Romans', 'Vikings'], hint: false },
	{ kind: 'where', tries: ['Lindisfarne'], hint: true },
	{ kind: 'when', tries: ['AD 793'], hint: false },
];

function mark(confidence: Confidence, answers: unknown) {
	const input = parseAttemptInput(ATTEMPT, { confidence, answers });
	if (!input.ok) return input;
	return scoreAttempt(ROUND, input.value);
}

const points = (confidence: Confidence, answers: unknown) => {
	const marked = mark(confidence, answers);
	assert.ok(marked.ok, JSON.stringify(marked));
	return marked.value.points;
};

const problems = (confidence: Confidence, answers: unknown) => {
	const marked = mark(confidence, answers);
	return marked.ok ? [] : marked.problems;
};

test('every answer right first time scores 30, times the bonus for how sure the child said they were', () => {
	assert.equal(points('lots', perfect), 45);
	assert.equal(points('bit', perfect), 36);
	assert.equal(points('easy', perfect), 30);
});

test('a second try earns 5, the hint costs 3, and the round total is rounded after the bonus', () => {
	assert.equal(points('easy', mixed), 22);
	assert.equal(points('bit', mixed), 26);
	assert.equal(points('lots', mixed), 33);
	assert.equal(points('easy', [{ kind: 'who', tries: ['Romans', 'Vikings'], hint: true }, ...perfect.slice(1)]), 22, 'right second time with the hint is 2');
});

test('two wrong tries score nothing, and the hint never takes a question below nothing', () => {
	const missed = [{ kind: 'who', tries: ['Romans', 'Normans'], hint: true }, ...perfect.slice(1)];
	assert.equal(points('easy', missed), 20);
	const marked = mark('easy', missed);
	assert.ok(marked.ok);
	assert.deepEqual(marked.value.right, { who: false, where: true, when: true });
});

test('a try must be a choice offered at the child\'s confidence, so going easy cannot pick the third decoy', () => {
	const third = [{ kind: 'who', tries: ['Ancient Egyptians', 'Vikings'], hint: false }, ...perfect.slice(1)];
	assert.equal(points('bit', third), 30);
	assert.deepEqual(problems('easy', third), ['who tries must be choices the round offered']);
	assert.deepEqual(problems('easy', [{ kind: 'who', tries: ['Saxons', 'Vikings'], hint: false }, ...perfect.slice(1)]), ['who tries must be choices the round offered']);
});

test('the log must follow the rules of play: one answer per question, a right first try ends it, a wrong one needs a second', () => {
	assert.deepEqual(problems('bit', perfect.slice(0, 2)), ['when has no answer']);
	assert.deepEqual(problems('bit', [...perfect, perfect[0]]), ['who is answered twice']);
	assert.deepEqual(problems('bit', [{ kind: 'who', tries: ['Vikings', 'Romans'], hint: false }, ...perfect.slice(1)]), ['who was right first time, so it has no second try']);
	assert.deepEqual(problems('bit', [{ kind: 'who', tries: ['Romans'], hint: false }, ...perfect.slice(1)]), ['who was wrong first time, so it needs a second try']);
	assert.deepEqual(problems('bit', [{ kind: 'who', tries: ['Romans', 'Romans'], hint: false }, ...perfect.slice(1)]), ['who tries the same choice twice']);
	assert.deepEqual(problems('bit', [{ kind: 'who', tries: ['Romans', 'Normans', 'Vikings'], hint: false }, ...perfect.slice(1)]), ['who tries must be 1 or 2 choices']);
	assert.deepEqual(problems('bit', [{ kind: 'what', tries: ['x'], hint: false }]), ['each answer needs a kind from who, where, when']);
	assert.deepEqual(problems('bit', [{ kind: 'who', tries: ['Vikings'] }]), ['who hint must be true or false']);
});

test('the attempt needs a GUID and a known confidence', () => {
	const bad = parseAttemptInput('nope', { confidence: 'sure', answers: perfect });
	assert.deepEqual(bad.ok ? [] : bad.problems, ['attemptId must be a GUID, made once per finished round', 'confidence must be one of lots, bit, easy']);
	const good = parseAttemptInput(ATTEMPT.toUpperCase(), { confidence: 'easy', answers: perfect });
	assert.ok(good.ok);
	assert.equal(good.value.attemptId, ATTEMPT);
	assert.equal(parseAttemptInput(ATTEMPT, null).ok, false);
});
