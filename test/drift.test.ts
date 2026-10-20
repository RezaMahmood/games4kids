import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmail, type Email, type EntraObjectId } from '@g4k/sdk';
import { computeDrift, ENTRA, parseAssignmentId, syncEntra, type Assignment, type Drift, type Member, type MemberView, type UserLookup } from '@g4k/host';
import { fakeGraph } from './support/graph.ts';
import { gameId, portalUserId } from './support/ids.ts';
import { newObjectId, world } from './support/world.ts';

function email(raw: string): Email {
	const parsed = parseEmail(raw);
	assert.ok(parsed);
	return parsed;
}

function assignment(objectId: EntraObjectId): Assignment {
	const assignmentId = parseAssignmentId(`assignment-${objectId}`);
	assert.ok(assignmentId);
	return { objectId, assignmentId };
}

const ada = portalUserId('00000000-0000-4000-8000-00000000000a');
const ben = portalUserId('00000000-0000-4000-8000-00000000000b');
const adaOid = newObjectId();
const benOid = newObjectId();
const signedInAdminOid = newObjectId();
const bootstrapAdminOid = newObjectId();

const view = (userId: typeof ada, state: Member['state'], objectId: EntraObjectId | null): MemberView => ({
	member: { userId, state, games: { kind: 'some', ids: [gameId('fixture')] } },
	email: email(`${userId.slice(-1)}@example.com`),
	objectId,
	profile: null,
});

const found = (objectId: EntraObjectId): UserLookup => ({ kind: 'found', objectId });
const otherOid = newObjectId();

const grant = { resourceDisplayName: 'Microsoft Graph', appRoleId: '1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9' };

const cases: readonly {
	readonly name: string;
	readonly assignments: readonly Assignment[];
	readonly rows: readonly MemberView[];
	readonly lookups?: readonly (readonly [typeof ada, UserLookup])[];
	readonly grants?: readonly (typeof grant)[];
	readonly expected: readonly Drift[];
}[] = [
	{ name: 'nothing anywhere', assignments: [], rows: [], expected: [] },
	{ name: 'active member with no account yet', assignments: [], rows: [view(ada, 'active', null)], expected: [{ kind: 'needs-account', userId: ada, email: email('a@example.com'), account: null }] },
	{ name: 'active member whose email finds an existing account', assignments: [], rows: [view(ada, 'active', null)], lookups: [[ada, found(adaOid)]], expected: [{ kind: 'needs-account', userId: ada, email: email('a@example.com'), account: adaOid }] },
	{ name: 'active member linked to the account their email finds', assignments: [assignment(adaOid)], rows: [view(ada, 'active', adaOid)], lookups: [[ada, found(adaOid)]], expected: [] },
	{
		name: 'active member linked to another account than their email finds',
		assignments: [assignment(adaOid)],
		rows: [view(ada, 'active', adaOid)],
		lookups: [[ada, found(otherOid)]],
		expected: [{ kind: 'wrong-account', userId: ada, email: email('a@example.com'), linked: adaOid, account: otherOid, assignment: assignment(adaOid) }],
	},
	{
		name: 'a wrongly linked member whose old account is not assigned',
		assignments: [],
		rows: [view(ada, 'active', adaOid)],
		lookups: [[ada, found(otherOid)]],
		expected: [{ kind: 'wrong-account', userId: ada, email: email('a@example.com'), linked: adaOid, account: otherOid, assignment: null }],
	},
	{
		name: 'an email with two matching accounts changes nothing, linked or not',
		assignments: [assignment(adaOid)],
		rows: [view(ada, 'active', adaOid), view(ben, 'active', null)],
		lookups: [
			[ada, { kind: 'ambiguous', userPrincipalNames: ['a1@example.com', 'a2@example.com'] }],
			[ben, { kind: 'ambiguous', userPrincipalNames: ['b1@example.com', 'b2@example.com'] }],
		],
		expected: [
			{ kind: 'ambiguous-account', userId: ada, email: email('a@example.com'), userPrincipalNames: ['a1@example.com', 'a2@example.com'] },
			{ kind: 'ambiguous-account', userId: ben, email: email('b@example.com'), userPrincipalNames: ['b1@example.com', 'b2@example.com'] },
		],
	},
	{
		name: 'an email that finds another member\'s sign-in is reported and never linked',
		assignments: [assignment(adaOid), assignment(benOid)],
		rows: [view(ada, 'revoked', adaOid), view(ben, 'active', benOid)],
		lookups: [[ben, found(adaOid)]],
		expected: [
			{ kind: 'assigned-revoked', userId: ada, assignment: assignment(adaOid) },
			{ kind: 'account-taken', userId: ben, email: email('b@example.com'), account: adaOid, owner: ada },
		],
	},
	{ name: 'active member assigned', assignments: [assignment(adaOid)], rows: [view(ada, 'active', adaOid)], expected: [] },
	{ name: 'active member Entra does not admit', assignments: [], rows: [view(ada, 'active', adaOid)], expected: [{ kind: 'not-assigned', userId: ada, objectId: adaOid }] },
	{ name: 'revoked member still assigned', assignments: [assignment(adaOid)], rows: [view(ada, 'revoked', adaOid)], expected: [{ kind: 'assigned-revoked', userId: ada, assignment: assignment(adaOid) }] },
	{ name: 'revoked member already unassigned', assignments: [], rows: [view(ada, 'revoked', adaOid)], expected: [] },
	{ name: 'revoked member who never had an account', assignments: [], rows: [view(ada, 'revoked', null)], expected: [] },
	{
		name: 'a bootstrap admin assignment with no identity row is unmanaged and never unassigned',
		assignments: [assignment(bootstrapAdminOid)],
		rows: [],
		expected: [{ kind: 'unmanaged', assignment: assignment(bootstrapAdminOid) }],
	},
	{
		name: 'the signed-in admin stays assigned while a revoked member beside them is unassigned',
		assignments: [assignment(signedInAdminOid), assignment(benOid)],
		rows: [view(ben, 'revoked', benOid)],
		expected: [
			{ kind: 'assigned-revoked', userId: ben, assignment: assignment(benOid) },
			{ kind: 'unmanaged', assignment: assignment(signedInAdminOid) },
		],
	},
	{
		name: 'every admin assignment is unmanaged even when every member is revoked',
		assignments: [assignment(signedInAdminOid), assignment(bootstrapAdminOid)],
		rows: [view(ada, 'revoked', adaOid), view(ben, 'revoked', null)],
		expected: [
			{ kind: 'unmanaged', assignment: assignment(signedInAdminOid) },
			{ kind: 'unmanaged', assignment: assignment(bootstrapAdminOid) },
		],
	},
	{ name: 'an app role held by the admin app is an alarm', assignments: [], rows: [], grants: [grant], expected: [{ kind: 'admin-app-grant', grant }] },
];

