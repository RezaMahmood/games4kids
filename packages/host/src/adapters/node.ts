import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpError } from '@g4k/sdk';
import { notFound, type App, type AppWorker, type HostReply, type HostRequest } from '../http.ts';
import type { Accounts } from '../storage.ts';

/** Headers a browser may read across origins. The Functions platform CORS cannot expose these, so a client treats both as optional. */
const EXPOSED = 'etag, www-authenticate';

export type NodeServer = { readonly origin: string; close(): Promise<void> };

export type NodeServerOptions = {
	readonly port: number;
	/** Exact origins, as each Function app's platform CORS lists them. Any other origin gets no CORS header. */
	readonly allowedOrigins: readonly string[] | ((app: App) => readonly string[]);
};

function toHostRequest(req: IncomingMessage): HostRequest {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
	let body: Promise<Uint8Array> | undefined;
	return {
		method: req.method ?? 'GET',
		path: url.pathname,
		headers,
		query: url.searchParams,
		bytes(maxBytes) {
			body ??= (async () => {
				if (Number(headers.get('content-length') ?? 0) > maxBytes) throw new HttpError(413, 'too_large', 'That is too big to send.');
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.byteLength;
					if (size > maxBytes) throw new HttpError(413, 'too_large', 'That is too big to send.');
					chunks.push(Buffer.from(chunk));
				}
				return new Uint8Array(Buffer.concat(chunks));
			})();
			return body;
		},
	};
}

function corsHeaders(req: IncomingMessage, allowed: readonly string[]): Record<string, string> {
	const origin = req.headers.origin;
	if (!origin || !allowed.includes(origin)) return {};
	return { 'access-control-allow-origin': origin, 'access-control-expose-headers': EXPOSED, vary: 'Origin' };
}

function write(res: ServerResponse, reply: HostReply, cors: Record<string, string>): void {
	res.writeHead(reply.status, { ...reply.headers, ...cors });
	res.end(reply.body === null ? undefined : typeof reply.body === 'string' ? reply.body : Buffer.from(reply.body));
}

/**
 * Dev and tests: every app on one port, each answering its own prefix, with the platform's exact-origin CORS
 * emulated here so no app and no game ever sets a CORS header.
 */
export async function serveWithNode(apps: readonly App[], options: NodeServerOptions): Promise<NodeServer> {
	const server = createServer(async (req, res) => {
		const request = toHostRequest(req);
		const app = apps.find((candidate) => request.path.startsWith(candidate.prefix));
		const allowed = !app ? [] : typeof options.allowedOrigins === 'function' ? options.allowedOrigins(app) : options.allowedOrigins;
		const cors = corsHeaders(req, allowed);
		if (req.method === 'OPTIONS') {
			const preflight = Object.keys(cors).length === 0 ? {} : { ...cors, 'access-control-allow-methods': req.headers['access-control-request-method'] ?? '', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '', 'access-control-max-age': '600' };
			res.writeHead(204, preflight).end();
			return;
		}
		write(res, app ? await app.handle(request) : notFound(), cors);
	});
	await new Promise<void>((resolve, reject) => (server.once('error', reject), server.listen(options.port, 'localhost', resolve)));
	const { port } = server.address() as { port: number };
	return {
		origin: `http://localhost:${port}`,
		close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
	};
}

/** The queue extension's default: the message is tried three times, and the third failure moves it aside. */
export const MAX_DEQUEUE_COUNT = 3;

export type QueueDelivery = Accounts & {
	/** Resolves when every message sent so far has been tried. */
	idle(): Promise<void>;
};

/**
 * Dev and tests, where nothing watches a queue: hands each message sent to a worker's queue to that worker, one at a
 * time like batchSize 1, retrying a throw up to the extension's maxDequeueCount. The message is still stored in the
 * wrapped account, so a test can read it back. `apps` is read at send time, because the apps are built over this.
 */
export function deliverQueues(accounts: Accounts, apps: () => readonly App[], onFailure: (worker: AppWorker, error: unknown, dequeueCount: number) => void = () => {}): QueueDelivery {
	let pending: Promise<void> = Promise.resolve();
	const deliver = async (worker: AppWorker, message: unknown) => {
		for (let dequeueCount = 1; dequeueCount <= MAX_DEQUEUE_COUNT; dequeueCount++) {
			try {
				await worker.run(JSON.parse(JSON.stringify(message)) as unknown, { dequeueCount });
				return;
			} catch (error) {
				onFailure(worker, error, dequeueCount);
			}
		}
	};
	return {
		idle: () => pending,
		open(owner) {
			const account = accounts.open(owner);
			return {
				...account,
				queue(name) {
					const queue = account.queue(name);
					return {
						async send(message) {
							await queue.send(message);
							const worker = apps()
								.flatMap((app) => app.workers ?? [])
								.find((candidate) => candidate.game === owner && candidate.queue === name);
							if (worker) pending = pending.then(() => deliver(worker, message));
						},
					};
				},
			};
		},
	};
}
