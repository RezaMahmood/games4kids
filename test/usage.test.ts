import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { estimateText, type AiCall, type Table } from '@g4k/sdk';
import { costMicroUsd, LEDGER_START, memoryAccounts, monthsForDays, periodOf, PRICE_VERSION, RECORD_TIMEOUT_MS, usageLedger, type UsageEntry } from '@g4k/host';
import { gameId } from './support/ids.ts';

const timedetectives = gameId('timedetectives');
const drawpad = gameId('drawpad');
const words: AiCall<'words'> = { area: 'words', model: 'gpt-5.4-mini', tokens: { input: 800, cachedInput: 200, output: 500 }, subject: { item: 'round-1', group: 'topic-1' } };

function ledger(at: { now: Date }, table: Table = memoryAccounts().open('portal').table('aiusage')) {
	const lines: string[] = [];
	const exceptions: unknown[] = [];
	let id = 0;
	const usage = usageLedger(table, { now: () => at.now, newId: () => `id-${++id}`, telemetry: { log: (_level, line) => void lines.push(line), exception: (error) => void exceptions.push(error) } });
	return { usage, table, lines, exceptions };
}

/** A table that remembers each partition read, so a test can see which game's rows were touched. */
function watched() {
	const table = memoryAccounts().open('portal').table('aiusage');
	const partitions: string[] = [];
	return { partitions, table: { ...table, inPartition: (key: string) => (partitions.push(key), table.inPartition(key)) } as Table };
}

test('each model costs its token counts at its own rates, rounded once to whole micro-USD', () => {
	assert.equal(costMicroUsd(words), 2865, '800 x 0.75 + 200 x 0.075 + 500 x 4.5');
	assert.equal(costMicroUsd({ area: 'p', model: 'gpt-image-1-mini', tokens: { textInput: 50, imageInput: 300, output: 1000 } }), 8850);
	assert.equal(costMicroUsd({ area: 'p', model: 'gpt-image-2', tokens: { textInput: 50, imageInput: 300, output: 1000 } }), 32650);
	assert.equal(costMicroUsd({ area: 'c', model: 'jev-1.14.0', tokens: { input: 2000, output: 40 } }), 84, 'Jev output is free');
	assert.equal(costMicroUsd({ area: 'c', model: 'jev-1.14.0', tokens: { input: 13, output: 0 } }), 1, '0.546 rounds to 1');
});

test('an estimate always says so, and shows small sums in tenths of a cent', () => {
	assert.deepEqual([0, 1, 999, 1_000, 42_000, 999_499, 1_270_000].map(estimateText), ['est. $0.00', 'est. <$0.001', 'est. <$0.001', 'est. $0.001', 'est. $0.042', 'est. $0.999', 'est. $1.27']);
});

test('a call is one row in its game and UTC month, keyed by time, with the host\'s price and price version', async () => {
	const at = { now: new Date('2026-10-23T14:05:09.123Z') };
	const { usage, table } = ledger(at);
	await usage.forGame(timedetectives, ['words']).record({ ...words, replyModel: 'gpt-5.4-mini-2026-03-17' });
	const rows = await table.inPartition('timedetectives|2026-10');
	assert.equal(rows.length, 1);
	const { etag: _etag, ...row } = rows[0] ?? assert.fail('no row');
	assert.deepEqual(row, {
		partitionKey: 'timedetectives|2026-10',
		rowKey: '2026-10-23T14:05:09.123Z|id-1',
		area: 'words',
		model: 'gpt-5.4-mini',
		replyModel: 'gpt-5.4-mini-2026-03-17',
		item: 'round-1',
		group: 'topic-1',
		at: '2026-10-23T14:05:09.123Z',
		tokens: '{"input":800,"cachedInput":200,"output":500}',
		microUsd: 2865,
		priceVersion: PRICE_VERSION,
	});
});

test('a call outside the declared areas, with tokens the model does not bill on, or with a price of its own, is refused and logged', async () => {
	const { usage, table, lines, exceptions } = ledger({ now: new Date('2026-10-23T12:00:00Z') });
	const record = usage.forGame(timedetectives, ['words']).record as (call: unknown) => Promise<void>;
	await record({ ...words, area: 'titles' });
	await record({ ...words, tokens: { textInput: 1, imageInput: 0, output: 1 } });
	await record({ ...words, tokens: { ...words.tokens, input: -1 } });
	await record({ ...words, model: 'gpt-99' });
	await record({ ...words, microUsd: 1, tokens: { ...words.tokens, output: 0 } });
	const rows = await table.list<{ microUsd: number } & UsageEntry & { partitionKey: string; rowKey: string }>();
	assert.deepEqual(rows.map((row) => row.microUsd), [600 + 15], 'only the last is written, at the host\'s price');
	assert.equal(lines.filter((line) => line.startsWith('usage entry refused')).length, 4);
	assert.equal(exceptions.length, 4);
});

test('a billed call with no usage adds no row, logs an exception naming the call, and an undeclared area is noted', async () => {
	const { usage, table, lines, exceptions } = ledger({ now: new Date('2026-10-23T12:00:00Z') });
	const mine = usage.forGame(timedetectives, ['words']);
	await mine.unmetered({ area: 'words', model: 'gpt-5.4-mini', subject: { item: 'round-1', group: 'topic-1' }, reason: 'the reply carried no readable usage' });
	assert.deepEqual(await table.list(), []);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? '', /^usage unmetered, a billed call is missing from the ledger: \{"game":"timedetectives","area":"words","model":"gpt-5.4-mini","item":"round-1","group":"topic-1","reason":"the reply carried no readable usage"\}$/);
	assert.equal(exceptions.length, 1);
	assert.match(String(exceptions[0]), /timedetectives words call to gpt-5.4-mini for round-1 was billed but reported no usage/);
	await (mine.unmetered as (call: unknown) => Promise<void>)({ area: 'nope', model: 'gpt-5.4-mini', subject: { item: 'round-1' }, reason: 'r' });
	assert.match(lines[1] ?? '', /and area "nope" is not in the manifest's admin\.ai/);
	assert.equal(exceptions.length, 2);
});

