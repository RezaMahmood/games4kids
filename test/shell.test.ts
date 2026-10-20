import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_ID, type Refusal } from '@g4k/sdk';
import { parseAdminCatalog, parseAdminConfig } from '../apps/admin/shell/v1/config.ts';
import { describeDrift, parseMembers } from '../apps/admin/pages/members-model.ts';
import { parseCatalog, parseGamesConfig } from '../apps/games/shell/v1/config.ts';
import { parseCaller, parseMe } from '../apps/games/shell/v1/me.ts';
import { onRefusal } from '../apps/games/shell/v1/refusal.ts';
import { createGameStorage } from '../apps/games/shell/v1/storage.ts';
import { safeReturn } from '../apps/games/pages/return-to.ts';
import { ApiFailure, createApiClient, type TokenSource } from '../apps/shared/api-client.ts';
import { asGameId, asPortalUserId, GAME_ID as BROWSER_GAME_ID } from '../apps/shared/ids.ts';
import { BEAT_MS, createTelemetry, envelopeFor, parseConnectionString, startGameSession, type ShellEvent } from '../apps/shared/telemetry.ts';
import { gameId, portalUserId } from './support/ids.ts';

type Call = { readonly url: string; readonly init: RequestInit };

function server(replies: readonly (Response | (() => Response))[]) {
	const calls: Call[] = [];
	const queue = [...replies];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error('no reply left');
		return typeof next === 'function' ? next() : next;
	};
	return { calls, fetchImpl };
}

function tokens(token: string | null = 'first') {
	const asked: boolean[] = [];
	let reauthenticated = 0;
	const source: TokenSource = {
		token: async ({ forceRefresh }) => (asked.push(forceRefresh), token === null ? null : forceRefresh ? 'refreshed' : token),
		reauthenticate: async () => void (reauthenticated += 1),
	};
	return { source, asked, reauthenticated: () => reauthenticated };
}

const BASE = 'https://api.example/api/g/fixture';
const refusal = (error: string, status = 401, extra: object = {}) => Response.json({ error, message: 'No.', ...extra }, { status });
const authorization = (call: Call | undefined) => new Headers(call?.init.headers).get('authorization');

test('a request carries the bearer token and the query, and a 204 answers undefined', async () => {
	const { calls, fetchImpl } = server([Response.json({ ok: 1 }), new Response(null, { status: 204 })]);
	const api = createApiClient({ baseUrl: BASE, tokens: tokens().source, fetchImpl });
	assert.deepEqual(await api.get('levels', { page: '2' }), { ok: 1 });
	assert.equal(calls[0]?.url, `${BASE}/levels?page=2`);
	assert.equal(authorization(calls[0]), 'Bearer first');
	assert.equal(await api.delete('/drawings/1'), undefined);
	assert.equal(calls[1]?.url, `${BASE}/drawings/1`);
	assert.equal(calls[1]?.init.method, 'DELETE');
});

test('a rejected token is refreshed once and the request retried with the new one', async () => {
	const { calls, fetchImpl } = server([refusal('invalid_token'), Response.json({ ok: 1 })]);
	const t = tokens();
	assert.deepEqual(await createApiClient({ baseUrl: BASE, tokens: t.source, fetchImpl }).get('levels'), { ok: 1 });
	assert.deepEqual(t.asked, [false, true]);
	assert.deepEqual(calls.map(authorization), ['Bearer first', 'Bearer refreshed']);
	assert.equal(t.reauthenticated(), 0);
});

test('a token refused twice sends the child to sign in again and reports the failure', async () => {
	const { fetchImpl } = server([refusal('invalid_token'), refusal('invalid_token')]);
	const t = tokens();
	await assert.rejects(createApiClient({ baseUrl: BASE, tokens: t.source, fetchImpl }).get('levels'), { status: 401, code: 'invalid_token' });
	assert.equal(t.reauthenticated(), 1);
});

