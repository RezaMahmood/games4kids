import { createServer } from 'node:http';
import { canvas, type Rgb } from './png.ts';

export type FoundryCall = {
	readonly path: string;
	readonly model: string | null;
	/** What the caller sent after "Bearer ", so a test can see the platform's token was used. */
	readonly token: string | null;
	/** What an image generation was asked to draw. */
	readonly prompt: string | null;
};

export type FakeFoundry = {
	readonly origin: string;
	readonly calls: readonly FoundryCall[];
	/** The next `count` image calls, or chat calls when `on` says so, answer with this HTTP status. */
	failNext(count: number, status?: number, on?: Kind): void;
	/**
	 * The next `count` image calls, or chat calls when `on` says so, are refused by the content filter: as the 400 Foundry
	 * answers a prompt it refuses, or with `as: 'finish'`, as a 200 chat reply the filter stopped part way.
	 */
	refuseNext(count: number, on?: Kind, as?: RefusedAs): void;
	/** The next `count` image calls answer 429 and ask to be tried again at once. */
	rateLimitNext(count: number): void;
	/** The next chat calls for a Time Detectives round answer with these, in order, instead of the Lindisfarne round. */
	answerNextRounds(...replies: unknown[]): void;
	/** Holds the next image call until `release`, so a test can change the world while a job is at work. `arrived` settles when the call comes in. */
	holdNext(): { readonly arrived: Promise<void>; release(): void };
	close(): Promise<void>;
};

/** Which calls a fault applies to: the image calls drawpad's tests expect, or the chat calls that write a Time Detectives round. */
type Kind = 'images' | 'chat';
type RefusedAs = 'error' | 'finish';

const SIZE = 256;
const NAVY: Rgb = [31, 36, 48];
const WHITE: Rgb = [255, 255, 255];

/** Flat colour areas with sharp edges, so the browser can turn it into a paint by numbers picture. */
function scene(): Uint8Array {
	const picture = canvas(SIZE, SIZE, [169, 203, 239]);
	picture.rect(0, 190, SIZE, 66, [109, 182, 91]);
	picture.disc(210, 50, 28, [242, 179, 61]);
	picture.rect(60, 110, 110, 90, [255, 253, 248]);
	for (let row = 0; row < 50; row++) picture.rect(50 + row, 60 + row, 130 - row * 2, 1, [217, 87, 59]);
	picture.rect(100, 150, 28, 50, [138, 90, 59]);
	picture.rect(70, 125, 24, 24, [43, 84, 214]);
	picture.rect(140, 125, 24, 24, [43, 84, 214]);
	picture.rect(10, 200, 30, 40, [30, 122, 70]);
	return picture.png();
}

/** The same shapes as plain ink on white, which is what the redraw of a photo is. */
function lineArt(): Uint8Array {
	const picture = canvas(SIZE, SIZE, WHITE);
	const frame = (x: number, y: number, w: number, h: number) => {
		picture.rect(x, y, w, 4, NAVY);
		picture.rect(x, y + h - 4, w, 4, NAVY);
		picture.rect(x, y, 4, h, NAVY);
		picture.rect(x + w - 4, y, 4, h, NAVY);
	};
	frame(60, 110, 110, 90);
	frame(100, 150, 28, 50);
	frame(70, 125, 24, 24);
	frame(140, 125, 24, 24);
	for (let row = 0; row < 50; row++) {
		picture.rect(50 + row, 60 + row, 4, 1, NAVY);
		picture.rect(176 - row, 60 + row, 4, 1, NAVY);
	}
	picture.rect(0, 200, SIZE, 4, NAVY);
	return picture.png();
}

const SCENE_PROMPTS = [
	'A friendly fox asleep under a big autumn tree. A flat illustration where every area is one solid colour: a pale blue sky, a green hill, an orange fox, a brown trunk and red leaves. No text and no borders.',
	'A fox curled up beside a round yellow sun on a hill. A flat illustration where every area is one solid colour, with a blue sky and green grass. No text and no borders.',
	'A small fox sitting by a red house with blue windows. A flat illustration where every area is one solid colour, with a blue sky and green grass. No text and no borders.',
];

const TITLES = ['Sleepy Fox', 'Fox On A Hill', 'Little Red House'];

