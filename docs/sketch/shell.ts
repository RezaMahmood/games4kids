/**
 * shell/ builds one ESM file, dist/site/shell/v1.js, with MSAL vendored inside, plus /shell/theme.css. Every page
 * on the site imports it by URL: `import { enter } from '/shell/v1.js'`. A static game needs no bundler. A Vite
 * game marks the URL external and gets these types from @g4k/sdk, which declares the '/shell/v1.js' module.
 *
 * Pages are separate documents on one origin. MSAL caches in sessionStorage, which every path in a tab shares, so
 * moving from / to /g/letterjoin/ gets a token silently. The registration needs https://<site>/ and
 * https://<site>/redirect.html as redirect URIs, for every game.
 */

import type { Catalog } from './registry';
import type { Me, PortalRole, PortalUserId, Profile } from './identity';

export type EnterOptions<Role extends string = string> = {
	/**
	 * Binds `api` to /api/g/<id>/. null on portal pages binds it to /api/portal/. 'admin', a reserved id, binds it
	 * to the admin Function app's /api/admin/ and requires portal admin; only the /admin/ pages pass it.
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

/** Bearer handling, one retry on 401 with a forced token refresh, then re-authentication. drawpad's transport.ts. */
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

/** /config.json, written at deploy. Parsed once by the shell. Games never read it. */
export type SiteConfig = {
	readonly authorities: readonly { readonly issuer: string; readonly authority: string; readonly clientId: string }[];
	/** The host Function app. */
	readonly apiOrigin: string;
	/** The admin Function app, called only by the /admin/ pages. */
	readonly adminApiOrigin: string;
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

/** Home cards from catalog.json, filtered to the games in `me.games`, which holds only granted games. */
export function mountCatalog(root: HTMLElement, catalog: Catalog, me: Extract<Me, { state: 'active' }>): void {
	throw new Error('not implemented');
}
