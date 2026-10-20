import { createHash, createVerify, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONWebKeySet } from 'jose';
import { createDirectory, type Directory } from './directory.ts';
import { FAKE_GRAPH_TOKEN_PREFIX } from './fake-graph.ts';

export type IdpClient = {
	readonly id: string;
	/** The site's origin: the only CORS origin, and the only post-logout destination, for this client. */
	readonly origin: string;
	readonly redirectUris: readonly string[];
	/** The admin registration puts auth_time in its access tokens (an optional claim set by bootstrap). */
	readonly authTimeClaim: boolean;
};

export type FakeIdpOptions = {
	/** Browsers need an https authority, so MSAL gets this port. */
	readonly httpsPort: number;
	/** The same endpoints over http, for the server-side OBO exchange, which would otherwise need to trust the self-signed certificate. */
	readonly httpPort: number;
	readonly tenantId: string;
	readonly clients: readonly IdpClient[];
	readonly directory?: Directory;
	readonly tokenTtlSec?: number;
};

export type FakeIdpControls = {
	/** The next `count` grants for a client with the admin.elevate scope carry an auth_time this old, as a stale single sign-on session would. */
	staleAuthTime: { minutes: number; count: number } | null;
	/** The next OBO exchange answers interaction_required with these claims. */
	oboClaims: string | null;
};

type Grant = {
	readonly email: string;
	readonly authTime: number;
	readonly clientId: string;
	readonly scope: string;
	readonly nonce: string | null;
	readonly challenge: string | null;
	readonly redirectUri: string;
};

