import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdminPlatform, CreateAdminApi, Ctx, CreatePlayApi, GameManifest, Ownership, PlayPlatform, RouteOf, SettingSpec, StorageDeclaration } from '@g4k/sdk';
import { adminFunctionName, adminModule, createAdminApp, createPlayerApp, requireGameId, type App, type Env, type HostReply, type TokenSource } from '@g4k/host';
import { call, codeOf, JPEG, PNG, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { newObjectId, seedAdmin, seedPlayer, world } from './support/world.ts';

/**
 * Both suites run once per game in the registry. Each builds the real app over memory storage, the memory portal and
 * the fake IdP, and drives app.handle. A spy wraps each handler, so "refused" means `run` never ran.
 */

const idp = await fakeIdp();
const tokens: TokenSource = async (service) => `fake-${service}-token`;
const WRITES = ['put', 'insertIfAbsent', 'replaceIfMatch', 'remove', 'send'];
const PLATFORM_KEYS = ['tables', 'blobs', 'queues', 'game', 'now', 'newId', 'settings', 'tokens'];

type Probe = { readonly name: string; readonly method: string; readonly path: string; readonly send: Send };

function spy<Who>(route: RouteOf<Who>, ran: string[]): RouteOf<Who> {
	switch (route.body) {
		case 'none':
			return { ...route, run: (ctx: Ctx<Who, undefined>) => (ran.push(route.name), route.run(ctx)) };
		case 'json':
			return { ...route, run: (ctx: Ctx<Who, unknown>) => (ran.push(route.name), route.run(ctx)) };
		case 'png':
			return { ...route, run: (ctx: Ctx<Who, Uint8Array>) => (ran.push(route.name), route.run(ctx)) };
		case 'jpeg':
			return { ...route, run: (ctx: Ctx<Who, Uint8Array>) => (ran.push(route.name), route.run(ctx)) };
	}
}

function probe(prefix: string, route: RouteOf<unknown>): Probe {
	const send: Send = route.body === 'json' ? { json: {} } : route.body === 'png' ? { png: PNG } : route.body === 'jpeg' ? { jpeg: JPEG } : {};
	return { name: route.name, method: route.method, path: `${prefix}${route.path.replace(/\{\w+\}/g, 'probe')}`, send };
}

/** Values that satisfy every declared setting, so the app can start. */
function envFor(settings: Readonly<Record<string, SettingSpec>>, prefix: string): Env {
	return Object.fromEntries(
		Object.entries(settings).flatMap(([name, spec]) => (spec.kind === 'int' ? [] : [[`${prefix}${name}`, spec.kind === 'url' ? 'https://example.com/' : 'set']])),
	);
}

function assertApiError(reply: HostReply & { readonly data: unknown }): void {
	assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
	const data = reply.data as Record<string, unknown>;
	assert.equal(typeof data['error'], 'string');
	assert.equal(typeof data['message'], 'string');
	if ('problems' in data) assert.ok(Array.isArray(data['problems']) && data['problems'].every((p) => typeof p === 'string'));
}

function assertNoCors(reply: HostReply): void {
	assert.deepEqual(Object.keys(reply.headers).filter((name) => name.toLowerCase().startsWith('access-control-')), []);
}

/** The runtime handles match ownership: write methods only where this side writes, no handle where it has no role. */
function assertHandles(handles: Readonly<Record<string, object>>, declared: StorageDeclaration, writes: readonly Ownership[], reads: readonly Ownership[]): void {
	for (const [name, ownership] of Object.entries(declared)) {
		const handle = handles[name];
		if (writes.includes(ownership)) assert.ok(handle && WRITES.some((method) => method in handle), `${name} is writable`);
		else if (reads.includes(ownership)) assert.deepEqual(handle && WRITES.filter((method) => method in handle), [], `${name} is read-only`);
		else assert.equal(handle, undefined, `${name} has no handle`);
	}
}

export function runPlayConformance<M extends GameManifest>(manifest: M, create: CreatePlayApi<M>): void {
	const id = requireGameId(manifest);
	const prefix = `/api/g/${id}/`;

	function setup() {
		const w = world();
		const ran: string[] = [];
		const seen: { platform?: PlayPlatform<M>; probes: Probe[]; createOps: number } = { probes: [], createOps: -1 };
		const app: App = createPlayerApp({
			manifest,
			create(platform) {
				const before = w.accounts.ops.length;
				const api = create(platform);
				seen.platform = platform;
				seen.createOps = w.accounts.ops.length - before;
				seen.probes = [{ name: 'session', method: 'GET', path: `${prefix}session`, send: {} }, ...api.routes.map((route) => probe(prefix, route))];
				return { ...api, routes: api.routes.map((route) => spy(route, ran)) };
			},
			portal: w.reader,
			accounts: w.accounts,
			tokens,
			env: envFor(manifest.play.settings, ''),
			issuers: [idp.games],
			telemetry: w.telemetry,
			now: w.now,
		});
		const all = async (send: Send) => Promise.all(seen.probes.map((p) => call(app, p.method, p.path, { ...p.send, ...send })));
		return { w, ran, seen, app, all };
	}

	async function assertRefused(refusal: string, status: number, send: Send) {
		const { ran, all } = setup();
		for (const reply of await all(send)) {
			assert.equal(reply.status, status);
			assert.equal(codeOf(reply), refusal);
		}
		assert.deepEqual(ran, [], 'no handler ran');
	}

	describe(`conformance: ${id} player app`, () => {
		it('refuses a request with no token: 401 unauthenticated', () => assertRefused('unauthenticated', 401, {}));

		it('refuses a token from an untrusted issuer: 401 invalid_token', async () => {
			await assertRefused('invalid_token', 401, { token: await idp.untrustedToken(newObjectId()) });
		});

		it('refuses a games4kids-admin token, even for a player granted this game: 401 invalid_token', async () => {
			const { w, ran, all } = setup();
			const player = await seedPlayer(w, idp, { games: [id] });
			for (const scp of ['admin.console', 'admin.elevate']) {
				const token = await idp.adminToken(player.objectId, { scp, authTime: new Date() });
				for (const reply of await all({ token })) assert.equal(codeOf(reply), 'invalid_token');
			}
			assert.deepEqual(ran, []);
		});

		it('refuses an unknown identity: 403 not_invited', async () => {
			await assertRefused('not_invited', 403, { token: await idp.gamesToken(newObjectId()) });
		});

		it('refuses a revoked member who was granted this game: 403 not_invited', async () => {
			const { w, ran, all } = setup();
			const revoked = await seedPlayer(w, idp, { games: [id], state: 'revoked' });
			for (const reply of await all({ token: revoked.token })) assert.equal(codeOf(reply), 'not_invited');
			assert.deepEqual(ran, []);
		});

		it('refuses an active member with no profile: 403 no_profile', async () => {
			const { w, ran, all } = setup();
			const fresh = await seedPlayer(w, idp, { games: [id], profile: null });
			for (const reply of await all({ token: fresh.token })) assert.equal(codeOf(reply), 'no_profile');
			assert.deepEqual(ran, []);
		});

		it('refuses an active member without this game: 403 not_entitled', async () => {
			const { w, ran, all } = setup();
			const other = await seedPlayer(w, idp, { games: [] });
			for (const reply of await all({ token: other.token })) assert.equal(codeOf(reply), 'not_entitled');
			assert.deepEqual(ran, []);
		});

		it('answers GET session with the Caller for a granted player, and nothing more', async () => {
			const { w, app } = setup();
			const profile = { displayName: 'Ada', timeZone: 'Europe/Paris' };
			const player = await seedPlayer(w, idp, { games: [id], profile });
			const reply = await call(app, 'GET', `${prefix}session`, { token: player.token });
			assert.equal(reply.status, 200);
			assert.deepEqual(reply.data, { userId: player.userId, ...profile });
		});

		it('keeps every function under /api/g/<id>/ with unique names and method and route pairs', () => {
			const { app } = setup();
			assert.equal(app.prefix, prefix);
			for (const fn of app.functions) assert.ok(`/api/${fn.route}`.startsWith(prefix), fn.route);
			assert.equal(new Set(app.functions.map((fn) => fn.name)).size, app.functions.length);
			assert.equal(new Set(app.functions.map((fn) => `${fn.method} ${fn.route}`)).size, app.functions.length);
		});

		it('creates the API with no storage I/O', () => {
			assert.equal(setup().seen.createOps, 0);
		});

		it("hands the player app write handles on 'play' names, read-only handles on 'admin' names, and none on 'admin-private' names", () => {
			const { seen } = setup();
			const platform = seen.platform;
			assert.ok(platform);
			assert.deepEqual(Object.keys(platform).sort(), [...PLATFORM_KEYS].sort());
			assertHandles(platform.tables, manifest.storage.tables, ['play'], ['admin']);
			assertHandles(platform.blobs, manifest.storage.containers, ['play'], ['admin']);
			assertHandles(platform.queues, manifest.storage.queues, ['play'], []);
		});

		it("touches only this game's account and the portal reader, and writes no 'admin' or 'admin-private' name", async () => {
			const { w, ran, seen, all } = setup();
			const player = await seedPlayer(w, idp, { games: [id] });
			const start = w.accounts.ops.length;
			await all({ token: player.token });
			assert.deepEqual(ran.sort(), seen.probes.slice(1).map((p) => p.name).sort(), 'every route ran for a granted player');
			const ops = w.accounts.ops.slice(start);
			assert.deepEqual([...new Set(ops.map((op) => op.account))].filter((account) => account !== id && account !== 'portal'), []);
			assert.deepEqual(ops.filter((op) => op.account === 'portal' && op.write), []);
			const declared = { table: manifest.storage.tables, container: manifest.storage.containers, queue: manifest.storage.queues };
			assert.deepEqual(ops.filter((op) => op.account === id && op.write && declared[op.kind][op.name] !== 'play'), []);
		});

		it('answers every refusal and error with the one ApiError shape and no CORS header', async () => {
			const { w, app, all } = setup();
			const player = await seedPlayer(w, idp, { games: [id] });
			const replies = [
				...(await all({})),
				...(await all({ token: await idp.gamesToken(newObjectId()) })),
				...(await all({ token: player.token })),
				await call(app, 'GET', `${prefix}no/such/route`),
				await call(app, 'GET', '/api/g/someothergame/session', { token: player.token }),
			];
			for (const reply of replies) {
				assertNoCors(reply);
				if (reply.status >= 400) assertApiError(reply);
			}
		});
	});
}

export function runAdminConformance<M extends GameManifest>(manifest: M, create: CreateAdminApi<M>): void {
	const id = requireGameId(manifest);
	const prefix = `/api/admin/g/${id}/`;

	function setup() {
		const w = world();
		const ran: string[] = [];
		const seen: { platform?: AdminPlatform<M>; probes: Probe[]; createOps: number } = { probes: [], createOps: -1 };
		const module = adminModule(manifest, (platform) => {
			const before = w.accounts.ops.length;
			const api = create(platform);
			seen.platform = platform;
			seen.createOps = w.accounts.ops.length - before;
			seen.probes = api.routes.map((route) => probe(prefix, route));
			return { ...api, routes: api.routes.map((route) => spy(route, ran)) };
		});
		const app = createAdminApp({
			issuer: idp.admin,
			telemetry: w.telemetry,
			now: w.now,
			store: w.admin,
			graph: () => assert.fail('a game admin module never reaches Graph'),
			games: [id],
			modules: [module],
			accounts: w.accounts,
			tokens,
			env: envFor(manifest.admin?.settings ?? {}, `${id.toUpperCase()}_`),
			gamesOrigin: 'https://games.example',
		});
		const all = async (send: Send) => Promise.all(seen.probes.map((p) => call(app, p.method, p.path, { ...p.send, ...send })));
		return { w, ran, seen, app, all };
	}

	describe(`conformance: ${id} admin module`, () => {
		it('refuses a games4kids token, including one for a member granted this game: 401', async () => {
			const { w, ran, all } = setup();
			const player = await seedPlayer(w, idp, { games: [id] });
			await seedAdmin(w, player.objectId);
			for (const reply of [...(await all({})), ...(await all({ token: player.token }))]) {
				assert.equal(reply.status, 401);
				assertApiError(reply);
			}
			assert.deepEqual(ran, []);
		});

		it('refuses a games4kids-admin token whose oid has no admins row: 403 forbidden', async () => {
			const { ran, all } = setup();
			for (const reply of await all({ token: await idp.adminToken(newObjectId()) })) {
				assert.equal(reply.status, 403);
				assert.equal(codeOf(reply), 'forbidden');
			}
			assert.deepEqual(ran, []);
		});

		it('runs every route for an admin with an admins row', async () => {
			const { w, ran, seen, all } = setup();
			const objectId = newObjectId();
			await seedAdmin(w, objectId);
			await all({ token: await idp.adminToken(objectId) });
			assert.deepEqual(ran.sort(), seen.probes.map((p) => p.name).sort());
		});

		it('mounts every route under /api/admin/g/<id>/ and names each function adminFunctionName(id, name)', () => {
			const { app, seen } = setup();
			const mine = app.functions.filter((fn) => fn.name.startsWith(`${id}-`));
			assert.deepEqual(mine.map((fn) => fn.name).sort(), seen.probes.map((p) => adminFunctionName(id, p.name)).sort());
			for (const fn of mine) assert.ok(`/api/${fn.route}`.startsWith(prefix), fn.route);
		});

		it('creates the API with no storage I/O', () => {
			assert.equal(setup().seen.createOps, 0);
		});

		it("hands the module no Graph client, write handles on 'admin' and 'admin-private' names, and read-only handles on 'play' names", () => {
			const { seen } = setup();
			const platform = seen.platform;
			assert.ok(platform);
			assert.deepEqual(Object.keys(platform).sort(), [...PLATFORM_KEYS, 'roster'].sort());
			assertHandles(platform.tables, manifest.storage.tables, ['admin', 'admin-private'], ['play']);
			assertHandles(platform.blobs, manifest.storage.containers, ['admin', 'admin-private'], ['play']);
			assertHandles(platform.queues, manifest.storage.queues, ['admin', 'admin-private'], []);
		});

		it("touches only this game's account and the portal, and writes no 'play' name", async () => {
			const { w, all } = setup();
			const objectId = newObjectId();
			await seedAdmin(w, objectId);
			const start = w.accounts.ops.length;
			const replies = await all({ token: await idp.adminToken(objectId) });
			for (const reply of replies) assertNoCors(reply);
			const ops = w.accounts.ops.slice(start);
			assert.deepEqual([...new Set(ops.map((op) => op.account))].filter((account) => account !== id && account !== 'portal'), []);
			assert.deepEqual(ops.filter((op) => op.account === 'portal' && op.write), []);
			const declared = { table: manifest.storage.tables, container: manifest.storage.containers, queue: manifest.storage.queues };
			assert.deepEqual(ops.filter((op) => op.account === id && op.write && declared[op.kind][op.name] === 'play'), []);
		});
	});
}
