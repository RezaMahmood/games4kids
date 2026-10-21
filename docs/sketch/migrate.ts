/**
 * tools/migrate/content.mjs and tools/migrate/player-data.mjs, run on the Mac as one-off, bootstrap-type data moves.
 * They read the old storage accounts in rg-drawpad and rg-letterjoin with the owner's existing data roles and write
 * each game's new account g4k<id><suffix>. They never write an old account, and both old apps stay live. They are
 * the one exception to the single-writer rule, once, before either backend has written the rows they insert.
 *
 * Every write is insert-if-absent at a key derived from the source, so a rerun converges, a crash anywhere is
 * finished by the next run, and a row a child made in the portal is never overwritten.
 */

import type { Row } from './host';
import type { Email, EntraObjectId, PortalUserId } from './identity';
import type { Brand } from './manifest';

/** An old account through read-only handles. */
export type OldAccount = {
	readonly tables: Readonly<Record<string, { list(filter?: string): AsyncIterable<Row> }>>;
	readonly containers: Readonly<Record<string, {
		list(prefix: string): AsyncIterable<string>;
		get(path: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
	}>>;
};

export type NewAccount = {
	table(name: string): { insertIfAbsent(row: Row): Promise<boolean> };
	container(name: string): { putIfAbsent(path: string, bytes: Uint8Array, contentType: string): Promise<boolean> };
};

export type OldAccounts = { readonly drawpad: OldAccount; readonly letterjoin: OldAccount };

/** Each game's data lands in its own account. */
export type NewAccounts = { readonly drawpad: NewAccount; readonly letterjoin: NewAccount };

export type MigrationMode = 'dry-run' | 'apply';

export type MigrationReport = {
	readonly mode: MigrationMode;
	readonly written: Readonly<Record<string, number>>;
	readonly skipped: Readonly<Record<string, number>>;
	/** Old player keys with no PortalUserId yet, with their row counts. Nothing is written for them. */
	readonly unmapped: readonly { readonly game: 'drawpad' | 'letterjoin'; readonly oldKey: string; readonly email: Email | null; readonly rows: number }[];
};

/**
 * Authored content, copied at cutover with the same keys. drawpad: the pictures table and container (every library
 * picture's original, outline and paint-by-numbers files) and the settings default row. letterjoin: the activities
 * table, including its settings partition. drawpad's jobs are in-flight only and are not copied.
 */
export const CONTENT = {
	drawpad: { tables: ['pictures', 'settings'], containers: ['pictures'] },
	letterjoin: { tables: ['activities'], containers: [] },
} as const;

/** `node tools/migrate/content.mjs [--apply]`. Dry-run by default. */
export function migrateContent(mode: MigrationMode, from: OldAccounts, to: NewAccounts): Promise<MigrationReport> {
	throw new Error('not implemented');
}

/**
 * Player data, re-keyed to PortalUserId. Built and tested, and not run until the owner says so.
 *   drawpad     drawings and usage (PK oid) and drawing blobs <oid>/<id>.png; each child's dailyLimitMinutes from the
 *               old profiles row becomes a settings row (PK 'child', RK userId). Names and time zones are dropped:
 *               each child chooses them again on /welcome/.
 *   letterjoin  results (practice partitions included, email column dropped) and attempts (PK userKey), submissions
 *               rows and blobs re-keyed; each submission's reviewed, reviewedBy, reviewedAt and note move to a
 *               reviews row (RK submission id), because the admin app owns review state.
 */
export const PLAYER_DATA = {
	drawpad: { tables: ['drawings', 'usage', 'profiles'], containers: ['drawings'] },
	letterjoin: { tables: ['results', 'attempts', 'submissions'], containers: ['submissions'] },
} as const;

/** letterjoin's key, the hex SHA-256 of the lowercased email. */
export type LetterjoinUserKey = Brand<string, 'LetterjoinUserKey'>;

/**
 * Derived from the portal tables, never typed by hand. A child is the same person when the email matches: drawpad's
 * oid maps through the email its old profiles row recorded, and letterjoin's key is sha256 of the emails row's
 * address. drawpad falls back to the identities rows (an object id is per tenant) only when that email is not a
 * member. A child gets an entry once added as a member, before any sign-in or Entra sync.
 */
export type PlayerDataMapping = {
	readonly byEmail: ReadonlyMap<Email, PortalUserId>;
	readonly byObjectId: ReadonlyMap<EntraObjectId, PortalUserId>;
};

/** Minted only by parseConfirmation, so no code path reaches apply without the flag on the command line. */
export type PlayerDataConfirmation = Brand<'confirm-player-data', 'PlayerDataConfirmation'>;

export function parseConfirmation(argv: readonly string[]): PlayerDataConfirmation | null {
	throw new Error('not implemented');
}

export type PlayerDataRun =
	| { readonly mode: 'dry-run'; readonly mapping: PlayerDataMapping }
	| { readonly mode: 'apply'; readonly mapping: PlayerDataMapping; readonly confirmation: PlayerDataConfirmation };

/** `node tools/migrate/player-data.mjs [--apply --confirm-player-data]`. Dry-run by default. */
export function migratePlayerData(run: PlayerDataRun, from: OldAccounts, to: NewAccounts): Promise<MigrationReport> {
	throw new Error('not implemented');
}
