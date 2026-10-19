/**
 * shell/ builds the shell artifact for one contract major: /shell/v1/index.js, with MSAL vendored inside, and
 * /shell/v1/theme.css. Every page imports the major it was built against by URL:
 * `import { enter } from '/shell/v1/index.js'`. A static game needs no bundler. A Vite game marks the URL external
 * and gets these types from @g4k/sdk, which declares the '/shell/v1/index.js' module. A minor release replaces
 * v1 in place and only adds; a breaking change ships as /shell/v2/ beside v1 (release.ts, `compatible`). The files
 * are served with no-cache and an ETag, so a page picks up a new minor on its next load.
 *
 * Pages are separate documents on one origin. MSAL caches in sessionStorage, which every path in a tab shares, so
 * moving from / to /g/letterjoin/ gets a token silently. The registration needs https://<site>/ and
 * https://<site>/redirect.html as redirect URIs, for every game, so a new game changes nothing in Entra.
 *
 * The shell also vendors the Application Insights browser SDK at 100 percent sampling. A telemetry initializer stamps
 * every page view with `game` (the id passed to enter, or 'portal') and the PortalUserId, and while a game page
 * is visible enter() sends a ShellEvent 'game_session' every 60 seconds (telemetry.ts). Games add nothing.
 */

import type { Refusal } from './host';
import type { Catalog, CatalogEntry } from './registry';
import type { Me, PortalRole, PortalUserId, Profile } from './identity';

export type EnterOptions<Role extends string = string> = {
	/**
	 * Binds `api` to `${apiBaseUrl}/api/g/<id>/`, with apiBaseUrl from this game's catalog entry. null on portal pages
	 * binds it to the portal app's /api/portal/. 'admin', a reserved id, binds it to the admin app's /api/admin/ and
	 * requires portal admin; only the /admin/ pages pass it.
	 */
	readonly game: string | null;
	/** A rung on the game's ladder, read from catalog.json. Below it, enter() draws "Only admins can open this page". */
	readonly requires?: Role;
};

export type Session<Role extends string = string> = {
	readonly me: {
		readonly userId: PortalUserId;
		readonly profile: Profile;
		readonly portalRole: PortalRole;
		/** The role in this game. On portal pages, the portal role. */
		readonly role: Role;
	};
	readonly api: ApiClient;
	signOut(): Promise<void>;
	/** Signs out and asks Entra for an account picker. For the family iPad passed between children. */
	switchAccount(): Promise<void>;
};

/**
 * Calls the portal app's GET /api/portal/me first, which claims a first sign-in, then reads catalog.json.
 * Resolves only with an active session for this game. Every other state is a screen the shell draws, or a
 * redirect, and the promise never resolves:
 *   signed out        loginRedirect in the top window, back to this page
 *   not invited       "Ask your grown-up to invite you", with the email and a sign-out button
 *   no profile        location = /welcome/?return=<this page>
 *   game hidden       effectiveRole is 'none': "This game is not switched on for you"
 *   below `requires`  "Only admins can open this page"
 */
export function enter<Role extends string = string>(options: EnterOptions<Role>): Promise<Session<Role>> {
	throw new Error('not implemented');
}

/** Thrown by ApiClient for any non-2xx reply, parsed from the one error shape. */
export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly problems: readonly string[] = [],
	) {
		super(message);
	}
}

/**
 * What the ApiClient does with each Refusal a game app sends. A switch with a `never` default, so a new Refusal
 * fails the shell's build until it is handled.
 *   unauthenticated, invalid_token   one forced token refresh and retry, then loginRedirect
 *   not_claimed                      GET /api/portal/me, which claims, then one retry
 *   not_invited, no_profile,         the same screens enter() draws
 *   not_entitled, forbidden
 */
export function onRefusal(code: Refusal): 'retry-after-refresh' | 'retry-after-claim' | 'screen' {
	throw new Error('not implemented');
}

/** Bearer handling and Refusal routing, from drawpad's transport.ts. A game's own error codes come back as ApiFailure. */
export type ApiClient = {
	get<T>(path: string, query?: Readonly<Record<string, string>>): Promise<T>;
	post<T>(path: string, body: unknown): Promise<T>;
	put<T>(path: string, body: unknown): Promise<T>;
	patch<T>(path: string, body: unknown): Promise<T>;
	delete(path: string): Promise<void>;
	sendPng<T>(path: string, png: Uint8Array): Promise<T>;
	/** Fetches a protected image with the token and returns an object URL. drawpad's blobs/cache.ts. */
	objectUrl(path: string): Promise<string>;
};

/** /config.json, written by web-release from the pins. Parsed once by the shell. Games never read it. Game app origins live in catalog.json. */
export type SiteConfig = {
	readonly authorities: readonly { readonly issuer: string; readonly authority: string; readonly clientId: string }[];
	/** func-g4k-portal. */
	readonly portalApiOrigin: string;
	/** func-g4k-admin, called only by the /admin/ pages. */
	readonly adminApiOrigin: string;
	/** Application Insights connection string. Its ingestion endpoint is the one telemetry entry in connect-src. */
	readonly telemetryConnectionString: string;
};

export function parseSiteConfig(raw: unknown): SiteConfig | null {
	throw new Error('not implemented');
}

/**
 * <portal-bar title="Letter Tracing" back="/">. Light-DOM slots, so Preact and plain DOM fill it the same way.
 * Draws the brand, the title, the child's name, Home, the game's admin link for its top role, and sign out.
 */
export declare class PortalBar extends HTMLElement {
	session: Session | null;
}

/** The catalog entries whose effectiveRole for this member is not 'none', with that role. Home and <portal-bar> use it. */
export function visibleGames(catalog: Catalog, me: Extract<Me, { state: 'active' }>): readonly { readonly entry: CatalogEntry; readonly role: string }[] {
	throw new Error('not implemented');
}

/** Home cards for visibleGames. A game without a grant has no card, even for a child who guesses its URL. */
export function mountCatalog(root: HTMLElement, catalog: Catalog, me: Extract<Me, { state: 'active' }>): void {
	throw new Error('not implemented');
}
