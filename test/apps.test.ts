import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineGame, definePlayApi, HttpError, parseEmail } from '@g4k/sdk';
import { createPlayerApp, createPortalApp, EntraRefused, type GraphFor, type PortalTableName } from '@g4k/host';
import { fixtureApps } from './support/apps.ts';
import { fakeGraph } from './support/graph.ts';
import { call, codeOf, PNG } from './support/http.ts';
import { gameId } from './support/ids.ts';
import { fakeIdp } from './support/idp.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world, type World } from './support/world.ts';

const idp = await fakeIdp();
const tokens = async () => 'token';
const id = gameId('fixture');
const apps = (w: World, graph?: GraphFor) => fixtureApps(w, idp, graph);

async function owner(w: World) {
	const objectId = newObjectId();
	await seedAdmin(w, objectId);
	return {
		console: await idp.adminToken(objectId),
		elevated: (authTime: Date) => idp.adminToken(objectId, { scp: 'admin.elevate', authTime }),
	};
}

test('a member saved with one game and synced signs in, chooses a name, plays that game, and is refused on the next call after a revoke', async () => {
	const w = world();
	const entra = fakeGraph();
	const { player, portal, admin } = apps(w, () => entra.graph);
	const me = await owner(w);

	const saved = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'Kid@Example.com', games: { kind: 'some', ids: ['fixture'] } } });
	assert.equal(saved.status, 201);
	const userId = (saved.data as { userId: string }).userId;

	const synced = await call(admin, 'POST', '/api/admin/portal/entra/sync', { token: await me.elevated(NOW), json: { userId } });
	assert.equal(synced.status, 200);
	const kidEmail = parseEmail('kid@example.com');
	assert.ok(kidEmail);
	const kidOid = entra.users.get(kidEmail);
	assert.ok(kidOid && entra.assignments.has(kidOid), 'invited and assigned to games4kids');

	const kid = await idp.gamesToken(kidOid);
	assert.deepEqual((await call(portal, 'GET', '/api/portal/me', { token: kid })).data, { state: 'no-profile' });
	assert.equal(codeOf(await call(player, 'GET', '/api/g/fixture/session', { token: kid })), 'no_profile');
	assert.equal((await call(portal, 'PUT', '/api/portal/profile', { token: kid, json: { displayName: 'Ada', timeZone: 'Europe/London' } })).status, 204);
	assert.deepEqual((await call(portal, 'GET', '/api/portal/me', { token: kid })).data, {
		state: 'active',
		userId,
		profile: { displayName: 'Ada', timeZone: 'Europe/London' },
		canRenameToday: true,
		games: [{ id: 'fixture', paused: false }],
	});
	assert.equal((await call(player, 'GET', '/api/g/fixture/session', { token: kid })).status, 200);

	const revoked = await call(admin, 'PUT', `/api/admin/portal/members/${userId}`, { token: me.console, json: { state: 'revoked', games: { kind: 'some', ids: ['fixture'] } } });
	assert.equal(revoked.status, 200);
	assert.equal(codeOf(await call(player, 'GET', '/api/g/fixture/levels', { token: kid })), 'not_invited');
	assert.deepEqual((await call(portal, 'GET', '/api/portal/me', { token: kid })).data, { state: 'not-invited', email: null });

	await call(admin, 'POST', '/api/admin/portal/entra/sync', { token: await me.elevated(NOW), json: { userId } });
	assert.ok(!entra.assignments.has(kidOid), 'the sync after a revoke removes the assignment');
});

test('an Entra route asks for a step-up unless the token is admin.elevate with a sign-in at most 10 minutes old', async () => {
	const w = world();
	let elevations = 0;
	const entra = fakeGraph();
	const { admin } = apps(w, () => (elevations++, entra.graph));
	const me = await owner(w);
	const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

	for (const token of [me.console, await me.elevated(minutesAgo(11))]) {
		const reply = await call(admin, 'GET', '/api/admin/portal/entra', { token });
		assert.equal(reply.status, 401);
		assert.equal(codeOf(reply), 'step_up_required');
		assert.match(reply.headers['www-authenticate'] ?? '', /^Bearer error="insufficient_user_authentication".*max_age="600"$/);
	}
	assert.equal(elevations, 0, 'no Graph client was built without an elevation');
	assert.equal((await call(admin, 'GET', '/api/admin/portal/entra', { token: await me.elevated(minutesAgo(9)) })).status, 200);
	assert.equal(elevations, 1);
});

