import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barPercent, parseCostReport, periodName, quietLine, spentPeriods, totalLine } from '../apps/admin/pages/costs-model.ts';

const cost = (microUsd: number, calls: number) => ({ microUsd, calls, text: `est. $${(microUsd / 1_000_000).toFixed(2)}` });

test('a costs reply is read into the report the page draws, and an unreadable one is a failure', () => {
	const area = { game: 'timedetectives', area: 'words', label: 'Story words', ...cost(3_000_000, 2) };
	const report = parseCostReport({
		by: 'month',
		from: '2026-10-01',
		to: '2026-10-23',
		total: cost(3_120_000, 4),
		games: [{ game: 'timedetectives', title: 'Time Detectives', ...cost(3_120_000, 4) }, { nonsense: true }],
		areas: [area],
		periods: [{ period: '2026-10', total: cost(3_120_000, 4), games: [], areas: [area] }],
	});
	assert.equal(report.games.length, 1, 'a row the page cannot read is left out');
	assert.equal(report.periods[0]?.areas[0]?.label, 'Story words');
	assert.equal(totalLine(report), 'est. $3.12 · 4 AI calls, 1 Oct 2026 to 23 Oct 2026');
	assert.throws(() => parseCostReport({ by: 'week' }), /cannot read/);
	assert.throws(() => parseCostReport(null), /cannot read/);
});

test('periods are named for the switch they came from', () => {
	assert.equal(periodName('2026-10-23', 'day'), '23 Oct 2026');
	assert.equal(periodName('2026-10', 'month'), 'October 2026');
	assert.equal(periodName('2026', 'year'), '2026');
});

test('a bar is a share of the dearest period, and any spend shows a sliver', () => {
	assert.deepEqual([barPercent(0, 100), barPercent(50, 100), barPercent(100, 100), barPercent(1, 1_000_000)], [0, 50, 100, 2]);
	assert.equal(barPercent(5, 0), 0);
});

test('only periods with spend are listed, newest first, and the rest are counted in one line', () => {
	const period = (name: string, calls: number) => ({ period: name, total: cost(calls * 1000, calls), games: [], areas: [] });
	assert.deepEqual(spentPeriods([period('2026-10-01', 0), period('2026-10-02', 2), period('2026-10-03', 0), period('2026-10-04', 1)]).map((one) => one.period), ['2026-10-04', '2026-10-02']);
	assert.equal(quietLine('day', 30), 'No AI spend on the other 30 days in this range.');
	assert.equal(quietLine('year', 1), 'No AI spend on the other 1 year in this range.');
	assert.equal(quietLine('month', 0), null);
});