test('a ledger that throws loses the entry without failing the caller, and logs the whole entry', async () => {
	const table = { ...memoryAccounts().open('portal').table('aiusage'), insertIfAbsent: () => Promise.reject(new Error('storage is down')) } as Table;
	const { usage, lines, exceptions } = ledger({ now: new Date('2026-10-23T12:00:00Z') }, table);
	await usage.forGame(timedetectives, ['words']).record(words);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? '', /^usage entry lost, storage is down: \{.*"id":"id-1".*"item":"round-1".*"microUsd":2865/);
	assert.equal(exceptions.length, 1);
});

test('a ledger that never answers is given up after RECORD_TIMEOUT_MS, and the entry is logged', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const table = { ...memoryAccounts().open('portal').table('aiusage'), insertIfAbsent: () => new Promise<boolean>(() => {}) } as Table;
		const { usage, lines } = ledger({ now: new Date('2026-10-23T12:00:00Z') }, table);
		let done = false;
		const recording = usage.forGame(timedetectives, ['words']).record(words).then(() => (done = true));
		await new Promise((resolve) => setImmediate(resolve));
		mock.timers.tick(RECORD_TIMEOUT_MS - 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(done, false);
		mock.timers.tick(1);
		await recording;
		assert.equal(RECORD_TIMEOUT_MS, 5_000);
		assert.match(lines[0] ?? '', /^usage entry lost, the write took longer than 5000 ms/);
	} finally {
		mock.timers.reset();
	}
});

test('a game\'s spend sums every month since the ledger began by item and by group, and never reads another game\'s rows', async () => {
	const at = { now: new Date('2026-10-31T23:59:00Z') };
	const { table, partitions } = watched();
	const { usage } = ledger(at, table);
	const mine = usage.forGame(timedetectives, ['words']);
	await mine.record(words);
	at.now = new Date('2026-11-01T00:01:00Z');
	await mine.record(words);
	await mine.record({ ...words, subject: { item: 'round-2', group: 'topic-1' } });
	await mine.record({ ...words, subject: { item: 'loose' } });
	await usage.forGame(drawpad, ['titles']).record({ ...words, area: 'titles', subject: { item: 'round-1', group: 'topic-1' } });

	const { byGroup, byItem } = await mine.spend();
	assert.deepEqual(Object.fromEntries(byGroup), { 'topic-1': { microUsd: 3 * 2865, calls: 3 } });
	assert.deepEqual(Object.fromEntries(byItem), { 'round-1': { microUsd: 2 * 2865, calls: 2 }, 'round-2': { microUsd: 2865, calls: 1 }, loose: { microUsd: 2865, calls: 1 } });
	assert.equal(LEDGER_START, '2026-10');
	assert.deepEqual(partitions.sort(), ['timedetectives|2026-10', 'timedetectives|2026-11']);
});

test('days are Europe/London days: across the clocks going back, and on the 1st of a summer month that starts in last month\'s UTC partition', async () => {
	assert.equal(periodOf(new Date('2026-09-30T23:30:00Z'), 'day'), '2026-10-01', 'BST, so already 1 October');
	assert.equal(periodOf(new Date('2026-09-30T23:30:00Z'), 'month'), '2026-10');
	assert.equal(periodOf(new Date('2025-12-31T23:30:00Z'), 'year'), '2025', 'GMT in winter, so still 2025');
	assert.equal(periodOf(new Date('2026-10-24T23:30:00Z'), 'day'), '2026-10-25', '00:30 BST on the day the clocks go back');
	assert.equal(periodOf(new Date('2026-10-25T23:30:00Z'), 'day'), '2026-10-25', '23:30 GMT that evening');
	assert.deepEqual(monthsForDays('2026-10-01', '2026-10-01'), ['2026-09', '2026-10']);
	assert.deepEqual(monthsForDays('2026-11-01', '2026-11-30'), ['2026-11'], 'GMT, so November starts in its own partition');
	assert.deepEqual(monthsForDays('2026-10-02', '2027-01-15'), ['2026-10', '2026-11', '2026-12', '2027-01']);

	const at = { now: new Date() };
	const { usage } = ledger(at);
	const game = usage.forGame(timedetectives, ['words']);
	const times = ['2026-09-30T22:30:00Z', '2026-09-30T23:30:00Z', '2026-10-24T23:30:00Z', '2026-10-25T23:30:00Z', '2026-10-26T00:30:00Z'];
	for (const time of times) {
		at.now = new Date(time);
		await game.record({ ...words, subject: { item: time } });
	}
	const items = async (from: string, to: string) => (await usage.read([timedetectives], { from, to })).map((entry) => entry.item);
	assert.deepEqual(await items('2026-10-01', '2026-10-01'), ['2026-09-30T23:30:00Z']);
	assert.deepEqual(await items('2026-10-25', '2026-10-25'), ['2026-10-24T23:30:00Z', '2026-10-25T23:30:00Z']);
	assert.deepEqual(await items('2026-09-30', '2026-10-26'), times);
});