test('Entra refusals become a claims challenge or entra_forbidden', async () => {
	const w = world();
	const me = await owner(w);
	const refusing = (error: EntraRefused): GraphFor => () => ({ ...fakeGraph().graph, assignments: async () => Promise.reject(error) });

	const challenged = await call(apps(w, refusing(new EntraRefused({ kind: 'claims_challenge', claims: '{"access_token":{}}' }))).admin, 'GET', '/api/admin/portal/entra', {
		token: await me.elevated(NOW),
	});
	assert.equal(challenged.status, 401);
	assert.equal(challenged.headers['www-authenticate'], `Bearer error="insufficient_claims", claims="${Buffer.from('{"access_token":{}}').toString('base64')}"`);
	assert.deepEqual(challenged.data, { error: 'insufficient_claims', message: 'Sign in again to continue.', claims: '{"access_token":{}}' }, 'a page on another origin cannot read the header, so the body carries the claims');

	const refusal = new EntraRefused({ kind: 'entra_forbidden', call: 'list-assignments' });
	const forbidden = await call(apps(w, refusing(refusal)).admin, 'GET', '/api/admin/portal/entra', {
		token: await me.elevated(NOW),
	});
	assert.equal(forbidden.status, 403);
	assert.equal(codeOf(forbidden), 'entra_forbidden');
	assert.deepEqual(w.telemetry.exceptions, [refusal], 'a refusal is a fault to look into, a claims challenge is the normal step-up');
});

test('the members routes parse at the boundary: an unknown game is a 400, an unknown member a 404', async () => {
	const w = world();
	const { admin } = apps(w);
	const me = await owner(w);
	const bad = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'kid@example.com', games: { kind: 'some', ids: ['fixture', 'nogame'] } } });
	assert.equal(bad.status, 400);
	assert.deepEqual((bad.data as { problems: string[] }).problems, ['nogame is not a game']);
	const missing = await call(admin, 'PUT', `/api/admin/portal/members/${newObjectId()}`, { token: me.console, json: { state: 'revoked', games: { kind: 'some', ids: [] } } });
	assert.equal(missing.status, 404);
});

test('the members routes refuse a malformed grant, and take an all-games grant that the list shows back', async () => {
	const w = world();
	const { admin } = apps(w);
	const me = await owner(w);
	for (const games of [['fixture'], { kind: 'every' }, { kind: 'all', ids: ['fixture'] }, { kind: 'some' }, { kind: 'some', ids: 'fixture' }, null]) {
		const reply = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'kid@example.com', games } });
		assert.equal(codeOf(reply), 'invalid', JSON.stringify(games));
	}
	const saved = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'owner@example.com', games: { kind: 'all' } } });
	assert.equal(saved.status, 201);
	const userId = (saved.data as { userId: string }).userId;
	const malformed = await call(admin, 'PUT', `/api/admin/portal/members/${userId}`, { token: me.console, json: { state: 'active', games: { kind: 'all', ids: [] } } });
	assert.equal(codeOf(malformed), 'invalid');
	const listed = (await call(admin, 'GET', '/api/admin/portal/members', { token: me.console })).data as { member: { userId: string; games: unknown } }[];
	assert.deepEqual(listed.map(({ member }) => [member.userId, member.games]), [[userId, { kind: 'all' }]]);
	assert.equal((await call(admin, 'PUT', `/api/admin/portal/members/${userId}`, { token: me.console, json: { state: 'active', games: { kind: 'some', ids: [] } } })).status, 200);
	const narrowed = (await call(admin, 'GET', '/api/admin/portal/members', { token: me.console })).data as { member: { games: unknown } }[];
	assert.deepEqual(narrowed.map(({ member }) => member.games), [{ kind: 'some', ids: [] }]);
});