test('a step-up or a 403 is not a token problem: no refresh, no sign-in, the failure keeps its code, problems and claims', async () => {
	const { calls, fetchImpl } = server([refusal('step_up_required'), refusal('insufficient_claims', 401, { claims: '{"c":1}' }), refusal('invalid', 400, { problems: ['title is required'] }), refusal('not_entitled', 403)]);
	const t = tokens();
	const api = createApiClient({ baseUrl: BASE, tokens: t.source, fetchImpl });
	await assert.rejects(api.get('x'), { status: 401, code: 'step_up_required' });
	await assert.rejects(api.get('x'), { code: 'insufficient_claims', claims: '{"c":1}' });
	await assert.rejects(api.put('x', {}), (error) => error instanceof ApiFailure && error.problems[0] === 'title is required');
	await assert.rejects(api.get('x'), { status: 403, code: 'not_entitled' });
	assert.equal(calls.length, 4);
	assert.deepEqual(t.asked, [false, false, false, false]);
	assert.equal(t.reauthenticated(), 0);
});

test('with nobody signed in no request is sent, and an error with no body still reports its status', async () => {
	const none = server([]);
	await assert.rejects(createApiClient({ baseUrl: BASE, tokens: tokens(null).source, fetchImpl: none.fetchImpl }).get('x'), { status: 401, code: 'unauthenticated' });
	assert.equal(none.calls.length, 0);
	const broken = server([new Response('<html>', { status: 502 })]);
	await assert.rejects(createApiClient({ baseUrl: BASE, tokens: tokens().source, fetchImpl: broken.fetchImpl }).get('x'), { status: 502, code: 'http_502' });
});

test('writes send JSON, a heartbeat can be kept alive, and a PNG goes up as image/png', async () => {
	const { calls, fetchImpl } = server([new Response(null, { status: 204 }), Response.json({ id: 'a' }, { status: 201 }), Response.json({ id: 'b' }, { status: 201 })]);
	const api = createApiClient({ baseUrl: BASE, tokens: tokens().source, fetchImpl });
	await api.put('usage', { seconds: 60 }, { keepalive: true });
	assert.equal(calls[0]?.init.keepalive, true);
	assert.equal(calls[0]?.init.body, '{"seconds":60}');
	assert.equal(new Headers(calls[0]?.init.headers).get('content-type'), 'application/json');
	assert.deepEqual(await api.post('drawings', { title: 'x' }), { id: 'a' });
	assert.equal(calls[1]?.init.keepalive, undefined);
	const png = new Uint8Array([0x89, 0x50]);
	assert.deepEqual(await api.sendPng('drawings/a/png', png), { id: 'b' });
	assert.equal(new Headers(calls[2]?.init.headers).get('content-type'), 'image/png');
});

test('a JPEG goes up as image/jpeg, and request hands back the Response as it is with the bearer token attached', async () => {
	const { calls, fetchImpl } = server([Response.json({ id: 'c' }, { status: 201 }), new Response(null, { status: 304 }), new Response('gone', { status: 404 })]);
	const api = createApiClient({ baseUrl: BASE, tokens: tokens().source, fetchImpl });
	assert.deepEqual(await api.sendJpeg('pictures/a/original', new Uint8Array([0xff, 0xd8, 0xff])), { id: 'c' });
	assert.equal(new Headers(calls[0]?.init.headers).get('content-type'), 'image/jpeg');
	assert.equal(calls[0]?.init.method, 'POST');
	const revalidated = await api.request('pictures/a/outline.png', { headers: { 'if-none-match': '"v1"' } });
	assert.equal(revalidated.status, 304);
	assert.equal(new Headers(calls[1]?.init.headers).get('if-none-match'), '"v1"');
	assert.ok(new Headers(calls[1]?.init.headers).get('authorization')?.startsWith('Bearer '));
	assert.equal((await api.request('pictures/b/outline.png')).status, 404, 'an error status is not thrown');
});

