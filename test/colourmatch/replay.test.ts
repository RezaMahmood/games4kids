import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MAX_JSON_BYTES } from '@g4k/host';
import { DEFAULT_TUNING, parseGameLog, replayGame, turnPoints, type GameLog } from '../../games/colourmatch/data/index.ts';
import { seeded, simulateGame, type WireLog } from './support.ts';

const T = DEFAULT_TUNING;

function parsed(wire: WireLog, gameId = randomUUID()): GameLog {
	const log = parseGameLog(gameId, wire);
	if (!log.ok) throw new Error(log.problems.join('; '));
	return log.value;
}

function replayed(wire: WireLog) {
	const result = replayGame(T, parsed(wire));
	if (!result.ok) throw new Error(result.problems.join('; '));
	return result.value;
}

const problemsOf = (wire: unknown, gameId?: string) => {
	const log = parseGameLog(gameId ?? randomUUID(), wire);
	if (!log.ok) return log.problems;
	const result = replayGame(T, log.value);
	return result.ok ? [] : result.problems;
};

test('a game of 8 right answers then 3 mistakes scores each right word by its round and speed, and the summary counts what happened', () => {
	const wire = simulateGame({ tuning: T, mode: 'normal', rng: seeded(1), turns: 11, endReason: 'mistakes', answerMs: (i) => 1000 + i * 100 });
	const { turns: marks, summary } = replayed(wire);
	assert.deepEqual(marks.map((m) => m.correct), [true, true, true, true, true, true, true, true, false, false, false]);
	const expected = [...Array(5).keys()].map((i) => turnPoints(T, 'normal', 1, 1000 + i * 100)).concat([5, 6, 7].map((i) => turnPoints(T, 'normal', 2, 1000 + i * 100)));
	assert.deepEqual(marks.map((m) => m.points), [...expected, 0, 0, 0]);
	assert.equal(marks[0]?.points, 88, 'round 1, 1000 ms of 4000: 100 × 0.875');
	assert.equal(marks[5]?.points, 99, 'round 2, 1500 ms of 3600: 100 × 0.79 × 1.25');
	assert.deepEqual(
		{ ...summary, medianCongruentMs: summary.medianCongruentMs !== null, medianIncongruentMs: summary.medianIncongruentMs !== null },
		{
			mode: 'normal', tuningId: 'default', endReason: 'mistakes', score: expected.reduce((a, b) => a + b, 0), roundsReached: 2, turns: 11, correct: 8, accuracy: 8 / 11,
			longestStreak: 8, medianCongruentMs: true, medianIncongruentMs: summary.medianIncongruentMs !== null, timeouts: 0, hiddenMs: 0, pointer: 'touch', viewport: '390x844', startedAt: '2026-10-19T19:00:00.000Z',
		},
	);
});

test('hard mode marks the ink and pays half again, and a game the clock ended counts its timeout', () => {
	const { turns: marks, summary } = replayed(simulateGame({ tuning: T, mode: 'hard', rng: seeded(2), turns: 7, endReason: 'clock', answerMs: 0 }));
	assert.deepEqual(marks.map((m) => m.points), [150, 150, 150, 150, 150, 188, 0]);
	assert.deepEqual([summary.timeouts, summary.correct, summary.score, summary.roundsReached], [1, 6, 938, 2]);
});

test('two wrong taps and then the clock running out is a game the clock ended, since a timeout is not a mistake', () => {
	const wire = simulateGame({ tuning: T, mode: 'normal', rng: seeded(7), turns: 6, endReason: 'clock', wrongAt: (i) => i === 3 || i === 4 });
	const { turns: marks, summary } = replayed(wire);
	assert.deepEqual(marks.map((m) => m.correct), [true, true, true, false, false, false]);
	assert.deepEqual([summary.endReason, summary.timeouts, summary.correct], ['clock', 1, 3]);
});

test('the medians split by whether the ink matched the word, which is the Stroop cost', () => {
	const wire = simulateGame({ tuning: T, mode: 'normal', rng: seeded(3), turns: 40, endReason: 'left', answerMs: (i) => 500 + (i % 3) * 100 });
	const log = parsed(wire);
	const { summary } = replayed(wire);
	const ms = (congruent: boolean) => log.turns.filter((t) => (t.word === t.ink) === congruent && t.answer).map((t) => t.answer?.answerMs ?? 0).sort((a, b) => a - b);
	const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2] : ((xs[xs.length / 2 - 1] ?? 0) + (xs[xs.length / 2] ?? 0)) / 2);
	assert.ok(ms(false).length > 0, 'the game had mismatched words');
	assert.deepEqual([summary.medianCongruentMs, summary.medianIncongruentMs], [median(ms(true)), median(ms(false))]);
});

test('a 1000 word game fits the JSON body cap with room to spare', () => {
	const wire = simulateGame({ tuning: T, mode: 'normal', rng: seeded(4), turns: 1000, endReason: 'left' });
	const bytes = new TextEncoder().encode(JSON.stringify(wire)).byteLength;
	assert.ok(bytes < MAX_JSON_BYTES / 2, `${bytes} bytes of ${MAX_JSON_BYTES}`);
	assert.equal(replayed(wire).summary.roundsReached, 102, '5 to 9 words in rounds 1 to 5, then 10 a round');
});

