/**
 * The game-facing half (Route, Platform, defineGameApi, HttpError) is packages/sdk/src/api.ts in @g4k/sdk.
 * The rest is packages/host, @g4k/host: the code that turns one game's api into one Azure Functions app,
 * func-g4k-<id>, and the portal routes into func-g4k-portal. Each app bundles the @g4k/host version in its game's
 * package.json, so a host change reaches a game only when that game next ships.
 *
 * A game receives a Platform<typeof manifest>: handles typed from the names it declared, parsed settings,
 * tokens for declared services, a read-only roster. It never receives a credential, a storage client, the
 * environment or @azure/functions. Lint (no @azure/*, jose or process.env in games/x/api) and TS project
 * references (a game project includes only its own folder and references only @g4k/sdk) close the rest. Since
 * each app's identity can reach only its own game's account, a game that got past both would still find no
 * other game's data.
 */

import type { AzureService, ContainerOf, GameId, GameManifest, QueueOf, RoleOf, ServiceOf, SettingSpec, TableOf } from './manifest';
import type { Member, PortalReader, PortalStore, PortalUserId, TrustedIssuer } from './identity';
import type { ContractVersion, GitSha } from './release';
import type { Telemetry, TelemetryOwner } from './telemetry';

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
	/** A line only. The app already holds this call's GameTelemetry, so a game cannot choose its own `game`. */
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
	/** A rung on this game's ladder. The app refuses the call before `run` when the caller's role is lower. */
	readonly access: RoleOf<M>;
};

/** `body` picks how the app parses the request: 415, 413 and 400 come back in the one error shape before `run`. */
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

/** What `defineGameApi` returns and the game's generated app entry imports as `createGameApi`. Called once at startup. */
export type CreateGameApi<M extends GameManifest> = (platform: Platform<M>) => GameApi<M>;

/** Binds the manifest so routes, workers and platform names are checked against it without annotations. */
export function defineGameApi<const M extends GameManifest>(manifest: M, create: CreateGameApi<M>): CreateGameApi<M> {
	throw new Error('not implemented');
}

/**
 * The one error shape on the wire: `{ error, message, problems?, claims? }`. drawpad switches on `error`, letterjoin
 * shows `message`. `claims` comes only with the admin app's 401 reauth_required, for MSAL's acquireTokenRedirect.
 */
export type ApiError = { readonly error: string; readonly message: string; readonly problems?: readonly string[]; readonly claims?: string };

/**
 * The codes an app sends before `run`, in check order. The shell switches on these exhaustively (shell.ts): it
 * signs in again on the first two, claims through the portal app and retries once on not_claimed, and draws a
 * screen for the rest. A game's own HttpError codes are game data and reach the page untouched.
 */
export type Refusal = 'unauthenticated' | 'invalid_token' | 'not_claimed' | 'not_invited' | 'no_profile' | 'not_entitled' | 'forbidden';

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

/** GET <app>/api/g/<id>/health, /api/portal/health and /api/admin/health. Only the app's own pipeline reads it, waiting for its sha. */
export type AppHealth = { readonly owner: TelemetryOwner | 'admin'; readonly version: GitSha; readonly contract: ContractVersion };

/** Transport-neutral, so one app runs under Functions, under the dev node server, and in tests. */
export type HostRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: { get(name: string): string | null };
	readonly query: URLSearchParams;
	readonly json: () => Promise<unknown>;
	readonly bytes: (maxBytes: number) => Promise<Uint8Array>;
};

export type HostReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | string | null };

/** What every app built from @g4k/host exposes to its adapters. */
export type App = {
	/** Under the node adapter, which serves several apps on one port, the app whose prefix matches answers. */
	readonly prefix: `/api/${string}/`;
	handle(request: HostRequest): Promise<HostReply>;
	/**
	 * Flat list for the Functions adapter: one app.http per route, one app.storageQueue per worker, each registered
	 * under functionName(owner, name), so the request row the Functions host writes carries the owner.
	 */
	readonly routes: readonly { readonly functionName: string; readonly absolutePath: string; readonly method: Method }[];
	readonly workers: readonly { readonly functionName: string; readonly queueName: string; readonly run: Worker }[];
};

