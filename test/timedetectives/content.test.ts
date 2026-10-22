import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offeredChoices, parseRoundContent } from '../../games/timedetectives/data/content.ts';
import { LINDISFARNE, ROUND } from './lindisfarne.ts';

const problemsOf = (raw: unknown) => {
	const parsed = parseRoundContent(raw);
	return parsed.ok ? [] : parsed.problems;
};
const withQuestion = (kind: string, change: object) => ({ ...LINDISFARNE, questions: LINDISFARNE.questions.map((q) => (q.kind === kind ? { ...q, ...change } : q)) });

test('a whole round parses, trimmed, with its questions in who, where, when order whatever order they came in', () => {
	const parsed = parseRoundContent({ ...LINDISFARNE, title: '  The raid  ', questions: [...LINDISFARNE.questions].reverse() });
	assert.ok(parsed.ok);
	assert.equal(parsed.value.title, 'The raid');
	assert.deepEqual(parsed.value.questions.map((q) => q.kind), ['who', 'where', 'when']);
	assert.deepEqual(parsed.value.questions[2], LINDISFARNE.questions[2]);
});

test('every kind must be asked exactly once, and no other kind', () => {
	assert.deepEqual(problemsOf({ ...LINDISFARNE, questions: LINDISFARNE.questions.slice(0, 2) }), ['questions must have exactly one when question']);
	assert.deepEqual(problemsOf({ ...LINDISFARNE, questions: [...LINDISFARNE.questions, LINDISFARNE.questions[0]] }), ['questions must have exactly one who question']);
	assert.deepEqual(problemsOf({ ...LINDISFARNE, questions: [...LINDISFARNE.questions, { ...LINDISFARNE.questions[0], kind: 'what' }] }), ['questions has unknown kinds: "what"']);
	assert.ok(problemsOf({ ...LINDISFARNE, questions: 'who' }).includes('questions must be a list of objects'));
});

test('a question has three decoys that differ from the answer and each other, ignoring case', () => {
	assert.deepEqual(problemsOf(withQuestion('who', { decoys: ['vikings', 'Romans', 'Normans'] })), ['who answer and decoys must all be different']);
	assert.deepEqual(problemsOf(withQuestion('where', { decoys: ['York', 'York', 'Jarrow'] })), ['where answer and decoys must all be different']);
	assert.deepEqual(problemsOf(withQuestion('when', { decoys: ['AD 43', 'AD 1066'] })), ['when decoys must be a list of 3']);
	assert.deepEqual(problemsOf(withQuestion('when', { hint: '' })), ['when hint must not be empty']);
});

test('text fields must be filled in, short enough and plain, and only the paragraphs may break lines', () => {
	assert.deepEqual(problemsOf({ ...LINDISFARNE, title: 'Two\nlines' }), ['title must be a single line of plain text']);
	assert.deepEqual(problemsOf({ ...LINDISFARNE, brief: ' ' }), ['brief must not be empty']);
	assert.deepEqual(problemsOf({ ...LINDISFARNE, full: 'x'.repeat(1601) }), ['full must be at most 1600 characters']);
	assert.ok(parseRoundContent({ ...LINDISFARNE, full: 'One.\r\n\r\nTwo.' }).ok);
	assert.deepEqual(problemsOf(withQuestion('who', { answer: 'x'.repeat(61) })), ['who answer must be at most 60 characters']);
});

test('anything that is not a round gives problems instead of throwing', () => {
	for (const raw of [null, undefined, 'round', 42, [], {}, { questions: [null, 1] }]) assert.notEqual(problemsOf(raw).length, 0, JSON.stringify(raw));
});

test('going easy offers the answer and the first two decoys, and the other confidences offer all four', () => {
	const [who] = ROUND.questions;
	assert.ok(who);
	assert.deepEqual(offeredChoices(who, 'easy'), ['Vikings', 'Romans', 'Normans']);
	assert.deepEqual(offeredChoices(who, 'bit'), ['Vikings', 'Romans', 'Normans', 'Ancient Egyptians']);
	assert.deepEqual(offeredChoices(who, 'lots'), ['Vikings', 'Romans', 'Normans', 'Ancient Egyptians']);
});