test('a log that is not a log, or names what the palette does not have, is refused with each problem named', () => {
	const good = simulateGame({ tuning: T, mode: 'normal', rng: seeded(5), turns: 5, endReason: 'left' });
	assert.deepEqual(problemsOf(good), []);
	assert.deepEqual(problemsOf(good, 'not-a-guid'), ['gameId must be a GUID']);
	assert.deepEqual(problemsOf({ ...good, mode: 'extreme' }), ['mode must be normal or hard']);
	assert.deepEqual(problemsOf({ ...good, tuningId: 'has spaces' }), ['tuningId must name a tuning']);
	assert.deepEqual(problemsOf({ ...good, startedAt: '2020-01-01T00:00:00Z' }), [], 'a device with a wrong clock can still save');
	assert.deepEqual(problemsOf({ ...good, startedAt: 'yesterday' }), ['startedAt must be an ISO time']);
	assert.deepEqual(problemsOf({ ...good, endReason: 'bored' }), ['endReason must be mistakes, clock or left']);
	assert.deepEqual(problemsOf({ ...good, turns: [] }), ['turns must be a list of 1 to 2000 turns']);
	assert.deepEqual(problemsOf({ ...good, device: { ...good.device, pointer: 'finger' } }), ['device.pointer must be touch, mouse or pen']);
	const [first, ...rest] = good.turns;
	assert.ok(first);
	assert.deepEqual(problemsOf({ ...good, turns: [[...first.slice(0, 2), 'teal', ...first.slice(3)] as never, ...rest] }), ['turns[0] colours must be from the palette']);
	assert.deepEqual(problemsOf({ ...good, turns: [[...first.slice(0, 8), 7, ...first.slice(9)] as never, ...rest] }), ['turns[0] answer must be a square 0 to 3, ms, a tap position 0 to 1 and a pointer type']);
	assert.deepEqual(problemsOf({ ...good, turns: [first.slice(0, 14) as never, ...rest] }), ['turns[0] must be a list of 15 values']);
	assert.equal(parseGameLog(randomUUID(), null).ok, false);
});

test('a log that could not come from a game played by the rules is refused', () => {
	const good = simulateGame({ tuning: T, mode: 'normal', rng: seeded(6), turns: 12, endReason: 'left', answerMs: 1000 });
	const edit = (index: number, change: (turn: unknown[]) => unknown[]) => ({ ...good, turns: good.turns.map((turn, i) => (i === index ? (change([...turn]) as never) : turn)) });
	const set = (index: number, slot: number, value: unknown) => edit(index, (turn) => ((turn[slot] = value), turn));

	assert.deepEqual(problemsOf(set(1, 1, 3)), ['turns[1] is round 1 word 3, but round 1 word 1 comes next']);
	assert.deepEqual(problemsOf(set(5, 0, 1)), ['turns[5] is round 1 word 0, but round 2 word 0 comes next', 'turns[5] has more clock left than round 1 has']);
	const ink = good.turns[0]?.[3];
	assert.deepEqual(problemsOf(set(0, 3, ink === 'red' ? 'blue' : 'red')).filter((p) => p.includes('opening')), ['turns[0] is an opening word, so its ink must match']);
	const word = good.turns[4]?.[2];
	assert.ok(word);
	const squares = good.turns[4]?.slice(4, 8) ?? [];
	const filler = squares.findIndex((s) => s !== word && s !== good.turns[4]?.[3]);
	assert.deepEqual(problemsOf(set(4, 4 + filler, word)), ['turns[4] must show four different colours']);
	const swapOut = squares.indexOf(word);
	const spare = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown'].find((c) => !squares.includes(c));
	assert.ok(spare);
	assert.deepEqual(problemsOf(set(4, 4 + swapOut, spare)), ["turns[4] must show the word's colour and the ink's"]);
	assert.deepEqual(problemsOf(set(2, 10, 19_000)), ["turns[2] was answered after round 1's clock ran out"]);
	assert.deepEqual(problemsOf(set(2, 14, 30_000)), ['turns[2] has more clock left than round 1 has']);
	assert.deepEqual(problemsOf(edit(3, (turn) => [...turn.slice(0, 8), null, turn[9], null, null, null, null, 0])), ['turns[3] ran out of clock, which ends the game']);

	const wrongSquare = (turn: unknown[]) => {
		const right = turn.slice(4, 8).indexOf(turn[2]);
		turn[8] = (right + 1) % 4;
		return turn;
	};
	const threeWrong = { ...good, turns: good.turns.map((turn, i) => (i >= 3 && i <= 5 ? (wrongSquare([...turn]) as never) : turn)) };
	assert.deepEqual(problemsOf(threeWrong), ['turns[5] was the 3th mistake in a row, which ends the game']);
	assert.deepEqual(problemsOf({ ...good, endReason: 'mistakes' }), ['a game ended by mistakes ends on the 3th mistake in a row']);
	assert.deepEqual(problemsOf({ ...good, endReason: 'clock' }), ['a game the clock ended ends on a word the clock ran out on']);
	const endsWrong = { ...good, turns: good.turns.map((turn, i) => (i >= 9 ? (wrongSquare([...turn]) as never) : turn)) };
	assert.deepEqual(problemsOf(endsWrong), ['3 mistakes in a row end the game, so endReason must be mistakes']);
	assert.deepEqual(problemsOf({ ...endsWrong, endReason: 'mistakes' }), []);
});
