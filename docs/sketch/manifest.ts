/**
 * packages/sdk/src/manifest.ts, part of @g4k/sdk, the only package a game may import.
 *
 * games/<id>/manifest.ts default-exports `defineGame({...})`. It is data only, so tools/gen.mjs,
 * the host and the conformance suite can load it without loading any game code. It is the single
 * list of everything the portal knows about a game. Nothing else in the repo names a game by hand.
 */

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/**
 * `^[a-z][a-z0-9]{2,23}$`, equal to the folder name, not reserved. One string serves as the URL segment
 * (/g/<id>/, /api/g/<id>/) and the storage prefix (drawpadPictures, drawpad-pictures). Minted only by
 * `parseGameId` in tools/gen.mjs; a manifest writes a plain literal and the generator brands it.
 */
export type GameId = Brand<string, 'GameId'>;

export const GAME_ID = /^[a-z][a-z0-9]{2,23}$/;

/** Paths and storage prefixes the portal owns. A game folder with one of these names fails the build. */
export const RESERVED_IDS = ['portal', 'shell', 'admin', 'welcome', 'api', 'g'] as const;

/** Lowest privilege first. The last rung is the game's admin role, which every portal admin holds. */
export type RoleLadder = readonly [string, ...string[]];

export type SettingSpec =
	| { readonly kind: 'url'; readonly optional?: true }
	| { readonly kind: 'string'; readonly optional?: true }
	| { readonly kind: 'int'; readonly min: number; readonly max: number; readonly default: number };

/** Azure services a game may hold a token for. Storage is not one of them: a game gets handles, never a credential. */
export type AzureService = 'cognitiveServices';

/** CSP directives a game may widen for its own pages. connect-src, script-src and frame-ancestors belong to the shell. */
export type CspExtension = Partial<Record<'img-src' | 'worker-src' | 'font-src' | 'style-src' | 'media-src', readonly string[]>>;

export type WebBuild =
	/** games/<id>/web is a Vite project, built with base /g/<id>/. */
	| { readonly kind: 'vite' }
	/** games/<id>/web is copied as is (ES modules, no bundler). */
	| { readonly kind: 'static' };

/**
 * The door for cross-game features such as a joint scoreboard. A game would export a named read here and a
 * portal hub would call it; no game ever reads another game's storage. No hub exists yet, so the type admits
 * only an empty object and tools/gen.mjs rejects a non-empty one as well.
 */
export type ReservedExports = Readonly<Record<string, never>>;

export type GameManifest = {
	readonly id: string;
	readonly title: string;
	/** One line on the home card. */
	readonly summary: string;
	/** Path under the game's built web output, shown on the home card. */
	readonly icon: string;
	readonly web: WebBuild;
	/** Relative to /g/<id>/. Listed on the /admin/ hub for anyone holding this game's top role. */
	readonly adminPath?: string;
	readonly roles: RoleLadder;
	/**
	 * The role a member holds when no grant says otherwise. Applied when the role is read, so adding a game
	 * never backfills member rows. `null` hides the game until an admin grants a role.
	 */
	readonly defaultRole: string | null;
	readonly storage: {
		readonly tables: readonly string[];
		readonly containers: readonly string[];
		readonly queues: readonly string[];
	};
	readonly settings: Readonly<Record<string, SettingSpec>>;
	readonly services: readonly AzureService[];
	readonly csp?: CspExtension;
	readonly exports?: ReservedExports;
};

export type RoleOf<M extends GameManifest> = M['roles'][number];
export type TableOf<M extends GameManifest> = M['storage']['tables'][number];
export type ContainerOf<M extends GameManifest> = M['storage']['containers'][number];
export type QueueOf<M extends GameManifest> = M['storage']['queues'][number];
export type ServiceOf<M extends GameManifest> = M['services'][number];

/** Reports a `defaultRole` that is not on the ladder at that property. */
type DefaultOnLadder<M extends GameManifest> = M['defaultRole'] extends RoleOf<M> | null
	? M
	: Omit<M, 'defaultRole'> & { readonly defaultRole: RoleOf<M> | null };

/** Keeps every literal, so roles, storage names, settings and services become unions downstream. */
export function defineGame<const M extends GameManifest>(manifest: DefaultOnLadder<M>): M {
	throw new Error('not implemented');
}

export function parseGameId(raw: string): GameId | { readonly problem: string } {
	throw new Error('not implemented');
}

/** Rank on the game's own ladder. The host's access check and the shell's `requires` both use this. */
export function atLeast<M extends GameManifest>(manifest: M, held: RoleOf<M>, needed: RoleOf<M>): boolean {
	throw new Error('not implemented');
}