/** Settings every app reads from its own environment, parsed once at startup. */
export type AppEnv = {
	readonly issuers: readonly TrustedIssuer[];
	readonly telemetry: Telemetry;
	/** The SWA origin. The only Access-Control-Allow-Origin the app ever sends. */
	readonly appOrigin: string;
	readonly version: GitSha;
	readonly contract: ContractVersion;
	readonly now?: () => Date;
};

export type GameAppDeps<M extends GameManifest> = AppEnv & {
	readonly id: GameId;
	readonly manifest: M;
	readonly create: CreateGameApi<M>;
	/** Read only. A game app cannot claim an identity or write a profile, member or grant. */
	readonly portal: PortalReader;
	readonly storage: StorageConfig;
	readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * One game's Function app, func-g4k-<id>, serving /api/g/<id>/*. Startup runs platformFor and create; a throw
 * fails this app's start, so its own pipeline's health check fails and redeploys the pinned package. No other
 * game shares the process, so nothing needs containing.
 *
 * handle, the only auth path in the app, in fixed order. Once the route matches, the rest runs inside
 * telemetry.within({ game: id, route, user: null }), and from admission on inside a nested within with the user:
 *   match route (404) -> verifyToken (401 unauthenticated or invalid_token) -> portal.known (403 not_claimed)
 *   -> active member (403 not_invited) -> profile present (403 no_profile) -> effectiveRole not 'none'
 *   (403 not_entitled) -> atLeast access (403 forbidden) -> parse body (400, 413, 415) -> run
 *   -> HttpError to its status, anything else 500 server_error -> CORS for appOrigin, cache-control no-store
 *   unless a bytes reply set one.
 * GET health needs no token and answers AppHealth.
 */
export function createGameApp<M extends GameManifest>(deps: GameAppDeps<M>): App {
	throw new Error('not implemented');
}

export type PortalAppDeps = AppEnv & {
	readonly portal: PortalStore;
};

/**
 * func-g4k-portal, serving /api/portal/*: me (which claims on a first sign-in), profile, and health. It knows no
 * game, at build time or at run time, and runs no game code. No route reads or changes Entra, and its identity holds no Graph
 * permission. Same fixed order as a game app, with PortalAccess in place of a ladder and game 'portal' on telemetry.
 */
export function createPortalApp(deps: PortalAppDeps): App {
	throw new Error('not implemented');
}

/** The owner of one storage account. Each game has its own, and the portal has one for its tables and the releases container. */
export type StorageOwner = GameId | 'portal';

/**
 * 'azure' and 'azurite' address one account per owner, accountName(owner, suffix). tools/dev.mjs writes Azurite's
 * AZURITE_ACCOUNTS from the dev registry. 'memory' keys its maps by account too, so conformance can see which one a game used.
 */
export type StorageConfig =
	| { readonly kind: 'azure'; readonly suffix: string }
	| { readonly kind: 'azurite'; readonly suffix: string }
	| { readonly kind: 'memory' };

/**
 * drawpad -> g4kdrawpad<suffix>, portal -> g4kportal<suffix>. The suffix is the first five characters of Bicep's
 * uniqueString(resourceGroup().id), so a 16-character GameId still fits Azure's 24. Inside the account, tables,
 * containers and queues keep the names the manifest declared: no owner prefix.
 */
export function accountName(owner: StorageOwner, suffix: string): string {
	throw new Error('not implemented');
}

/**
 * The only function that holds a storage credential. Builds handles against this game's own account only, under the
 * declared names, and parses settings from the environment; a missing required setting throws, so the app does not
 * start. The app's identity holds data roles on this account only, so RBAC agrees with the types.
 */
export function platformFor<M extends GameManifest>(manifest: M, id: GameId, storage: StorageConfig, env: Readonly<Record<string, string | undefined>>, portal: PortalReader): Platform<M> {
	throw new Error('not implemented');
}

/** packages/host/src/adapters/functions.ts, the only importer of @azure/functions. Route prefix '', authLevel anonymous. */
export function registerWithFunctions(app: App): void {
	throw new Error('not implemented');
}

/**
 * packages/host/src/adapters/node.ts. Dev and tests only: tools/dev.mjs serves the portal app and every game app
 * from the dev registry on one port, each answering its own prefix, with the real verifyToken against the fake IdP.
 */
export function serveWithNode(apps: readonly App[], port: number): Promise<{ readonly origin: string; close(): Promise<void> }> {
	throw new Error('not implemented');
}
