import assert from 'node:assert/strict';
import { test } from 'node:test';
import azureFunctions from '@azure/functions';
import type { App, AppWorker } from '@g4k/host';
import { registerWithFunctions } from '@g4k/host/functions';
import { deliverQueues } from '@g4k/host/node';
import { fixtureApps } from './support/apps.ts';
import { call, JPEG, PNG } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, seedAdmin, seedPlayer, world } from './support/world.ts';

const idp = await fakeIdp();
const fixture = gameId('fixture');

async function setup() {
	const w = world();
	const apps: App[] = [];
	const failures: { readonly dequeueCount: number }[] = [];
	const delivery = deliverQueues(w.accounts, () => apps, (_worker, _error, dequeueCount) => void failures.push({ dequeueCount }));
	const built = fixtureApps(w, idp, undefined, delivery);
	apps.push(built.player, built.admin);
	const objectId = newObjectId();
	await seedAdmin(w, objectId);
	const kid = await seedPlayer(w, idp, { games: [fixture] });
	return { w, ...built, delivery, failures, adminToken: await idp.adminToken(objectId), kidToken: kid.token };
}

test('a route that declares a JPEG body is parsed, capped and checked like a PNG one', async () => {
	const { admin, adminToken } = await setup();
	const put = (send: Parameters<typeof call>[3]) => call(admin, 'POST', '/api/admin/g/fixture/art/one', { token: adminToken, ...send });
	assert.equal((await put({ jpeg: JPEG })).status, 204);
	assert.equal((await put({ png: PNG })).status, 415, 'a PNG is not a JPEG');
	assert.equal((await put({ jpeg: new Uint8Array([1, 2, 3, 4]) })).status, 415, 'the bytes must carry the JPEG signature');
	assert.equal((await put({ jpeg: new Uint8Array([0xff, 0xd8, 0xff, ...new Uint8Array(4 * 1024 * 1024)]) })).status, 413);
});

test('a bytes route sees the request If-None-Match and answers 304 for the ETag it already sent', async () => {
	const { admin, player, adminToken, kidToken } = await setup();
	await call(admin, 'POST', '/api/admin/g/fixture/art/one', { token: adminToken, jpeg: JPEG });
	const first = await call(player, 'GET', '/api/g/fixture/art/one', { token: kidToken });
	assert.equal(first.status, 200);
	const etag = first.headers['etag'];
	assert.ok(etag);
	assert.equal(first.headers['content-type'], 'image/jpeg');
	const again = await call(player, 'GET', '/api/g/fixture/art/one', { token: kidToken, headers: { 'if-none-match': etag } });
	assert.equal(again.status, 304);
	const changed = await call(player, 'GET', '/api/g/fixture/art/one', { token: kidToken, headers: { 'if-none-match': '"other"' } });
	assert.equal(changed.status, 200);
});

test('the admin app lists a game worker as its own function on the queue, with the connection settings name the game ships', async () => {
	const { admin } = await setup();
	assert.deepEqual(
		admin.workers?.map(({ name, game, queue, connection }) => ({ name, game, queue, connection })),
		[{ name: 'fixture-worker-jobs', game: fixture, queue: 'jobs', connection: 'FIXTURE_STORAGE' }],
	);
});

test('a message sent to a worker queue reaches the worker, and the game reads its effect back', async () => {
	const { admin, delivery, adminToken } = await setup();
	const made = await call(admin, 'POST', '/api/admin/g/fixture/notes', { token: adminToken, json: { text: 'hello' } });
	assert.equal(made.status, 201);
	const { id } = made.data as { id: string };
	await delivery.idle();
	assert.deepEqual((await call(admin, 'GET', `/api/admin/g/fixture/notes/${id}`, { token: adminToken })).data, { text: 'hello', done: true });
});

test('a worker that throws is tried again with a rising dequeue count, and the third failure ends the message', async () => {
	const { w, delivery, failures } = await setup();
	const account = w.accounts.open(fixture);
	await account.table('notes').put({ partitionKey: 'note', rowKey: 'a', text: 'a' });
	await account.table('notes').put({ partitionKey: 'note', rowKey: 'b', text: 'b' });
	await delivery.open(fixture).queue('jobs').send({ noteId: 'a', failFirst: 2 });
	await delivery.idle();
	assert.deepEqual(failures.map((failure) => failure.dequeueCount), [1, 2]);
	assert.equal((await account.table('notes').get('note', 'a'))?.['done'], true);
	await delivery.open(fixture).queue('jobs').send({ noteId: 'b', failFirst: 3 });
	await delivery.idle();
	assert.deepEqual(failures.map((failure) => failure.dequeueCount), [1, 2, 1, 2, 3]);
	assert.equal((await account.table('notes').get('note', 'b'))?.['done'], undefined);
});

test('messages are handled one at a time, in the order they were sent', async () => {
	const order: string[] = [];
	const slow: AppWorker = {
		name: 'x-worker-q',
		game: fixture,
		queue: 'jobs',
		connection: 'X_STORAGE',
		async run(message) {
			const id = (message as { id: string }).id;
			order.push(`start ${id}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push(`end ${id}`);
		},
	};
	const w = world();
	const delivery = deliverQueues(w.accounts, () => [{ prefix: '/api/x/', handle: async () => assert.fail('no request'), functions: [], workers: [slow] }]);
	const queue = delivery.open(fixture).queue('jobs');
	await queue.send({ id: 1 });
	await queue.send({ id: 2 });
	await delivery.idle();
	assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
	assert.deepEqual(w.accounts.messages(fixture, 'jobs'), [{ id: 1 }, { id: 2 }], 'the message is still stored');
});

test('registerWithFunctions registers a queue function for each worker, with the dequeue count from the trigger', async () => {
	const registered: { name: string; options: { queueName: string; connection: string; handler: (message: unknown, context: { triggerMetadata?: Record<string, unknown> }) => Promise<unknown> } }[] = [];
	const original = azureFunctions.app.storageQueue;
	azureFunctions.app.storageQueue = ((name: string, options: (typeof registered)[number]['options']) => void registered.push({ name, options })) as typeof original;
	const seen: { message: unknown; dequeueCount: number }[] = [];
	try {
		registerWithFunctions({
			prefix: '/api/x/',
			handle: async () => assert.fail('no request'),
			functions: [],
			workers: [{ name: 'fixture-worker-jobs', game: fixture, queue: 'jobs', connection: 'FIXTURE_STORAGE', run: async (message, { dequeueCount }) => void seen.push({ message, dequeueCount }) }],
		});
	} finally {
		azureFunctions.app.storageQueue = original;
	}
	const [only] = registered;
	assert.equal(registered.length, 1);
	assert.equal(only?.name, 'fixture-worker-jobs');
	assert.equal(only?.options.queueName, 'jobs');
	assert.equal(only?.options.connection, 'FIXTURE_STORAGE');
	await only?.options.handler({ noteId: 'a' }, { triggerMetadata: { dequeueCount: '2' } });
	await only?.options.handler({ noteId: 'b' }, {});
	assert.deepEqual(seen, [{ message: { noteId: 'a' }, dequeueCount: 2 }, { message: { noteId: 'b' }, dequeueCount: 1 }]);
});