test('an image is revalidated with its ETag and a 304 reuses the cached bytes', async () => {
	const created: string[] = [];
	const revoked: string[] = [];
	const urls = URL as unknown as { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
	const original = { create: urls.createObjectURL, revoke: urls.revokeObjectURL };
	urls.createObjectURL = () => (created.push(`blob:${created.length}`), `blob:${created.length - 1}`);
	urls.revokeObjectURL = (url) => void revoked.push(url);
	try {
		const { calls, fetchImpl } = server([
			new Response('one', { headers: { etag: '"v1"', 'content-type': 'image/png' } }),
			new Response(null, { status: 304 }),
			new Response('two', { headers: { etag: '"v2"', 'content-type': 'image/png' } }),
		]);
		const api = createApiClient({ baseUrl: BASE, tokens: tokens().source, fetchImpl });
		const first = await api.objectUrl('drawings/1/png');
		assert.equal(new Headers(calls[0]?.init.headers).get('if-none-match'), null);
		assert.equal(await api.objectUrl('drawings/1/png'), first, 'a 304 hands back the same object URL');
		assert.equal(new Headers(calls[1]?.init.headers).get('if-none-match'), '"v1"');
		assert.equal(created.length, 1);
		const changed = await api.objectUrl('drawings/1/png');
		assert.notEqual(changed, first);
		assert.deepEqual(revoked, [first], 'the replaced URL is released');
		assert.equal(new Headers(calls[2]?.init.headers).get('if-none-match'), '"v1"');
	} finally {
		urls.createObjectURL = original.create;
		urls.revokeObjectURL = original.revoke;
	}
});

test('storage keys carry the game and the child, so neither games nor children on one iPad share a value', () => {
	const kept = new Map<string, string>();
	const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } as unknown as Storage;
	const ada = portalUserId('00000000-0000-4000-8000-00000000000a');
	const ben = portalUserId('00000000-0000-4000-8000-00000000000b');
	const draw = createGameStorage(store, gameId('drawpad'), ada);
	draw.set('lastPicture', 'cat');
	assert.equal(draw.get('lastPicture'), 'cat');
	assert.equal(createGameStorage(store, gameId('drawpad'), ben).get('lastPicture'), null);
	assert.equal(createGameStorage(store, gameId('letterjoin'), ada).get('lastPicture'), null);
	assert.deepEqual([...kept.keys()], [`g4k:drawpad:${ada}:lastPicture`]);
	draw.remove('lastPicture');
	assert.equal(draw.get('lastPicture'), null);
});

test('storage that throws behaves as empty and a write is dropped', () => {
	const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } } as unknown as Storage;
	const storage = createGameStorage(broken, gameId('drawpad'), portalUserId('00000000-0000-4000-8000-00000000000a'));
	assert.doesNotThrow(() => (storage.set('a', 'b'), storage.remove('a')));
	assert.equal(storage.get('a'), null);
});

test('the games config has no admin field, and a missing or malformed one fails with its name', () => {
	const good = { authority: 'https://login.example/tenant', clientId: 'c', scope: 'api://c/access_as_user', portalApiOrigin: 'https://portal.example', telemetryConnectionString: '' };
	assert.deepEqual(parseGamesConfig({ ...good, consoleScope: 'api://admin/admin.console', adminApiOrigin: 'https://admin.example' }), good);
	assert.throws(() => parseGamesConfig({ ...good, scope: undefined }), /needs scope/);
	assert.throws(() => parseGamesConfig({ ...good, portalApiOrigin: 'nope' }), /portalApiOrigin must be a URL/);
	const admin = { authority: 'https://login.example/tenant', clientId: 'a', consoleScope: 'api://a/admin.console', elevateScope: 'api://a/admin.elevate', adminApiOrigin: 'https://admin.example', telemetryConnectionString: '' };
	assert.deepEqual(parseAdminConfig(admin), admin);
	assert.throws(() => parseAdminConfig({ ...admin, elevateScope: '' }), /needs elevateScope/);
});