test('pausing a game converges however often it is sent, and a bad game or body changes nothing', async () => {
	const w = world();
	const { admin, player } = apps(w);
	const me = await owner(w);
	const kid = await seedPlayer(w, idp, { games: [id] });
	const put = (path: string, json: unknown) => call(admin, 'PUT', `/api/admin/portal/games/${path}`, { token: me.console, json });
	const listed = async () => (await call(admin, 'GET', '/api/admin/portal/games', { token: me.console })).data;
	const portal = w.accounts.open('portal');
	const rows = async (name: PortalTableName) => (await portal.table(name).list()).map((row) => [row.partitionKey, row.rowKey, row['state']]);
	const memberRows = await rows('members');

	for (let i = 0; i < 2; i++) assert.deepEqual((await put('fixture', { paused: true })).data, { id: 'fixture', paused: true });
	assert.deepEqual(await listed(), [{ id: 'fixture', paused: true }]);
	assert.equal(codeOf(await call(player, 'GET', '/api/g/fixture/session', { token: kid.token })), 'game_paused');
	assert.deepEqual(await rows('games'), [['game', 'fixture', 'paused']]);
	assert.deepEqual(await rows('members'), memberRows, 'pausing writes nothing to members');

	for (let i = 0; i < 2; i++) assert.deepEqual((await put('fixture', { paused: false })).data, { id: 'fixture', paused: false });
	assert.deepEqual(await listed(), [{ id: 'fixture', paused: false }]);
	assert.equal((await call(player, 'GET', '/api/g/fixture/session', { token: kid.token })).status, 200);
	assert.deepEqual(await rows('games'), [], 'making a game available deletes its row');

	assert.equal((await put('nogame', { paused: true })).status, 404);
	assert.equal((await put('No%20Good', { paused: true })).status, 404);
	for (const body of [{}, { paused: 'yes' }, { paused: 1 }, null]) assert.equal(codeOf(await put('fixture', body)), 'invalid', JSON.stringify(body));
	assert.deepEqual(await listed(), [{ id: 'fixture', paused: false }]);
});

test('a game row with a key that is no game id, or a state that is not paused, pauses nothing', async () => {
	const w = world();
	const { admin, player } = apps(w);
	const me = await owner(w);
	const kid = await seedPlayer(w, idp, { games: [id] });
	const games = w.accounts.open('portal').table('games');
	await games.put({ partitionKey: 'game', rowKey: 'fixture', state: 'stopped' });
	await games.put({ partitionKey: 'game', rowKey: 'No Good', state: 'paused' });
	await games.put({ partitionKey: 'game', rowKey: 'latecomer', state: 'paused' });
	assert.deepEqual([...(await w.reader.paused())], ['latecomer']);
	assert.equal((await call(player, 'GET', '/api/g/fixture/session', { token: kid.token })).status, 200);
	assert.deepEqual((await call(admin, 'GET', '/api/admin/portal/games', { token: me.console })).data, [{ id: 'fixture', paused: false }], 'only registered games are listed');
	assert.equal(codeOf(await call(laterGame(w, 'latecomer'), 'GET', '/api/g/latecomer/session', { token: kid.token })), 'not_entitled', 'a paused game not granted stays hidden');
});

/** A game app built after the members row was written, as a newly deployed game is. */
function laterGame(w: World, raw: string) {
	const manifest = defineGame({ id: raw, title: raw, summary: '', icon: 'icon.svg', storage: { tables: {}, containers: {}, queues: {} }, play: { web: { kind: 'static' }, settings: {}, services: [] } });
	return createPlayerApp({ issuers: [idp.games], telemetry: w.telemetry, now: w.now, manifest, create: definePlayApi(manifest, () => ({ routes: [] })), portal: w.reader, accounts: w.accounts, tokens, env: {} });
}

test('an all-games member plays every game, including one registered after the row was written, and me lists each one', async () => {
	const w = world();
	const { player } = apps(w);
	const everyGame = await seedPlayer(w, idp, { games: 'all', profile: { displayName: 'Owner', timeZone: 'UTC' } });
	assert.equal((await call(player, 'GET', '/api/g/fixture/session', { token: everyGame.token })).status, 200);
	assert.equal((await call(laterGame(w, 'latecomer'), 'GET', '/api/g/latecomer/session', { token: everyGame.token })).status, 200);
	const portal = createPortalApp({ issuers: [idp.games], telemetry: w.telemetry, now: w.now, portal: w.portal, games: [id, gameId('latecomer')] });
	assert.deepEqual((await call(portal, 'GET', '/api/portal/me', { token: everyGame.token })).data, {
		state: 'active',
		userId: everyGame.userId,
		profile: { displayName: 'Owner', timeZone: 'UTC' },
		canRenameToday: true,
		games: [
			{ id: 'fixture', paused: false },
			{ id: 'latecomer', paused: false },
		],
	});
});