for (const { name, assignments, rows, lookups = [], grants = [], expected } of cases) {
	test(`computeDrift: ${name}`, () => {
		assert.deepEqual(computeDrift(assignments, grants, rows, new Map(lookups)), expected);
	});
}

async function family() {
	const w = world();
	const entra = fakeGraph();
	const fixture = gameId('fixture');
	const newKid = await w.admin.userIdFor(email('new@example.com'));
	await w.admin.putMember({ userId: newKid, state: 'active', games: { kind: 'some', ids: [fixture] } });
	const existingGuest = await w.admin.userIdFor(email('guest@example.com'));
	await w.admin.putMember({ userId: existingGuest, state: 'active', games: { kind: 'all' } });
	const guestOid = newObjectId();
	entra.users.set(email('guest@example.com'), guestOid);
	const leaver = await w.admin.userIdFor(email('leaver@example.com'));
	const leaverOid = newObjectId();
	await w.admin.recordIdentity(leaverOid, leaver);
	await w.admin.putMember({ userId: leaver, state: 'revoked', games: { kind: 'some', ids: [fixture] } });
	await entra.assign(leaverOid);
	await entra.assign(bootstrapAdminOid);
	return { w, entra, newKid, existingGuest, guestOid, leaver, leaverOid };
}

test('syncEntra invites only a new person, finds an existing guest, unassigns a revoked member, and leaves the bootstrap admin alone', async () => {
	const { w, entra, guestOid, leaverOid } = await family();
	const drift = await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	assert.deepEqual(drift, [{ kind: 'unmanaged', assignment: entra.assignments.get(bootstrapAdminOid) }]);
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 1);
	assert.ok(entra.assignments.has(guestOid));
	assert.ok(!entra.assignments.has(leaverOid));
	assert.ok(entra.assignments.has(bootstrapAdminOid));
	assert.equal(entra.assignments.size, 3);
});

test('a second syncEntra run changes nothing in Entra', async () => {
	const { w, entra } = await family();
	await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	const before = entra.writes().length;
	const drift = await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	assert.equal(entra.writes().length, before);
	assert.deepEqual(drift.map((d) => d.kind), ['unmanaged']);
});

