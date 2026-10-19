// CommonJS: Node 22 does not detect every named export, so the module is imported whole.
import azureFunctions, { type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { HttpError } from '@g4k/sdk';
import type { App, HostReply, HostRequest } from '../http.ts';

export function toHostRequest(request: HttpRequest): HostRequest {
	const url = new URL(request.url);
	const tooLarge = () => new HttpError(413, 'too_large', 'That is too big to send.');
	return {
		method: request.method,
		path: url.pathname,
		headers: request.headers,
		query: url.searchParams,
		async bytes(maxBytes) {
			if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw tooLarge();
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (bytes.byteLength > maxBytes) throw tooLarge();
			return bytes;
		},
	};
}

export function toResponse(reply: HostReply): HttpResponseInit {
	return { status: reply.status, headers: reply.headers, ...(reply.body === null ? {} : { body: reply.body }) };
}

/** One app.http per route, so each route is its own function name in telemetry. */
export function registerWithFunctions(app: App): void {
	for (const fn of app.functions) {
		azureFunctions.app.http(fn.name, {
			methods: [fn.method],
			route: fn.route,
			authLevel: 'anonymous',
			handler: async (request) => toResponse(await app.handle(toHostRequest(request))),
		});
	}
}
