import type { TokenSource } from '../../../shared/api-client.ts';
import { knownAuthorities, loadMsal } from '../../../shared/msal.ts';
import type { GamesSiteConfig } from './config.ts';

export type SignedIn = {
	readonly tokens: TokenSource;
	signOut(): Promise<void>;
	/** Clears this tab's sign-in and asks Entra for an account picker, for the family iPad passed between children. */
	switchAccount(): Promise<void>;
};

export type GamesAuth = { readonly session: SignedIn | null; signIn(): Promise<never> };

const REAUTH_KEY = 'g4k:reauthenticated-at';
const REAUTH_PAUSE_MS = 10_000;

function recentlyReauthenticated(now: number): boolean {
	try {
		const last = Number(sessionStorage.getItem(REAUTH_KEY) ?? 0);
		if (now - last < REAUTH_PAUSE_MS) return true;
		sessionStorage.setItem(REAUTH_KEY, String(now));
	} catch {
		return false;
	}
	return false;
}

const never = (): Promise<never> => new Promise(() => {});

/**
 * MSAL with the games4kids client and the access_as_user scope, cached in sessionStorage so every path in a tab
 * shares it. This module knows no other scope and no other origin, so a games page cannot ask for an admin token.
 */
export async function startGamesAuth(config: GamesSiteConfig): Promise<GamesAuth> {
	const msal = await loadMsal();
	const home = `${location.origin}/`;
	const app = new msal.PublicClientApplication({
		auth: {
			clientId: config.clientId,
			authority: config.authority,
			knownAuthorities: knownAuthorities(config.authority),
			redirectUri: home,
			postLogoutRedirectUri: home,
			navigateToLoginRequestUrl: true,
		},
		cache: { cacheLocation: 'sessionStorage' },
	});
	await app.initialize();
	const scopes = [config.scope];
	const signIn = async (): Promise<never> => {
		await app.loginRedirect({ scopes, redirectStartPage: location.href });
		return never();
	};

	const redirected = await app.handleRedirectPromise();
	const account = redirected?.account ?? app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
	if (!account) return { session: null, signIn };
	app.setActiveAccount(account);

	return {
		signIn,
		session: {
			tokens: {
				async token({ forceRefresh }) {
					try {
						return (await app.acquireTokenSilent({ scopes, account, forceRefresh, redirectUri: `${location.origin}/redirect.html` })).accessToken;
					} catch (error) {
						if (!(error instanceof msal.InteractionRequiredAuthError)) throw error;
						await app.acquireTokenRedirect({ scopes, account, redirectStartPage: location.href });
						return never();
					}
				},
				async reauthenticate() {
					if (!recentlyReauthenticated(Date.now())) await app.acquireTokenRedirect({ scopes, account, redirectStartPage: location.href });
				},
			},
			signOut: () => app.logoutRedirect({ account }),
			async switchAccount() {
				await app.clearCache();
				await app.loginRedirect({ scopes, prompt: 'select_account', redirectStartPage: home });
			},
		},
	};
}
