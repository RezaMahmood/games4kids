/**
 * tools/gen.mjs. The folder is the registry: the set of games/<id>/manifest.ts files.
 *
 * Gen checks every folder at once, so one run lists every problem, then writes its outputs (gitignored, rewritten on
 * predev, prebuild and pretest; each write goes to a temp file and is renamed into place):
 *   games/<id>/.gen/play-app.ts      the player app entry: createPlayerApp + registerWithFunctions
 *   games/<id>/.gen/params.json      GameInfraParams for infra/game.bicep, deployment game-<id>
 *   apps/games/.gen/catalog.json     CatalogEntry per game, minus apiBaseUrl, which the site deploy job fills in
 *   apps/admin/.gen/modules.ts       every game's admin part, for the admin app entry and the admin site's game list
 *   dev/generated/games.ts           every game, for tools/dev.mjs and the tests
 */

import type { CreateAdminApi, CreatePlayApi } from './host';
import type { GameId, GameManifest, Hosting } from './manifest';

export type Problem =
	| { readonly kind: 'no-manifest'; readonly folder: string }
	| { readonly kind: 'id-mismatch'; readonly folder: string; readonly id: string }
	| { readonly kind: 'bad-id'; readonly folder: string; readonly id: string }
	| { readonly kind: 'reserved-id'; readonly folder: string; readonly id: string }
	| { readonly kind: 'duplicate-id'; readonly id: string; readonly folders: readonly string[] }
	| { readonly kind: 'missing-file'; readonly game: string; readonly path: string }
	| { readonly kind: 'storage-name'; readonly game: string; readonly name: string; readonly rule: string }
	/** Storage owned by 'admin' or 'admin-private' with no admin part to write it. */
	| { readonly kind: 'no-admin-writer'; readonly game: string; readonly names: readonly string[] }
	| { readonly kind: 'exports-reserved'; readonly game: string; readonly names: readonly string[] };

export type ScannedGame = { readonly id: GameId; readonly folder: string; readonly manifest: GameManifest };

export function scanGames(root: string): Promise<{ readonly games: readonly ScannedGame[]; readonly problems: readonly Problem[] }> {
	throw new Error('not implemented');
}

/** One home card on the games site. A game appears for a child only when its id is in their member row. */
export type CatalogEntry = {
	readonly id: GameId;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly path: `/g/${string}/`;
	/** func-g4k-<id>'s https origin, read from Azure by the games-site deploy job. */
	readonly apiBaseUrl: string;
};

/** One row of the admin site's game list (apps/admin/.gen/catalog.json): what a member can be granted, and whether the game has admin pages. */
export type AdminCatalogEntry = { readonly id: GameId; readonly title: string; readonly hasAdmin: boolean; readonly path: `/g/${string}/` };

/** Bicep tags. `game` is a GameId on a game's resources, 'portal' or 'admin' on those apps, 'shared' on what serves everyone. */
export type ResourceTags = { readonly app: 'games4kids'; readonly game: GameId | 'portal' | 'admin' | 'shared' };

/**
 * infra/game.bicep, one deployment per game named game-<id>: the game's storage account with its declared names,
 * its Flex plan and player app func-g4k-<id> (system-assigned identity, platform CORS for the games origin), that
 * identity's roles ('play' names: Data Contributor; 'admin' names: Data Reader), id-g4k-admin's roles ('admin' and
 * 'admin-private' names: Data Contributor; 'play' names: Data Reader), Table Data Reader on members, identities and
 * profiles for the player app, and the game's own games/<id>/infra.bicep with GameModuleParams.
 */
export type GameInfraParams = {
	readonly id: GameId;
	readonly tags: ResourceTags & { readonly game: GameId };
	readonly storage: GameManifest['storage'];
	readonly hosting: Required<Hosting>;
	/** id-g4k-admin's principal id, from a repository variable that bootstrap set. */
	readonly adminPrincipalId: string;
};

/** What games/<id>/infra.bicep receives, so drawpad's Foundry module can grant and wire without guessing names. */
export type GameModuleParams = {
	readonly tags: ResourceTags & { readonly game: GameId };
	readonly location: string;
	readonly storageAccountName: string;
	readonly playPrincipalId: string;
	readonly adminPrincipalId: string;
	readonly queues: readonly string[];
};

export type GameParts<M extends GameManifest> = { readonly manifest: M; readonly play: CreatePlayApi<M>; readonly admin: CreateAdminApi<M> | null };

/**
 * Dev and tests only. A list cannot hold each game's own manifest type, and an erased CreatePlayApi<GameManifest> does
 * not accept a concrete game's create, so `use` hands the parts back with their types to code generic over manifests.
 */
export type RegistryEntry = { readonly id: GameId; use<R>(visit: <M extends GameManifest>(parts: GameParts<M>) => R): R };

/** Pure renderers, one per output, snapshot-tested in test/gen.test.ts. */
export function renderPlayApp(game: ScannedGame): string {
	throw new Error('not implemented');
}
export function renderGameParams(game: ScannedGame, adminPrincipalId: string): GameInfraParams {
	throw new Error('not implemented');
}
export function renderCatalog(games: readonly ScannedGame[]): readonly Omit<CatalogEntry, 'apiBaseUrl'>[] {
	throw new Error('not implemented');
}
export function renderAdminModules(games: readonly ScannedGame[]): string {
	throw new Error('not implemented');
}
