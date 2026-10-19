/**
 * The game-facing half (Route, Platform, defineGameApi, HttpError) is packages/sdk/src/api.ts in @g4k/sdk.
 * The rest is host/src: one Azure Functions app that mounts /api/portal/* and every game's /api/g/<id>/*.
 *
 * A game receives a Platform<typeof manifest>: handles typed from the names it declared, parsed settings,
 * tokens for declared services, a read-only roster. It never receives a credential, a storage client, the
 * environment or @azure/functions. Lint (no @azure/*, jose or process.env in games/x/api) and TS project
 * references (a game project includes only its own folder and references only @g4k/sdk) close the rest.
 */

import type { AzureService, ContainerOf, GameId, GameManifest, QueueOf, RoleOf, ServiceOf, SettingSpec, TableOf } from './manifest';
import type { HostStore, Member, PortalUserId, TrustedIssuer } from './identity';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What a handler knows about the person. No token, oid, email or portal role. `userId` is the one sign-in key
 * shared by every game, now and later. A future parent-set policy (identity.ts, portalPolicies) would arrive
 * here as a new readonly field; no game reads a portal table.
 */
export type Caller<M extends GameManifest> = {
	readonly userId: PortalUserId;
	readonly displayName: string;
	readonly timeZone: string;
	/** Already resolved by effectiveRole and already at least the route's `access`. */
	readonly role: RoleOf<M>;
};

export type RouteCtx<M extends GameManifest, Body> = {
	readonly caller: Caller<M>;
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	readonly body: Body;
	readonly now: Date;
	readonly log: (line: string) => void;
};

/** No headers member: a game cannot set CORS, cache policy for JSON, or cookies. */
export type Reply =
	| { readonly status: 200 | 201 | 202 | 204; readonly json?: unknown }
	| { readonly status: 200; readonly bytes: Uint8Array; readonly contentType: string; readonly cacheControl?: string };

type RouteBase<M extends GameManifest> = {
	/** Unique within the game. */
	readonly name: string;
	readonly method: Method;
	/** Relative, Functions template syntax: 'activities/{id}/result' mounts at /api/g/<id>/activities/{id}/result. */
	readonly path: string;
	/** A rung on this game's ladder. The host refuses the call before `run` when the caller's role is lower. */
	readonly access: RoleOf<M>;
};

/** `body` picks how the host parses the request: 415, 413 and 400 come back in the one error shape before `run`. */
export type Route<M extends GameManifest> =
	| (RouteBase<M> & { readonly body: 'none'; run(ctx: RouteCtx<M, undefined>): Promise<Reply> })
	| (RouteBase<M> & { readonly body: 'json'; run(ctx: RouteCtx<M, unknown>): Promise<Reply> })
	| (RouteBase<M> & { readonly body: 'png'; run(ctx: RouteCtx<M, Uint8Array>): Promise<Reply> });

/** Queue-triggered. Throwing lets the Functions runtime retry up to maxDequeueCount. */
export type Worker = (message: unknown, ctx: { readonly now: Date; readonly log: (line: string) => void; readonly dequeueCount: number }) => Promise<void>;

export type GameApi<M extends GameManifest> = {
	readonly routes: readonly Route<M>[];
	readonly workers?: readonly { readonly queue: QueueOf<M>; readonly run: Worker }[];
};

/** What `defineGameApi` returns and the generated registry imports as `createGameApi`. Called once at startup. */
export type CreateGameApi<M extends GameManifest> = (platform: Platform<M>) => GameApi<M>;

/** Binds the manifest so routes, workers and platform names are checked against it without annotations. */
export function defineGameApi<const M extends GameManifest>(manifest: M, create: CreateGameApi<M>): CreateGameApi<M> {
	throw new Error('not implemented');
}

/** The one error shape on the wire: `{ error, message, problems? }`. drawpad switches on `error`, letterjoin shows `message`. */
export type ApiError = { readonly error: string; readonly message: string; readonly problems?: readonly string[] };

export class HttpError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409 | 412 | 413 | 415 | 429 | 502 | 503,
		readonly code: string,
		message: string,
		readonly problems?: readonly string[],
	) {
		super(message);
	}
}

export type Row = { readonly partitionKey: string; readonly rowKey: string; readonly [field: string]: unknown };

/** drawpad's Table<R> wrapper, moved behind the platform. */
export type Table = {
	get<R extends Row>(partitionKey: string, rowKey: string): Promise<(R & { readonly etag: string }) | undefined>;
	put(row: Row): Promise<void>;
	insertIfAbsent(row: Row): Promise<boolean>;
	/** Replace only while the etag matches. false on conflict. */
	replaceIfMatch(row: Row, etag: string): Promise<boolean>;
	remove(partitionKey: string, rowKey: string): Promise<void>;
	inPartition<R extends Row>(partitionKey: string): Promise<readonly (R & { readonly etag: string })[]>;
};

