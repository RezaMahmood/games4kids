import type { GameUsage } from './usage.ts';
import type { AdminCaller, Caller, PortalUserId, Profile } from './identity.ts';
import type { AiAreas, AreaOf, AzureService, GameId, GameManifest, Ownership, SettingSpec, Side, StorageDeclaration } from './manifest.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** No headers member: a game sets no CORS, cookie or JSON cache header. A bytes reply may carry an ETag. */
export type Reply =
	| { readonly status: 200 | 201 | 202 | 204; readonly json?: unknown }
	| { readonly status: 200; readonly bytes: Uint8Array; readonly contentType: string; readonly cacheControl?: string; readonly etag?: string }
	| { readonly status: 304 };

export type Ctx<Who, Body> = {
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
	readonly body: Body;
	readonly now: Date;
	/** The request's If-None-Match, for a bytes route that answers 304 through ReadBlobs.get. */
	readonly ifNoneMatch: string | undefined;
	readonly log: (line: string) => void;
} & Who;

export type BodyKind = 'none' | 'json' | 'png' | 'jpeg';

export type RouteOf<Who> =
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'none'; run(ctx: Ctx<Who, undefined>): Promise<Reply> }
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'json'; run(ctx: Ctx<Who, unknown>): Promise<Reply> }
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'png'; run(ctx: Ctx<Who, Uint8Array>): Promise<Reply> }
	| { readonly name: string; readonly method: Method; readonly path: string; readonly body: 'jpeg'; run(ctx: Ctx<Who, Uint8Array>): Promise<Reply> };

/** Mounted at /api/g/<id>/<path> on func-g4k-<id>. No access level: every caller is a player of this game. */
export type PlayRoute = RouteOf<{ readonly caller: Caller }>;

/** Mounted at /api/admin/g/<id>/<path> on func-g4k-admin. */
export type AdminRoute = RouteOf<{ readonly admin: AdminCaller }>;

/** Queue-triggered. Throwing lets the Functions runtime retry up to maxDequeueCount. */
export type Worker = (message: unknown, ctx: { readonly now: Date; readonly log: (line: string) => void; readonly dequeueCount: number }) => Promise<void>;

/** The one error body every app sends. */
export type ApiError = {
	readonly error: string;
	readonly message: string;
	readonly problems?: readonly string[];
	/** Only on insufficient_claims: the claims challenge, also in WWW-Authenticate, which a page on another origin cannot read. */
	readonly claims?: string;
};

/** What a player app sends before `run`, in check order. A game's own HttpError codes reach the page untouched. */
export type Refusal = 'unauthenticated' | 'invalid_token' | 'not_invited' | 'no_profile' | 'not_entitled' | 'game_paused';

export type HttpErrorStatus = 400 | 403 | 404 | 409 | 412 | 413 | 415 | 429 | 502 | 503;

export class HttpError extends Error {
	readonly status: HttpErrorStatus;
	readonly code: string;
	readonly problems: readonly string[] | undefined;

	constructor(status: HttpErrorStatus, code: string, message: string, problems?: readonly string[]) {
		super(message);
		this.status = status;
		this.code = code;
		this.problems = problems;
	}
}

export type Row = { readonly partitionKey: string; readonly rowKey: string; readonly [field: string]: unknown };

export type Stored<R extends Row> = R & { readonly etag: string };

export type ReadTable = {
	get<R extends Row>(partitionKey: string, rowKey: string): Promise<Stored<R> | undefined>;
	inPartition<R extends Row>(partitionKey: string): Promise<readonly Stored<R>[]>;
	list<R extends Row>(): Promise<readonly Stored<R>[]>;
};

export type Table = ReadTable & {
	put(row: Row): Promise<void>;
	insertIfAbsent(row: Row): Promise<boolean>;
	/** Replace only while the etag matches. false on conflict. */
	replaceIfMatch(row: Row, etag: string): Promise<boolean>;
	remove(partitionKey: string, rowKey: string): Promise<void>;
};