test('a members row in the old list form still parses, and is still refused a game it was not granted', async () => {
	const w = world();
	const { player } = apps(w);
	const kid = await seedPlayer(w, idp, { games: [], profile: { displayName: 'Ada', timeZone: 'UTC' } });
	await w.accounts.open('portal').table('members').put({ partitionKey: 'member', rowKey: kid.userId, state: 'active', games: 'fixture' });
	assert.equal((await call(player, 'GET', '/api/g/fixture/session', { token: kid.token })).status, 200);
	assert.equal(codeOf(await call(laterGame(w, 'latecomer'), 'GET', '/api/g/latecomer/session', { token: kid.token })), 'not_entitled');
	const portal = createPortalApp({ issuers: [idp.games], telemetry: w.telemetry, now: w.now, portal: w.portal, games: [id, gameId('latecomer')] });
	assert.deepEqual(((await call(portal, 'GET', '/api/portal/me', { token: kid.token })).data as { games: unknown }).games, [{ id: 'fixture', paused: false }]);
});

test('a re-invite of the same email keeps the same PortalUserId', async () => {
	const w = world();
	const { admin } = apps(w);
	const me = await owner(w);
	const first = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'kid@example.com', games: { kind: 'some', ids: [] } } });
	const second = await call(admin, 'POST', '/api/admin/portal/members', { token: me.console, json: { email: 'KID@example.com', games: { kind: 'some', ids: ['fixture'] } } });
	assert.equal((first.data as { userId: string }).userId, (second.data as { userId: string }).userId);
});

test('the portal app refuses a display name another child holds and an invalid profile', async () => {
	const w = world();
	const { portal } = apps(w);
	await seedPlayer(w, idp, { games: [id], profile: { displayName: 'Ada', timeZone: 'UTC' } });
	const other = await seedPlayer(w, idp, { games: [id], profile: null });
	const taken = await call(portal, 'PUT', '/api/portal/profile', { token: other.token, json: { displayName: ' ada ', timeZone: 'UTC' } });
	assert.equal(taken.status, 409);
	assert.equal(codeOf(taken), 'name_taken');
	const invalid = await call(portal, 'PUT', '/api/portal/profile', { token: other.token, json: { displayName: '', timeZone: 'Mars/Olympus' } });
	assert.equal(invalid.status, 400);
	const stranger = await call(portal, 'PUT', '/api/portal/profile', { token: await idp.gamesToken(newObjectId()), json: { displayName: 'Zed', timeZone: 'UTC' } });
	assert.equal(codeOf(stranger), 'not_invited');
});

test('the portal app refuses an unkind display name with name_not_allowed and writes no profile', async () => {
	const w = world();
	const { portal } = apps(w);
	const kid = await seedPlayer(w, idp, { games: [id], profile: null });
	for (const displayName of ['Shit', 'sh1t', 'Stupid']) {
		const refused = await call(portal, 'PUT', '/api/portal/profile', { token: kid.token, json: { displayName, timeZone: 'UTC' } });
		assert.equal(refused.status, 400, displayName);
		assert.equal(codeOf(refused), 'name_not_allowed', displayName);
	}
	assert.deepEqual((await call(portal, 'GET', '/api/portal/me', { token: kid.token })).data, { state: 'no-profile' });
	const kind = await call(portal, 'PUT', '/api/portal/profile', { token: kid.token, json: { displayName: 'Ada', timeZone: 'UTC' } });
	assert.equal(kind.status, 204);
});

test('the portal app lets a child rename once a day, by their own calendar day, and a refused rename writes nothing', async () => {
	const w = world();
	const clock = { at: NOW };
	const portal = createPortalApp({ issuers: [idp.games], telemetry: w.telemetry, now: () => clock.at, portal: w.portal, games: [id] });
	const kid = await seedPlayer(w, idp, { games: [id], profile: null });
	const put = (displayName: string, timeZone = 'Europe/London') => call(portal, 'PUT', '/api/portal/profile', { token: kid.token, json: { displayName, timeZone } });
	const me = async () => (await call(portal, 'GET', '/api/portal/me', { token: kid.token })).data as { profile: { displayName: string; timeZone: string }; canRenameToday: boolean };

	assert.equal((await put('Ada')).status, 204, 'the first name is not a rename');
	assert.equal((await me()).canRenameToday, true);
	assert.equal((await put('Bea')).status, 204, 'so the first rename is still open');
	assert.equal((await me()).canRenameToday, false);

	const refused = await put('Cleo');
	assert.equal(refused.status, 429);
	assert.equal(codeOf(refused), 'rename_tomorrow');
	assert.equal((refused.data as { message: string }).message, 'You can change your name again tomorrow.');
	assert.deepEqual((await me()).profile, { displayName: 'Bea', timeZone: 'Europe/London' }, 'nothing was written');

	assert.equal((await put('Bea', 'Pacific/Auckland')).status, 204, 'a time zone change keeps the name, so it is no rename');
	assert.equal((await me()).canRenameToday, false, 'and it keeps the day of the last rename');
	assert.equal(codeOf(await put('Cleo', 'Pacific/Auckland')), 'rename_tomorrow');
	clock.at = new Date(NOW.getTime() + 24 * 3_600_000);
	assert.equal((await put('Dee')).status, 204, 'a day later');
	assert.equal((await me()).canRenameToday, false);
});

