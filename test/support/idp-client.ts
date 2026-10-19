import { createHash, randomBytes } from 'node:crypto';
import type { DevStack } from '../../dev/stack.ts';
import { ADMIN_CLIENT_ID, GAMES_CLIENT_ID, TENANT_ID } from '../../dev/stack.ts';

type Sign = { readonly email: string; readonly prompt?: 'login' };

/** What a browser and MSAL do at the fake IdP, without the browser: authorize with PKCE, then redeem the code. */
async function authorizationCodeFlow(stack: DevStack, clientId: string, origin: string, scope: string, sign: Sign): Promise<string> {
	const verifier = randomBytes(32).toString('base64url');
	const authorize = new URL(`${stack.idp.httpOrigin}/${TENANT_ID}/oauth2/v2.0/authorize`);
	const redirectUri = `${origin}/redirect.html`;
	for (const [name, value] of Object.entries({
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: `${scope} openid profile offline_access`,
		response_type: 'code',
		response_mode: 'query',
		state: 'state',
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256',
		...(sign.prompt ? { prompt: sign.prompt } : {}),
	})) {
		authorize.searchParams.set(name, value);
	}
	const signedIn = await fetch(authorize, { method: 'POST', body: new URLSearchParams({ email: sign.email }), redirect: 'manual' });
	const code = new URL(signedIn.headers.get('location') ?? '').searchParams.get('code');
	if (!code) throw new Error(`the fake IdP gave no code (${signedIn.status})`);
	const redeemed = await fetch(`${stack.idp.httpOrigin}/${TENANT_ID}/oauth2/v2.0/token`, {
		method: 'POST',
		body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
	});
	const reply = (await redeemed.json()) as { access_token?: string };
	if (!reply.access_token) throw new Error(`the fake IdP gave no token (${redeemed.status})`);
	return reply.access_token;
}

export const gamesToken = (stack: DevStack, email: string) =>
	authorizationCodeFlow(stack, GAMES_CLIENT_ID, stack.gamesOrigin, `api://${GAMES_CLIENT_ID}/access_as_user`, { email });

export const consoleToken = (stack: DevStack) =>
	authorizationCodeFlow(stack, ADMIN_CLIENT_ID, stack.adminOrigin, `api://${ADMIN_CLIENT_ID}/admin.console`, { email: stack.adminEmail });

/** What the elevation popup returns: admin.elevate, with credentials entered now. */
export const elevationToken = (stack: DevStack) =>
	authorizationCodeFlow(stack, ADMIN_CLIENT_ID, stack.adminOrigin, `api://${ADMIN_CLIENT_ID}/admin.elevate`, { email: stack.adminEmail, prompt: 'login' });

export type Reply = { readonly status: number; readonly headers: Headers; readonly data: unknown };

export async function api(stack: DevStack, method: string, path: string, token?: string, json?: unknown): Promise<Reply> {
	const response = await fetch(`${stack.apiOrigin}${path}`, {
		method,
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
		...(json === undefined ? {} : { body: JSON.stringify(json) }),
	});
	const text = await response.text();
	return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : undefined };
}
