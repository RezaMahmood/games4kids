/**
 * The game-facing half (definePlayApi, defineAdminApi, the Route types, the platforms, HttpError) is @g4k/sdk. The
 * rest is @g4k/host: the code that turns a game's play part into its Function app func-g4k-<id>, the portal routes
 * into func-g4k-portal, and every game's admin part into modules of func-g4k-admin (admin.ts).
 *
 * A game never receives a credential, a storage client, the environment or @azure/functions. It receives handles over
 * its own storage account, and which handles can write depends on the side: a player app writes only 'play' storage,
 * the admin app writes only 'admin' and 'admin-private' storage. Each app's identity holds the matching data roles,
 * table by table and container by container, so RBAC agrees with the types.
 */

import type { Caller, Email, EntraObjectId, PortalReader, PortalStore, PortalUserId, Profile, TrustedIssuer } from './identity';
import type { AzureService, GameId, GameManifest, Ownership, SettingSpec, Side } from './manifest';
import type { Telemetry } from './telemetry';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** No headers member: a game sets no CORS, cookie or JSON cache header. A bytes reply may carry an ETag. */
export type Reply =
	| { readonly status: 200 | 201 | 202 | 204; readonly json?: unknown }
	| { readonly status: 200; readonly bytes: Uint8Array; readonly contentType: string; readonly cacheControl?: string; readonly etag?: string }
	| { readonly status: 304 };

type Ctx<Who, Body> = {
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	readonly body: Body;
	readonly now: Date;
	readonly log: (line: string) => void;
} & Who;

type RouteOf<Who> =
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'none'; run(ctx: Ctx<Who, undefined>): Promise<Reply> }
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'json'; run(ctx: Ctx<Who, unknown>): Promise<Reply> }
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'png'; run(ctx: Ctx<Who, Uint8Array>): Promise<Reply> };

/** A player route, mounted at /api/g/<id>/<path> on func-g4k-<id>. There is no access level: every caller is a player of this game. */
export type PlayRoute = RouteOf<{ readonly caller: Caller }>;

/** The admin behind an admin-module request. Only the admin app builds one (admin.ts). */
export type AdminCaller = { readonly objectId: EntraObjectId; readonly email: Email };

/** An admin route, mounted at /api/admin/g/<id>/<path> on func-g4k-admin. */
export type AdminRoute = RouteOf<{ readonly admin: AdminCaller }>;

/** Queue-triggered. Throwing lets the Functions runtime retry up to maxDequeueCount. */
export type Worker = (message: unknown, ctx: { readonly now: Date; readonly log: (line: string) => void; readonly dequeueCount: number }) => Promise<void>;

export type ApiError = { readonly error: string; readonly message: string; readonly problems?: readonly string[] };

/**
 * What a player app sends before `run`, in check order. The games shell switches on these exhaustively. A game's
 * own HttpError codes reach the page untouched.
 */
export type Refusal = 'unauthenticated' | 'invalid_token' | 'not_invited' | 'no_profile' | 'not_entitled';

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

export type ReadTable = {
	get<R extends Row>(partitionKey: string, rowKey: string): Promise<(R & { readonly etag: string }) | undefined>;
	inPartition<R extends Row>(partitionKey: string): Promise<readonly (R & { readonly etag: string })[]>;
	/** No OData filter: the memory account cannot honor one, so a game filters in code. */
	list<R extends Row>(): Promise<readonly (R & { readonly etag: string })[]>;
};

export type Table = ReadTable & {
	put(row: Row): Promise<void>;
	insertIfAbsent(row: Row): Promise<boolean>;
	/** Replace only while the etag matches. false on conflict. */
	replaceIfMatch(row: Row, etag: string): Promise<boolean>;
	remove(partitionKey: string, rowKey: string): Promise<void>;
};

