/**
 * packages/sdk/src/manifest.ts, part of @g4k/sdk.
 *
 * games/<id>/manifest.ts default-exports `defineGame({...})`. It is data only, so tools/gen.mjs, infra/game.bicep's
 * parameters, both sites' game lists and the conformance suites load it without loading game code. It is the one
 * list of what the platform knows about a game. Nothing else in the repo names a game by hand.
 *
 * A game has three parts, and the manifest describes all three:
 *   games/<id>/data    the storage it declares here, its row types, parse functions and stores. Both backends import it.
 *   games/<id>/play    player pages (games site, /g/<id>/) and the player API (func-g4k-<id>, audience games4kids)
 *   games/<id>/admin   admin pages (admin site, /g/<id>/) and an admin API module (func-g4k-admin, audience
 *                      games4kids-admin). Optional: a game with no content to manage has none.
 * There is no role anywhere in a manifest. A player is a player; administration is a different app.
 */

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/**
 * `^[a-z][a-z0-9]{2,15}$`, equal to the folder name, not reserved. One string names the page path (/g/<id>/ on both
 * sites), the player Function app (func-g4k-<id>), the storage account (g4k<id><suffix>), the Bicep deployment
 * (game-<id>), the `game` tag, and the admin route prefix (api/admin/g/<id>/). No hyphen, so an admin function
 * name `<id>-<name>` splits back. Minted only by parseGameId.
 */
export type GameId = Brand<string, 'GameId'>;

export const GAME_ID = /^[a-z][a-z0-9]{2,15}$/;

export const RESERVED_IDS = ['portal', 'shared', 'shell', 'admin', 'welcome', 'api', 'g'] as const;

/** One of the two backends. */
export type Side = 'play' | 'admin';

/**
 * Who writes a table, container or queue. Exactly one backend writes each, and RBAC agrees with the type.
 *   'play'           the game's player app writes; the admin app reads (reports, review, gallery)
 *   'admin'          the admin app writes (content, settings); the player app reads
 *   'admin-private'  the admin app only (AI jobs, review state); the player app has no role on it at all
 */
export type Ownership = 'play' | 'admin' | 'admin-private';

export type SettingSpec =
	| { readonly kind: 'url'; readonly optional?: true }
	| { readonly kind: 'string'; readonly optional?: true }
	| { readonly kind: 'int'; readonly min: number; readonly max: number; readonly default: number };

/** Azure services a backend may hold a token for. Storage is not one: code gets handles, never a credential. */
export type AzureService = 'cognitiveServices';

/** CSP directives a game may widen for its own pages. connect-src, script-src and frame-ancestors belong to the site. */
export type CspExtension = Partial<Record<'img-src' | 'worker-src' | 'font-src' | 'style-src' | 'media-src', readonly string[]>>;

export type WebBuild = { readonly kind: 'vite' } | { readonly kind: 'static' };

/** What one side of a game needs from its backend and its site. */
export type Part = {
	readonly web: WebBuild;
	readonly settings: Readonly<Record<string, SettingSpec>>;
	readonly services: readonly AzureService[];
	readonly csp?: CspExtension;
};

/** The player app's own Flex settings. Defaults: 2048 MB, 100 instances. The admin app's are fixed in infra (one instance). */
export type Hosting = { readonly maxInstances?: number; readonly memoryMb?: 512 | 2048 | 4096 };

/** The door for cross-game features. No hub exists yet, so only an empty object type-checks. */
export type ReservedExports = Readonly<Record<string, never>>;

export type GameManifest = {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly storage: {
		readonly tables: Readonly<Record<string, Ownership>>;
		readonly containers: Readonly<Record<string, Ownership>>;
		readonly queues: Readonly<Record<string, Ownership>>;
	};
	readonly play: Part & { readonly hosting?: Hosting };
	readonly admin?: Part;
	readonly exports?: ReservedExports;
};

/** Keeps every literal, so storage names, ownership, settings and services become unions downstream. */
export function defineGame<const M extends GameManifest>(manifest: M): M {
	throw new Error('not implemented');
}

export function parseGameId(raw: string): GameId | { readonly problem: string } {
	throw new Error('not implemented');
}
