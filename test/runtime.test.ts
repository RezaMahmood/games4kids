import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminModule } from '@g4k/host';
import { adminAppFromEnv, playerAppFromEnv, portalAppFromEnv } from '@g4k/host/runtime';
import { createAdminApi } from './fixtures/games/fixture/admin/api/index.ts';
import fixture from './fixtures/games/fixture/manifest.ts';
import { createPlayApi } from './fixtures/games/fixture/play/api/index.ts';
import { call, codeOf } from './support/http.ts';
import { gameId } from './support/ids.ts';

const credential = { getToken: async () => ({ token: 'managed-identity-token', expiresOnTimestamp: Date.now() + 3_600_000 }) };
const TENANT = '11111111-2222-4333-8444-555555555555';
const EMULATOR = 'UseDevelopmentStorage=true';

test('an app with missing settings fails at startup naming every one of them', () => {
	assert.throws(() => playerAppFromEnv(fixture, createPlayApi, {}, credential), /missing app settings: TENANT_ID, GAMES_CLIENT_ID$/);
	assert.throws(() => portalAppFromEnv({ TENANT_ID: TENANT, GAMES_CLIENT_ID: 'x' }, credential), /missing app settings: STORAGE_SUFFIX$/);
	assert.throws(() => adminAppFromEnv([], [], { AZURITE_CONNECTION_STRING: EMULATOR }, credential), /missing app settings: TENANT_ID, ADMIN_CLIENT_ID, GAMES_PRINCIPAL_ID, ADMIN_PRINCIPAL_ID, GAMES_ORIGIN$/);
});

test('a player app built from settings serves its prefix and checks tokens', async () => {
	const app = playerAppFromEnv(fixture, createPlayApi, { TENANT_ID: TENANT, GAMES_CLIENT_ID: 'games-client', AZURITE_CONNECTION_STRING: EMULATOR }, credential);
	assert.equal(app.prefix, '/api/g/fixture/');
	assert.equal((await call(app, 'GET', '/api/g/fixture/health')).status, 200);
	assert.equal(codeOf(await call(app, 'GET', '/api/g/fixture/session')), 'unauthenticated');
});

test('the portal app and the admin app are built from settings too, and refuse a request with no token', async () => {
	const base = { TENANT_ID: TENANT, AZURITE_CONNECTION_STRING: EMULATOR };
	const portal = portalAppFromEnv({ ...base, GAMES_CLIENT_ID: 'games-client' }, credential);
	assert.equal(codeOf(await call(portal, 'GET', '/api/portal/me')), 'unauthenticated');
	const admin = adminAppFromEnv(
		[gameId('fixture')],
		[adminModule(fixture, createAdminApi)],
		{ ...base, ADMIN_CLIENT_ID: 'admin-client', GAMES_PRINCIPAL_ID: 'games-sp', ADMIN_PRINCIPAL_ID: 'admin-sp', GAMES_ORIGIN: 'https://games.example' },
		credential,
	);
	assert.equal(codeOf(await call(admin, 'GET', '/api/admin/portal/members')), 'unauthenticated');
	assert.ok(admin.functions.some((fn) => fn.name === 'fixture-putLevel'));
});
