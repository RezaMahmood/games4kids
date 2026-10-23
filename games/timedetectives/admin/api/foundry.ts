import { chatUse, imageUse, type Meter, type Metered, type AreaOf, type BilledAs, type ChatTokens, type ImageTokens } from '@g4k/sdk';
import type manifest from '../../manifest.ts';

export type Area = AreaOf<typeof manifest>;

const REFUSAL = /content_policy|content_filter|moderation_blocked|ResponsibleAIPolicyViolation/i;
const RETRY_DEFAULT_SECONDS = 10;
export const RETRY_MAX_SECONDS = 20;
/** An image takes about a minute at most, so a request still open after this has hung. */
export const REQUEST_TIMEOUT_MS = 90_000;
const DETAIL_MAX = 300;

/**
 * Why an AI call gave no usable answer. One that is not `retryable` never works on another try, because the content
 * filter said no or the answer was unusable twice, so the round fails at once. The queue retries the others.
 */
export class AiFailure extends Error {
	readonly retryable: boolean;

	constructor(retryable: boolean, reason: string) {
		super(reason.slice(0, DETAIL_MAX));
		this.retryable = retryable;
	}
}

/** The content filter said no. Asking again with the same words gets the same answer. */
export class Refusal extends AiFailure {
	constructor() {
		super(false, 'The AI safety filter turned it down.');
	}
}

export type FoundryDeps = {
	endpoint: string;
	/** The platform's service token for Cognitive Services, so this code holds no credential. */
	token: () => Promise<string>;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	/** Hears every 2xx reply, billed whether or not the answer is usable: its tokens, or why it has none. */
	meter?: Meter<Area>;
};

const retryDelayMs = (res: Response) => {
	const header = res.headers.get('retry-after')?.trim();
	const seconds = header ? Number(header) : NaN;
	return 1000 * (Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, RETRY_MAX_SECONDS) : RETRY_DEFAULT_SECONDS);
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs JSON to the Foundry OpenAI v1 API and returns the parsed reply. Waits out one 429, since back to back calls hit
 * the per-minute limit. Each request, body included, is given up after REQUEST_TIMEOUT_MS, so a hung call fails the attempt.
 * A 2xx reply's usage is metered before the caller checks the answer, since an unusable answer is billed too.
 */
async function postFoundry(deps: FoundryDeps, path: string, body: object, usageOf: (reply: unknown) => Metered<Area>): Promise<unknown> {
	const send = async () => {
		const signal = AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
		try {
			const res = await fetch(new URL(`openai/v1/${path}`, deps.endpoint), {
				method: 'POST',
				headers: { authorization: `Bearer ${await deps.token()}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal,
			});
			return { res, text: await res.text() };
		} catch (error) {
			throw new AiFailure(true, `${(error as Error).name}: ${(error as Error).message}`);
		}
	};
	let { res, text } = await send();
	if (res.status === 429) {
		await (deps.sleep ?? wait)(retryDelayMs(res));
		({ res, text } = await send());
	}
	if (res.status === 400 && REFUSAL.test(text)) throw new Refusal();
	if (!res.ok) throw new AiFailure(true, `${res.status}: ${text}`);
	let reply: unknown;
	try {
		reply = JSON.parse(text);
	} catch {
		throw new AiFailure(true, 'the reply was not JSON');
	}
	await deps.meter?.(usageOf(reply));
	return reply;
}

type ChatReply = { choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[] };

/** One chat completion whose answer must match a strict JSON schema, returned parsed. */
export async function chatJson(deps: FoundryDeps, ask: { area: Area; model: BilledAs<ChatTokens>; messages: unknown[]; name: string; schema: object }): Promise<unknown> {
	const body = {
		model: ask.model,
		messages: ask.messages,
		response_format: { type: 'json_schema', json_schema: { name: ask.name, strict: true, schema: ask.schema } },
		reasoning_effort: 'low',
		max_completion_tokens: 4000,
	};
	const reply = (await postFoundry(deps, 'chat/completions', body, (raw) => chatUse(ask.area, ask.model, raw))) as ChatReply;
	const choice = reply?.choices?.[0];
	if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Refusal();
	if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new AiFailure(true, `the reply stopped early: ${choice?.finish_reason ?? 'no choice'}`);
	try {
		return JSON.parse(choice.message.content) as unknown;
	} catch {
		throw new AiFailure(true, 'the reply was not JSON');
	}
}

/** One picture from a Foundry image model, as PNG bytes. */
export async function generateImage(deps: FoundryDeps, ask: { area: Area; model: BilledAs<ImageTokens>; prompt: string }): Promise<Uint8Array> {
	const body = { model: ask.model, prompt: ask.prompt, size: '1536x1024', quality: 'medium', n: 1 };
	const reply = await postFoundry(deps, 'images/generations', body, (raw) => imageUse(ask.area, ask.model, raw));
	const png = (reply as { data?: { b64_json?: unknown }[] } | null)?.data?.[0]?.b64_json;
	if (typeof png !== 'string') throw new AiFailure(true, 'the reply had no image');
	return Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
}
