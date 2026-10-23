declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** `^[a-z][a-z0-9]{2,15}$`, equal to the folder name, not reserved. No hyphen, so `<id>-<name>` splits back. */
export type GameId = Brand<string, 'GameId'>;

export const GAME_ID = /^[a-z][a-z0-9]{2,15}$/;

export const RESERVED_IDS = ['portal', 'shared', 'shell', 'admin', 'welcome', 'api', 'g'] as const;

export type Side = 'play' | 'admin';

/**
 * Who writes a table, container or queue. Exactly one backend writes each.
 *   'play'           the player app writes; the admin app reads
 *   'admin'          the admin app writes; the player app reads
 *   'admin-private'  the admin app only; the player app has no handle at all
 */
export type Ownership = 'play' | 'admin' | 'admin-private';

export type SettingSpec =
	| { readonly kind: 'url'; readonly optional?: true }
	| { readonly kind: 'string'; readonly optional?: true }
	/** One of `values`. The app does not start on any other. */
	| { readonly kind: 'choice'; readonly values: readonly [string, ...string[]]; readonly optional?: true }
	| { readonly kind: 'int'; readonly min: number; readonly max: number; readonly default: number };

/** Storage is not one: code gets handles, never a credential. */
export type AzureService = 'cognitiveServices';

export type CspExtension = Partial<Record<'img-src' | 'worker-src' | 'font-src' | 'style-src' | 'media-src', readonly string[]>>;

export type WebBuild = { readonly kind: 'vite' } | { readonly kind: 'static' };

export type Part = {
	readonly web: WebBuild;
	readonly settings: Readonly<Record<string, SettingSpec>>;
	readonly services: readonly AzureService[];
	readonly csp?: CspExtension;
};

/** Area id (`^[a-z][a-z0-9-]{1,23}$`, checked by gen) to the label the Costs page shows. */
export type AiAreas = Readonly<Record<string, string>>;

/** A part may call AI models. `ai` names each area it bills, and `platform.usage.record` takes only those. */
export type AdminPartSpec = Part & { readonly ai?: AiAreas };

/**
 * The table in a game's own account that holds its player app's AI cost ledger. The host adds it, owned 'play', to
 * every game whose `play.ai` declares an area, so no manifest may declare it.
 */
export const PLAY_LEDGER_TABLE = 'aiusage';

export type Hosting = { readonly maxInstances?: number; readonly memoryMb?: 512 | 2048 | 4096 };

/** No cross-game hub exists yet, so only an empty object type-checks. */
export type ReservedExports = Readonly<Record<string, never>>;

export type StorageDeclaration = Readonly<Record<string, Ownership>>;

export type GameManifest = {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly storage: {
		readonly tables: StorageDeclaration & { readonly [PLAY_LEDGER_TABLE]?: never };
		readonly containers: StorageDeclaration;
		readonly queues: StorageDeclaration;
	};
	readonly play: Part & { readonly hosting?: Hosting; readonly ai?: AiAreas };
	readonly admin?: AdminPartSpec;
	/**
	 * The play API answers GET and PUT `board/me` for a child's own switch: `{ optedIn }`, and `{ on }` to change it.
	 * The profile page shows a switch for each granted game that sets this, and reads `board/me` after a rename, so the
	 * game must bring any copy it keeps of the child's name up to date on that read.
	 */
	readonly scoreboard?: true;
	readonly exports?: ReservedExports;
};

/** The AI areas one part declares, admin by default. `never` when it declares none, so it cannot record any usage. */
export type AreaOf<M extends GameManifest, S extends Side = 'admin'> = NonNullable<M[S]> extends { readonly ai: infer A } ? keyof A & string : never;

/** Keeps every literal, so storage names, ownership, settings and services become unions downstream. */
export function defineGame<const M extends GameManifest>(manifest: M): M {
	return manifest;
}

export function parseGameId(raw: string): GameId | { readonly problem: string } {
	if (!GAME_ID.test(raw)) return { problem: `"${raw}" must match ${GAME_ID.source}` };
	if ((RESERVED_IDS as readonly string[]).includes(raw)) return { problem: `"${raw}" is reserved` };
	return raw as GameId;
}
