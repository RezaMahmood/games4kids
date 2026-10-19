import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEmail, type Email, type EntraObjectId } from '@g4k/sdk';
import { computeDrift, parseAssignmentId, syncEntra, type Assignment, type Drift, type Member, type MemberView } from '@g4k/host';
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
	member: { userId, state, games: [gameId('fixture')] },
	email: email(`${userId.slice(-1)}@example.com`),
	objectId,
	profile: null,
});

const grant = { resourceDisplayName: 'Microsoft Graph', appRoleId: '1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9' };

const cases: readonly { readonly name: string; readonly assignments: readonly Assignment[]; readonly rows: readonly MemberView[]; readonly grants?: readonly (typeof grant)[]; readonly expected: readonly Drift[] }[] = [
	{ name: 'nothing anywhere', assignments: [], rows: [], expected: [] },
	{ name: 'active member with no account yet', assignments: [], rows: [view(ada, 'active', null)], expected: [{ kind: 'needs-account', userId: ada, email: email('a@example.com') }] },
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

for (const { name, assignments, rows, grants = [], expected } of cases) {
	test(`computeDrift: ${name}`, () => {
		assert.deepEqual(computeDrift(assignments, grants, rows), expected);
	});
}

async function family() {
	const w = world();
	const entra = fakeGraph();
	const fixture = gameId('fixture');
	const newKid = await w.admin.userIdFor(email('new@example.com'));
	await w.admin.putMember({ userId: newKid, state: 'active', games: [fixture] });
	const existingGuest = await w.admin.userIdFor(email('guest@example.com'));
	await w.admin.putMember({ userId: existingGuest, state: 'active', games: [fixture] });
	const guestOid = newObjectId();
	entra.users.set(email('guest@example.com'), guestOid);
	const leaver = await w.admin.userIdFor(email('leaver@example.com'));
	const leaverOid = newObjectId();
	await w.admin.recordIdentity(leaverOid, leaver);
	await w.admin.putMember({ userId: leaver, state: 'revoked', games: [fixture] });
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

test('a sync for one member touches only that member', async () => {
	const { w, entra, existingGuest, guestOid, leaverOid } = await family();
	await syncEntra(entra.graph, w.admin, existingGuest, 'https://games.example/');
	assert.ok(entra.assignments.has(guestOid));
	assert.ok(entra.assignments.has(leaverOid), 'the revoked member waits for their own sync');
	assert.equal(entra.calls.filter((call) => call === 'invite').length, 0);
});
