import type { AdminCatalogEntry } from '@g4k/sdk';
import { ApiFailure, createApiClient, type ApiClient } from '../../../shared/api-client.ts';
import { showScreen, stylesheet } from '../../../shared/dom.ts';
import { asGameId, fieldsOf } from '../../../shared/ids.ts';
import { createTelemetry } from '../../../shared/telemetry.ts';
import { mountAdminBar } from './admin-bar.ts';
import { startAdminAuth, type AdminSignedIn, type Elevation } from './auth.ts';
import { loadAdminCatalog, loadAdminConfig, type AdminSiteConfig } from './config.ts';

/** An admin page for one game's admin module: api bound to /api/admin/g/<id>/ with an admin.console token. */
export type AdminGameSession = {
	readonly admin: { readonly email: string };
	readonly api: ApiClient;
	signOut(): Promise<void>;
};

/** The admin site's own pages (members, Entra). Only these can elevate. */
export type AdminPortalSession = AdminGameSession & {
	/** Every game a member can be granted, for the tick boxes. */
	readonly games: readonly AdminCatalogEntry[];
	/**
	 * One Entra task. Opens a popup on a fresh memory-only MSAL instance for admin.elevate with prompt=login, runs
	 * `task` with an ApiClient bound to that token, then clears and drops the instance. A step_up_required or
	 * insufficient_claims reply inside the task reopens the popup once (with the claims) and retries.
	 */
	elevated<T>(task: (api: ApiClient) => Promise<T>): Promise<T>;
};

const never = (): Promise<never> => new Promise(() => {});

const STEP_UPS = ['step_up_required', 'insufficient_claims'];

function elevatedFor(signedIn: AdminSignedIn, config: AdminSiteConfig): AdminPortalSession['elevated'] {
	let ready = signedIn.newElevation();
	return async <T>(task: (api: ApiClient) => Promise<T>): Promise<T> => {
		const elevation: Elevation = await ready;
		ready = signedIn.newElevation();
		try {
			let claims: string | undefined;
			for (let attempt = 1; ; attempt++) {
				const token = await elevation.popup(claims);
				const api = createApiClient({ baseUrl: `${config.adminApiOrigin}/api/admin/portal`, tokens: { token: async () => token, reauthenticate: async () => {} } });
				try {
					return await task(api);
				} catch (error) {
					if (attempt > 1 || !(error instanceof ApiFailure) || !STEP_UPS.includes(error.code)) throw error;
					claims = error.claims;
				}
			}
		} finally {
			await elevation.discard();
		}
	};
}

/**
 * The admin site's one entry. Resolves only for an account with an admins row. Signed out is a redirect to sign in;
 * an account that is not an administrator, or a failure on the way in, gets a screen, and the promise never settles.
 * The page calls ready() once its first data has rendered.
 */
export function enterAdmin(options: { readonly game: null }): Promise<AdminPortalSession>;
export function enterAdmin(options: { readonly game: string }): Promise<AdminGameSession>;
export async function enterAdmin(options: { readonly game: string | null }): Promise<AdminGameSession | AdminPortalSession> {
	try {
		return await admit(options);
	} catch (error) {
		console.error(error);
		showUnreachable();
		return never();
	}
}

const showUnreachable = (): void =>
	showScreen('Something went wrong', 'We could not reach the admin service. Try again in a moment.', [{ label: 'Try again', run: () => location.reload() }]);

async function admit(options: { readonly game: string | null }): Promise<AdminGameSession | AdminPortalSession> {
	const config = await loadAdminConfig();
	stylesheet('/shared/tokens.css');
	stylesheet('/shared/shell.css');
	const auth = await startAdminAuth(config);
	if (!auth.session) return auth.signIn();
	const signedIn = auth.session;
	const portal = createApiClient({ baseUrl: `${config.adminApiOrigin}/api/admin/portal`, tokens: signedIn.tokens });

	let email: string;
	try {
		const me = fieldsOf(await portal.get('me'))['email'];
		if (typeof me !== 'string') throw new Error('GET me answered no email');
		email = me;
	} catch (error) {
		const forbidden = error instanceof ApiFailure && error.code === 'forbidden';
		if (forbidden) showScreen('This account is not an administrator', 'Sign in with the administrator account.', [{ label: 'Sign out', run: signedIn.signOut }]);
		else showUnreachable();
		return never();
	}

	const catalog = await loadAdminCatalog();
	mountAdminBar({ email, games: catalog, signOut: () => void signedIn.signOut() });
	const id = options.game === null ? 'portal' : asGameId(options.game);
	if (!id || (id !== 'portal' && !catalog.some((game) => game.id === id && game.hasAdmin))) {
		showScreen('That game has no admin pages', 'Pick one from the bar above.');
		return never();
	}
	createTelemetry(config.telemetryConnectionString).track({ name: 'page_view', site: 'admin', game: id, user: null });

	const admin = { email };
	if (id === 'portal') return { admin, api: portal, games: catalog, signOut: signedIn.signOut, elevated: elevatedFor(signedIn, config) };
	return { admin, api: createApiClient({ baseUrl: `${config.adminApiOrigin}/api/admin/g/${id}`, tokens: signedIn.tokens }), signOut: signedIn.signOut };
}
