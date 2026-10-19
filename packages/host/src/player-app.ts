import { HttpError, type CreatePlayApi, type GameManifest, type Method, type PlayRoute, type Profile } from '@g4k/sdk';
import { failure, json, matcher, notFound, readJson, refuse, runRoute, toHostReply, underPrefix, type App, type HostReply, type HostRequest } from './http.ts';
import { decide, meFor, verifyGamesToken, type Authentication, type PortalAdmission, type PortalReader, type PortalStore } from './identity.ts';
import { playPlatform, requireGameId, type Env, type TokenSource } from './platform.ts';
import type { Accounts } from './storage.ts';
import type { Telemetry } from './telemetry.ts';
import type { TrustedIssuer } from './token.ts';

export type AppEnv = {
	readonly issuers: readonly TrustedIssuer[];
	readonly telemetry: Telemetry;
	readonly now: () => Date;
};

export type PlayerAppDeps<M extends GameManifest> = AppEnv & {
	readonly manifest: M;
	readonly create: CreatePlayApi<M>;
	readonly portal: PortalReader;
	readonly accounts: Accounts;
	readonly tokens: TokenSource;
	readonly env: Env;
};

const ADMISSION_REFUSALS = { 'not-invited': 'not_invited', 'no-profile': 'no_profile', 'not-entitled': 'not_entitled' } as const;

type PlayTarget = { readonly kind: 'health' } | { readonly kind: 'session' } | { readonly kind: 'route'; readonly route: PlayRoute };

/**
 * func-g4k-<id>, serving /api/g/<id>/*. The only auth path, in fixed order: match route (404), verifyGamesToken
 * (401), portal.find and decide (403), parse body (400, 413, 415), run, HttpError to its status, else 500.
 * GET health needs no token. GET session answers the Caller, so a game page wakes only its own app.
 */
export function createPlayerApp<M extends GameManifest>(deps: PlayerAppDeps<M>): App {
	const id = requireGameId(deps.manifest);
	const prefix = `/api/g/${id}/` as const;
	const api = deps.create(playPlatform(deps.manifest, id, { account: deps.accounts.open(id), env: deps.env, tokens: deps.tokens, now: deps.now }));
	const builtIn = [
		{ name: 'health', method: 'GET', path: 'health', target: { kind: 'health' } },
		{ name: 'session', method: 'GET', path: 'session', target: { kind: 'session' } },
	] as const satisfies readonly { name: string; method: Method; path: string; target: PlayTarget }[];
	const routes = [...builtIn, ...api.routes.map((route) => ({ name: route.name, method: route.method, path: route.path, target: { kind: 'route', route } as const }))];
	const match = matcher<PlayTarget>(routes);
	const log = (line: string) => deps.telemetry.log('info', line);

	async function handle(request: HostRequest): Promise<HostReply> {
		try {
			const rest = underPrefix(request.path, prefix);
			const matched = rest === null ? undefined : match(request.method, rest);
			if (!matched) return notFound();
			if (matched.target.kind === 'health') return json(200, { ok: true });
			const auth = await verifyGamesToken(deps.issuers, request.headers.get('authorization'));
			if (!auth.ok) return refuse(auth.code);
			const admission = decide(await deps.portal.find(auth.identity), id);
			if (admission.kind !== 'player') return refuse(ADMISSION_REFUSALS[admission.kind]);
			deps.telemetry.setUser(admission.caller.userId);
			if (matched.target.kind === 'session') return json(200, admission.caller);
			const reply = await runRoute(matched.target.route, request, { params: matched.params, query: request.query, now: deps.now(), log }, { caller: admission.caller });
			return toHostReply(reply);
		} catch (error) {
			return failure(error, deps.telemetry);
		}
	}

	return { prefix, handle, functions: routes.map(({ name, method, path }) => ({ name, method, route: `g/${id}/${path}` })) };
}

const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,23}$/u;

function isTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

export function parseProfile(raw: unknown): Profile | { readonly problems: readonly string[] } {
	const fields = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	const displayName = typeof fields['displayName'] === 'string' ? fields['displayName'].trim() : '';
	const timeZone = typeof fields['timeZone'] === 'string' ? fields['timeZone'] : '';
	const problems = [
		...(DISPLAY_NAME.test(displayName) ? [] : ['displayName must be 1 to 24 letters, numbers, spaces, hyphens or apostrophes']),
		...(isTimeZone(timeZone) ? [] : ['timeZone must be an IANA time zone']),
	];
	return problems.length === 0 ? { displayName, timeZone } : { problems };
}

type PortalTarget = 'health' | 'me' | 'profile';

/** func-g4k-portal, serving /api/portal/*: GET me for home and /welcome/, and PUT profile. It knows no game. */
export function createPortalApp(deps: AppEnv & { readonly portal: PortalStore }): App {
	const prefix = '/api/portal/' as const;
	const routes = [
		{ name: 'health', method: 'GET', path: 'health', target: 'health' },
		{ name: 'me', method: 'GET', path: 'me', target: 'me' },
		{ name: 'profile', method: 'PUT', path: 'profile', target: 'profile' },
	] as const satisfies readonly { name: string; method: Method; path: string; target: PortalTarget }[];
	const match = matcher<PortalTarget>(routes);

	async function admit(request: HostRequest): Promise<{ readonly auth: Extract<Authentication, { ok: true }>; readonly admission: PortalAdmission } | HostReply> {
		const auth = await verifyGamesToken(deps.issuers, request.headers.get('authorization'));
		if (!auth.ok) return refuse(auth.code);
		return { auth, admission: decide(await deps.portal.find(auth.identity), null) };
	}

	async function handle(request: HostRequest): Promise<HostReply> {
		try {
			const rest = underPrefix(request.path, prefix);
			const matched = rest === null ? undefined : match(request.method, rest);
			if (!matched) return notFound();
			if (matched.target === 'health') return json(200, { ok: true });
			const admitted = await admit(request);
			if ('status' in admitted) return admitted;
			const { auth, admission } = admitted;
			if (admission.kind === 'player') deps.telemetry.setUser(admission.caller.userId);
			if (matched.target === 'me') return json(200, meFor(auth.identity, admission));
			if (admission.kind === 'not-invited') return refuse('not_invited');
			const userId = admission.kind === 'player' ? admission.caller.userId : admission.userId;
			const profile = parseProfile(await readJson(request));
			if ('problems' in profile) throw new HttpError(400, 'invalid', 'That name or time zone is not valid.', profile.problems);
			if ((await deps.portal.setProfile(userId, profile)) === 'name_taken') throw new HttpError(409, 'name_taken', 'Someone already has that name.');
			return { status: 204, headers: {}, body: null };
		} catch (error) {
			return failure(error, deps.telemetry);
		}
	}

	return { prefix, handle, functions: routes.map(({ name, method, path }) => ({ name, method, route: `portal/${path}` })) };
}
