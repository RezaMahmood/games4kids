import { HttpError } from '@g4k/sdk';
import type { App, HostReply, HostRequest } from '@g4k/host';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export type Send = { readonly token?: string; readonly json?: unknown; readonly png?: Uint8Array };

export function request(method: string, path: string, send: Send = {}): HostRequest {
	const headers = new Headers();
	if (send.token) headers.set('authorization', `Bearer ${send.token}`);
	if (send.json !== undefined) headers.set('content-type', 'application/json');
	if (send.png) headers.set('content-type', 'image/png');
	const body = send.json !== undefined ? new TextEncoder().encode(JSON.stringify(send.json)) : (send.png ?? new Uint8Array());
	const url = new URL(path, 'http://localhost');
	return {
		method,
		path: url.pathname,
		headers,
		query: url.searchParams,
		async bytes(maxBytes) {
			if (body.byteLength > maxBytes) throw new HttpError(413, 'too_large', 'That is too big to send.');
			return body;
		},
	};
}

export async function call(app: App, method: string, path: string, send: Send = {}): Promise<HostReply & { readonly data: unknown }> {
	const reply = await app.handle(request(method, path, send));
	return { ...reply, data: typeof reply.body === 'string' ? JSON.parse(reply.body) : reply.body };
}

/** The `error` code of an ApiError body, or undefined. */
export function codeOf(reply: { readonly data: unknown }): unknown {
	return typeof reply.data === 'object' && reply.data !== null && 'error' in reply.data ? reply.data.error : undefined;
}
