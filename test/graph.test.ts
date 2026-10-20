import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmail, type Email } from '@g4k/sdk';
import {
	ASSIGN_RETRY_MS,
	elevate,
	EntraRefused,
	graphAs,
	openAdminSession,
	syncEntra,
	verifyAdminToken,
	type Elevation,
	type GraphConfig,
} from '@g4k/host';
import { FAKE_GRAPH_TOKEN_PREFIX, createFakeGraph } from '../dev/fake-graph.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, world as portalWorld } from './support/world.ts';

const idp = await fakeIdp();
const GAMES_SP = newObjectId();
const ADMIN_SP = newObjectId();
const CLIENT = 'aaaaaaaa-0000-4000-8000-000000000002';
const TENANT = '11111111-2222-4333-8444-555555555555';

function email(raw: string): Email {
	const parsed = parseEmail(raw);
	assert.ok(parsed);
	return parsed;
}

async function elevation(authTime: Date = NOW): Promise<{ readonly elevation: Elevation; readonly token: string; readonly oid: string }> {
	const w = portalWorld();
	const oid = newObjectId();
	await seedAdmin(w, oid);
	const token = await idp.adminToken(oid, { scp: 'admin.elevate', authTime });
	const auth = await verifyAdminToken(idp.admin, `Bearer ${token}`);
	assert.ok(auth.ok);
	const session = await openAdminSession(auth.token, w.admin);
	assert.notEqual(session, 'forbidden');
	if (session === 'forbidden') throw new Error('unreachable');
	const result = elevate(session, authTime);
	assert.ok(!('kind' in result));
	return { elevation: result, token, oid };
}

type TokenCall = { readonly form: URLSearchParams };

/** Entra's token endpoint and Graph in one injected fetch: the token endpoint answers only a correct OBO grant. */
function entra(options: { readonly pageSize?: number; readonly tokenReply?: (call: TokenCall) => Response | undefined; readonly graphReply?: (url: URL) => Response | undefined } = {}) {
	const graph = createFakeGraph({ gamesPrincipalId: GAMES_SP, adminPrincipalId: ADMIN_SP, ...(options.pageSize ? { pageSize: options.pageSize } : {}) });
	const tokenCalls: TokenCall[] = [];
	const sleeps: number[] = [];
	const logs: { readonly level: string; readonly line: string }[] = [];
	const config = (assertion = 'federated-credential'): { readonly config: GraphConfig; readonly assertion: () => Promise<string> } => ({
		assertion: async () => assertion,
		config: {
			tenantId: TENANT,
			clientId: CLIENT,
			gamesPrincipalId: GAMES_SP,
			adminPrincipalId: ADMIN_SP,
			sleep: async (ms) => void sleeps.push(ms),
			log: (level, line) => void logs.push({ level, line }),
			fetch: async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.hostname !== 'login.microsoftonline.com') return options.graphReply?.(url) ?? graph.handle(input, init);
				assert.equal(url.pathname, `/${TENANT}/oauth2/v2.0/token`);
				const form = new URLSearchParams(String(init?.body));
				tokenCalls.push({ form });
				return options.tokenReply?.({ form }) ?? Response.json({ token_type: 'Bearer', access_token: `${FAKE_GRAPH_TOKEN_PREFIX}${form.get('assertion')?.length}` });
			},
		},
	});
	return { graph, tokenCalls, sleeps, logs, config };
}

test('graphAs exchanges the elevated token as an OBO grant for Graph with the federated client assertion', async () => {
	const world = entra();
	const { elevation: e, token } = await elevation();
	const { config, assertion } = world.config('id-g4k-admin-token');
	await graphAs(e, assertion, config).findUser(email('nobody@example.com'));
	const [call] = world.tokenCalls;
	assert.deepEqual(Object.fromEntries(call?.form ?? []), {
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		client_id: CLIENT,
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: 'id-g4k-admin-token',
		assertion: token,
		scope: 'https://graph.microsoft.com/.default',
		requested_token_use: 'on_behalf_of',
	});
});

test('graphAs exchanges once per instance and never shares a Graph token between instances', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const first = graphAs(e, assertion, config);
	await first.findUser(email('a@example.com'));
	await first.assignments();
	await first.adminAppGrants();
	assert.equal(world.tokenCalls.length, 1);
	await graphAs(e, assertion, config).assignments();
	assert.equal(world.tokenCalls.length, 2);
});