test('catalogs keep valid entries and drop the rest, and the browser id rule equals the SDK rule', () => {
	assert.deepEqual(
		parseCatalog([
			{ id: 'drawpad', title: 'Draw Pad', summary: 'Draw.', icon: 'icon.svg', apiBaseUrl: 'https://func-drawpad.example' },
			{ id: 'Bad Id', title: 'x', summary: '', icon: '', apiBaseUrl: 'https://x.example' },
			{ id: 'nourl', title: 'x', summary: '', icon: '', apiBaseUrl: 'not a url' },
			'junk',
		]).map((entry) => entry.id),
		['drawpad'],
	);
	assert.deepEqual(parseAdminCatalog([{ id: 'drawpad', title: 'Draw Pad', hasAdmin: true }, { id: 'x', title: 'short', hasAdmin: true }, { id: 'letterjoin', title: 'L', hasAdmin: 'yes' }]).map((entry) => entry.id), ['drawpad']);
	assert.equal(BROWSER_GAME_ID.source, GAME_ID.source);
	assert.equal(asGameId('Drawpad'), null);
	assert.equal(asPortalUserId('not-a-guid'), null);
});

test('each refusal the host can send is either retried after a refresh or shown as a screen', () => {
	const expected: Record<Refusal, string> = { unauthenticated: 'retry-after-refresh', invalid_token: 'retry-after-refresh', not_invited: 'screen', no_profile: 'screen', not_entitled: 'screen' };
	for (const [code, handling] of Object.entries(expected)) assert.equal(onRefusal(code as Refusal), handling, code);
});

test('GET me and GET session are parsed at the boundary, and anything else is refused', () => {
	const id = '00000000-0000-4000-8000-00000000000a';
	assert.deepEqual(parseMe({ state: 'active', userId: id, profile: { displayName: 'Ada', timeZone: 'UTC' }, games: ['fixture', 'No Good'] }), { state: 'active', userId: id, profile: { displayName: 'Ada', timeZone: 'UTC' }, games: ['fixture'] });
	assert.deepEqual(parseMe({ state: 'no-profile' }), { state: 'no-profile' });
	assert.deepEqual(parseMe({ state: 'not-invited', email: 'kid@example.com' }), { state: 'not-invited', email: 'kid@example.com' });
	assert.equal(parseMe({ state: 'active', userId: 'x', profile: {}, games: [] }), null);
	assert.equal(parseMe({ state: 'admin' }), null);
	assert.equal(parseMe(null), null);
	assert.deepEqual(parseCaller({ userId: id, displayName: 'Ada', timeZone: 'UTC' }), { userId: id, profile: { displayName: 'Ada', timeZone: 'UTC' } });
	assert.equal(parseCaller({ displayName: 'Ada' }), null);
});

test('the welcome page returns only to a path on this site, never to another origin or to itself', () => {
	const origin = 'https://games.example';
	const cases: readonly (readonly [string | null, string])[] = [
		['/g/drawpad/?level=2#top', '/g/drawpad/?level=2#top'],
		['/', '/'],
		[null, '/'],
		['', '/'],
		['https://evil.example/', '/'],
		['//evil.example/', '/'],
		['/\\evil.example', '/'],
		['javascript:alert(1)', '/'],
		['/welcome/?return=/', '/'],
		['g/drawpad/', '/'],
	];
	for (const [raw, expected] of cases) assert.equal(safeReturn(raw, origin), expected, String(raw));
});