test('the fixture game: the admin writes a level, the player reads it and scores, and the admin sees the score by name', async () => {
	const w = world();
	const { player, admin } = apps(w);
	const me = await owner(w);
	const kid = await seedPlayer(w, idp, { games: [id], profile: { displayName: 'Ada', timeZone: 'UTC' } });

	assert.equal((await call(admin, 'PUT', '/api/admin/g/fixture/levels/one', { token: me.console, json: { title: 'One' } })).status, 204);
	assert.deepEqual((await call(player, 'GET', '/api/g/fixture/levels', { token: kid.token })).data, [{ id: 'one', title: 'One' }]);
	assert.equal((await call(player, 'PUT', '/api/g/fixture/scores/one', { token: kid.token, json: { points: 7 } })).status, 204);
	assert.equal((await call(player, 'PUT', '/api/g/fixture/scores/two', { token: kid.token, json: { points: 7 } })).status, 404);
	assert.deepEqual((await call(admin, 'GET', '/api/admin/g/fixture/scores', { token: me.console })).data, [{ userId: kid.userId, levelId: 'one', points: 7, name: 'Ada' }]);
	assert.equal((await call(admin, 'POST', '/api/admin/g/fixture/notes', { token: me.console, json: { text: 'hi' } })).status, 201);
	assert.equal(w.accounts.messages(id, 'jobs').length, 1);
});

test('a play route parses its declared body: wrong type is 415, not a PNG is 415, too big is 413, bad JSON is 400', async () => {
	const w = world();
	const { player } = apps(w);
	const kid = await seedPlayer(w, idp, { games: [id] });
	assert.equal((await call(player, 'POST', '/api/g/fixture/uploads', { token: kid.token, json: {} })).status, 415);
	assert.equal((await call(player, 'POST', '/api/g/fixture/uploads', { token: kid.token, png: new Uint8Array([1, 2, 3]) })).status, 415);
	const huge = new Uint8Array(4 * 1024 * 1024 + 1);
	huge.set(PNG);
	assert.equal((await call(player, 'POST', '/api/g/fixture/uploads', { token: kid.token, png: huge })).status, 413);
	assert.equal((await call(player, 'POST', '/api/g/fixture/uploads', { token: kid.token, png: PNG })).status, 201);
	const broken = await player.handle({
		method: 'PUT',
		path: '/api/g/fixture/scores/one',
		headers: new Headers({ authorization: `Bearer ${kid.token}`, 'content-type': 'application/json' }),
		query: new URLSearchParams(),
		bytes: async () => new TextEncoder().encode('{nope'),
	});
	assert.equal(broken.status, 400);
});

test('an unexpected error is a 500 that names nothing internal, and telemetry records it', async () => {
	const w = world();
	const crasher = defineGame({
		id: 'crasher',
		title: 'Crasher',
		summary: '',
		icon: 'icon.svg',
		storage: { tables: {}, containers: {}, queues: {} },
		play: { web: { kind: 'static' }, settings: {}, services: [] },
	});
	const app = createPlayerApp({
		issuers: [idp.games],
		telemetry: w.telemetry,
		now: w.now,
		manifest: crasher,
		create: definePlayApi(crasher, () => ({
			routes: [{ name: 'boom', method: 'GET', path: 'boom', body: 'none', run: async () => Promise.reject(new Error('secret detail')) }],
		})),
		portal: w.reader,
		accounts: w.accounts,
		tokens,
		env: {},
	});
	const kid = await seedPlayer(w, idp, { games: [gameId('crasher')] });
	const reply = await call(app, 'GET', '/api/g/crasher/boom', { token: kid.token });
	assert.equal(reply.status, 500);
	assert.deepEqual(reply.data, { error: 'internal', message: 'Something went wrong.' });
	assert.equal(w.telemetry.exceptions.length, 1);
});