export type Blobs = {
	get(path: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | undefined>;
	put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(path: string): Promise<void>;
	list(prefix: string): Promise<readonly string[]>;
};

export type Queue = { send(message: unknown): Promise<void> };

export type Settings<S extends Readonly<Record<string, SettingSpec>>> = {
	readonly [K in keyof S]: S[K] extends { readonly kind: 'int' } ? number : S[K] extends { readonly optional: true } ? string | undefined : string;
};

/** Only the declared services. AzureService has no storage member, so no game can hold a storage token. */
export type Tokens<V extends AzureService> = { readonly [K in V]: () => Promise<string> };

/** The members granted this game, and portal admins, with their role in it. For admin screens that show children's names. */
export type Roster<M extends GameManifest> = {
	list(): Promise<readonly { readonly userId: PortalUserId; readonly displayName: string; readonly role: RoleOf<M> }[]>;
};

export type Platform<M extends GameManifest> = {
	readonly game: GameId;
	readonly tables: { readonly [K in TableOf<M>]: Table };
	readonly blobs: { readonly [K in ContainerOf<M>]: Blobs };
	readonly queues: { readonly [K in QueueOf<M>]: Queue };
	readonly settings: Settings<M['settings']>;
	readonly tokens: Tokens<ServiceOf<M>>;
	readonly roster: Roster<M>;
	readonly now: () => Date;
	readonly newId: () => string;
};

/** Portal routes run before a profile exists, so their floor has more states than a game ladder. */
export type PortalAccess = 'public' | 'signed-in' | 'member' | 'admin';

export type PortalRoute = {
	readonly name: string;
	readonly method: Method;
	readonly path: string;
	readonly access: PortalAccess;
	readonly body: 'none' | 'json';
	run(ctx: { readonly member: Member | null; readonly params: Readonly<Record<string, string>>; readonly body: unknown; readonly now: Date }): Promise<Reply>;
};

/** A game after startup. `unavailable` games answer every /api/g/<id>/* call with 503 game_unavailable. */
export type Mounted =
	| { readonly state: 'ok'; readonly manifest: GameManifest; readonly api: GameApi<GameManifest> }
	| { readonly state: 'unavailable'; readonly manifest: GameManifest; readonly reason: string };

/** GET /api/portal/health. tools/deploy.mjs verify fails the deploy unless every game is ok and the version matches. */
export type Health = {
	readonly version: string;
	readonly games: readonly { readonly id: GameId; readonly state: 'ok' | 'unavailable'; readonly reason?: string }[];
};

export type HostDeps = {
	readonly issuers: readonly TrustedIssuer[];
	readonly identities: HostStore;
	readonly games: readonly Mounted[];
	readonly portal: readonly PortalRoute[];
	/** The SWA origin. The only Access-Control-Allow-Origin the host ever sends. */
	readonly appOrigin: string;
	readonly version: string;
	readonly now?: () => Date;
};

/** Transport-neutral, so one host runs under Functions, under the dev node server, and in tests. */
export type HostRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: { get(name: string): string | null };
	readonly query: URLSearchParams;
	readonly json: () => Promise<unknown>;
	readonly bytes: (maxBytes: number) => Promise<Uint8Array>;
};

export type HostReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | string | null };

export type Host = {
	/**
	 * Fixed order, the only auth path in the repo:
	 *   match route (404) -> verifyToken (401) -> find + decide, claim if planned (403 not_invited)
	 *   -> profile present (403 no_profile) -> effectiveRole not 'none' (403 not_entitled) -> atLeast access (403 forbidden)
	 *   -> parse body (400, 413, 415) -> run -> HttpError to its status, anything else 500 server_error
	 *   -> CORS for appOrigin, cache-control no-store unless a bytes reply set one.
	 */
	handle(request: HostRequest, log: (line: string) => void): Promise<HostReply>;
	readonly health: Health;
	/** Flat list for the Functions adapter: one app.http per route, one app.storageQueue per worker. */
	readonly routes: readonly { readonly absolutePath: string; readonly method: Method }[];
	readonly workers: readonly { readonly queueName: string; readonly run: Worker }[];
};

export function createHost(deps: HostDeps): Host {
	throw new Error('not implemented');
}

export type StorageConfig =
	| { readonly kind: 'account'; readonly accountName: string }
	| { readonly kind: 'connection-string'; readonly connectionString: string }
	| { readonly kind: 'memory' };

/** drawpad + pictures -> drawpadPictures. */
export function tableName(owner: GameId | 'portal', declared: string): string {
	throw new Error('not implemented');
}

/** drawpad + stencil-jobs -> drawpad-stencil-jobs. Containers and queues share the rule. */
export function containerOrQueueName(owner: GameId | 'portal', declared: string): string {
	throw new Error('not implemented');
}

/**
 * The only function that holds a storage credential. Builds handles bound to prefixed names and parses
 * settings from the environment; a missing required setting throws, which mountGames contains.
 */
export function platformFor<M extends GameManifest>(manifest: M, id: GameId, storage: StorageConfig, env: Readonly<Record<string, string | undefined>>, identities: HostStore): Platform<M> {
	throw new Error('not implemented');
}

/**
 * Startup containment. For each registry entry: platformFor, then createGameApi, inside one try/catch. A throw
 * marks that game unavailable and the others mount. Module evaluation is not covered: registry imports are
 * static, so a game whose module throws on import fails the whole app, and CI catches that before deploy.
 */
export function mountGames(entries: readonly import('./registry').RegistryEntry[], build: (manifest: GameManifest, id: GameId) => Platform<GameManifest>): readonly Mounted[] {
	throw new Error('not implemented');
}

/** host/src/adapters/functions.ts, the only importer of @azure/functions. Route prefix '', authLevel anonymous. */
export function registerWithFunctions(host: Host): void {
	throw new Error('not implemented');
}

/** host/src/adapters/node.ts. The same host behind node:http, for tools/dev.mjs and Playwright. */
export function serveWithNode(host: Host, port: number): Promise<{ readonly origin: string; close(): Promise<void> }> {
	throw new Error('not implemented');
}

/**
 * Portal routes: me, profile and health. Invites, grants, revokes and drift live in the admin Function app
 * (admin.ts). No route here reads or changes Entra, and the host's identity holds no Graph permission.
 */
export function portalRoutes(identities: HostStore, manifests: readonly GameManifest[], health: () => Health): readonly PortalRoute[] {
	throw new Error('not implemented');
}
