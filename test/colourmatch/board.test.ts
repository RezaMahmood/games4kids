import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, daysEndingAt, type BoardChild, type DailyBest } from '../../games/colourmatch/data/index.ts';

const DAYS = daysEndingAt('2026-10-19');
const BEGINNING = '2026-10-01T00:00:00.000Z';

const best = (day: string, points: number): DailyBest => ({ day, points });
const child = (userId: string, bests: DailyBest[], extra: Partial<BoardChild> = {}): BoardChild => ({ userId, name: userId.toUpperCase(), timeZone: 'UTC', since: BEGINNING, bests, ...extra });
const board = (children: BoardChild[], viewerId = 'ada') => buildBoard({ days: DAYS, viewerId, children });

test('each day shows the child\'s best game that day, and the week is the sum of the daily bests', () => {
	const [ada] = board([child('ada', [best('2026-10-19', 420), best('2026-10-17', 150), best('2026-10-01', 999)])]).children;
	assert.deepEqual(ada?.points, [0, 0, 0, 0, 150, 0, 420]);
	assert.equal(ada?.total, 570);
});

test('a child counts from the day they switched the board on, that day included, and a child with no points is not listed', () => {
	const since = '2026-10-19T12:00:00.000Z';
	const [ada] = board([child('ada', [best('2026-10-18', 300), best('2026-10-19', 90)], { since })]).children;
	assert.equal(ada?.total, 90);
	assert.deepEqual(board([child('bea', [best('2026-10-18', 300)], { since })]).children, []);
	const [cy] = board([child('cy', [best('2026-10-18', 300)], { since: '2026-10-18T23:30:00.000Z', timeZone: 'Pacific/Auckland' })]).children;
	assert.equal(cy, undefined, 'in Auckland the switch was on the 19th');
});

test('children sort by total then name, the viewer is marked, and no user id is ever returned', () => {
	const b = board([child('zed', [best('2026-10-19', 20)]), child('bea', [best('2026-10-19', 40)]), child('abe', [best('2026-10-19', 20)])], 'zed');
	assert.deepEqual(b.children.map((line) => [line.name, line.me]), [['BEA', false], ['ABE', false], ['ZED', true]]);
	assert.equal(JSON.stringify(b).includes('userId'), false);
	assert.equal(JSON.stringify(b).includes('zed'), false);
});
