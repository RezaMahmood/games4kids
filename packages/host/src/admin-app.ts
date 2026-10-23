import { randomUUID } from 'node:crypto';
import { HttpError, parsePortalUserId, type AdminApi, type AdminRoute, type CreateAdminApi, type GameId, type GameManifest, type Method, type Reply, type Roster, type Worker } from '@g4k/sdk';
import {
	ELEVATION_MAX_AGE_SECONDS,
	elevate,
	openAdminSession,
	parseAccessChange,
	parseMemberRequest,
	parsePauseChange,
	saveMember,
	setAccess,
	verifyAdminToken,
	type AdminSession,
	type AdminStore,
	type GameState,
} from './admin.ts';
import { checkEntra, EntraRefused, syncEntra, type GraphFor, type OboGraph } from './entra.ts';
import { apiError, failure, json, matcher, notFound, readJson, refuse, runRoute, toHostReply, underPrefix, type App, type AppWorker, type HostReply, type HostRequest } from './http.ts';
import { adminPlatform, areasOf, requireGameId, type Env, type TokenSource } from './platform.ts';
import { rosterOf } from './portal-tables.ts';
import type { Accounts } from './storage.ts';
import { adminFunctionName, type Telemetry } from './telemetry.ts';
import type { TrustedIssuer } from './token.ts';
import { usageLedger, type UsageLedger } from './usage.ts';

/** What the admin app lends a game's admin module: that game's account, its settings, tokens, roster and AI cost ledger. */
export type ModuleHost = {
	readonly accounts: Accounts;
	readonly env: Env;
	readonly tokens: TokenSource;
	readonly now: () => Date;
	readonly roster: (game: GameId) => Roster;
	readonly usage: UsageLedger;
};

/** What a mounted module hands the app: its routes, and its queue workers with the queue names widened so a list can hold them. */
export type MountedModule = { readonly routes: readonly AdminRoute[]; readonly workers: readonly { readonly queue: string; readonly run: Worker }[] };

/** One game's admin part. The manifest's literal types stay inside `mount`, so the app can hold a list of them. */
export type AdminModule = { readonly id: GameId; mount(host: ModuleHost): MountedModule };

export function adminModule<M extends GameManifest>(manifest: M, create: CreateAdminApi<M>): AdminModule {
	const id = requireGameId(manifest);
	return {
		id,
		mount(host) {
			const platformHost = { account: host.accounts.open(id), env: host.env, tokens: host.tokens, now: host.now };
			const api: AdminApi<M> = create(adminPlatform(manifest, id, platformHost, host.roster(id), host.usage.forGame(id, areasOf(manifest))));
			return { routes: api.routes, workers: api.workers ?? [] };
		},
	};
}

/** The app settings prefix of a game's queue account connection: DRAWPAD_STORAGE__queueServiceUri and its credential settings. */
export const workerConnection = (game: GameId): string => `${game.toUpperCase()}_STORAGE`;

export type AdminAppDeps = {
	readonly issuer: TrustedIssuer;
	readonly telemetry: Telemetry;
	readonly now: () => Date;
	readonly store: AdminStore;
	readonly graph: GraphFor;
	/** Every game a member can be granted, with or without an admin part. */
	readonly games: readonly GameId[];
	readonly modules: readonly AdminModule[];
	readonly accounts: Accounts;
	readonly tokens: TokenSource;
	readonly env: Env;
	/** The games site origin, the invitation redirect. */
	readonly gamesOrigin: string;
};

type Request = { readonly session: AdminSession; readonly params: Readonly<Record<string, string>>; readonly request: HostRequest };

type AdminTarget =
	| { readonly kind: 'health' }
	| { readonly kind: 'console'; run(ctx: Request): Promise<Reply> }
	| { readonly kind: 'elevated'; run(ctx: Request & { readonly graph: OboGraph }): Promise<Reply> }
	| { readonly kind: 'game'; readonly game: GameId; readonly route: AdminRoute };

type Entry = { readonly owner: GameId | 'portal'; readonly name: string; readonly method: Method; readonly path: string; readonly target: AdminTarget };

