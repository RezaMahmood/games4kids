import assert from 'node:assert/strict';
import { get } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startDevStack, type DevStack } from '../dev/stack.ts';
import { api, consoleToken, elevationToken, gamesToken } from './support/idp-client.ts';

/** fetch tidies dot segments away before sending, so a path-traversal attempt needs a raw request. */
const rawStatus = (origin: string, path: string) =>
	new Promise<number | undefined>((resolve, reject) => {
		const { hostname, port } = new URL(origin);
		get({ hostname, port, path }, (res) => (res.resume(), resolve(res.statusCode))).on('error', reject);
	});

/**
 * B2 without a browser: the same story the Playwright spec tells, through the HTTP APIs of the dev stack and its
 * fake IdP and Graph. Each step uses the real token checks, the real graphAs, and the real apps.
 */
describe('the dev stack tells the B2 story over HTTP', () => {
	let stack: DevStack;
	before(async () => void (stack = await startDevStack({ fixtures: true })));
	after(() => stack.close());

	const kidEmail = 'kid@example.com';
	let userId = '';
	let kid = '';

	test('saving a member needs only the console token, and a console token cannot sync', async () => {
		const console_ = await consoleToken(stack);
		const saved = await api(stack, 'POST', '/api/admin/portal/members', console_, { email: kidEmail, games: { kind: 'some', ids: ['fixture'] } });
		assert.equal(saved.status, 201);
		userId = (saved.data as { userId: string }).userId;
		const early = await api(stack, 'POST', '/api/admin/portal/entra/sync', console_, { userId });
		assert.equal(early.status, 401);
		assert.equal((early.data as { error: string }).error, 'step_up_required');
		assert.equal(stack.graph.calls.length, 0, 'Graph was not touched without an elevation');
	});

	test('a sync with a fresh sign-in invites the guest, assigns them, and a second sync changes nothing', async () => {
		const first = await api(stack, 'POST', '/api/admin/portal/entra/sync', await elevationToken(stack), { userId });
		assert.equal(first.status, 200);
		const person = stack.directory.byEmail(kidEmail);
		assert.ok(person?.guest, 'the child was invited as a guest');
		assert.deepEqual([...stack.graph.assignments.values()].map((a) => a.principalId), [person.id]);
		const writes = () => stack.graph.calls.filter((call) => call.method !== 'GET').length;
		const before = writes();
		assert.equal((await api(stack, 'POST', '/api/admin/portal/entra/sync', await elevationToken(stack), { userId })).status, 200);
		assert.equal(writes(), before);
		assert.ok(stack.idp.authorizations.filter((a) => a.scope.includes('admin.elevate')).every((a) => a.prompt === 'login'), 'every elevation forced credentials');
	});

	test('the child sees only the granted game after choosing a name', async () => {
		kid = await gamesToken(stack, kidEmail);
		assert.deepEqual((await api(stack, 'GET', '/api/portal/me', kid)).data, { state: 'no-profile' });
		assert.equal((await api(stack, 'PUT', '/api/portal/profile', kid, { displayName: 'Ada', timeZone: 'Europe/London' })).status, 204);
		assert.deepEqual((await api(stack, 'GET', '/api/portal/me', kid)).data, { state: 'active', userId, profile: { displayName: 'Ada', timeZone: 'Europe/London' }, games: [{ id: 'fixture', paused: false }] });
		assert.equal((await api(stack, 'GET', '/api/g/fixture/session', kid)).status, 200);
		const other = await api(stack, 'GET', '/api/g/puzzle/session', kid);
		assert.equal(other.status, 403);
		assert.equal((other.data as { error: string }).error, 'not_entitled');
	});

	test('a paused game stays on the child’s list but refuses play, and plays again once the admin makes it available', async () => {
		const console_ = await consoleToken(stack);
		const paused = await api(stack, 'PUT', '/api/admin/portal/games/fixture', console_, { paused: true });
		assert.deepEqual(paused.data, { id: 'fixture', paused: true });
		const refused = await api(stack, 'GET', '/api/g/fixture/session', kid);
		assert.equal(refused.status, 403);
		assert.equal((refused.data as { error: string }).error, 'game_paused');
		assert.deepEqual(((await api(stack, 'GET', '/api/portal/me', kid)).data as { games: unknown }).games, [{ id: 'fixture', paused: true }]);
		const ungranted = await api(stack, 'PUT', '/api/admin/portal/games/puzzle', console_, { paused: true });
		assert.equal(ungranted.status, 200);
		assert.equal(((await api(stack, 'GET', '/api/g/puzzle/session', kid)).data as { error: string }).error, 'not_entitled', 'a paused game not granted stays not entitled');
		assert.deepEqual((await api(stack, 'GET', '/api/admin/portal/games', console_)).data, [
			{ id: 'fixture', paused: true },
			{ id: 'puzzle', paused: true },
		]);

		assert.equal((await api(stack, 'PUT', '/api/admin/portal/games/fixture', console_, { paused: false })).status, 200);
		assert.equal((await api(stack, 'PUT', '/api/admin/portal/games/puzzle', console_, { paused: false })).status, 200);
		assert.equal((await api(stack, 'GET', '/api/g/fixture/session', kid)).status, 200);
		assert.deepEqual(((await api(stack, 'GET', '/api/portal/me', kid)).data as { games: unknown }).games, [{ id: 'fixture', paused: false }]);
	});

	test('a games token cannot list or pause games on the admin app', async () => {
		assert.equal((await api(stack, 'GET', '/api/admin/portal/games', kid)).status, 401);
		assert.equal((await api(stack, 'PUT', '/api/admin/portal/games/fixture', kid, { paused: true })).status, 401);
		assert.equal((await api(stack, 'GET', '/api/g/fixture/session', kid)).status, 200, 'nothing was paused');
	});

	test('a games token is no admin token, and an admin token is no games token', async () => {
		assert.equal((await api(stack, 'GET', '/api/admin/portal/members', kid)).status, 401);
		assert.equal((await api(stack, 'GET', '/api/portal/me', await consoleToken(stack))).status, 401);
	});

	test('a sign-in 11 minutes old is a step-up, and a fresh one then works', async () => {
		stack.idp.controls.staleAuthTime = { minutes: 11, count: 1 };
		const stale = await api(stack, 'GET', '/api/admin/portal/entra', await elevationToken(stack));
		assert.equal(stale.status, 401);
		assert.equal((stale.data as { error: string }).error, 'step_up_required');
		assert.match(stale.headers.get('www-authenticate') ?? '', /insufficient_user_authentication.*max_age="600"/);
		assert.equal((await api(stack, 'GET', '/api/admin/portal/entra', await elevationToken(stack))).status, 200);
	});

	test('a claims challenge from the OBO exchange reaches the page in the body', async () => {
		stack.idp.controls.oboClaims = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
		const challenged = await api(stack, 'GET', '/api/admin/portal/entra', await elevationToken(stack));
		assert.equal(challenged.status, 401);
		assert.deepEqual(challenged.data, { error: 'insufficient_claims', message: 'Sign in again to continue.', claims: '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}' });
	});

	test('a revoke is refused on the next call, and a sync then removes the assignment', async () => {
		const console_ = await consoleToken(stack);
		assert.equal((await api(stack, 'PUT', `/api/admin/portal/members/${userId}`, console_, { state: 'revoked', games: { kind: 'some', ids: ['fixture'] } })).status, 200);
		const refused = await api(stack, 'GET', '/api/g/fixture/levels', kid);
		assert.equal(refused.status, 403);
		assert.equal((refused.data as { error: string }).error, 'not_invited');
		assert.equal((await api(stack, 'POST', '/api/admin/portal/entra/sync', await elevationToken(stack), { userId })).status, 200);
		assert.equal(stack.graph.assignments.size, 0);
	});

	test('the two sites are two origins with their own config, and the games config holds no admin field', async () => {
		assert.notEqual(stack.gamesOrigin, stack.adminOrigin);
		const games = await (await fetch(`${stack.gamesOrigin}/config.json`)).json();
		assert.deepEqual(Object.keys(games).sort(), ['authority', 'clientId', 'portalApiOrigin', 'scope', 'telemetryConnectionString']);
		const admin = await (await fetch(`${stack.adminOrigin}/config.json`)).json();
		assert.deepEqual(Object.keys(admin).sort(), ['adminApiOrigin', 'authority', 'clientId', 'consoleScope', 'elevateScope', 'telemetryConnectionString']);
		assert.notEqual(games.clientId, admin.clientId);
	});

	test('each site is served with its CSP, and the games site can reach no admin origin', async () => {
		const home = await fetch(`${stack.gamesOrigin}/`);
		const csp = home.headers.get('content-security-policy') ?? '';
		assert.match(csp, /script-src 'self'(;|$)/);
		assert.match(csp, /frame-ancestors 'none'/);
		assert.ok(csp.includes(`connect-src 'self' ${stack.apiOrigin}`));
		assert.ok(!csp.includes(stack.adminOrigin));
		assert.match((await fetch(`${stack.gamesOrigin}/redirect.html`)).headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
		const own = (await fetch(`${stack.gamesOrigin}/g/fixture/`)).headers.get('content-security-policy') ?? '';
		assert.match(own, /img-src 'self' data: blob: https:\/\/cdn\.example;/, 'a game widens the policy of its own pages');
		assert.ok(!(await fetch(`${stack.gamesOrigin}/g/puzzle/`)).headers.get('content-security-policy')?.includes('cdn.example'), 'and of no other game');
		assert.match((await fetch(`${stack.adminOrigin}/g/fixture/`)).headers.get('content-security-policy') ?? '', /worker-src 'self' blob:/);
		const members = await fetch(`${stack.adminOrigin}/`);
		assert.ok((members.headers.get('content-security-policy') ?? '').includes(`connect-src 'self' ${stack.apiOrigin}`));
		for (const path of ['/shell/v1/index.js', '/shared/api-client.js', '/shared/vendor/msal-browser.min.js', '/shared/tokens.css', '/home.js', '/welcome/', '/profile/', '/profile.js', '/g/fixture/', '/g/puzzle/icon.svg']) {
			assert.equal((await fetch(`${stack.gamesOrigin}${path}`)).status, 200, path);
		}
		for (const path of ['/shell/v1/index.js', '/members.js', '/games/', '/games.js', '/g/fixture/']) assert.equal((await fetch(`${stack.adminOrigin}${path}`)).status, 200, path);
		assert.equal((await fetch(`${stack.gamesOrigin}/members.js`)).status, 404, 'the games site serves none of the admin pages');
		for (const path of ['/../../package.json', '/shared/..%2f..%2f..%2fpackage.json', '/g/fixture/../../../package.json']) assert.equal(await rawStatus(stack.gamesOrigin, path), 404, path);
	});

	test('the apps reported no unexpected error', () => {
		assert.deepEqual(stack.exceptions, []);
	});
});
