import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Accounts } from '@g4k/host';
import { gameId } from './ids.ts';

const row = (rowKey: string, value: number) => ({ partitionKey: 'p', rowKey, value });

export type StorageHarness = { readonly accounts: Accounts; close(): Promise<void> };

/** What every Accounts implementation promises its apps, run against the memory accounts and against Azurite. */
export function storageContract(name: string, start: () => Promise<StorageHarness>, options: { readonly skip?: string | undefined } = {}): void {
	describe(`storage contract: ${name}`, { skip: options.skip ?? false }, () => {
		let harness: StorageHarness;
		before(async () => void (harness = await start()));
		after(() => harness.close());

		test('a table inserts only when absent and replaces only while the etag matches', async () => {
			const table = harness.accounts.open('portal').table('conflicts');
			assert.equal(await table.insertIfAbsent(row('a', 1)), true);
			assert.equal(await table.insertIfAbsent(row('a', 2)), false);
			const first = await table.get('p', 'a');
			assert.equal(first?.['value'], 1);
			assert.ok(first);
			assert.equal(await table.replaceIfMatch(row('a', 3), first.etag), true);
			assert.equal(await table.replaceIfMatch(row('a', 4), first.etag), false, 'a stale etag loses');
			assert.equal(await table.replaceIfMatch(row('missing', 4), first.etag), false, 'a missing row loses');
			assert.equal((await table.get('p', 'a'))?.['value'], 3);
			await table.remove('p', 'a');
			assert.equal(await table.get('p', 'a'), undefined);
			await table.remove('p', 'a');
		});

		test('a table keeps strings, numbers and booleans, and put replaces the whole row', async () => {
			const table = harness.accounts.open('portal').table('fields');
			await table.put({ partitionKey: 'p', rowKey: 'a', name: 'Ada', count: 3, done: true, extra: 'x' });
			await table.put({ partitionKey: 'p', rowKey: 'a', name: 'Ada B', count: 4, done: false });
			const stored = await table.get('p', 'a');
			assert.ok(stored);
			const fields = Object.fromEntries(Object.entries(stored).filter(([name]) => name !== 'etag'));
			assert.deepEqual(fields, { partitionKey: 'p', rowKey: 'a', name: 'Ada B', count: 4, done: false });
		});

		test('a table lists a partition and the whole table in key order', async () => {
			const table = harness.accounts.open('portal').table('listing');
			await table.put(row('b', 2));
			await table.put(row('a', 1));
			await table.put({ partitionKey: 'o', rowKey: 'z', value: 0 });
			assert.deepEqual((await table.inPartition('p')).map((r) => r.rowKey), ['a', 'b']);
			assert.deepEqual((await table.list()).map((r) => `${r.partitionKey}/${r.rowKey}`), ['o/z', 'p/a', 'p/b']);
			assert.deepEqual(await table.inPartition('nobody'), []);
		});

		test('a container answers not-modified for the current etag and hands out copies', async () => {
			const blobs = harness.accounts.open('portal').container('pictures');
			await blobs.put('x/1.png', new Uint8Array([1, 2]), 'image/png');
			await blobs.put('x/2.png', new Uint8Array([3]), 'image/png');
			const blob = await blobs.get('x/1.png');
			assert.ok(blob && blob !== 'not-modified');
			assert.equal(blob.contentType, 'image/png');
			assert.equal(await blobs.get('x/1.png', blob.etag), 'not-modified');
			blob.bytes[0] = 9;
			const again = await blobs.get('x/1.png');
			assert.ok(again && again !== 'not-modified');
			assert.deepEqual([...again.bytes], [1, 2]);
			assert.equal(again.etag, blob.etag);
			assert.deepEqual(await blobs.list('x/'), ['x/1.png', 'x/2.png']);
			assert.deepEqual(await blobs.list('y/'), []);
			await blobs.remove('x/1.png');
			assert.equal(await blobs.get('x/1.png'), undefined);
			await blobs.remove('x/1.png');
		});

		test('a changed blob has a new etag, so a stale If-None-Match gets the new bytes', async () => {
			const blobs = harness.accounts.open('portal').container('changes');
			await blobs.put('a', new Uint8Array([1]), 'application/octet-stream');
			const first = await blobs.get('a');
			assert.ok(first && first !== 'not-modified');
			await blobs.put('a', new Uint8Array([2]), 'application/octet-stream');
			const second = await blobs.get('a', first.etag);
			assert.ok(second && second !== 'not-modified');
			assert.deepEqual([...second.bytes], [2]);
		});

		test('two opens of one account see the same data, and other accounts see none of it', async () => {
			await harness.accounts.open(gameId('fixture')).table('shared').put(row('a', 1));
			assert.equal((await harness.accounts.open(gameId('fixture')).table('shared').get('p', 'a'))?.['value'], 1);
			assert.equal(await harness.accounts.open(gameId('drawpad')).table('shared').get('p', 'a'), undefined);
		});
	});
}
