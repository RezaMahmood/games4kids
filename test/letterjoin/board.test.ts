import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, parseBoardInput, pointsFor, type BoardChild } from '../../games/letterjoin/data/board.ts';
import { daysEndingAt } from '../../games/letterjoin/data/practice.ts';
import type { Level } from '../../games/letterjoin/data/activity.ts';

const DAYS = daysEndingAt('2026-10-19');
const BEGINNING = '2026-10-01T00:00:00.000Z';

let n = 0;
const attempt = (activityId: string, score: number, completedAt: string, extra: { level?: Level; hard?: boolean } = {}) => ({
	id: `a${n++}`,
	activityId,
	level: extra.level ?? 'starter',
	chars: 5,
	score,
	timeMs: 1000,
	hard: extra.hard ?? false,
	completedAt,
});
const child = (userId: string, attempts: BoardChild['attempts'], extra: Partial<BoardChild> = {}): BoardChild => ({ userId, name: userId.toUpperCase(), timeZone: 'UTC', since: BEGINNING, attempts, ...extra });
const board = (children: BoardChild[], viewerId = 'ada') => buildBoard({ days: DAYS, viewerId, children });
const level = (b: ReturnType<typeof board>, name: Level) => b.levels.find((l) => l.level === name)!.children;

test('points are the whole number the child saw, with the hard bonus on top', () => {
	assert.equal(pointsFor({ score: 80.4, hard: false }), 80);
	assert.equal(pointsFor({ score: 55.5, hard: false }), 56);
	assert.equal(pointsFor({ score: 80, hard: true }), 96);
	assert.equal(pointsFor({ score: 0, hard: true }), 0);
});

test('only the best attempt at each activity counts on a day, and different activities add up', () => {
	const result = level(board([child('ada', [
		attempt('cat', 40, '2026-10-19T09:00:00.000Z'),
		attempt('cat', 90, '2026-10-19T10:00:00.000Z'),
		attempt('cat', 60, '2026-10-19T11:00:00.000Z'),
		attempt('dog', 50, '2026-10-19T12:00:00.000Z'),
	])]), 'starter');
	assert.deepEqual(result.map((c) => [c.points.at(-1), c.total]), [[140, 140]]);
});

test('the same activity on two days counts once on each', () => {
	const [ada] = level(board([child('ada', [attempt('cat', 70, '2026-10-18T09:00:00.000Z'), attempt('cat', 50, '2026-10-19T09:00:00.000Z')])]), 'starter');
	assert.deepEqual(ada?.points, [0, 0, 0, 0, 0, 70, 50]);
	assert.equal(ada?.total, 120);
});

test('a result is grouped by the level its attempt was saved with, and a level lists only children with points in it', () => {
	const b = board([
		child('ada', [attempt('cat', 80, '2026-10-19T09:00:00.000Z', { level: 'champion' })]),
		child('bea', [attempt('dog', 60, '2026-10-19T09:00:00.000Z', { level: 'starter' }), attempt('cow', 0, '2026-10-19T09:00:00.000Z', { level: 'explorer' })]),
	]);
	assert.deepEqual(b.levels.map((l) => l.level), ['starter', 'explorer', 'champion']);
	assert.deepEqual(level(b, 'starter').map((c) => c.name), ['BEA']);
	assert.deepEqual(level(b, 'explorer'), [], 'a score of nothing earns no place');
	assert.deepEqual(level(b, 'champion').map((c) => c.name), ['ADA']);
});

test('a child can be in several levels, each with its own days and total', () => {
	const b = board([child('ada', [attempt('a', 50, '2026-10-18T09:00:00.000Z'), attempt('b', 70, '2026-10-19T09:00:00.000Z', { level: 'explorer' })])]);
	assert.deepEqual(level(b, 'starter').map((c) => [c.points, c.total]), [[[0, 0, 0, 0, 0, 50, 0], 50]]);
	assert.deepEqual(level(b, 'explorer').map((c) => [c.points, c.total]), [[[0, 0, 0, 0, 0, 0, 70], 70]]);
});

