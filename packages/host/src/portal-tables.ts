import { parseEmail, parseEntraObjectId, parseGameId, parsePortalUserId, type EntraObjectId, type GameId, type PortalUserId, type Profile, type ReadTable, type Row, type Table } from '@g4k/sdk';
import type { AdminRow, AdminStore, MemberView } from './admin.ts';
import { grants, type Found, type GameGrant, type Identity, type Member, type PortalReader, type PortalStore } from './identity.ts';
import { planSave, type StoredProfile } from './rename.ts';
import { ENTRA } from './token.ts';

/**
 * The portal account's tables, one writer each:
 *   members     PK 'member'    RK PortalUserId               admin app
 *   games       PK 'game'      RK GameId, state 'paused'     admin app; no row is available
 *   identities  PK 'identity'  RK `${IssuerKey}|${subject}`  admin app, when sync learns the object id
 *   emails      PK 'email'     RK Email                      admin app; no games-side app reads it
 *   profiles    PK 'profile'   RK PortalUserId               portal app, on /welcome/ and /profile/
 *   admins      PK 'admin'     RK EntraObjectId              tools/bootstrap.mjs on the Mac
 */
export type PortalTableName = 'members' | 'games' | 'identities' | 'emails' | 'profiles' | 'admins';

const identityKey = (issuer: string, subject: string) => `${issuer}|${subject}`;

/** `*` is never a GameId, so a reader that predates the all-games grant grants nothing. */
const ALL_GAMES = '*';

function parseGrant(raw: unknown): GameGrant {
	if (raw === ALL_GAMES) return { kind: 'all' };
	const ids = (typeof raw === 'string' ? raw.split(',') : []).flatMap((id) => {
		const parsed = parseGameId(id);
		return typeof parsed === 'string' ? [parsed] : [];
	});
	return { kind: 'some', ids };
}

function grantColumn(grant: GameGrant): string {
	switch (grant.kind) {
		case 'all':
			return ALL_GAMES;
		case 'some':
			return grant.ids.join(',');
	}
}

function parseMember(row: Row | undefined): Member | undefined {
	const userId = parsePortalUserId(row?.rowKey);
	const state = row?.['state'];
	if (!userId || (state !== 'active' && state !== 'revoked')) return undefined;
	return { userId, state, games: parseGrant(row?.['games']) };
}

function memberRow(member: Member): Row {
	return { partitionKey: 'member', rowKey: member.userId, state: member.state, games: grantColumn(member.games) };
}

function parseProfile(row: Row | undefined): Profile | undefined {
	const displayName = row?.['displayName'];
	const timeZone = row?.['timeZone'];
	return typeof displayName === 'string' && typeof timeZone === 'string' ? { displayName, timeZone } : undefined;
}

/** A `renamedAt` that is not a date reads as no rename, never as a day to compare. */
function parseRenamedAt(row: Row | undefined): string | undefined {
	const renamedAt = row?.['renamedAt'];
	return typeof renamedAt === 'string' && !Number.isNaN(Date.parse(renamedAt)) ? renamedAt : undefined;
}

function parseStoredProfile(row: Row | undefined): StoredProfile | undefined {
	const profile = parseProfile(row);
	const renamedAt = parseRenamedAt(row);
	return profile && (renamedAt === undefined ? profile : { ...profile, renamedAt });
}

const userIdOf = (row: Row | undefined): PortalUserId | null => parsePortalUserId(row?.['userId']);

const PAUSED = 'paused';

/** A row whose key is no game id, or whose state is not paused, pauses nothing. */
function parsePaused(rows: readonly Row[]): ReadonlySet<GameId> {
	return new Set(rows.flatMap((row) => {
		const id = parseGameId(row.rowKey);
		return typeof id === 'string' && row['state'] === PAUSED ? [id] : [];
	}));
}

export type ReaderTables = { readonly identities: ReadTable; readonly members: ReadTable; readonly games: ReadTable; readonly profiles: ReadTable };

