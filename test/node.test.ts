import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveWithNode } from '@g4k/host/node';
import { fixtureApps } from './support/apps.ts';
import { PNG } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world } from './support/world.ts';

const idp = await fakeIdp();
const GAMES_ORIGIN = 'http://localhost:4280';

async function served() {
	const w = world();
	const { player, portal, admin } = fixtureApps(w, idp);
	const server = await serveWithNode([player, portal, admin], { port: 0, allowedOrigins: [GAMES_ORIGIN] });
	const kid = await seedPlayer(w, idp, { games: [gameId('fixture')], profile: { displayName: 'Ada', timeZone: 'UTC' } });
	return { w, server, kid };
}

test('one node server answers every app on its own prefix with the real token checks', async () => {
	const { server, kid } = await served();
	try {
		const bearer = { authorization: `Bearer ${kid.token}` };
		assert.equal((await fetch(`${server.origin}/api/g/fixture/session`, { headers: bearer })).status, 200);
		assert.deepEqual(await (await fetch(`${server.origin}/api/portal/me`, { headers: bearer })).json(), {
			state: 'active',
			userId: kid.userId,
			profile: { displayName: 'Ada', timeZone: 'UTC' },
			games: ['fixture'],
		});
		assert.equal((await fetch(`${server.origin}/api/g/fixture/session`)).status, 401);
		assert.equal((await fetch(`${server.origin}/api/admin/portal/members`, { headers: bearer })).status, 401, 'a games token is no admin token');
		assert.equal((await fetch(`${server.origin}/api/nothing/here`)).status, 404);
	} finally {
		await server.close();
	}
});

test('CORS is the exact allowed origin and nothing else, preflight included', async () => {
	const { server } = await served();
	try {
		const url = `${server.origin}/api/g/fixture/health`;
		const allowed = await fetch(url, { headers: { origin: GAMES_ORIGIN } });
		assert.equal(allowed.headers.get('access-control-allow-origin'), GAMES_ORIGIN);
		assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /etag/);
		assert.equal((await fetch(url, { headers: { origin: 'http://localhost:4281' } })).headers.get('access-control-allow-origin'), null);
		assert.equal((await fetch(url)).headers.get('access-control-allow-origin'), null);

		const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: GAMES_ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get('access-control-allow-origin'), GAMES_ORIGIN);
		assert.equal(preflight.headers.get('access-control-allow-methods'), 'PUT');
		const refused = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'PUT' } });
		assert.equal(refused.headers.get('access-control-allow-origin'), null);
	} finally {
		await server.close();
	}
});

test('a body past the cap is a 413 whether the length is declared or streamed, and a PNG upload passes', async () => {
	const { server, kid } = await served();
	try {
		const headers = { authorization: `Bearer ${kid.token}`, 'content-type': 'application/json' };
		const big = JSON.stringify({ points: 1, pad: 'x'.repeat(300 * 1024) });
		const declared = await fetch(`${server.origin}/api/g/fixture/scores/one`, { method: 'PUT', headers, body: big });
		assert.equal(declared.status, 413);
		const streamed = await fetch(`${server.origin}/api/g/fixture/scores/one`, {
			method: 'PUT',
			headers,
			body: new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode(big)), controller.close()) }),
			duplex: 'half',
		} as RequestInit);
		assert.equal(streamed.status, 413);
		const upload = await fetch(`${server.origin}/api/g/fixture/uploads`, { method: 'POST', headers: { authorization: `Bearer ${kid.token}`, 'content-type': 'image/png' }, body: PNG });
		assert.equal(upload.status, 201);
	} finally {
		await server.close();
	}
});

test('an admin request reaches the admin app and a step-up carries its challenge header', async () => {
	const { w, server } = await served();
	try {
		const oid = newObjectId();
		await seedAdmin(w, oid);
		const members = await fetch(`${server.origin}/api/admin/portal/members`, { headers: { authorization: `Bearer ${await idp.adminToken(oid)}` } });
		assert.equal(members.status, 200);
		const stale = await fetch(`${server.origin}/api/admin/portal/entra`, {
			headers: { authorization: `Bearer ${await idp.adminToken(oid, { scp: 'admin.elevate', authTime: new Date(NOW.getTime() - 11 * 60_000) })}`, origin: GAMES_ORIGIN },
		});
		assert.equal(stale.status, 401);
		assert.match(stale.headers.get('www-authenticate') ?? '', /insufficient_user_authentication.*max_age="600"/);
	} finally {
		await server.close();
	}
});