test('a level sorts by total, then name', () => {
	const at = '2026-10-19T09:00:00.000Z';
	const names = (b: ReturnType<typeof board>) => level(b, 'starter').map((c) => c.name);
	assert.deepEqual(names(board([child('zed', [attempt('a', 50, at)]), child('bea', [attempt('a', 90, at)]), child('abe', [attempt('a', 50, at)])])), ['BEA', 'ABE', 'ZED']);
});

test('attempts before the child opted in do not count', () => {
	const since = '2026-10-19T10:00:00.000Z';
	const [ada] = level(board([child('ada', [attempt('cat', 90, '2026-10-19T09:59:59.999Z'), attempt('dog', 30, since), attempt('cow', 20, '2026-10-19T11:00:00.000Z')], { since })]), 'starter');
	assert.equal(ada?.total, 50);
	assert.deepEqual(level(board([child('bea', [attempt('cat', 90, '2026-10-19T09:00:00.000Z')], { since })]), 'starter'), []);
});

test('a day is the child\'s own local day, so one instant lands on different days for different zones', () => {
	const instant = '2026-10-19T22:30:00.000Z';
	const b = board([
		child('ada', [attempt('cat', 50, instant)], { timeZone: 'Europe/London' }),
		child('bea', [attempt('cat', 50, instant)], { timeZone: 'Pacific/Auckland' }),
		child('cy', [attempt('cat', 50, instant)], { timeZone: 'America/Los_Angeles' }),
	]);
	const byName = new Map(level(b, 'starter').map((c) => [c.name, c.points]));
	assert.deepEqual(byName.get('ADA'), [0, 0, 0, 0, 0, 0, 50]);
	assert.equal(byName.has('BEA'), false, 'Auckland is already on the 20th, past the window');
	assert.deepEqual(byName.get('CY'), [0, 0, 0, 0, 0, 0, 50]);
	const early = board([child('ada', [attempt('cat', 50, '2026-10-19T02:00:00.000Z')], { timeZone: 'America/Los_Angeles' })]);
	assert.deepEqual(level(early, 'starter')[0]?.points, [0, 0, 0, 0, 0, 50, 0], '2 am UTC is still the evening before in Los Angeles');
});

test('only the last seven days show, and an older or later day adds nothing', () => {
	const b = board([child('ada', [attempt('old', 99, '2026-10-12T12:00:00.000Z'), attempt('first', 10, '2026-10-13T12:00:00.000Z'), attempt('later', 99, '2026-10-21T12:00:00.000Z')])]);
	assert.deepEqual(b.days, ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
	assert.deepEqual(level(b, 'starter').map((c) => [c.points, c.total]), [[[10, 0, 0, 0, 0, 0, 0], 10]]);
});

test('the viewer is marked as me and no user id is ever returned', () => {
	const at = '2026-10-19T09:00:00.000Z';
	const b = board([child('ada', [attempt('a', 60, at)]), child('bea', [attempt('a', 50, at)])], 'bea');
	assert.deepEqual(level(b, 'starter').map((c) => [c.name, c.me]), [['ADA', false], ['BEA', true]]);
	assert.equal(JSON.stringify(b).includes('"userId"'), false);
	assert.equal(JSON.stringify(b).includes('ada'), false);
	assert.deepEqual(level(board([child('ada', [attempt('a', 60, at)])], 'nobody'), 'starter').map((c) => c.me), [false]);
});

test('a board with nobody on it has every level, empty', () => {
	assert.deepEqual(board([]).levels, [{ level: 'starter', children: [] }, { level: 'explorer', children: [] }, { level: 'champion', children: [] }]);
});

test('the switch takes on as true or false and nothing else', () => {
	assert.deepEqual(parseBoardInput({ on: true }), { ok: true, value: true });
	assert.deepEqual(parseBoardInput({ on: false }), { ok: true, value: false });
	for (const bad of [undefined, null, 'on', {}, { on: 'true' }, { on: 1 }, []]) assert.equal(parseBoardInput(bad).ok, false, JSON.stringify(bad));
});
