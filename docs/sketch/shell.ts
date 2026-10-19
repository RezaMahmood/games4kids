/**
 * Two shells, one per site, each built from its own app folder and served at a stable path, /shell/v1/index.js on
 * its own origin. A shell change is additive only; CI runs every game's tests on any shell change, and a change that
 * breaks a game changes that game in the same pull request. There is no second major and no version rule.
 *
 * apps/games/shell: the games site, origin A. MSAL client games4kids, scope access_as_user, cache in sessionStorage,
 * which every path in a tab shares, so moving from / to /g/letterjoin/ gets a token silently. This shell has no admin
 * scope and no admin origin in its config, so nothing on origin A can ask for a games4kids-admin token.
 *
 * apps/admin/shell: the admin site, origin B. MSAL client games4kids-admin. One instance in sessionStorage for
 * admin.console, and a second, memory-only instance created per Entra task (elevated).
 */

import type { Refusal } from './host';
import type { AdminCatalogEntry, CatalogEntry } from './registry';
import type { Profile, PortalUserId } from './identity';

/** Thrown by ApiClient for any non-2xx reply, parsed from the one error shape. */
export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly problems: readonly string[] = [],
		/** insufficient_claims only: the challenge, in the body because a page on another origin cannot read WWW-Authenticate. */
		readonly claims?: string,
	) {
		super(message);
	}
}

export type SendOptions = {
	/** fetch keepalive, for drawpad's heartbeat and letterjoin's addPractice on pagehide. */
	readonly keepalive?: true;
};

/** Bearer handling and refusal routing, from drawpad's transport.ts. */
export type ApiClient = {
	get<T>(path: string, query?: Readonly<Record<string, string>>): Promise<T>;
	post<T>(path: string, body: unknown, options?: SendOptions): Promise<T>;
	put<T>(path: string, body: unknown, options?: SendOptions): Promise<T>;
	patch<T>(path: string, body: unknown): Promise<T>;
	delete(path: string): Promise<void>;
	sendPng<T>(path: string, png: Uint8Array): Promise<T>;
	/** A protected image as an object URL. Keeps the ETag and sends If-None-Match, so a 304 reuses the cached bytes (drawpad's blobs/cache.ts). */
	objectUrl(path: string): Promise<string>;
};

/** localStorage keyed `g4k:<game>:<userId>:<key>`, so two games, or two children on one iPad, never share a key. */
export type GameStorage = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

/** /config.json on the games site, written at deploy. No admin field exists. */
export type GamesSiteConfig = {
	readonly authority: string;
	readonly clientId: string;
	/** api://<games4kids>/access_as_user */
	readonly scope: string;
	readonly portalApiOrigin: string;
	readonly telemetryConnectionString: string;
};

export type GameSession = {
	readonly me: { readonly userId: PortalUserId; readonly profile: Profile };
	readonly api: ApiClient;
	readonly storage: GameStorage;
	signOut(): Promise<void>;
	/** Signs out and asks Entra for an account picker. For the family iPad passed between children. */
	switchAccount(): Promise<void>;
};

/**
 * Games site. The game id is the page's folder name, checked against catalog.json. `game: null` on portal pages binds `api` to func-g4k-portal and calls GET me. A game page binds `api`
 * to its own app and calls its GET session, so only that app wakes. Resolves only for a player of this game; every
 * other state is a screen or a redirect and the promise never resolves:
 *   signed out     loginRedirect, back to this page
 *   not_invited    "Ask your grown-up to invite you", with a sign-out button
 *   no_profile     location = /welcome/?return=<this page>
 *   not_entitled   "This game is not switched on for you"
 */
export function enter(options: { readonly game: null }): Promise<PortalSession>;
export function enter(options: { readonly game: string }): Promise<GameSession>;
export function enter(options: { readonly game: string | null }): Promise<GameSession | PortalSession> {
	throw new Error('not implemented');
}

/** Home also gets a card for each game switched on for this child, from catalog.json. */
export type PortalSession = GameSession & { readonly games: readonly CatalogEntry[] };

/** /welcome/ runs for a member with no profile, which `enter` would send back there. */
export function enterWelcome(): Promise<{ readonly api: ApiClient; signOut(): Promise<void> }> {
	throw new Error('not implemented');
}

/** A switch with a `never` default, so a new Refusal fails the shell's build until handled. */
export function onRefusal(code: Refusal): 'retry-after-refresh' | 'screen' {
	throw new Error('not implemented');
}

/** /config.json on the admin site. */
export type AdminSiteConfig = {
	readonly authority: string;
	readonly clientId: string;
	/** api://<games4kids-admin>/admin.console */
	readonly consoleScope: string;
	/** api://<games4kids-admin>/admin.elevate */
	readonly elevateScope: string;
	readonly adminApiOrigin: string;
	readonly telemetryConnectionString: string;
};

/** An admin page for one game's admin module: api bound to /api/admin/g/<id>/ with an admin.console token. */
export type AdminGameSession = {
	readonly admin: { readonly email: string };
	readonly api: ApiClient;
	signOut(): Promise<void>;
};

/** The admin site's own pages (members, Entra). Only these can elevate. */
export type AdminPortalSession = AdminGameSession & {
	/** Every game a member can be granted, from the admin site's catalog.json. */
	readonly games: readonly AdminCatalogEntry[];
	/**
	 * One Entra task. Creates a PublicClientApplication with cacheLocation 'memoryStorage', calls acquireTokenPopup
	 * for elevateScope with prompt 'login' and the admin as loginHint, runs `task` with an ApiClient bound to that
	 * token, then clears and drops the instance. A step_up_required or insufficient_claims reply inside the task
	 * reopens the popup once (with the claims) and retries.
	 */
	elevated<T>(task: (api: ApiClient) => Promise<T>): Promise<T>;
};

export function enterAdmin(options: { readonly game: null }): Promise<AdminPortalSession>;
export function enterAdmin(options: { readonly game: string }): Promise<AdminGameSession>;
export function enterAdmin(options: { readonly game: string | null }): Promise<AdminGameSession> {
	throw new Error('not implemented');
}