const STEP_UP = `Bearer error="insufficient_user_authentication", error_description="Sign in again to change Entra.", max_age="${ELEVATION_MAX_AGE_SECONDS}"`;

function entraRefusal(error: EntraRefused): HostReply {
	const { refusal } = error;
	switch (refusal.kind) {
		case 'claims_challenge':
			return apiError(
				401,
				{ error: 'insufficient_claims', message: 'Sign in again to continue.', claims: refusal.claims },
				{ 'www-authenticate': `Bearer error="insufficient_claims", claims="${Buffer.from(refusal.claims).toString('base64')}"` },
			);
		case 'entra_forbidden':
			return apiError(403, { error: 'entra_forbidden', message: `Entra refused ${refusal.call}.` });
	}
}

/**
 * func-g4k-admin, serving /api/admin/*. Fixed order: match route (404), verifyAdminToken (401), openAdminSession
 * (403 forbidden), for the two elevated routes elevate (401 step-up) and graph, parse body (400), run.
 */
export function createAdminApp(deps: AdminAppDeps): App {
	const prefix = '/api/admin/' as const;
	const known = deps.games;
	const portal: readonly Entry[] = [
		{ owner: 'portal', name: 'health', method: 'GET', path: 'portal/health', target: { kind: 'health' } },
		{
			owner: 'portal',
			name: 'me',
			method: 'GET',
			path: 'portal/me',
			target: { kind: 'console', run: async ({ session }) => ({ status: 200, json: { email: session.admin.email } }) },
		},
		{
			owner: 'portal',
			name: 'members-list',
			method: 'GET',
			path: 'portal/members',
			target: { kind: 'console', run: async () => ({ status: 200, json: await deps.store.rows() }) },
		},
		{
			owner: 'portal',
			name: 'members-save',
			method: 'POST',
			path: 'portal/members',
			target: {
				kind: 'console',
				async run({ session, request }) {
					const parsed = parseMemberRequest(await readJson(request), known);
					if ('problems' in parsed) throw new HttpError(400, 'invalid', 'That member is not valid.', parsed.problems);
					return { status: 201, json: await saveMember(parsed, session, deps.store) };
				},
			},
		},
		{
			owner: 'portal',
			name: 'members-access',
			method: 'PUT',
			path: 'portal/members/{userId}',
			target: {
				kind: 'console',
				async run({ session, params, request }) {
					const userId = parsePortalUserId(params['userId']);
					if (!userId) throw new HttpError(404, 'not_found', 'That member does not exist.');
					const change = parseAccessChange(await readJson(request), known);
					if ('problems' in change) throw new HttpError(400, 'invalid', 'That change is not valid.', change.problems);
					return { status: 200, json: await setAccess(userId, change, session, deps.store) };
				},
			},
		},
		{
			owner: 'portal',
			name: 'games-list',
			method: 'GET',
			path: 'portal/games',
			target: {
				kind: 'console',
				async run() {
					const paused = await deps.store.paused();
					return { status: 200, json: known.map((id): GameState => ({ id, paused: paused.has(id) })) };
				},
			},
		},
		{
			owner: 'portal',
			name: 'games-pause',
			method: 'PUT',
			path: 'portal/games/{gameId}',
			target: {
				kind: 'console',
				async run({ params, request }) {
					const id = known.find((game) => game === params['gameId']);
					if (!id) throw new HttpError(404, 'not_found', 'That game does not exist.');
					const paused = parsePauseChange(await readJson(request));
					if (typeof paused !== 'boolean') throw new HttpError(400, 'invalid', 'That change is not valid.', paused.problems);
					await deps.store.setPaused(id, paused);
					return { status: 200, json: { id, paused } satisfies GameState };
				},
			},
		},
		{
			owner: 'portal',
			name: 'entra-check',
			method: 'GET',
			path: 'portal/entra',
			target: { kind: 'elevated', run: async ({ graph }) => ({ status: 200, json: await checkEntra(graph, deps.store) }) },
		},
		{
			owner: 'portal',
			name: 'entra-sync',
			method: 'POST',
			path: 'portal/entra/sync',
			target: {
				kind: 'elevated',
				async run({ graph, request }) {
					const body = await readJson(request);
					const raw = typeof body === 'object' && body !== null && 'userId' in body ? body.userId : null;
					const only = raw === null ? null : parsePortalUserId(raw);
					if (raw !== null && !only) throw new HttpError(400, 'invalid', 'userId must be a member id or null.');
					return { status: 200, json: await syncEntra(graph, deps.store, only, `${deps.gamesOrigin}/`) };
				},
			},
		},
	];
	const usage = usageLedger(deps.accounts.open('portal').table('aiusage'), { now: deps.now, newId: randomUUID, telemetry: deps.telemetry });
	const host: ModuleHost = { accounts: deps.accounts, env: deps.env, tokens: deps.tokens, now: deps.now, roster: (game: GameId) => rosterOf(deps.store, game), usage };
	const mounted = deps.modules.map((module) => ({ module, ...module.mount(host) }));
	const games: readonly Entry[] = mounted.flatMap(({ module, routes }) =>
		routes.map((route) => ({
			owner: module.id,
			name: route.name,
			method: route.method,
			path: `g/${module.id}/${route.path}`,
			target: { kind: 'game', game: module.id, route } as const,
		})),
	);
	const workers: readonly AppWorker[] = mounted.flatMap(({ module, workers: list }) =>
		list.map(({ queue, run }) => ({
			name: adminFunctionName(module.id, `worker-${queue}`),
			game: module.id,
			queue,
			connection: workerConnection(module.id),
			async run(message, { dequeueCount }) {
				try {
					await run(message, { now: deps.now(), log, dequeueCount });
				} catch (error) {
					deps.telemetry.exception(error);
					throw error;
				}
			},
		})),
	);
	const entries = [...portal, ...games];
	const match = matcher(entries);
	const log = (line: string) => deps.telemetry.log('info', line);

	async function dispatch(target: Exclude<AdminTarget, { kind: 'health' }>, ctx: Request): Promise<HostReply> {
		switch (target.kind) {
			case 'console':
				return toHostReply(await target.run(ctx));
			case 'elevated': {
				const elevation = elevate(ctx.session, deps.now());
				if ('kind' in elevation) return apiError(401, { error: elevation.kind, message: 'Sign in again to change Entra.' }, { 'www-authenticate': STEP_UP });
				return toHostReply(await target.run({ ...ctx, graph: deps.graph(elevation) }));
			}
			case 'game': {
				const admin = { objectId: ctx.session.admin.objectId, email: ctx.session.admin.email };
				return toHostReply(await runRoute(target.route, ctx.request, { params: ctx.params, query: ctx.request.query, now: deps.now(), log }, { admin }));
			}
		}
	}

	async function handle(request: HostRequest): Promise<HostReply> {
		try {
			const rest = underPrefix(request.path, prefix);
			const matched = rest === null ? undefined : match(request.method, rest);
			if (!matched) return notFound();
			deps.telemetry.setRoute(`${prefix}${matched.path}`);
			if (matched.target.kind === 'health') return json(200, { ok: true });
			const auth = await verifyAdminToken(deps.issuer, request.headers.get('authorization'));
			if (!auth.ok) return refuse(auth.code);
			const session = await openAdminSession(auth.token, deps.store);
			if (session === 'forbidden') return apiError(403, { error: 'forbidden', message: 'This account is not an administrator.' });
			return await dispatch(matched.target, { session, params: matched.params, request });
		} catch (error) {
			if (error instanceof EntraRefused) {
				if (error.refusal.kind === 'entra_forbidden') deps.telemetry.exception(error);
				return entraRefusal(error);
			}
			return failure(error, deps.telemetry);
		}
	}

	return { prefix, handle, functions: entries.map(({ owner, name, method, path }) => ({ name: adminFunctionName(owner, name), method, route: path })), workers };
}
