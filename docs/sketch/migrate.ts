/**
 * tools/migrate/content.mjs and tools/migrate/player-data.mjs. The admin runs them on the Mac as one-off,
 * bootstrap-type data moves. They read the old storage accounts in rg-drawpad and rg-letterjoin with the admin's
 * existing data roles and write each game's own new account in rg-games4kids, g4k<id><suffix>, under the declared
 * names. They never write an old account, and both old apps stay live.
 *
 * They do not run in the pipeline, because a pipeline identity would need new role assignments on the old resource
 * groups, which changes them. If the admin lacks a read role on an old account, the tool stops and names it.
 *
 * Every write is insert-if-absent at a key derived from the source, so a rerun converges, a crash at any point
 * is finished by the next run, and a row the child made in the portal is never overwritten.
 */

import type { Row } from './host';
import type { EntraObjectId, PortalUserId } from './identity';
import type { Brand } from './manifest';

/** An old account through read-only handles. No member writes, so the tools cannot change old data. */
export type OldAccount = {
	readonly tables: Readonly<Record<string, { list(filter?: string): AsyncIterable<Row> }>>;
	readonly containers: Readonly<Record<string, {
		list(prefix: string): AsyncIterable<string>;
		get(path: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
	}>>;
};

/** One game's new account, addressed by the names its manifest declared (pictures, drawings). */
export type NewAccount = {
	table(name: string): { insertIfAbsent(row: Row): Promise<boolean> };
	container(name: string): { putIfAbsent(path: string, bytes: Uint8Array, contentType: string): Promise<boolean> };
};

export type OldAccounts = { readonly drawpad: OldAccount; readonly letterjoin: OldAccount };

/** Each game's data lands in its own account, so a migration can never write one game's rows into another's. */
export type NewAccounts = { readonly drawpad: NewAccount; readonly letterjoin: NewAccount };

export type MigrationMode = 'dry-run' | 'apply';

export type MigrationReport = {
	readonly mode: MigrationMode;
	/** Per target table or container, the count written in apply or that would be written in dry-run. */
	readonly written: Readonly<Record<string, number>>;
	/** Already present in the new account and left alone. */
	readonly skipped: Readonly<Record<string, number>>;
	/** Old player keys with no PortalUserId yet, with their row counts. Nothing is written for them. */
	readonly unmapped: readonly { readonly game: 'drawpad' | 'letterjoin'; readonly oldKey: string; readonly rows: number }[];
};

/**
 * Authored content, copied at cutover with the same keys. The drawpad pictures container holds every library
 * picture's original.jpg, outline.png, pbn.json, pbn-regions.png and pbn-preview.png, which is where accepted
 * AI tracing and paint-by-numbers images end up. drawpad's jobs table and container hold only in-flight AI jobs
 * (blobs expire after 7 days), so they are not copied. letterjoin's activities table includes the settings partition.
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
 *   drawpad     drawings (PK oid), usage (PK oid), drawings blobs <oid>/<id>.png, and each child's
 *               dailyLimitMinutes from profiles, which becomes a settings row (PK 'child', RK userId)
 *   letterjoin  results and attempts (PK userKey), practice rows (PK practice-<userKey>, email column dropped),
 *               submissions rows (userKey and email columns rewritten, pointer rows re-keyed) and blobs <userKey>/<id>.png
 */
export const PLAYER_DATA = {
	drawpad: { tables: ['drawings', 'usage', 'profiles'], containers: ['drawings'] },
	letterjoin: { tables: ['results', 'attempts', 'submissions'], containers: ['submissions'] },
} as const;

/** letterjoin's key, the hex SHA-256 of the lowercased email. */
export type LetterjoinUserKey = Brand<string, 'LetterjoinUserKey'>;

/**
 * Derived from the members table, never typed by hand. drawpad's oid is the member's entraObjectId, because an object
 * id is per tenant, not per app, and inviting an existing guest returns that guest (guess). letterjoin's key is
 * sha256 of the member's email. A child gets an entry once invited, before any portal sign-in.
 */
export type PlayerDataMapping = {
	readonly drawpad: ReadonlyMap<EntraObjectId, PortalUserId>;
	readonly letterjoin: ReadonlyMap<LetterjoinUserKey, PortalUserId>;
};

/** Minted only by parseConfirmation, so no code path reaches apply without the flag on the command line. */
export type PlayerDataConfirmation = Brand<'confirm-player-data', 'PlayerDataConfirmation'>;

/** Returns a confirmation only when argv holds both --apply and --confirm-player-data. */
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