export type Blob = { readonly bytes: Uint8Array; readonly contentType: string; readonly etag: string };

export type ReadBlobs = {
	/** With `ifNoneMatch` equal to the stored ETag, answers 'not-modified', so a bytes route can reply 304. */
	get(path: string, ifNoneMatch?: string): Promise<Blob | 'not-modified' | undefined>;
	list(prefix: string): Promise<readonly string[]>;
};

export type Blobs = ReadBlobs & {
	put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	remove(path: string): Promise<void>;
};

export type Queue = { send(message: unknown): Promise<void> };

/** The access one side has to one owned name. `never` means no handle at all. */
export type Access<O extends Ownership, S extends Side> = S extends 'play'
	? O extends 'play' ? 'write' : O extends 'admin' ? 'read' : never
	: O extends 'play' ? 'read' : 'write';

type Handles<R extends StorageDeclaration, S extends Side, W, Rd> = {
	readonly [K in keyof R as [Access<R[K], S>] extends [never] ? never : K]: Access<R[K], S> extends 'write' ? W : Rd;
};

type Writable<R extends StorageDeclaration, S extends Side> = {
	readonly [K in keyof R as [Access<R[K], S>] extends [never] ? never : Access<R[K], S> extends 'write' ? K : never]: Queue;
};

/** The handles one side of one game gets over that game's account. Its side decides read or write per name. */
export type StorageFor<M extends GameManifest, S extends Side> = {
	readonly tables: Handles<M['storage']['tables'], S, Table, ReadTable>;
	readonly blobs: Handles<M['storage']['containers'], S, Blobs, ReadBlobs>;
	readonly queues: Writable<M['storage']['queues'], S>;
};

export type Settings<S extends Readonly<Record<string, SettingSpec>>> = {
	readonly [K in keyof S]: S[K] extends { readonly kind: 'int' }
		? number
		: (S[K] extends { readonly kind: 'choice'; readonly values: readonly (infer V)[] } ? V : string) | (S[K] extends { readonly optional: true } ? undefined : never);
};

/** Only the declared services. AzureService has no storage member, so no game holds a storage token. */
export type Tokens<V extends AzureService> = { readonly [K in V]: () => Promise<string> };

type Common = { readonly game: GameId; readonly now: () => Date; readonly newId: () => string };

export type PlayPlatform<M extends GameManifest> = StorageFor<M, 'play'> &
	Common & {
		readonly settings: Settings<M['play']['settings']>;
		readonly tokens: Tokens<M['play']['services'][number]>;
	} & (M['play'] extends { readonly ai: AiAreas } ? { /** The player app's AI cost ledger, in this game's own account. */ readonly usage: GameUsage<AreaOf<M, 'play'>> } : unknown);

type AdminPart<M extends GameManifest> = NonNullable<M['admin']>;

/** The players granted this game, with display names. No email. */
export type Roster = { list(): Promise<readonly { readonly userId: PortalUserId; readonly profile: Profile | null }[]> };

export type AdminPlatform<M extends GameManifest> = StorageFor<M, 'admin'> &
	Common & {
		readonly settings: Settings<AdminPart<M>['settings']>;
		readonly tokens: Tokens<AdminPart<M>['services'][number]>;
		readonly roster: Roster;
		/** The admin app's AI cost ledger, a portal table. */
		readonly usage: GameUsage<AreaOf<M>>;
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
export function definePlayApi<const M extends GameManifest>(_manifest: M, create: CreatePlayApi<M>): CreatePlayApi<M> {
	return create;
}

/** games/<id>/admin/api/index.ts exports `createAdminApi = defineAdminApi(manifest, ...)`. */
export function defineAdminApi<const M extends GameManifest>(_manifest: M, create: CreateAdminApi<M>): CreateAdminApi<M> {
	return create;
}