export type ReadBlobs = {
	/** With `ifNoneMatch` equal to the stored ETag, answers 'not-modified', so a bytes route can reply 304. */
	get(path: string, ifNoneMatch?: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string; readonly etag: string } | 'not-modified' | undefined>;
	list(prefix: string): Promise<readonly string[]>;
};

export type Blobs = ReadBlobs & {
	put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(path: string): Promise<void>;
};

export type Queue = { send(message: unknown): Promise<void> };

type Access<O extends Ownership, S extends Side> = S extends 'play'
	? O extends 'play' ? 'write' : O extends 'admin' ? 'read' : never
	: O extends 'play' ? 'read' : 'write';

type Handles<R extends Readonly<Record<string, Ownership>>, S extends Side, W, Rd> = {
	readonly [K in keyof R as [Access<R[K], S>] extends [never] ? never : K]: Access<R[K], S> extends 'write' ? W : Rd;
};

type Writable<R extends Readonly<Record<string, Ownership>>, S extends Side> = {
	readonly [K in keyof R as [Access<R[K], S>] extends [never] ? never : Access<R[K], S> extends 'write' ? K : never]: Queue;
};

/** The handles one side of one game gets over that game's account. Its side decides read or write per name. */
export type StorageFor<M extends GameManifest, S extends Side> = {
	readonly tables: Handles<M['storage']['tables'], S, Table, ReadTable>;
	readonly blobs: Handles<M['storage']['containers'], S, Blobs, ReadBlobs>;
	readonly queues: Writable<M['storage']['queues'], S>;
};

export type Settings<S extends Readonly<Record<string, SettingSpec>>> = {
	readonly [K in keyof S]: S[K] extends { readonly kind: 'int' } ? number : S[K] extends { readonly optional: true } ? string | undefined : string;
};

/** Only the declared services. AzureService has no storage member, so no game holds a storage token. */
export type Tokens<V extends AzureService> = { readonly [K in V]: () => Promise<string> };

type Common = { readonly game: GameId; readonly now: () => Date; readonly newId: () => string };

export type PlayPlatform<M extends GameManifest> = StorageFor<M, 'play'> &
	Common & {
		readonly settings: Settings<M['play']['settings']>;
		readonly tokens: Tokens<M['play']['services'][number]>;
	};

type AdminPart<M extends GameManifest> = NonNullable<M['admin']>;

/** The players granted this game, with display names, for admin screens. No email: the admin app reads emails only for invites. */
export type Roster = { list(): Promise<readonly { readonly userId: PortalUserId; readonly profile: Profile | null }[]> };

export type AdminPlatform<M extends GameManifest> = StorageFor<M, 'admin'> &
	Common & {
		readonly settings: Settings<AdminPart<M>['settings']>;
		readonly tokens: Tokens<AdminPart<M>['services'][number]>;
		readonly roster: Roster;
	};

type WorkerOn<Q extends string> = { readonly queue: Q; readonly run: Worker };

export type PlayApi<M extends GameManifest> = {
	readonly routes: readonly PlayRoute[];
	readonly workers?: readonly WorkerOn<keyof Writable<M['storage']['queues'], 'play'> & string>[];
};

export type AdminApi<M extends GameManifest> = {
	readonly routes: readonly AdminRoute[];
	readonly workers?: readonly WorkerOn<keyof Writable<M['storage']['queues'], 'admin'> & string>[];
};

export type CreatePlayApi<M extends GameManifest> = (platform: PlayPlatform<M>) => PlayApi<M>;
export type CreateAdminApi<M extends GameManifest> = (platform: AdminPlatform<M>) => AdminApi<M>;

/** games/<id>/play/api/index.ts exports `createPlayApi = definePlayApi(manifest, ...)`. */
export function definePlayApi<const M extends GameManifest>(manifest: M, create: CreatePlayApi<M>): CreatePlayApi<M> {
	throw new Error('not implemented');
}

/** games/<id>/admin/api/index.ts exports `createAdminApi = defineAdminApi(manifest, ...)`. */
export function defineAdminApi<const M extends GameManifest>(manifest: M, create: CreateAdminApi<M>): CreateAdminApi<M> {
	throw new Error('not implemented');
}