test('a sync cut short after the invite converges on the next run without a second invite', async () => {
	const { w, entra } = await family();
	let failOnce = true;
	const crashing = {
		...w.admin,
		async recordIdentity(...args: Parameters<typeof w.admin.recordIdentity>) {
			if (failOnce) {
				failOnce = false;
				throw new Error('crashed after the invite');
			}
			return w.admin.recordIdentity(...args);
		},
	};
	await assert.rejects(syncEntra(entra.graph, crashing, null, 'https://games.example/'));
	const drift = await syncEntra(entra.graph, crashing, null, 'https://games.example/');
	assert.deepEqual(drift.map((d) => d.kind), ['unmanaged']);
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 1);
});

async function wronglyLinked() {
	const w = world();
	const entra = fakeGraph();
	const riz = email('riz74@hotmail.com');
	const userId = await w.admin.userIdFor(riz);
	await w.admin.putMember({ userId, state: 'active', games: { kind: 'all' } });
	const member = newObjectId();
	const guest = newObjectId();
	await w.admin.recordIdentity(member, userId);
	await entra.assign(member);
	entra.users.set(riz, guest);
	await entra.assign(bootstrapAdminOid);
	return { w, entra, userId, member, guest };
}

test('a member linked to the wrong account is relinked to the account their address resolves to, and the old assignment goes', async () => {
	const { w, entra, userId, member, guest } = await wronglyLinked();
	const drift = await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	assert.equal((await w.admin.rows()).find((row) => row.member.userId === userId)?.objectId, guest);
	assert.equal((await w.reader.find({ issuer: ENTRA, subject: guest, email: null })).kind, 'known');
	assert.equal((await w.reader.find({ issuer: ENTRA, subject: member, email: null })).kind, 'unknown');
	assert.ok(entra.assignments.has(guest));
	assert.ok(!entra.assignments.has(member));
	assert.ok(entra.assignments.has(bootstrapAdminOid), 'an unmanaged assignment is never removed');
	assert.deepEqual(drift.map((d) => d.kind), ['unmanaged']);
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 0);
});

test('a second sync after a relink changes nothing', async () => {
	const { w, entra } = await wronglyLinked();
	await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	const before = entra.writes().length;
	const drift = await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	assert.equal(entra.writes().length, before);
	assert.deepEqual(drift.map((d) => d.kind), ['unmanaged']);
});

test('a relink cut short after the old link is forgotten converges on the next run', async () => {
	const { w, entra, userId, member, guest } = await wronglyLinked();
	let failOnce = true;
	const crashing = {
		...w.admin,
		async recordIdentity(...args: Parameters<typeof w.admin.recordIdentity>) {
			if (failOnce) {
				failOnce = false;
				throw new Error('crashed after forgetting the old link');
			}
			return w.admin.recordIdentity(...args);
		},
	};
	await assert.rejects(syncEntra(entra.graph, crashing, null, 'https://games.example/'));
	const drift = await syncEntra(entra.graph, crashing, null, 'https://games.example/');
	assert.deepEqual(drift.map((d) => d.kind), ['unmanaged']);
	assert.equal((await w.admin.rows()).find((row) => row.member.userId === userId)?.objectId, guest);
	assert.deepEqual([entra.assignments.has(guest), entra.assignments.has(member)], [true, false]);
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 0);
});

test('an email that matches two accounts sends no invite, assigns nothing, and is reported with both UPNs', async () => {
	const w = world();
	const entra = fakeGraph();
	const riz = email('riz74@hotmail.com');
	const userId = await w.admin.userIdFor(riz);
	await w.admin.putMember({ userId, state: 'active', games: { kind: 'all' } });
	entra.ambiguous.set(riz, ['riz74@hotmail.com', 'riz74_hotmail.com#EXT#@tenant.onmicrosoft.com']);
	const drift = await syncEntra(entra.graph, w.admin, null, 'https://games.example/');
	assert.deepEqual(drift, [{ kind: 'ambiguous-account', userId, email: riz, userPrincipalNames: ['riz74@hotmail.com', 'riz74_hotmail.com#EXT#@tenant.onmicrosoft.com'] }]);
	assert.deepEqual(entra.writes(), []);
	assert.equal((await w.admin.rows())[0]?.objectId, null);
});

test('a sync for one member touches only that member', async () => {
	const { w, entra, existingGuest, guestOid, leaverOid } = await family();
	await syncEntra(entra.graph, w.admin, existingGuest, 'https://games.example/');
	assert.ok(entra.assignments.has(guestOid));
	assert.ok(entra.assignments.has(leaverOid), 'the revoked member waits for their own sync');
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 0);
});
