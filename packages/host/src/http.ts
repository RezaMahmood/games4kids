import { HttpError, type ApiError, type Ctx, type GameId, type Method, type Refusal, type Reply, type RouteOf } from '@g4k/sdk';
import type { Telemetry } from './telemetry.ts';

/** Transport-neutral, so one app runs under Functions, the dev node server, and in tests. */
export type HostRequest = {
	readonly method: string;
	readonly path: string;
	readonly headers: { get(name: string): string | null };
	readonly query: URLSearchParams;
	/** Throws HttpError 413 past maxBytes. */
	readonly bytes: (maxBytes: number) => Promise<Uint8Array>;
};

/** No CORS header: each Function app's platform CORS is the only CORS mechanism. */
export type HostReply = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | string | null };

/** One app.http registration for the Functions adapter. `route` is relative to the app's host.json route prefix: `api` for player apps, `api/admin` for the admin app, because Functions refuses any route that starts with `admin`. */
export type AppFunction = { readonly name: string; readonly method: Method; readonly route: string };

/** One queue-triggered function. `connection` names the app settings prefix that holds the queue account's identity-based connection. */
export type AppWorker = {
	readonly name: string;
	readonly game: GameId;
	readonly queue: string;
	readonly connection: string;
	run(message: unknown, context: { readonly dequeueCount: number }): Promise<void>;
};

export type App = {
	readonly prefix: `/api/${string}/`;
	handle(request: HostRequest): Promise<HostReply>;
	readonly functions: readonly AppFunction[];
	readonly workers?: readonly AppWorker[];
};

export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_PNG_BYTES = 4 * 1024 * 1024;
export const MAX_JPEG_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export function json(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): HostReply {
	return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(value) };
}

export function apiError(status: number, error: ApiError, headers: Readonly<Record<string, string>> = {}): HostReply {
	return json(status, error, headers);
}

const REFUSALS: { readonly [R in Refusal]: { readonly status: 401 | 403; readonly message: string } } = {
	unauthenticated: { status: 401, message: 'Sign in to continue.' },
	invalid_token: { status: 401, message: 'Your sign-in is not valid or has expired. Sign in again.' },
	not_invited: { status: 403, message: 'Ask your grown-up to invite you.' },
	no_profile: { status: 403, message: 'Choose your name first.' },
	not_entitled: { status: 403, message: 'This game is not switched on for you.' },
	game_paused: { status: 403, message: 'This game is having a rest. Try again later.' },
};

export function refuse(refusal: Refusal): HostReply {
	const { status, message } = REFUSALS[refusal];
	return apiError(status, { error: refusal, message });
}

export const notFound = (): HostReply => apiError(404, { error: 'not_found', message: 'There is nothing here.' });

/** HttpError keeps its status and code, and telemetry records it when it is a 5xx. Anything else is a 500 that names nothing internal. */
export function failure(error: unknown, telemetry: Telemetry): HostReply {
	if (error instanceof HttpError) {
		if (error.status >= 500) telemetry.exception(error);
		return apiError(error.status, { error: error.code, message: error.message, ...(error.problems ? { problems: error.problems } : {}) });
	}
	telemetry.exception(error);
	return apiError(500, { error: 'internal', message: 'Something went wrong.' });
}

export function toHostReply(reply: Reply): HostReply {
	if (reply.status === 304) return { status: 304, headers: {}, body: null };
	if ('bytes' in reply) {
		const headers: Record<string, string> = { 'content-type': reply.contentType };
		if (reply.cacheControl) headers['cache-control'] = reply.cacheControl;
		if (reply.etag) headers['etag'] = reply.etag;
		return { status: 200, headers, body: reply.bytes };
	}
	return reply.json === undefined ? { status: reply.status, headers: {}, body: null } : json(reply.status, reply.json);
}

type Segment = { readonly literal: string } | { readonly param: string };

export type Matcher<T> = (method: string, path: string) => { readonly target: T; readonly path: string; readonly params: Readonly<Record<string, string>> } | undefined;

/** Paths like `limits/{userId}`. First match wins, so a caller lists literal routes before parameterised ones. */
export function matcher<T>(routes: readonly { readonly method: Method; readonly path: string; readonly target: T }[]): Matcher<T> {
	const compiled = routes.map((route) => ({
		...route,
		segments: route.path.split('/').map((part): Segment => {
			const param = /^\{(\w+)\}$/.exec(part)?.[1];
			return param ? { param } : { literal: part };
		}),
	}));
	return (method, path) => {
		const parts = path.split('/');
		for (const route of compiled) {
			if (route.method !== method || route.segments.length !== parts.length) continue;
			const params: Record<string, string> = {};
			const matches = route.segments.every((segment, i) => {
				const part = parts[i] ?? '';
				if ('literal' in segment) return segment.literal === part;
				if (part === '') return false;
				params[segment.param] = decodeURIComponent(part);
				return true;
			});
			if (matches) return { target: route.target, path: route.path, params };
		}
		return undefined;
	};
}

export async function readJson(request: HostRequest): Promise<unknown> {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
		throw new HttpError(415, 'unsupported_media_type', 'Send JSON.');
	}
	const text = new TextDecoder().decode(await request.bytes(MAX_JSON_BYTES));
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
	}
}

async function readPng(request: HostRequest): Promise<Uint8Array> {
	if (request.headers.get('content-type')?.toLowerCase() !== 'image/png') throw new HttpError(415, 'unsupported_media_type', 'Send a PNG.');
	const bytes = await request.bytes(MAX_PNG_BYTES);
	if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new HttpError(415, 'unsupported_media_type', 'That is not a PNG.');
	return bytes;
}

async function readJpeg(request: HostRequest): Promise<Uint8Array> {
	if (request.headers.get('content-type')?.toLowerCase() !== 'image/jpeg') throw new HttpError(415, 'unsupported_media_type', 'Send a JPEG.');
	const bytes = await request.bytes(MAX_JPEG_BYTES);
	if (!JPEG_SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new HttpError(415, 'unsupported_media_type', 'That is not a JPEG.');
	return bytes;
}

type Base = { readonly params: Readonly<Record<string, string>>; readonly query: URLSearchParams; readonly now: Date; readonly log: (line: string) => void };

/** Parses the body the route declared, then runs it. */
export async function runRoute<Who>(route: RouteOf<Who>, request: HostRequest, base: Base, who: Who): Promise<Reply> {
	const context = { ...base, ifNoneMatch: request.headers.get('if-none-match') ?? undefined };
	switch (route.body) {
		case 'none':
			return route.run({ ...context, body: undefined, ...who } satisfies Ctx<Who, undefined>);
		case 'json':
			return route.run({ ...context, body: await readJson(request), ...who } satisfies Ctx<Who, unknown>);
		case 'png':
			return route.run({ ...context, body: await readPng(request), ...who } satisfies Ctx<Who, Uint8Array>);
		case 'jpeg':
			return route.run({ ...context, body: await readJpeg(request), ...who } satisfies Ctx<Who, Uint8Array>);
	}
}

/** The part of the path after the app's prefix, or null when the request is not this app's. */
export function underPrefix(path: string, prefix: string): string | null {
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