/** Transport-neutral, so one app runs under Functions, the dev node server, and in tests. */
export type HostRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: { get(name: string): string | null };
	readonly query: URLSearchParams;
	/** Throws HttpError 413 past maxBytes. JSON is parsed from these bytes, so it has a cap too. */
	readonly bytes: (maxBytes: number) => Promise<Uint8Array>;
};

/**
 * No CORS header: each Function app's platform CORS (Bicep, allowedOrigins = its one site origin) is the only CORS
 * mechanism. The dev adapter adds it for the dev origins.
 */
export type HostReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | string | null };

export type App = {
	readonly prefix: `/api/${string}/`;
	handle(request: HostRequest): Promise<HostReply>;
	/** One app.http per route, for the Functions adapter. Queue workers join when a game first declares one. */
	readonly functions: readonly { readonly name: string; readonly method: Method; readonly route: string }[];
};

export type AppEnv = {
	readonly issuers: readonly TrustedIssuer[];
	readonly telemetry: Telemetry;
	readonly now: () => Date;
};

/** The owner of one storage account. */
export type StorageOwner = GameId | 'portal';

export type StorageConfig =
	| { readonly kind: 'azure'; readonly suffix: string }
	| { readonly kind: 'azurite'; readonly suffix: string }
	| { readonly kind: 'memory' };

/** drawpad -> g4kdrawpad<suffix>. The suffix is five characters of uniqueString(resourceGroup().id). */
export function accountName(owner: StorageOwner, suffix: string): string {
	throw new Error('not implemented');
}

/** Full handles over one account. Only the host holds these; a game gets the StorageFor view of its own account. */
export type Account = { table(name: string): Table; container(name: string): Blobs; queue(name: string): Queue };

/**
 * An app takes opened accounts, not a StorageConfig, so a test can read back what each side wrote. The entry turns
 * the StorageConfig into Accounts.
 */
export type Accounts = { open(owner: StorageOwner): Account };

/** A token for one Azure service, from the app's managed identity. */
export type TokenSource = (service: AzureService) => Promise<string>;

/** The game id comes from the manifest, parsed once at startup. */
export type PlayerAppDeps<M extends GameManifest> = AppEnv & {
	readonly manifest: M;
	readonly create: CreatePlayApi<M>;
	readonly portal: PortalReader;
	readonly accounts: Accounts;
	readonly tokens: TokenSource;
	readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * func-g4k-<id>, serving /api/g/<id>/*. The only auth path, in fixed order:
 *   match route (404) -> verifyGamesToken (401) -> portal.find -> decide(found, id): not_invited, no_profile,
 *   not_entitled (403) -> parse body (400, 413, 415) -> run -> HttpError to its status, else 500.
 * Built in: GET session answers the Caller, so a game page needs only its own app on load (one cold start, not two).
 * GET health needs no token. Telemetry needs no game field: this app's cloud_RoleName is func-g4k-<id>.
 */
export function createPlayerApp<M extends GameManifest>(deps: PlayerAppDeps<M>): App {
	throw new Error('not implemented');
}

/**
 * func-g4k-portal, serving /api/portal/*: GET me (meFor over decide(found, null)) for home and /welcome/, and PUT
 * profile. It knows no game and holds no Entra right. A game page never calls it.
 */
export function createPortalApp(deps: AppEnv & { readonly portal: PortalStore }): App {
	throw new Error('not implemented');
}

/** packages/host/src/adapters/functions.ts, the only importer of @azure/functions. */
export function registerWithFunctions(app: App): void {
	throw new Error('not implemented');
}

/** Dev and tests: every app on one port, each answering its prefix, against the fake IdP for both audiences. */
export function serveWithNode(apps: readonly App[], port: number): Promise<{ readonly origin: string; close(): Promise<void> }> {
	throw new Error('not implemented');
}