const b64 = (value: string | object) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const html = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function selfSignedCert() {
	const dir = mkdtempSync(join(tmpdir(), 'g4k-fake-idp-'));
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
	return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Entra's v2 endpoints for the local stack and the e2e tests only: one tenant, one key, a token per client audience. */
export async function startFakeIdp(options: FakeIdpOptions) {
	const directory = options.directory ?? createDirectory();
	const ttl = options.tokenTtlSec ?? 3600;
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const kid = randomUUID();
	const jwks: JSONWebKeySet = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };
	const origin = `https://localhost:${options.httpsPort}`;
	const authority = `${origin}/${options.tenantId}`;
	const issuer = `${authority}/v2.0`;
	const codes = new Map<string, Grant>();
	const refreshTokens = new Map<string, Grant>();
	const controls: FakeIdpControls = { staleAuthTime: null, oboClaims: null };
	const authorizations: { readonly clientId: string; readonly prompt: string | null; readonly scope: string }[] = [];

	const jwt = (claims: object) => {
		const input = `${b64({ typ: 'JWT', alg: 'RS256', kid })}.${b64(claims)}`;
		return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
	};
	const clientOf = (id: string | null) => options.clients.find((client) => client.id === id);
	const oidFor = (email: string) => (directory.byEmail(email) ?? directory.add({ mail: email, guest: false })).id;

	function tokens(grant: Grant, includeIdToken: boolean) {
		const client = clientOf(grant.clientId);
		if (!client) throw new Error('unknown client');
		const now = Math.floor(Date.now() / 1000);
		const person = directory.byEmail(grant.email);
		const oid = oidFor(grant.email);
		const prefix = `api://${client.id}/`;
		const scp = grant.scope.split(' ').filter((scope) => scope.startsWith(prefix)).map((scope) => scope.slice(prefix.length)).join(' ');
		const common = { iss: issuer, tid: options.tenantId, oid, sub: oid, iat: now, nbf: now, exp: now + ttl, ver: '2.0' };
		const stale = controls.staleAuthTime && scp.includes('admin.elevate') ? controls.staleAuthTime : null;
		if (stale && --stale.count <= 0) controls.staleAuthTime = null;
		const refresh = randomBytes(24).toString('base64url');
		refreshTokens.set(refresh, grant);
		return {
			token_type: 'Bearer',
			scope: grant.scope,
			expires_in: ttl,
			ext_expires_in: ttl,
			access_token: jwt({
				...common,
				aud: client.id,
				azp: client.id,
				scp,
				email: grant.email,
				upn: person?.upn ?? grant.email,
				preferred_username: grant.email,
				...(client.authTimeClaim ? { auth_time: stale ? now - stale.minutes * 60 : grant.authTime } : {}),
			}),
			...(includeIdToken ? { id_token: jwt({ ...common, aud: client.id, nonce: grant.nonce ?? undefined, name: grant.email.split('@')[0], preferred_username: grant.email }) } : {}),
			refresh_token: refresh,
			client_info: b64({ uid: oid, utid: options.tenantId }),
		};
	}

	const base = `/${options.tenantId}`;
	const config = {
		issuer,
		authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
		token_endpoint: `${authority}/oauth2/v2.0/token`,
		end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
		jwks_uri: `${authority}/discovery/v2.0/keys`,
		response_modes_supported: ['query', 'fragment', 'form_post'],
		response_types_supported: ['code'],
		scopes_supported: ['openid', 'profile', 'offline_access'],
		subject_types_supported: ['pairwise'],
		id_token_signing_alg_values_supported: ['RS256'],
		code_challenge_methods_supported: ['S256'],
		tenant_region_scope: 'EU',
		cloud_instance_name: 'localhost',
	};

	const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
		res.end(JSON.stringify(body));
	};

	function redirectWith(res: ServerResponse, params: Record<string, string>, query: URLSearchParams) {
		const target = new URL(query.get('redirect_uri') ?? '');
		const pairs = new URLSearchParams({ ...params, state: query.get('state') ?? '' });
		if (query.get('response_mode') === 'query') target.search = pairs.toString();
		else target.hash = pairs.toString();
		res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }).end();
	}

	const session = (req: IncomingMessage): { readonly email: string; readonly authTime: number } | null => {
		const raw = /(?:^|;\s*)fake_idp_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
		try {
			const parsed = JSON.parse(Buffer.from(decodeURIComponent(raw ?? ''), 'base64url').toString('utf8')) as { email?: unknown; authTime?: unknown };
			return typeof parsed.email === 'string' && typeof parsed.authTime === 'number' ? { email: parsed.email, authTime: parsed.authTime } : null;
		} catch {
			return null;
		}
	};

	function issueCode(query: URLSearchParams, email: string, authTime: number): string {
		const code = randomBytes(24).toString('base64url');
		codes.set(code, { email, authTime, clientId: query.get('client_id') ?? '', scope: query.get('scope') ?? '', nonce: query.get('nonce'), challenge: query.get('code_challenge'), redirectUri: query.get('redirect_uri') ?? '' });
		return code;
	}

	async function authorize(req: IncomingMessage, res: ServerResponse, url: URL) {
		const query = url.searchParams;
		const client = clientOf(query.get('client_id'));
		if (!client || !client.redirectUris.includes(query.get('redirect_uri') ?? '')) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
		const prompt = query.get('prompt');
		if (req.method === 'POST') {
			const email = (await readForm(req)).get('email')?.trim().toLowerCase() ?? '';
			const authTime = Math.floor(Date.now() / 1000);
			const cookie = encodeURIComponent(Buffer.from(JSON.stringify({ email, authTime })).toString('base64url'));
			res.setHeader('set-cookie', `fake_idp_session=${cookie}; Path=/; Secure; HttpOnly; SameSite=None`);
			authorizations.push({ clientId: client.id, prompt, scope: query.get('scope') ?? '' });
			return redirectWith(res, { code: issueCode(query, email, authTime), client_info: b64({ uid: oidFor(email), utid: options.tenantId }) }, query);
		}
		const existing = session(req);
		if (prompt === 'none') {
			if (!existing) return redirectWith(res, { error: 'login_required', error_description: 'no session' }, query);
			authorizations.push({ clientId: client.id, prompt, scope: query.get('scope') ?? '' });
			return redirectWith(res, { code: issueCode(query, existing.email, existing.authTime) }, query);
		}
		if (existing && prompt !== 'login' && prompt !== 'select_account') {
			authorizations.push({ clientId: client.id, prompt, scope: query.get('scope') ?? '' });
			return redirectWith(res, { code: issueCode(query, existing.email, existing.authTime) }, query);
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake Entra sign-in</title></head>
<body><main><h1>Fake Entra sign-in (local only)</h1><p>${prompt === 'login' ? 'Credentials are required again for this task.' : 'Choose who is signing in.'}</p>
<form method="post" action="${html(url.pathname + url.search)}"><p><label for="email">Email</label> <input id="email" name="email" type="email" value="${html(query.get('login_hint') ?? '')}" required></p>
<button id="signin" type="submit">Sign in</button></form></main></body></html>`);
	}

	function verifiedAssertion(token: string, client: IdpClient): { readonly oid: string } | null {
		const [head, body, signature] = token.split('.');
		if (!head || !body || !signature) return null;
		const verifier = createVerify('sha256').update(`${head}.${body}`);
		if (!verifier.verify(publicKey, Buffer.from(signature, 'base64url'))) return null;
		const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { aud?: string; oid?: string; exp?: number; scp?: string };
		const live = typeof claims.exp === 'number' && claims.exp > Date.now() / 1000;
		return claims.aud === client.id && live && typeof claims.oid === 'string' && claims.scp?.includes('admin.elevate') ? { oid: claims.oid } : null;
	}

	async function token(req: IncomingMessage, res: ServerResponse) {
		const form = await readForm(req);
		const client = clientOf(form.get('client_id'));
		if (!client) return json(res, 400, { error: 'invalid_client' });
		switch (form.get('grant_type')) {
			case 'authorization_code': {
				const code = form.get('code') ?? '';
				const grant = codes.get(code);
				codes.delete(code);
				const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
				if (!grant || grant.redirectUri !== form.get('redirect_uri') || grant.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
				return json(res, 200, tokens(grant, true));
			}
			case 'refresh_token': {
				const grant = refreshTokens.get(form.get('refresh_token') ?? '');
				return grant ? json(res, 200, tokens({ ...grant, scope: form.get('scope') ?? grant.scope }, false)) : json(res, 400, { error: 'invalid_grant' });
			}
			case 'urn:ietf:params:oauth:grant-type:jwt-bearer': {
				if (form.get('requested_token_use') !== 'on_behalf_of' || !form.get('client_assertion')) return json(res, 400, { error: 'invalid_request' });
				const caller = verifiedAssertion(form.get('assertion') ?? '', client);
				if (!caller) return json(res, 400, { error: 'invalid_grant', error_description: 'the assertion is not a live admin.elevate token for this client' });
				if (controls.oboClaims) {
					const claims = controls.oboClaims;
					controls.oboClaims = null;
					return json(res, 400, { error: 'interaction_required', suberror: 'basic_action', claims });
				}
				return json(res, 200, { token_type: 'Bearer', expires_in: 3600, access_token: `${FAKE_GRAPH_TOKEN_PREFIX}${caller.oid}` });
			}
			default:
				return json(res, 400, { error: 'unsupported_grant_type' });
		}
	}

	function control(res: ServerResponse, url: URL) {
		const query = url.searchParams;
		switch (url.pathname) {
			case '/__control/stale-auth-time':
				controls.staleAuthTime = { minutes: Number(query.get('minutes') ?? 11), count: Number(query.get('count') ?? 1) };
				return json(res, 200, controls);
			case '/__control/obo-claims':
				controls.oboClaims = query.get('claims') ?? '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
				return json(res, 200, controls);
			case '/__control/authorizations':
				return json(res, 200, authorizations);
			default:
				return json(res, 404, { error: 'not_found' });
		}
	}

	async function handle(req: IncomingMessage, res: ServerResponse, viaHttp: boolean) {
		const url = new URL(req.url ?? '/', origin);
		const allowedOrigin = options.clients.find((client) => client.origin === req.headers.origin)?.origin;
		if (allowedOrigin) res.setHeader('access-control-allow-origin', allowedOrigin);
		if (req.method === 'OPTIONS') return void res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '') }).end();
		if (url.pathname.startsWith('/__control/') && viaHttp) return control(res, url);
		const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
		if (path === '/v2.0/.well-known/openid-configuration' || path === '/.well-known/openid-configuration') return json(res, 200, config);
		if (path === '/discovery/v2.0/keys') return json(res, 200, jwks);
		if (path === '/oauth2/v2.0/authorize') return authorize(req, res, url);
		if (path === '/oauth2/v2.0/token' && req.method === 'POST') return token(req, res);
		if (path === '/oauth2/v2.0/logout') {
			const back = url.searchParams.get('post_logout_redirect_uri');
			const allowed = options.clients.some((client) => back?.startsWith(client.origin));
			res.writeHead(302, { location: allowed && back ? back : (options.clients[0]?.origin ?? '/'), 'set-cookie': 'fake_idp_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None' });
			return void res.end();
		}
		return json(res, 404, { error: 'not_found' });
	}

	const https = createHttpsServer(selfSignedCert(), (req, res) => void handle(req, res, false));
	const http = createHttpServer((req, res) => void handle(req, res, true));
	await Promise.all([
		new Promise<void>((resolve) => https.listen(options.httpsPort, 'localhost', resolve)),
		new Promise<void>((resolve) => http.listen(options.httpPort, 'localhost', resolve)),
	]);
	const close = (server: typeof https | typeof http) => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections()));
	return {
		origin,
		authority,
		issuer,
		jwks,
		httpOrigin: `http://localhost:${options.httpPort}`,
		directory,
		controls,
		authorizations,
		close: () => Promise.all([close(https), close(http)]).then(() => undefined),
	};
}

export type FakeIdp = Awaited<ReturnType<typeof startFakeIdp>>;
