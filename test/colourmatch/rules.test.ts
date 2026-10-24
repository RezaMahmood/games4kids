import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLOUR_IDS, DEFAULT_TUNING, isCongruent, makeTurn, mismatchChance, parseTuning, rightColour, roundClockMs, roundMultiplier, secondsPerTurn, speedFactor, turnPoints, turnsIn } from '../../games/colourmatch/data/index.ts';
import { seeded } from './support.ts';

const T = DEFAULT_TUNING;

test('round 1 has 5 words and each round one more, up to 10, with no last round', () => {
	assert.deepEqual([1, 2, 5, 6, 7, 50].map((round) => turnsIn(T, round)), [5, 6, 9, 10, 10, 10]);
});

test('seconds per word start at 4, shrink by a tenth each round and never go under 1.2, and the round clock is words times seconds', () => {
	assert.equal(secondsPerTurn(T, 1), 4);
	assert.ok(Math.abs(secondsPerTurn(T, 2) - 3.6) < 1e-9);
	assert.equal(secondsPerTurn(T, 40), 1.2);
	assert.equal(roundClockMs(T, 1), 20_000);
	assert.equal(roundClockMs(T, 2), 21_600);
	assert.equal(roundClockMs(T, 40), 12_000);
});

test('the mismatch chance climbs a tenth a round from a quarter, adds a bonus when the last three correct answers were fast, and caps at 0.8', () => {
	assert.equal(mismatchChance(T, 1, []), 0.25);
	assert.ok(Math.abs(mismatchChance(T, 3, [2000, 2000, 2000]) - 0.45) < 1e-9);
	assert.ok(Math.abs(mismatchChance(T, 1, [900, 3000, 1000]) - 0.4) < 1e-9, 'the median of 900, 1000 and 3000 is under 1200');
	assert.equal(mismatchChance(T, 1, [500, 1000, 1500, 5000, 5000]), 0.25, 'only the last three count');
	assert.equal(mismatchChance(T, 20, [100, 100, 100]), 0.8);
});

test('the opening words match their ink, every word shows four different colours including the right one, and a mismatch shows the lure too', () => {
	const rng = seeded(7);
	let mismatches = 0;
	for (let i = 0; i < 400; i++) {
		const turn = makeTurn(T, { round: 1 + Math.floor(i / 5), turnInGame: i, recentCorrectMs: [300, 300, 300] }, rng);
		assert.equal(new Set(turn.squares).size, 4, 'four different colours');
		assert.ok(turn.squares.every((id) => COLOUR_IDS.includes(id)));
		assert.ok(turn.squares.includes(rightColour('normal', turn)), 'the word\'s colour is a square');
		assert.ok(turn.squares.includes(rightColour('hard', turn)), 'the ink is a square');
		if (i < T.openingTurns) assert.ok(isCongruent(turn), `word ${i} is an opening word`);
		if (!isCongruent(turn)) mismatches++;
	}
	assert.ok(mismatches > 200 && mismatches < 340, `at the 0.8 cap most later words mismatch, got ${mismatches}`);
	const slow = seeded(7);
	let early = 0;
	for (let i = 3; i < 103; i++) if (!isCongruent(makeTurn(T, { round: 1, turnInGame: i, recentCorrectMs: [] }, slow))) early++;
	assert.ok(early > 10 && early < 40, `in round 1 with no speed bonus about a quarter mismatch, got ${early}`);
});

test('points start at 100, halve for an answer that takes the whole time, grow a quarter a round and half again in hard mode', () => {
	assert.equal(speedFactor(0, 4000), 1);
	assert.equal(speedFactor(2000, 4000), 0.75);
	assert.equal(speedFactor(9000, 4000), 0.5);
	assert.equal(turnPoints(T, 'normal', 1, 0), 100);
	assert.equal(turnPoints(T, 'normal', 1, 2000), 75);
	assert.equal(turnPoints(T, 'hard', 1, 2000), 113);
	assert.equal(roundMultiplier(T, 3), 1.5);
	assert.equal(turnPoints(T, 'normal', 3, 0), 150);
	assert.equal(turnPoints(T, 'hard', 3, 99_999), 113);
});

test('a tuning must have every field as a number inside its bounds, whole where the rule counts things, and consistent across fields', () => {
	assert.deepEqual(parseTuning(DEFAULT_TUNING), { ok: true, value: DEFAULT_TUNING });
	const problemsOf = (change: Record<string, unknown>) => {
		const parsed = parseTuning({ ...DEFAULT_TUNING, ...change });
		return parsed.ok ? [] : parsed.problems;
	};
	assert.deepEqual(problemsOf({ openingTurns: 2.5 }), ['openingTurns must be a whole number']);
	assert.deepEqual(problemsOf({ decay: 1.5 }), ['decay must be between 0.5 and 1']);
	assert.deepEqual(problemsOf({ basePoints: 'lots' }), ['basePoints must be a number']);
	assert.deepEqual(problemsOf({ maxTurns: 3 }), ['firstTurns must be at most maxTurns']);
	assert.deepEqual(problemsOf({ minSecondsPerTurn: 5 }), ['minSecondsPerTurn must be at most firstSecondsPerTurn']);
	assert.deepEqual(problemsOf({ decay: 2, maxTurns: 1 }), ['decay must be between 0.5 and 1', 'firstTurns must be at most maxTurns'], 'a bad field does not hide a cross-field problem');
	assert.deepEqual(problemsOf({ startChance: 0.9 }), ['startChance must be at most maxChance']);
	const { hardMultiplier: _dropped, ...missing } = DEFAULT_TUNING;
	assert.deepEqual(parseTuning(missing), { ok: false, problems: ['hardMultiplier must be a number'] });
	assert.equal(parseTuning(null).ok, false);
});
