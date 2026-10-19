import type { PublicClientApplication } from '@azure/msal-browser';
import type { TokenSource } from '../../../shared/api-client.ts';
import { knownAuthorities, loadMsal, type Msal } from '../../../shared/msal.ts';
import type { AdminSiteConfig } from './config.ts';

export type AdminSignedIn = {
	readonly email: string;
	/** Everyday work: an admin.console token that the backend never exchanges for Graph. */
	readonly tokens: TokenSource;
	signOut(): Promise<void>;
	/** A fresh elevation instance each time: memory-only cache, so nothing it holds outlives the task. */
	newElevation(): Promise<Elevation>;
};

/** One Entra task's sign-in. `popup` asks for credentials every time (prompt=login). */
export type Elevation = {
	popup(claims?: string): Promise<string>;
	discard(): Promise<void>;
};

export type AdminAuth = { readonly session: AdminSignedIn | null; signIn(): Promise<never> };

const never = (): Promise<never> => new Promise(() => {});

function clientFor(msal: Msal, config: AdminSiteConfig, cacheLocation: 'sessionStorage' | 'memoryStorage'): PublicClientApplication {
	return new msal.PublicClientApplication({
		auth: {
			clientId: config.clientId,
			authority: config.authority,
			knownAuthorities: knownAuthorities(config.authority),
			redirectUri: cacheLocation === 'memoryStorage' ? `${location.origin}/redirect.html` : `${location.origin}/`,
			postLogoutRedirectUri: `${location.origin}/`,
			navigateToLoginRequestUrl: true,
		},
		cache: { cacheLocation },
	});
}

/**
 * Two MSAL instances for one registration. The console instance lives in sessionStorage and only ever asks for
 * admin.console. An elevation instance is memory-only (so it needs a popup, redirect is not supported there) and asks
 * for admin.elevate with prompt=login, which forces credentials and negates single sign-on.
 */
export async function startAdminAuth(config: AdminSiteConfig): Promise<AdminAuth> {
	const msal = await loadMsal();
	const app = clientFor(msal, config, 'sessionStorage');
	await app.initialize();
	const scopes = [config.consoleScope];
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
			email: account.username,
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
				reauthenticate: async () => void (await app.acquireTokenRedirect({ scopes, account, redirectStartPage: location.href })),
			},
			signOut: () => app.logoutRedirect({ account }),
			async newElevation() {
				const elevation = clientFor(msal, config, 'memoryStorage');
				await elevation.initialize();
				return {
					async popup(claims) {
						const result = await elevation.acquireTokenPopup({
							scopes: [config.elevateScope],
							prompt: 'login',
							loginHint: account.username,
							redirectUri: `${location.origin}/redirect.html`,
							...(claims ? { claims } : {}),
						});
						return result.accessToken;
					},
					discard: () => elevation.clearCache(),
				};
			},
		},
	};
}