test('a 5xx HttpError keeps its reply and telemetry records it, but a 4xx is an answer and is not recorded', async () => {
	const w = world();
	const flaky = defineGame({
		id: 'flaky',
		title: 'Flaky',
		summary: '',
		icon: 'icon.svg',
		storage: { tables: {}, containers: {}, queues: {} },
		play: { web: { kind: 'static' }, settings: {}, services: [] },
	});
	const app = createPlayerApp({
		issuers: [idp.games],
		telemetry: w.telemetry,
		now: w.now,
		manifest: flaky,
		create: definePlayApi(flaky, () => ({
			routes: [
				{ name: 'down', method: 'GET', path: 'down', body: 'none', run: async () => Promise.reject(new HttpError(502, 'upstream_down', 'The picture service did not answer.')) },
				{ name: 'bad', method: 'GET', path: 'bad', body: 'none', run: async () => Promise.reject(new HttpError(400, 'bad_level', 'There is no such level.')) },
			],
		})),
		portal: w.reader,
		accounts: w.accounts,
		tokens,
		env: {},
	});
	const kid = await seedPlayer(w, idp, { games: [gameId('flaky')] });
	const down = await call(app, 'GET', '/api/g/flaky/down', { token: kid.token });
	const bad = await call(app, 'GET', '/api/g/flaky/bad', { token: kid.token });
	assert.deepEqual([down.status, down.data], [502, { error: 'upstream_down', message: 'The picture service did not answer.' }]);
	assert.equal(bad.status, 400);
	assert.deepEqual(w.telemetry.exceptions.map((error) => (error as Error).message), ['The picture service did not answer.']);
});

test('a player app refuses to start when a required setting is missing', () => {
	const w = world();
	const needy = defineGame({
		id: 'needy',
		title: 'Needy',
		summary: '',
		icon: 'icon.svg',
		storage: { tables: {}, containers: {}, queues: {} },
		play: { web: { kind: 'static' }, settings: { API_URL: { kind: 'url' } }, services: [] },
	});
	const deps = { issuers: [idp.games], telemetry: w.telemetry, now: w.now, manifest: needy, create: definePlayApi(needy, () => ({ routes: [] })), portal: w.reader, accounts: w.accounts, tokens };
	assert.throws(() => createPlayerApp({ ...deps, env: {} }), /API_URL is required/);
	assert.throws(() => createPlayerApp({ ...deps, env: { API_URL: 'not a url' } }), /API_URL must be a URL/);
	assert.doesNotThrow(() => createPlayerApp({ ...deps, env: { API_URL: 'https://example.com/' } }));
});

test('GET portal/me tells an admin page who it is signed in as, and refuses anyone else', async () => {
	const w = world();
	const { admin } = apps(w);
	const me = await owner(w);
	assert.deepEqual((await call(admin, 'GET', '/api/admin/portal/me', { token: me.console })).data, { email: 'owner@example.com' });
	assert.equal(codeOf(await call(admin, 'GET', '/api/admin/portal/me', { token: await idp.adminToken(newObjectId()) })), 'forbidden');
	const kid = await seedPlayer(w, idp, { games: [id] });
	assert.equal(codeOf(await call(admin, 'GET', '/api/admin/portal/me', { token: kid.token })), 'invalid_token');
});

test('telemetry sees the matched route template and the player, never a raw id or an email', async () => {
	const w = world();
	const { player, admin } = apps(w);
	const kid = await seedPlayer(w, idp, { games: [id], profile: { displayName: 'Ada', timeZone: 'UTC' } });
	await call(player, 'PUT', '/api/g/fixture/scores/one', { token: kid.token, json: { points: 3 } });
	const me = await owner(w);
	await call(admin, 'PUT', '/api/admin/g/fixture/levels/zed', { token: me.console, json: { title: 'Zed' } });
	assert.deepEqual(w.telemetry.routes, ['/api/g/fixture/scores/{levelId}', '/api/admin/g/fixture/levels/{id}']);
	assert.deepEqual(w.telemetry.users, [kid.userId]);
});
