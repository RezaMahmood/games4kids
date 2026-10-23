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
 */
async function postFoundry(deps: FoundryDeps, path: string, body: object): Promise<unknown> {
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
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new AiFailure(true, 'the reply was not JSON');
	}
}

type ChatReply = { choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[] };

/** One chat completion whose answer must match a strict JSON schema, returned parsed. */
export async function chatJson(deps: FoundryDeps, ask: { model: string; messages: unknown[]; name: string; schema: object }): Promise<unknown> {
	const reply = (await postFoundry(deps, 'chat/completions', {
		model: ask.model,
		messages: ask.messages,
		response_format: { type: 'json_schema', json_schema: { name: ask.name, strict: true, schema: ask.schema } },
		reasoning_effort: 'low',
		max_completion_tokens: 4000,
	})) as ChatReply;
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
export async function generateImage(deps: FoundryDeps, ask: { model: string; prompt: string }): Promise<Uint8Array> {
	const reply = await postFoundry(deps, 'images/generations', { model: ask.model, prompt: ask.prompt, size: '1536x1024', quality: 'medium', n: 1 });
	const png = (reply as { data?: { b64_json?: unknown }[] } | null)?.data?.[0]?.b64_json;
	if (typeof png !== 'string') throw new AiFailure(true, 'the reply had no image');
	return Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
}
