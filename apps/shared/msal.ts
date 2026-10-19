export type Msal = typeof import('@azure/msal-browser');

const VENDORED = new URL('./vendor/msal-browser.min.js', import.meta.url).href;

/** MSAL.js is vendored beside the shell, so the page's CSP needs no third-party script source. */
export async function loadMsal(): Promise<Msal> {
	const loaded = () => (globalThis as { msal?: Msal }).msal;
	if (!loaded()) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = VENDORED;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('MSAL did not load.'));
			document.head.append(script);
		});
	}
	const msal = loaded();
	if (typeof msal?.PublicClientApplication !== 'function') throw new Error('MSAL did not load.');
	return msal;
}

/** A custom authority (the dev stack's fake IdP) must be trusted explicitly; Entra's own needs nothing. */
export function knownAuthorities(authority: string): string[] {
	const { host } = new URL(authority);
	return host === 'login.microsoftonline.com' ? [] : [host];
}