test('telemetry stamps game and user on every event, never an email, and sends nothing without a connection string', async () => {
	const target = parseConnectionString('InstrumentationKey=00000000-1111-4222-8333-444444444444;IngestionEndpoint=https://west.in.example');
	assert.deepEqual(target, { instrumentationKey: '00000000-1111-4222-8333-444444444444', endpoint: 'https://west.in.example/' });
	assert.equal(parseConnectionString(''), null);
	const user = portalUserId('00000000-0000-4000-8000-00000000000a');
	const sent: { url: string; body: string }[] = [];
	const fetchImpl: typeof fetch = async (input, init) => (sent.push({ url: String(input), body: String(init?.body) }), new Response(null, { status: 204 }));
	const telemetry = createTelemetry('InstrumentationKey=k;IngestionEndpoint=https://west.in.example/', { fetchImpl, page: () => 'https://games.example/g/drawpad/', now: () => new Date('2026-10-20T10:00:00Z') });
	telemetry.track({ name: 'page_view', site: 'games', game: gameId('drawpad'), user });
	const [envelope] = JSON.parse(sent[0]?.body ?? '[]');
	assert.equal(sent[0]?.url, 'https://west.in.example/v2/track');
	assert.equal(envelope.data.baseData.properties.game, 'drawpad');
	assert.equal(envelope.data.baseData.url, 'https://games.example/g/drawpad/');
	assert.equal(envelope.tags['ai.user.id'], user);
	assert.ok(!JSON.stringify(envelope).includes('@'));

	const silent = createTelemetry('', { fetchImpl });
	silent.track({ name: 'page_view', site: 'admin', game: 'portal', user: null });
	assert.equal(sent.length, 1);
	assert.equal(envelopeFor({ name: 'page_view', site: 'admin', game: 'portal', user: null }, target ?? assert.fail(), '/', new Date()).tags['ai.cloud.role'], 'g4k-admin-site');
});

test('a game_session beat goes out each minute only while the page is visible, and stops when asked', () => {
	const events: ShellEvent[] = [];
	let visible = true;
	let tick: () => void = () => {};
	let stopped = false;
	const stop = startGameSession(
		{ track: (event) => void events.push(event) },
		gameId('drawpad'),
		portalUserId('00000000-0000-4000-8000-00000000000a'),
		'session-1',
		{ interval: (run, ms) => ((tick = run), assert.equal(ms, BEAT_MS), () => void (stopped = true)), visible: () => visible },
	);
	tick();
	visible = false;
	tick();
	visible = true;
	tick();
	assert.deepEqual(events.map((event) => [event.name, event.name === 'game_session' ? event.sessionId : '']), [['game_session', 'session-1'], ['game_session', 'session-1']]);
	stop();
	assert.equal(stopped, true);
});

test('the members page reads rows defensively and describes each drift in plain words', () => {
	const rows = parseMembers([
		{ member: { userId: 'u1', state: 'active', games: { kind: 'some', ids: ['fixture'] } }, email: 'kid@example.com', objectId: null, profile: null },
		{ member: { userId: 'u2', state: 'revoked', games: { kind: 'some', ids: [] } }, email: 'old@example.com', objectId: 'o', profile: { displayName: 'Ben' } },
		{ member: { userId: 'u3', state: 'weird', games: { kind: 'some', ids: [] } }, email: 'bad@example.com' },
		{ member: { userId: 'u4', state: 'active', games: { kind: 'all' } }, email: 'owner@example.com', objectId: null, profile: null },
		{ member: { userId: 'u5', state: 'active', games: ['fixture'] }, email: 'list@example.com', objectId: null, profile: null },
		'junk',
	]);
	assert.deepEqual(rows.map((row) => [row.userId, row.state, row.linked, row.displayName]), [['u1', 'active', false, null], ['u2', 'revoked', true, 'Ben'], ['u4', 'active', false, null]]);
	assert.deepEqual(rows.map((row) => row.games), [{ kind: 'some', ids: ['fixture'] }, { kind: 'some', ids: [] }, { kind: 'all' }]);
	const lines = describeDrift(
		[
			{ kind: 'needs-account', userId: 'u1', email: 'kid@example.com' },
			{ kind: 'assigned-revoked', userId: 'u2' },
			{ kind: 'admin-app-grant', grant: { resourceDisplayName: 'Microsoft Graph' } },
			{ kind: 'surprise' },
		],
		rows,
	);
	assert.deepEqual(lines.map((line) => line.alarm), [false, false, true, true]);
	assert.match(lines[0]?.text ?? '', /kid@example\.com has no Entra account yet/);
	assert.match(lines[1]?.text ?? '', /old@example\.com is revoked but still assigned/);
	assert.match(lines[2]?.text ?? '', /Microsoft Graph/);
});