/** What the model answers for a Time Detectives round: Vikings at Lindisfarne in AD 793. */
export const VIKING_ROUND = {
	title: 'The raid on Lindisfarne',
	full: 'The monks of a quiet island priory were singing their morning prayers. Out at sea, long ships with striped sails cut through the grey waves. The year was AD 793, and the island was Lindisfarne, off the coast of Northumbria. The ships carried Vikings from across the North Sea. They ran up the beach and burst into the church. They grabbed silver cups, jewelled books and food. Some monks hid in the fields until the ships sailed away. News of the raid spread across England. People had never seen anything like it. Many say the Viking Age began on that cold June day.',
	brief: 'The bells were still ringing for morning prayers when the lookout saw sails on the horizon. The wind smelled of salt and seaweed. Nobody on the little island knew who was coming, or why. By lunchtime, nothing there would ever be the same again.',
	pictureAlt: 'Longships with striped sails land on a rocky island beach beside a small stone church.',
	picturePrompt: 'Three wooden longships with red and white striped sails pulled up on a rocky beach at dawn, a small stone priory on the grassy hill above, grey sea and soft clouds.',
	questions: [
		{ kind: 'who', answer: 'Vikings', decoys: ['Romans', 'Normans', 'Ancient Egyptians'], hint: 'Look for who the ships carried across the North Sea.' },
		{ kind: 'where', answer: 'Lindisfarne', decoys: ["Hadrian's Wall", 'Stonehenge', 'The Tower of London'], hint: 'The story names the island off Northumbria.' },
		{ kind: 'when', answer: 'AD 793', decoys: ['about 3000 BC', 'AD 43', 'AD 1066'], hint: 'Find the year in the third sentence.' },
	],
};

/**
 * The Foundry API as drawpad and Time Detectives call it: chat completions that answer a JSON schema, and image edits and generations that
 * answer a PNG. No network, no keys: it only wants a bearer token, as the real account does of the admin identity.
 */
export async function startFakeFoundry(options: { readonly port?: number } = {}): Promise<FakeFoundry> {
	const calls: FoundryCall[] = [];
	const failing = { images: { count: 0, status: 500 }, chat: { count: 0, status: 500 } };
	const refusing: Record<Kind, { count: number; as: RefusedAs }> = { images: { count: 0, as: 'error' }, chat: { count: 0, as: 'error' } };
	let limiting = 0;
	let held: { arrive(): void; released: Promise<void> } | null = null;
	const roundReplies: unknown[] = [];
	const png = (bytes: Uint8Array) => ({ data: [{ b64_json: Buffer.from(bytes).toString('base64') }] });

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
		const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
		if (req.method !== 'POST' || !path.startsWith('/openai/v1/')) return json(404, { error: 'not found' });
		if (!token) return json(401, { error: 'no bearer token' });
		const asJson = req.headers['content-type']?.startsWith('application/json') ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : null;
		calls.push({ path: path.slice('/openai/v1/'.length), model: typeof asJson?.['model'] === 'string' ? asJson['model'] : (/name="model"\r\n\r\n([^\r]+)/.exec(body.toString('latin1'))?.[1] ?? null), token, prompt: typeof asJson?.['prompt'] === 'string' ? asJson['prompt'] : null });

		const kind: Kind = path.endsWith('/chat/completions') ? 'chat' : 'images';
		/** Answers with the fault the test asked for, if any is left for this kind of call. */
		const fault = (): boolean => {
			if (refusing[kind].count > 0) {
				refusing[kind].count -= 1;
				if (refusing[kind].as === 'finish') json(200, { choices: [{ finish_reason: 'content_filter', message: { content: null } }] });
				else json(400, { error: { code: kind === 'chat' ? 'content_filter' : 'content_policy_violation', message: 'The request was refused.' } });
				return true;
			}
			if (failing[kind].count > 0) {
				failing[kind].count -= 1;
				json(failing[kind].status, { error: { message: 'the fake Foundry was told to fail' } });
				return true;
			}
			return false;
		};

		if (kind === 'chat') {
			if (fault()) return;
			const schema = (asJson?.['response_format'] as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
			const content = schema === 'round' ? (roundReplies.shift() ?? VIKING_ROUND) : schema === 'titles' ? { titles: TITLES } : { prompts: SCENE_PROMPTS, titles: TITLES };
			return json(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
		}
		if (held) {
			const hold = held;
			held = null;
			hold.arrive();
			await hold.released;
		}
		if (limiting > 0) {
			limiting -= 1;
			res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }).end('{"error":{"message":"slow down"}}');
			return;
		}
		if (fault()) return;
		if (path.endsWith('/images/edits')) return json(200, png(lineArt()));
		if (path.endsWith('/images/generations')) return json(200, png(scene()));
		return json(404, { error: 'not found' });
	});
	await new Promise<void>((resolve, reject) => (server.once('error', reject), server.listen(options.port ?? 0, 'localhost', resolve)));
	const { port } = server.address() as { port: number };
	return {
		origin: `http://localhost:${port}`,
		calls,
		failNext(count, status = 500, on = 'images') {
			failing[on] = { count, status };
		},
		refuseNext(count, on = 'images', as = 'error') {
			refusing[on] = { count, as };
		},
		rateLimitNext(count) {
			limiting = count;
		},
		answerNextRounds(...replies) {
			roundReplies.push(...replies);
		},
		holdNext() {
			let arrive = () => {};
			let release = () => {};
			const arrived = new Promise<void>((resolve) => (arrive = resolve));
			const released = new Promise<void>((resolve) => (release = resolve));
			held = { arrive, released };
			return { arrived, release };
		},
		close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
	};
}
