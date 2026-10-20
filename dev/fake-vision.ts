import { createServer } from 'node:http';

export type VisionWord = { readonly text: string; readonly confidence?: number; readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number };

export type VisionCall = {
	readonly path: string;
	/** What the caller sent after "Bearer ", so a test can see the platform's token was used. */
	readonly token: string | null;
	readonly bytes: number;
};

export type FakeVision = {
	readonly origin: string;
	readonly calls: readonly VisionCall[];
	/** What every later read finds, until the next call. */
	say(words: readonly VisionWord[]): void;
	/** The next `count` reads answer with this HTTP status. */
	failNext(count: number, status?: number): void;
	close(): Promise<void>;
};

/** Azure AI Vision Image Analysis `features=read`, with no network and no keys: it wants only a bearer token. */
export async function startFakeVision({ port = 0 }: { port?: number } = {}): Promise<FakeVision> {
	const calls: VisionCall[] = [];
	let words: readonly VisionWord[] = [];
	let failures = { count: 0, status: 503 };

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
		if (req.method !== 'POST' || path !== '/computervision/imageanalysis:analyze') return void res.writeHead(404).end();
		calls.push({ path, token, bytes: Buffer.concat(chunks).length });
		if (!token) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"Unauthorized"}}');
		if (failures.count > 0) {
			failures = { ...failures, count: failures.count - 1 };
			return void res.writeHead(failures.status, { 'content-type': 'application/json' }).end('{"error":{"code":"Busy"}}');
		}
		const line = words.map(({ text, confidence = 0.99, x = 0, y = 0, w = 40, h = 40 }, i) => ({
			text,
			confidence,
			boundingPolygon: [{ x: x + i * w, y }, { x: x + i * w + w, y }, { x: x + i * w + w, y: y + h }, { x: x + i * w, y: y + h }],
		}));
		const readResult = { blocks: line.length > 0 ? [{ lines: [{ text: words.map((word) => word.text).join(' '), words: line }] }] : [] };
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ readResult }));
	});
	await new Promise<void>((resolve, reject) => (server.once('error', reject), server.listen(port, 'localhost', resolve)));
	const bound = (server.address() as { port: number }).port;

	return {
		origin: `http://localhost:${bound}`,
		calls,
		say: (next) => void (words = next),
		failNext: (count, status = 503) => void (failures = { count, status }),
		close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
	};
}
