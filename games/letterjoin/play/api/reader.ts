export type Box = { x: number; y: number; w: number; h: number };
export type RecognisedWord = { text: string; confidence: number; box: Box };
export type RecognitionResult = { words: RecognisedWord[] };
export type Reader = { read(png: Uint8Array): Promise<RecognitionResult> };

/** The service could not be reached, was busy or broken, or answered with something that is not a reading. */
export class ReaderUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReaderUnavailable';
	}
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const isPoint = (point: unknown): point is { x: number; y: number } => isRecord(point) && Number.isFinite(point['x']) && Number.isFinite(point['y']);

function parseWord(raw: unknown): RecognisedWord {
	const word = isRecord(raw) ? raw : {};
	const polygon = word['boundingPolygon'];
	const text = word['text'];
	const confidence = word['confidence'];
	if (typeof text !== 'string' || typeof confidence !== 'number' || !Number.isFinite(confidence) || !Array.isArray(polygon) || polygon.length === 0 || !polygon.every(isPoint)) {
		throw new ReaderUnavailable('The reading service sent a word this app does not understand.');
	}
	const xs = polygon.map((point) => point.x);
	const ys = polygon.map((point) => point.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { text, confidence, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
}

/** `readResult.blocks[].lines[].words[]`. An image with no text has no blocks, or no readResult at all. */
export function parseReadResult(raw: unknown): RecognitionResult {
	const result = isRecord(raw) ? raw['readResult'] : undefined;
	const blocks = isRecord(result) ? (result['blocks'] ?? []) : [];
	const wellFormed = (block: unknown) => isRecord(block) && Array.isArray(block['lines']) && block['lines'].every((line: unknown) => isRecord(line) && Array.isArray(line['words']));
	if (!Array.isArray(blocks) || !blocks.every(wellFormed)) throw new ReaderUnavailable('The reading service sent a result this app does not understand.');
	const lines = (blocks as { lines: { words: unknown[] }[] }[]).flatMap((block) => block.lines);
	return { words: lines.flatMap((line) => line.words.map(parseWord)) };
}

/** Reads handwriting with Azure AI Vision Image Analysis 4.0 (`features=read`), signing in with the platform's Cognitive Services token. */
export function createVisionReader({ endpoint, token, fetch: send = fetch }: { endpoint: string; token: () => Promise<string>; fetch?: typeof fetch }): Reader {
	const url = `${endpoint.replace(/\/+$/, '')}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`;
	return {
		async read(png) {
			let res: Response;
			try {
				res = await send(url, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/octet-stream' }, body: png as BodyInit });
			} catch (error) {
				throw new ReaderUnavailable(`The reading service could not be reached: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (res.status === 429 || res.status >= 500) throw new ReaderUnavailable(`The reading service answered ${res.status}.`);
			if (!res.ok) throw new Error(`The reading service refused the request with ${res.status}.`);
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				throw new ReaderUnavailable('The reading service sent something that is not JSON.');
			}
			return parseReadResult(body);
		},
	};
}