test('findUser matches mail, otherMails and the userPrincipalName, and answers null for a stranger', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const mail = world.graph.directory.add({ mail: 'ada@example.com', guest: true });
	const other = world.graph.directory.add({ mail: 'primary@corp.example', otherMails: ['ben@home.example'], guest: false });
	const upnOnly = world.graph.directory.add({ mail: '', upn: 'cy@tenant.example', guest: false });
	const graph = graphAs(e, assertion, config);
	assert.equal(await graph.findUser(email('ada@example.com')), mail.id);
	assert.equal(await graph.findUser(email('ben@home.example')), other.id);
	assert.equal(await graph.findUser(email('cy@tenant.example')), upnOnly.id);
	assert.equal(await graph.findUser(email('stranger@example.com')), null);
});

const RIZ_GUEST = { id: 'c2bb6fcc-0000-4000-8000-000000000001', mail: null, otherMails: ['riz74@hotmail.com'], userPrincipalName: 'riz74_hotmail.com#EXT#@riz74hotmail.onmicrosoft.com', userType: 'Guest' };
const REZA_MEMBER = { id: '716328f1-0000-4000-8000-000000000002', mail: 'reza@rezamahmood.net', otherMails: ['riz74@hotmail.com'], userPrincipalName: 'reza@rezamahmood.net', userType: 'Member' };

test('findUser resolves riz74@hotmail.com to the guest it signs in as, not the member that lists it in otherMails', async () => {
	const world = entra({ graphReply: (url) => (url.pathname === '/v1.0/users' ? Response.json({ value: [REZA_MEMBER, RIZ_GUEST] }) : undefined) });
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	assert.equal(await graphAs(e, assertion, config).findUser(email('riz74@hotmail.com')), RIZ_GUEST.id);
});

test('findUser escapes an apostrophe in the address so it cannot widen the filter', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const person = world.graph.directory.add({ mail: "o'brien@example.com", guest: true });
	world.graph.directory.add({ mail: 'other@example.com', guest: true });
	const graph = graphAs(e, assertion, config);
	assert.equal(await graph.findUser(email("o'brien@example.com")), person.id);
	assert.equal(await graph.findUser(email("x'-or-'a@example.com")), null);
});

test('inviteGuest returns the new guest, who findUser then finds', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const graph = graphAs(e, assertion, config);
	const invited = await graph.inviteGuest(email('new@example.com'), 'https://games.example/');
	assert.equal(await graph.findUser(email('new@example.com')), invited);
});

test('assignments lists only users and follows every page', async () => {
	const world = entra({ pageSize: 2 });
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const graph = graphAs(e, assertion, config);
	const people = [1, 2, 3, 4, 5].map((n) => world.graph.directory.add({ mail: `p${n}@example.com`, guest: true }));
	for (const person of people) await graph.assign(person.id);
	world.graph.assignments.set('group', { id: 'group', principalId: newObjectId(), principalType: 'Group' as 'User', appRoleId: '' });
	const listed = await graph.assignments();
	assert.deepEqual(listed.map((a) => a.objectId).sort(), people.map((p) => p.id).sort());
});

test('assign twice is one assignment, and unassign of a missing one is done', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const graph = graphAs(e, assertion, config);
	const person = world.graph.directory.add({ mail: 'a@example.com', guest: true });
	await graph.assign(person.id);
	await graph.assign(person.id);
	const [only, ...rest] = await graph.assignments();
	assert.ok(only);
	assert.equal(rest.length, 0);
	await graph.unassign(only);
	await graph.unassign(only);
	assert.deepEqual(await graph.assignments(), []);
});

test('assign waits 2, 4 and 8 seconds for a new guest to replicate, then succeeds', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const person = world.graph.directory.add({ mail: 'a@example.com', guest: true });
	world.graph.controls.replicationMisses = 3;
	await graphAs(e, assertion, config).assign(person.id);
	assert.deepEqual(world.sleeps, [2000, 4000, 8000]);
	assert.equal(world.graph.assignments.size, 1);
});

test('assign gives up with a 502 after the last retry', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const person = world.graph.directory.add({ mail: 'a@example.com', guest: true });
	world.graph.controls.replicationMisses = 99;
	await assert.rejects(graphAs(e, assertion, config).assign(person.id), { status: 502, code: 'entra_unavailable' });
	assert.deepEqual(world.sleeps, ASSIGN_RETRY_MS);
});

