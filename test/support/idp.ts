import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { ENTRA, type TrustedIssuer } from '@g4k/host';

export const TENANT = '11111111-2222-4333-8444-555555555555';
export const GAMES_CLIENT = 'aaaaaaaa-0000-4000-8000-000000000001';
export const ADMIN_CLIENT = 'aaaaaaaa-0000-4000-8000-000000000002';

type Signer = { readonly issuer: string; sign(claims: JWTPayload): Promise<string> };

async function signer(issuer: string): Promise<Signer & { readonly jwk: object }> {
	const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
	const kid = randomUUID();
	const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
	return {
		issuer,
		jwk,
		sign: (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(privateKey),
	};
}

export type TokenOptions = {
	readonly audience?: string;
	readonly scp?: string;
	readonly email?: string;
	readonly authTime?: Date;
	readonly lifetimeSeconds?: number;
	readonly claims?: JWTPayload;
};

/**
 * Entra in one process: one tenant and key signs tokens for both audiences, exactly as Entra does, so only the aud
 * and scp checks keep the two apps apart. `untrusted` signs with another key under another issuer.
 */
export async function fakeIdp() {
	const issuerUrl = `https://login.microsoftonline.com/${TENANT}/v2.0`;
	const trusted = await signer(issuerUrl);
	const untrusted = await signer('https://evil.example.com/v2.0');
	const keys = { keys: [trusted.jwk] };
	const games: TrustedIssuer = { key: ENTRA, issuer: issuerUrl, audience: GAMES_CLIENT, keys, tenantId: TENANT };
	const admin: TrustedIssuer = { key: ENTRA, issuer: issuerUrl, audience: ADMIN_CLIENT, keys, tenantId: TENANT };

	function claimsFor(objectId: string, defaults: { audience: string; scp: string }, options: TokenOptions): JWTPayload {
		const now = Math.floor(Date.now() / 1000);
		return {
			aud: options.audience ?? defaults.audience,
			tid: TENANT,
			oid: objectId,
			sub: objectId,
			ver: '2.0',
			scp: options.scp ?? defaults.scp,
			iat: now,
			nbf: now,
			exp: now + (options.lifetimeSeconds ?? 3600),
			...(options.email ? { email: options.email } : {}),
			...(options.authTime ? { auth_time: Math.floor(options.authTime.getTime() / 1000) } : {}),
			...options.claims,
		};
	}

	return {
		games,
		admin,
		gamesToken: (objectId: string, options: TokenOptions = {}) =>
			trusted.sign({ iss: issuerUrl, ...claimsFor(objectId, { audience: GAMES_CLIENT, scp: 'access_as_user' }, options) }),
		adminToken: (objectId: string, options: TokenOptions = {}) =>
			trusted.sign({ iss: issuerUrl, ...claimsFor(objectId, { audience: ADMIN_CLIENT, scp: 'admin.console' }, options) }),
		untrustedToken: (objectId: string) =>
			untrusted.sign({ iss: untrusted.issuer, ...claimsFor(objectId, { audience: GAMES_CLIENT, scp: 'access_as_user' }, {}) }),
	};
}

export type FakeIdp = Awaited<ReturnType<typeof fakeIdp>>;
