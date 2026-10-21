import { randomUUID } from 'node:crypto';
import { parseEmail, parseEntraObjectId, type EntraObjectId, type GameId, type PortalUserId, type Profile } from '@g4k/sdk';
import { adminStore, memoryAccounts, portalReader, portalStore, type Member, type MemoryAccounts, type PortalTableName, type Telemetry } from '@g4k/host';
import type { FakeIdp } from './idp.ts';

export type RecordingTelemetry = Telemetry & { readonly exceptions: unknown[]; readonly users: PortalUserId[]; readonly routes: string[] };

export function recordingTelemetry(): RecordingTelemetry {
	const exceptions: unknown[] = [];
	const users: PortalUserId[] = [];
	const routes: string[] = [];
	return { exceptions, users, routes, setUser: (user) => void users.push(user), setRoute: (route) => void routes.push(route), log: () => {}, exception: (error) => void exceptions.push(error) };
}

export const NOW = new Date('2026-10-19T20:00:00Z');

/** One memory world: every account, and the portal views each app is given in production. */
export function world() {
	const accounts: MemoryAccounts = memoryAccounts();
	const portal = accounts.open('portal');
	const table = (name: PortalTableName) => portal.table(name);
	const reader = portalReader({ identities: table('identities'), members: table('members'), games: table('games'), profiles: table('profiles') });
	const portalWrites = portalStore({ identities: table('identities'), members: table('members'), games: table('games'), profiles: table('profiles') });
	const admin = adminStore(
		{ members: table('members'), games: table('games'), identities: table('identities'), emails: table('emails'), profiles: table('profiles'), admins: table('admins') },
		randomUUID,
	);
	return { accounts, reader, portal: portalWrites, admin, telemetry: recordingTelemetry(), now: () => NOW };
}

export type World = ReturnType<typeof world>;

export function newObjectId(): EntraObjectId {
	const objectId = parseEntraObjectId(randomUUID());
	if (!objectId) throw new Error('a UUID is an object id');
	return objectId;
}

export type Person = { readonly userId: PortalUserId; readonly objectId: EntraObjectId; readonly email: string; readonly token: string };

/** A person the admin app invited and synced, written through the same stores the apps use. */
export async function seedPlayer(
	w: World,
	idp: FakeIdp,
	{ games, state = 'active', profile = { displayName: `Kid ${randomUUID().slice(0, 4)}`, timeZone: 'Europe/London' } }: {
		readonly games: readonly GameId[] | 'all';
		readonly state?: Member['state'];
		readonly profile?: Profile | null;
	},
): Promise<Person> {
	const objectId = newObjectId();
	const email = parseEmail(`${objectId.slice(0, 8)}@example.com`);
	if (!email) throw new Error('test email must parse');
	const userId = await w.admin.userIdFor(email);
	await w.admin.recordIdentity(objectId, userId);
	await w.admin.putMember({ userId, state, games: games === 'all' ? { kind: 'all' } : { kind: 'some', ids: games } });
	if (profile) await w.portal.setProfile(userId, profile, w.now());
	return { userId, objectId, email, token: await idp.gamesToken(objectId) };
}

/** The admins row tools/bootstrap.mjs writes. */
export async function seedAdmin(w: World, objectId: string, email = 'owner@example.com'): Promise<void> {
	await w.accounts.open('portal').table('admins').put({ partitionKey: 'admin', rowKey: objectId, email });
}
