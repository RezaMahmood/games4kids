import type { ApiError, Refusal } from '@g4k/sdk';
import { report as reportFault } from './telemetry.ts';

/** Thrown for any non-2xx reply, parsed from the one error shape every app sends. */
export class ApiFailure extends Error {
	readonly status: number;
	readonly code: string;
	readonly problems: readonly string[];
	readonly claims: string | undefined;

	constructor(status: number, code: string, message: string, problems: readonly string[] = [], claims?: string) {
		super(message);
		this.name = 'ApiFailure';
		this.status = status;
		this.code = code;
		this.problems = problems;
		this.claims = claims;
	}
}

export type SendOptions = {
	/** fetch keepalive, for a heartbeat or a practice report sent as the page is hidden. */
	readonly keepalive?: true;
};

export type ApiClient = {
	get<T>(path: string, query?: Readonly<Record<string, string>>): Promise<T>;
	post<T>(path: string, body: unknown, options?: SendOptions): Promise<T>;
	put<T>(path: string, body: unknown, options?: SendOptions): Promise<T>;
	patch<T>(path: string, body: unknown): Promise<T>;
	delete(path: string): Promise<void>;
	sendPng<T>(path: string, png: Uint8Array): Promise<T>;
	sendJpeg<T>(path: string, jpeg: Uint8Array): Promise<T>;
	/** An authenticated request that hands back the Response as it is, 304 and errors included, for a cache that revalidates with ETags itself. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** A protected image as an object URL. Keeps the ETag and sends If-None-Match, so a 304 reuses the cached bytes. */
	objectUrl(path: string): Promise<string>;
};

export type TokenSource = {
	/** Null means nobody is signed in. */
	token(options: { readonly forceRefresh: boolean }): Promise<string | null>;
	/** Starts a sign-in unless one just happened, so a rejected token cannot loop. */
	reauthenticate(): Promise<void>;
};

/** `report` hears every failure, and the page's reporter decides which are faults. */
type Options = { readonly baseUrl: string; readonly tokens: TokenSource; readonly fetchImpl?: typeof fetch; readonly report?: (error: unknown) => void };

const TOKEN_REFUSALS = ['unauthenticated', 'invalid_token'] as const satisfies readonly Refusal[];

const isTokenRefusal = (code: unknown) => TOKEN_REFUSALS.some((refusal) => refusal === code);

function isApiError(value: unknown): value is ApiError {
	return typeof value === 'object' && value !== null && typeof (value as ApiError).error === 'string' && typeof (value as ApiError).message === 'string';
}

async function readError(response: Response): Promise<ApiFailure> {
	const body: unknown = await response.json().catch(() => null);
	if (!isApiError(body)) return new ApiFailure(response.status, `http_${response.status}`, 'Something went wrong.');
	return new ApiFailure(response.status, body.error, body.message, body.problems ?? [], body.claims);
}

type CachedImage = { readonly etag: string | null; readonly url: string };

export function createApiClient({ baseUrl, tokens, fetchImpl, report = reportFault }: Options): ApiClient {
	const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
	const images = new Map<string, CachedImage>();
	const urlFor = (path: string, query?: Readonly<Record<string, string>>) => {
		const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
		return `${baseUrl}/${path.replace(/^\//, '')}${search}`;
	};

	async function attempt(url: string, init: RequestInit, forceRefresh: boolean): Promise<Response | null> {
		const token = await tokens.token({ forceRefresh });
		if (token === null) return null;
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${token}`);
		return doFetch(url, { ...init, headers });
	}

	const refusedToken = async (response: Response) => response.status === 401 && isTokenRefusal(((await response.clone().json().catch(() => null)) as Partial<ApiError> | null)?.error);

	const reported = <T>(work: Promise<T>): Promise<T> =>
		work.catch((error: unknown) => {
			report(error);
			throw error;
		});

	function send(url: string, init: RequestInit = {}): Promise<Response> {
		return reported(sendOnce(url, init));
	}

	async function sendOnce(url: string, init: RequestInit): Promise<Response> {
		const signedOut = () => new ApiFailure(401, 'unauthenticated', 'Sign in to continue.');
		const first = await attempt(url, init, false);
		if (first === null) throw signedOut();
		if (!(await refusedToken(first))) return first;
		const retried = await attempt(url, init, true);
		if (retried === null) throw signedOut();
		if (await refusedToken(retried)) await tokens.reauthenticate();
		return retried;
	}

	async function failed(response: Response): Promise<ApiFailure> {
		const failure = await readError(response);
		report(failure);
		return failure;
	}

	async function parsed<T>(response: Response): Promise<T> {
		if (!response.ok) throw await failed(response);
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	const withJson = (method: string, body: unknown, options?: SendOptions): RequestInit => ({
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		...(options?.keepalive ? { keepalive: true } : {}),
	});

	return {
		async get(path, query) {
			return parsed(await send(urlFor(path, query)));
		},
		async post(path, body, options) {
			return parsed(await send(urlFor(path), withJson('POST', body, options)));
		},
		async put(path, body, options) {
			return parsed(await send(urlFor(path), withJson('PUT', body, options)));
		},
		async patch(path, body) {
			return parsed(await send(urlFor(path), withJson('PATCH', body)));
		},
		async delete(path) {
			await parsed(await send(urlFor(path), { method: 'DELETE' }));
		},
		async sendPng(path, png) {
			return parsed(await send(urlFor(path), { method: 'POST', headers: { 'content-type': 'image/png' }, body: png as BodyInit }));
		},
		async sendJpeg(path, jpeg) {
			return parsed(await send(urlFor(path), { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg as BodyInit }));
		},
		request(path, init) {
			return send(urlFor(path), init);
		},
		async objectUrl(path) {
			const cached = images.get(path);
			const response = await send(urlFor(path), cached?.etag ? { headers: { 'if-none-match': cached.etag } } : {});
			if (response.status === 304 && cached) return cached.url;
			if (!response.ok) throw await failed(response);
			if (cached) URL.revokeObjectURL(cached.url);
			const url = URL.createObjectURL(await response.blob());
			images.set(path, { etag: response.headers.get('etag'), url });
			return url;
		},
	};
}