test('adminAppGrants lists what the admin app holds', async () => {
	const world = entra();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	world.graph.grants.push({ resourceDisplayName: 'Microsoft Graph', appRoleId: 'role-1' });
	assert.deepEqual(await graphAs(e, assertion, config).adminAppGrants(), [{ resourceDisplayName: 'Microsoft Graph', appRoleId: 'role-1' }]);
});

test('an interaction_required answer with claims becomes a claims challenge carrying them', async () => {
	const claims = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
	const world = entra({ tokenReply: () => Response.json({ error: 'interaction_required', suberror: 'basic_action', claims }, { status: 400 }) });
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	await assert.rejects(graphAs(e, assertion, config).assignments(), (error) => error instanceof EntraRefused && error.refusal.kind === 'claims_challenge' && error.refusal.claims === claims);
});

test('a refused grant or a Graph 403 is entra_forbidden naming the call', async () => {
	const refusedGrant = entra({ tokenReply: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
	const { elevation: e } = await elevation();
	await assert.rejects(
		graphAs(e, refusedGrant.config().assertion, refusedGrant.config().config).adminAppGrants(),
		(error) => error instanceof EntraRefused && error.refusal.kind === 'entra_forbidden' && error.refusal.call === 'list-admin-grants',
	);

	const forbidden = entra();
	const person = forbidden.graph.directory.add({ mail: 'a@example.com', guest: true });
	forbidden.graph.controls.refuseWrites = 403;
	await assert.rejects(
		graphAs(e, forbidden.config().assertion, forbidden.config().config).assign(person.id),
		(error) => error instanceof EntraRefused && error.refusal.kind === 'entra_forbidden' && error.refusal.call === 'assign',
	);
});

test('a Graph 403 on find-user is still entra_forbidden and the log line carries Graph\'s error code and message', async () => {
	const world = entra({
		graphReply: () => Response.json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, { status: 403 }),
	});
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	await assert.rejects(graphAs(e, assertion, config).findUser(email('riz74@hotmail.com')), (error) => error instanceof EntraRefused && error.refusal.kind === 'entra_forbidden' && error.refusal.call === 'find-user');
	assert.equal(world.logs.length, 1);
	assert.equal(world.logs[0]?.level, 'warn');
	assert.match(world.logs[0]?.line ?? '', /find-user.*403.*Authorization_RequestDenied.*Insufficient privileges/);
	assert.doesNotMatch(world.logs[0]?.line ?? '', new RegExp(FAKE_GRAPH_TOKEN_PREFIX));
});

test('a refused grant logs the token endpoint error and its AADSTS codes, never the assertion', async () => {
	const world = entra({ tokenReply: () => Response.json({ error: 'invalid_grant', error_codes: [50013], error_description: 'AADSTS50013: assertion failed' }, { status: 400 }) });
	const { elevation: e, token } = await elevation();
	const { config, assertion } = world.config('federated-secret-value');
	await assert.rejects(graphAs(e, assertion, config).findUser(email('a@example.com')), (error) => error instanceof EntraRefused && error.refusal.kind === 'entra_forbidden' && error.refusal.call === 'find-user');
	assert.equal(world.logs.length, 1);
	assert.match(world.logs[0]?.line ?? '', /find-user.*400.*invalid_grant.*AADSTS50013/);
	assert.equal(world.logs[0]?.line.includes('federated-secret-value') || world.logs[0]?.line.includes(token), false);
});

test('a token endpoint outage is a 502, not a refusal', async () => {
	const world = entra({ tokenReply: () => new Response('down', { status: 503 }) });
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	await assert.rejects(graphAs(e, assertion, config).assignments(), { status: 502 });
});

test('syncEntra over graphAs invites, assigns, and a second run makes no write', async () => {
	const world = entra();
	const w = portalWorld();
	const { elevation: e } = await elevation();
	const { config, assertion } = world.config();
	const kid = email('kid@example.com');
	const userId = await w.admin.userIdFor(kid);
	await w.admin.putMember({ userId, state: 'active', games: { kind: 'some', ids: [gameId('fixture')] } });
	const graph = graphAs(e, assertion, config);
	await syncEntra(graph, w.admin, null, 'https://games.example/');
	const invited = world.graph.directory.byEmail('kid@example.com');
	assert.ok(invited);
	assert.deepEqual([...world.graph.assignments.values()].map((a) => a.principalId), [invited.id]);
	const writes = () => world.graph.calls.filter((call) => call.method !== 'GET').length;
	const before = writes();
	await syncEntra(graph, w.admin, null, 'https://games.example/');
	assert.equal(writes(), before);
});
