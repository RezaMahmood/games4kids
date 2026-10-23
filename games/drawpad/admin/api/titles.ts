import type { Photo } from '../../data/model.ts';
import { TITLE_MAX } from '../../data/parse.ts';
import { chatJson, failure, type FoundryDeps } from './foundry.ts';

const MAX_TITLES = 3;
const BASE64_CHUNK = 0x8000;

export const CHAT_DEPLOYMENT = 'gpt-5.4-mini';

const CODES = { failed: 'title_failed', refused: 'title_refused' } as const;

const SYSTEM = 'You name pictures for a family colouring app. Answer only with the requested JSON.';

const ASK =
	'Suggest 3 titles for this photo, best first. Each is 2 to 5 words in Title Case and says what the picture shows, such as "Elephant Statue Against Blue Sky". Family friendly. Never name real people and do not read out text or numbers in the photo. Mention a famous place or landmark only if you are sure of it.';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['titles'], properties: { titles: { type: 'array', items: { type: 'string' } } } };

/** Up to three usable titles from whatever the model returned: trimmed, short enough, non-empty and distinct. */
export function cleanTitles(value: unknown): string[] {
	const titles = (value as { titles?: unknown } | null)?.titles;
	const kept: string[] = [];
	for (const raw of Array.isArray(titles) ? titles : []) {
		const title = typeof raw === 'string' ? raw.trim() : '';
		if (title && title.length <= TITLE_MAX && !kept.some((k) => k.toLowerCase() === title.toLowerCase())) kept.push(title);
	}
	return kept.slice(0, MAX_TITLES);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
	return btoa(binary);
}

/** Asks a Foundry chat model for up to three picture titles, best first. */
export async function suggestTitles(deps: FoundryDeps, photo: Photo): Promise<string[]> {
	const messages = [
		{ role: 'system', content: SYSTEM },
		{
			role: 'user',
			content: [
				{ type: 'text', text: ASK },
				{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(photo.jpeg)}`, detail: 'high' } },
			],
		},
	];
	const titles = cleanTitles(await chatJson(deps, { area: 'titles', model: CHAT_DEPLOYMENT, messages, name: 'titles', schema: SCHEMA }, CODES));
	if (!titles.length) throw failure(CODES.failed, 'the reply had no usable titles');
	return titles;
}
