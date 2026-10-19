import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountName, memoryAccounts } from '@g4k/host';
import { gameId } from './support/ids.ts';

const row = (rowKey: string, value: number) => ({ partitionKey: 'p', rowKey, value });

test('accountName joins g4k, the owner and the suffix', () => {
	assert.equal(accountName(gameId('drawpad'), 'x7k2q'), 'g4kdrawpadx7k2q');
	assert.equal(accountName('portal', 'x7k2q'), 'g4kportalx7k2q');
});

test('a table inserts only when absent and replaces only while the etag matches', async () => {
	const table = memoryAccounts().open('portal').table('t');
	assert.equal(await table.insertIfAbsent(row('a', 1)), true);
	assert.equal(await table.insertIfAbsent(row('a', 2)), false);
	const first = await table.get('p', 'a');
	assert.equal(first?.['value'], 1);
	assert.ok(first);
	assert.equal(await table.replaceIfMatch(row('a', 3), first.etag), true);
	assert.equal(await table.replaceIfMatch(row('a', 4), first.etag), false, 'a stale etag loses');
	assert.equal((await table.get('p', 'a'))?.['value'], 3);
	await table.remove('p', 'a');
	assert.equal(await table.get('p', 'a'), undefined);
});

test('a table lists a partition and the whole table in key order', async () => {
	const table = memoryAccounts().open('portal').table('t');
	await table.put(row('b', 2));
	await table.put(row('a', 1));
	await table.put({ partitionKey: 'o', rowKey: 'z', value: 0 });
	assert.deepEqual((await table.inPartition('p')).map((r) => r.rowKey), ['a', 'b']);
	assert.deepEqual((await table.list()).map((r) => `${r.partitionKey}/${r.rowKey}`), ['o/z', 'p/a', 'p/b']);
});

test('a container answers not-modified for the current etag and hands out copies', async () => {
	const blobs = memoryAccounts().open('portal').container('c');
	await blobs.put('x/1.png', new Uint8Array([1, 2]), 'image/png');
	const blob = await blobs.get('x/1.png');
	assert.ok(blob && blob !== 'not-modified');
	assert.equal(await blobs.get('x/1.png', blob.etag), 'not-modified');
	blob.bytes[0] = 9;
	const again = await blobs.get('x/1.png');
	assert.ok(again && again !== 'not-modified');
	assert.deepEqual([...again.bytes], [1, 2]);
	assert.deepEqual(await blobs.list('x/'), ['x/1.png']);
	assert.deepEqual(await blobs.list('y/'), []);
});

test('two opens of one account see the same data, and other accounts see none of it', async () => {
	const accounts = memoryAccounts();
	await accounts.open(gameId('fixture')).table('t').put(row('a', 1));
	assert.equal((await accounts.open(gameId('fixture')).table('t').get('p', 'a'))?.['value'], 1);
	assert.equal(await accounts.open(gameId('drawpad')).table('t').get('p', 'a'), undefined);
});
