import { parseEntraObjectId, type Brand, type EntraObjectId } from '@g4k/sdk';
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** 'entra' today; 'extid' if Entra External ID is added later. */
export type IssuerKey = Brand<string, 'IssuerKey'>;

export const ENTRA: IssuerKey = 'entra' as IssuerKey;

export type TrustedIssuer = {
	readonly key: IssuerKey;
	/** https://login.microsoftonline.com/<tenantId>/v2.0 */
	readonly issuer: string;
	/** The client id this app accepts: games4kids on the games side, games4kids-admin on the admin side. */
	readonly audience: string;
	/** A URL in production; a local key set in tests and the dev stack. */
	readonly keys: URL | JSONWebKeySet;
	readonly tenantId?: string;
};

export function entraIssuer(tenantId: string, audience: string): TrustedIssuer {
	const authority = `https://login.microsoftonline.com/${tenantId}`;
	return { key: ENTRA, issuer: `${authority}/v2.0`, audience, keys: new URL(`${authority}/discovery/v2.0/keys`), tenantId };
}

export type TokenRejection = { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

export type VerifiedToken = {
	readonly ok: true;
	readonly issuer: TrustedIssuer;
	readonly objectId: EntraObjectId;
	readonly scopes: readonly string[];
	readonly claims: JWTPayload;
	readonly raw: string;
};

const keySets = new WeakMap<TrustedIssuer, JWTVerifyGetKey>();

function keySetFor(issuer: TrustedIssuer): JWTVerifyGetKey {
	let keySet = keySets.get(issuer);
	if (!keySet) {
		keySet = issuer.keys instanceof URL ? createRemoteJWKSet(issuer.keys) : createLocalJWKSet(issuer.keys);
		keySets.set(issuer, keySet);
	}
	return keySet;
}

const unauthenticated: TokenRejection = { ok: false, code: 'unauthenticated' };
const invalidToken: TokenRejection = { ok: false, code: 'invalid_token' };

/** RS256, iss, aud, exp, iat, tid, ver 2.0, a GUID oid, and at least one of `acceptedScopes` in scp. */
export async function verifyBearer(
	issuers: readonly TrustedIssuer[],
	authorization: string | null,
	acceptedScopes: readonly string[],
): Promise<VerifiedToken | TokenRejection> {
	const raw = /^Bearer ([\w-]+\.[\w-]+\.[\w-]*)$/.exec(authorization ?? '')?.[1];
	if (!raw) return unauthenticated;
	let iss: unknown;
	try {
		iss = decodeJwt(raw).iss;
	} catch {
		return invalidToken;
	}
	const issuer = issuers.find((candidate) => candidate.issuer === iss);
	if (!issuer) return invalidToken;
	let claims: JWTPayload;
	try {
		({ payload: claims } = await jwtVerify(raw, keySetFor(issuer), {
			issuer: issuer.issuer,
			audience: issuer.audience,
			algorithms: ['RS256'],
			requiredClaims: ['exp', 'iat'],
			clockTolerance: 60,
		}));
	} catch {
		return invalidToken;
	}
	const scopes = typeof claims['scp'] === 'string' ? claims['scp'].split(' ') : [];
	const objectId = parseEntraObjectId(claims['oid']);
	if (
		(issuer.tenantId !== undefined && claims['tid'] !== issuer.tenantId) ||
		claims['ver'] !== '2.0' ||
		!scopes.some((scope) => acceptedScopes.includes(scope)) ||
		!objectId
	) {
		return invalidToken;
	}
	return { ok: true, issuer, objectId, scopes, claims, raw };
}
