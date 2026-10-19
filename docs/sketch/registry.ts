/**
 * tools/gen.mjs. The folder is the registry: the set of games/<id>/manifest.ts files. Every other list of games
 * is derived from it.
 *
 * Outputs are gitignored and rewritten by `npm run gen`, which predev, prebuild and pretest run, and which CI
 * and tools/infra.mjs run first. Writes go to a temp file and rename, so a crash never leaves half a file.
 *
 *   host/generated/games.ts          static imports of every manifest and api/index.ts, as RegistryEntry[]
 *   tsconfig.games.json              one project reference per games/<id>/api and games/<id>/web
 *   portal/web/public/catalog.json   Catalog, read by the home page and /admin/, and bundled into the admin app
 *   dist/site/staticwebapp.config.json routes: /g/<id>/* fallback and per-game CSP
 *   infra/generated/storage.json     StorageAccounts: one account per game plus the portal's, with declared names
 *                                    and tags, read by main.bicep, which also grants the host data roles on each
 *   infra/generated/games.bicep      one module per games/<id>/infra.bicep, passed tags { app: 'games4kids', game: <id> }
 *
 * tools/infra.mjs builds main.bicep and fails if any resource lacks the `app` or `game` tag, so cost by tag covers
 * everything. The workbook groups by `game` at query time, so nothing here lists games for it.
 */

import type { CreateGameApi } from './host';
import type { GameId, GameManifest } from './manifest';

export type Problem =
	| { readonly kind: 'no-manifest'; readonly folder: string }
	| { readonly kind: 'id-mismatch'; readonly folder: string; readonly id: string }
	| { readonly kind: 'bad-id'; readonly folder: string; readonly id: string }
	| { readonly kind: 'reserved-id'; readonly folder: string; readonly id: string }
	| { readonly kind: 'duplicate-id'; readonly id: string; readonly folders: readonly string[] }
	| { readonly kind: 'missing-file'; readonly game: string; readonly path: string }
	/** Declared table names must match ^[A-Za-z][A-Za-z0-9]{2,62}$; containers and queues 3 to 63 lowercase characters with single hyphens. */
	| { readonly kind: 'storage-name'; readonly game: string; readonly name: string; readonly rule: string }
	| { readonly kind: 'default-role'; readonly game: string; readonly role: string }
	/** effectiveRole returns 'none' for no access, so a ladder may not use it. */
	| { readonly kind: 'reserved-role'; readonly game: string }
	| { readonly kind: 'exports-reserved'; readonly game: string; readonly names: readonly string[] };

export type ScannedGame = { readonly id: GameId; readonly folder: string; readonly manifest: GameManifest };

/**
 * Reads games/*, imports each manifest, and checks every rule at once so one run lists every problem.
 * Missing files checked: web/index.html, api/index.ts, the adminPath target for static games.
 */
export function scanGames(root: string): Promise<{ readonly games: readonly ScannedGame[]; readonly problems: readonly Problem[] }> {
	throw new Error('not implemented');
}

/**
 * The generated host file calls this once per game. It hides the per-game manifest type behind one erased
 * shape, so host code never handles Platform<M> for an unknown M.
 *
 *   import drawpad from '../../games/drawpad/manifest.js';
 *   import { createGameApi as drawpadApi } from '../../games/drawpad/api/index.js';
 *   export const games = [entry('drawpad', drawpad, drawpadApi), ...];
 */
export type RegistryEntry = { readonly id: GameId; readonly manifest: GameManifest; readonly mount: CreateGameApi<GameManifest> };

export function entry<M extends GameManifest>(id: GameId, manifest: M, createGameApi: CreateGameApi<M>): RegistryEntry {
	throw new Error('not implemented');
}

export type CatalogEntry = {
	readonly id: GameId;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly path: `/g/${string}/`;
	readonly roles: readonly string[];
	/** Pre-selected in the /admin/ role picker for this game. Grants nothing. */
	readonly defaultRole: string;
	readonly adminPath?: string;
};

export type Catalog = readonly CatalogEntry[];

/** One storage account. `owner` gives both the account name (accountName in host.ts) and the `game` tag ('shared' for the portal). */
export type StorageAccount = {
	readonly owner: GameId | 'portal';
	readonly tags: { readonly app: 'games4kids'; readonly game: GameId | 'shared' };
	readonly tables: readonly string[];
	readonly containers: readonly string[];
	readonly queues: readonly string[];
};

export type StorageAccounts = readonly StorageAccount[];

/** Pure renderers, one per output, snapshot-tested in test/gen.test.ts. */
export function renderHostRegistry(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
export function renderProjectReferences(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
export function renderCatalog(games: readonly ScannedGame[]): Catalog {
	throw new Error('not implemented');
}
export function renderSwaRoutes(games: readonly ScannedGame[]): unknown {
	throw new Error('not implemented');
}
export function renderStorage(games: readonly ScannedGame[]): StorageAccounts {
	throw new Error('not implemented');
}
export function renderInfraModules(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