/** Every games-side app: Table Data Reader on identities, members, games and profiles. */
export function portalReader(tables: ReaderTables): PortalReader {
	return {
		async find(identity: Identity): Promise<Found> {
			const userId = userIdOf(await tables.identities.get('identity', identityKey(identity.issuer, identity.subject)));
			if (!userId) return { kind: 'unknown' };
			const [member, profile] = await Promise.all([tables.members.get('member', userId), tables.profiles.get('profile', userId)]);
			return { kind: 'known', userId, member: parseMember(member), profile: parseProfile(profile), renamedAt: parseRenamedAt(profile) };
		},
		async paused() {
			return parsePaused(await tables.games.inPartition('game'));
		},
	};
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The portal app: the reader, plus profiles, the one table it writes. */
export function portalStore(tables: ReaderTables & { readonly profiles: Table }): PortalStore {
	return {
		...portalReader(tables),
		async setProfile(userId, profile, now) {
			const rows = await tables.profiles.inPartition('profile');
			const save = planSave(parseStoredProfile(rows.find((row) => row.rowKey === userId)), profile, now);
			if (save.kind === 'refused') return 'rename_tomorrow';
			if (rows.some((row) => row.rowKey !== userId && sameName(parseProfile(row)?.displayName ?? '', profile.displayName))) return 'name_taken';
			await tables.profiles.put({ partitionKey: 'profile', rowKey: userId, ...profile, ...(save.renamedAt === undefined ? {} : { renamedAt: save.renamedAt }) });
			return 'ok';
		},
	};
}

export type AdminTables = {
	readonly members: Table;
	readonly games: Table;
	readonly identities: Table;
	readonly emails: Table;
	readonly profiles: ReadTable;
	readonly admins: ReadTable;
};

/** The admin app: writes members, games, emails and identities; reads profiles and admins. */
export function adminStore(tables: AdminTables, newId: () => string): AdminStore {
	return {
		async admin(objectId: EntraObjectId): Promise<AdminRow | undefined> {
			const email = parseEmail((await tables.admins.get('admin', objectId))?.['email']);
			return email ? { objectId, email } : undefined;
		},
		async member(userId) {
			return parseMember(await tables.members.get('member', userId));
		},
		async userIdFor(email) {
			const fresh = parsePortalUserId(newId());
			if (!fresh) throw new Error('newId must mint a UUID');
			if (await tables.emails.insertIfAbsent({ partitionKey: 'email', rowKey: email, userId: fresh })) return fresh;
			const existing = userIdOf(await tables.emails.get('email', email));
			if (!existing) throw new Error(`emails row for a member has no userId`);
			return existing;
		},
		async putMember(member) {
			await tables.members.put(memberRow(member));
		},
		async recordIdentity(objectId, userId) {
			await tables.identities.insertIfAbsent({ partitionKey: 'identity', rowKey: identityKey(ENTRA, objectId), userId });
		},
		async forgetIdentity(objectId) {
			await tables.identities.remove('identity', identityKey(ENTRA, objectId));
		},
		async rows(): Promise<readonly MemberView[]> {
			const [members, emails, identities, profiles] = await Promise.all([
				tables.members.inPartition('member'),
				tables.emails.inPartition('email'),
				tables.identities.inPartition('identity'),
				tables.profiles.inPartition('profile'),
			]);
			const emailOf = new Map(emails.flatMap((row) => {
				const email = parseEmail(row.rowKey);
				const userId = userIdOf(row);
				return email && userId ? [[userId, email] as const] : [];
			}));
			const objectIdOf = new Map(identities.flatMap((row) => {
				const [issuer, subject] = row.rowKey.split('|');
				const objectId = issuer === ENTRA ? parseEntraObjectId(subject) : null;
				const userId = userIdOf(row);
				return objectId && userId ? [[userId, objectId] as const] : [];
			}));
			const profileOf = new Map(profiles.map((row) => [row.rowKey, parseProfile(row)] as const));
			return members.flatMap((row) => {
				const member = parseMember(row);
				const email = member && emailOf.get(member.userId);
				return member && email
					? [{ member, email, objectId: objectIdOf.get(member.userId) ?? null, profile: profileOf.get(member.userId) ?? null }]
					: [];
			});
		},
		async paused() {
			return parsePaused(await tables.games.inPartition('game'));
		},
		async setPaused(game, paused) {
			if (paused) await tables.games.put({ partitionKey: 'game', rowKey: game, state: PAUSED });
			else await tables.games.remove('game', game);
		},
	};
}

/** The players granted one game, with display names and no email. */
export function rosterOf(store: AdminStore, game: GameId) {
	return {
		async list() {
			const rows = await store.rows();
			return rows
				.filter(({ member }) => member.state === 'active' && grants(member.games, game))
				.map(({ member, profile }) => ({ userId: member.userId, profile }));
		},
	};
}
