import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, daysEndingAt, parseBoardInput, parseDayQuery, type BoardChild, type Played } from '../../games/timedetectives/data/board.ts';

const DAYS = daysEndingAt('2026-10-19');
const BEGINNING = '2026-10-01T00:00:00.000Z';
const AT = '2026-10-19T09:00:00.000Z';

const played = (roundId: string, points: number, completedAt = AT): Played => ({ roundId, points, completedAt });
const child = (userId: string, rounds: Played[], extra: Partial<BoardChild> = {}): BoardChild => ({ userId, name: userId.toUpperCase(), timeZone: 'UTC', since: BEGINNING, played: rounds, ...extra });
const board = (children: BoardChild[], viewerId = 'ada') => buildBoard({ days: DAYS, viewerId, children });

test('only the best go at each round counts on a day, and different rounds add up', () => {
	const [ada] = board([child('ada', [played('vikings', 20), played('vikings', 45, '2026-10-19T10:00:00.000Z'), played('vikings', 30), played('romans', 12)])]).children;
	assert.deepEqual([ada?.points.at(-1), ada?.total], [57, 57]);
});

test('the same round on two days counts once on each', () => {
	const [ada] = board([child('ada', [played('vikings', 30, '2026-10-18T09:00:00.000Z'), played('vikings', 20)])]).children;
	assert.deepEqual(ada?.points, [0, 0, 0, 0, 0, 30, 20]);
	assert.equal(ada?.total, 50);
});

test('rounds before the child switched the board on do not count, and a child with no points is not listed', () => {
	const since = '2026-10-19T10:00:00.000Z';
	const [ada] = board([child('ada', [played('a', 40, '2026-10-19T09:59:59.999Z'), played('b', 10, since)], { since })]).children;
	assert.equal(ada?.total, 10);
	assert.deepEqual(board([child('bea', [played('a', 40)], { since })]).children, []);
	assert.deepEqual(board([child('cy', [played('a', 0)])]).children, []);
});

test('a day is the child\'s own local day, so one moment lands on different days in different zones', () => {
	const instant = '2026-10-19T22:30:00.000Z';
	const b = board([
		child('ada', [played('a', 10, instant)], { timeZone: 'Europe/London' }),
		child('bea', [played('a', 10, instant)], { timeZone: 'Pacific/Auckland' }),
	]);
	assert.deepEqual(b.children.map((line) => [line.name, line.points.at(-1)]), [['ADA', 10]], 'Auckland is already on the 20th, past the window');
});

test('children sort by total then name, the viewer is marked, and no user id is ever returned', () => {
	const b = board([child('zed', [played('a', 20)]), child('bea', [played('a', 40)]), child('abe', [played('a', 20)])], 'zed');
	assert.deepEqual(b.children.map((line) => [line.name, line.me]), [['BEA', false], ['ABE', false], ['ZED', true]]);
	assert.equal(JSON.stringify(b).includes('userId'), false);
	assert.equal(JSON.stringify(b).includes('zed'), false);
});

test('the board asks for a real device day within a day of today, and the switch for true or false', () => {
	const now = new Date('2026-10-19T12:00:00.000Z');
	const day = (value: string) => parseDayQuery(new URLSearchParams({ day: value }), now).ok;
	assert.deepEqual(['2026-10-18', '2026-10-19', '2026-10-20'].map(day), [true, true, true]);
	assert.deepEqual(['2026-10-17', '2026-10-21', '2026-02-30', '19/10/2026', ''].map(day), [false, false, false, false, false]);
	assert.equal(parseDayQuery(new URLSearchParams(), now).ok, false);
	assert.deepEqual(DAYS, ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
	assert.deepEqual(parseBoardInput({ on: true }), { ok: true, value: true });
	for (const bad of [undefined, null, {}, { on: 'true' }, []]) assert.equal(parseBoardInput(bad).ok, false);
});
