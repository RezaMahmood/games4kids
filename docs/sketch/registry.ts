/**
 * tools/gen.mjs. The folder is the registry: the set of games/<id>/manifest.ts files.
 *
 * Gen checks every folder at once, so one run lists every problem, then writes per-game outputs that each game's
 * own pipeline uses, and two dev-only files. Outputs are gitignored and rewritten by `npm run gen`, which predev,
 * prebuild and pretest run. Writes go to a temp file and rename, so a crash never leaves half a file.
 *
 *   games/<id>/.gen/app.ts            the game's Function app entry: createGameApp + registerWithFunctions
 *   games/<id>/.gen/catalog-entry.json  CatalogEntry minus apiBaseUrl and contract, packed into the web artifact
 *   games/<id>/.gen/params.json       GameInfraParams for infra/game.bicep, deployment game-<id>
 *   tsconfig.games.json               one project reference per games/<id>/api and games/<id>/web
 *   dev/generated/games.ts            every game as a RegistryEntry, for tools/dev.mjs and tests only
 *
 * No output lists every game for production. The site's catalog.json, routes and CSP are written by web-release
 * from the pinned artifacts (release.ts), and shared infra (infra/main.bicep) never names a game.
 */

import type { CreateGameApi } from './host';
import type { GameId, GameManifest, Hosting, RoleLadder } from './manifest';
import type { AppOrigin, ContractVersion } from './release';

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
 * Reads games/*, imports each manifest, and checks every rule at once. Missing files checked: web/index.html,
 * api/index.ts, package.json, the adminPath target for static games.
 */
export function scanGames(root: string): Promise<{ readonly games: readonly ScannedGame[]; readonly problems: readonly Problem[] }> {
	throw new Error('not implemented');
}

/**
 * Dev and tests only. Hides each game's manifest type behind one erased shape, so tools/dev.mjs can mount every
 * game in one node process with serveWithNode, and conformance can loop over games.
 */
export type RegistryEntry = { readonly id: GameId; readonly manifest: GameManifest; readonly create: CreateGameApi<GameManifest> };

export function entry<M extends GameManifest>(id: GameId, manifest: M, createGameApi: CreateGameApi<M>): RegistryEntry {
	throw new Error('not implemented');
}

/** One home card and one /admin/ grid column. web-release writes catalog.json from the pinned artifacts. */
export type CatalogEntry = {
	readonly id: GameId;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly path: `/g/${string}/`;
	readonly roles: RoleLadder;
	/** Pre-selected in the /admin/ role picker for this game. Grants nothing. */
	readonly defaultRole: string;
	readonly adminPath?: string;
	/** The game's own Function app, from its app pin. The shell's ApiClient for this game calls `${apiBaseUrl}/api/g/<id>/`. */
	readonly apiBaseUrl: AppOrigin;
	/** The contract the live web artifact was built against, shown on /admin/. */
	readonly contract: ContractVersion;
};

export type Catalog = readonly CatalogEntry[];

/** Bicep tags. `game` is a GameId on a game's resources, 'portal' on the portal's own, 'shared' on what serves everyone. */
export type ResourceTags = { readonly app: 'games4kids'; readonly game: GameId | 'portal' | 'shared' };

/**
 * Parameters for infra/game.bicep, one deployment per game named game-<id>. It creates the game's storage account
 * with its declared tables, containers and queues, its Flex plan and app func-g4k-<id> with a system-assigned
 * identity, that identity's data roles on its own account and Storage Table Data Reader on three portal tables,
 * the deploy identity's rights on the app, and the module games/<id>/infra.bicep with the same tags.
 */
export type GameInfraParams = {
	readonly id: GameId;
	readonly tags: ResourceTags & { readonly game: GameId };
	readonly tables: readonly string[];
	readonly containers: readonly string[];
	readonly queues: readonly string[];
	readonly hosting: Required<Hosting>;
};

/** Pure renderers, one per output, snapshot-tested in test/gen.test.ts. */
export function renderGameApp(game: ScannedGame): string {
	throw new Error('not implemented');
}
export function renderCatalogEntry(game: ScannedGame): Omit<CatalogEntry, 'apiBaseUrl' | 'contract'> {
	throw new Error('not implemented');
}
export function renderGameParams(game: ScannedGame): GameInfraParams {
	throw new Error('not implemented');
}
export function renderProjectReferences(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
export function renderDevRegistry(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
