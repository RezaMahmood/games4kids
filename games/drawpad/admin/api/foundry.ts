import type { AiErrorCode } from '../../data/types.ts';

const REFUSAL = /content_policy|content_filter|moderation_blocked|ResponsibleAIPolicyViolation/i;
const RETRY_DEFAULT_SECONDS = 10;
const RETRY_MAX_SECONDS = 20;
const DETAIL_MAX = 300;

/**
 * Why an AI call did not give an answer. A `refused` call will never work, because the content filter said no, so its
 * step settles as failed. A `failed` call may work on another try, so the queue retries the message.
 */
export class AiFailure extends Error {
	readonly kind: 'refused' | 'failed';
	readonly code: AiErrorCode;
	readonly detail: string;

	constructor(kind: 'refused' | 'failed', code: AiErrorCode, detail = '') {
		super(`${kind} ${code}`);
		this.kind = kind;
		this.code = code;
		this.detail = detail.slice(0, DETAIL_MAX);
	}
}

export type FoundryDeps = {
	endpoint: string;
	/** The platform's service token for Cognitive Services, so this code holds no credential. */
	token: () => Promise<string>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

/** The error codes one kind of Foundry call reports. */
export type FoundryCodes = { failed: AiErrorCode; refused: AiErrorCode };

export const failure = (code: AiErrorCode, detail: string) => new AiFailure('failed', code, detail);

const retryDelayMs = (res: Response) => {
	const header = res.headers.get('retry-after')?.trim();
	const seconds = header ? Number(header) : NaN;
	return 1000 * (Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, RETRY_MAX_SECONDS) : RETRY_DEFAULT_SECONDS);
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs to the Foundry OpenAI v1 API and returns the parsed JSON reply. Waits out one 429 (back to back image
 * requests hit the per-minute limit), then reports any failure as `codes.failed` with the upstream status and text.
 */
export async function postFoundry(deps: FoundryDeps, path: string, init: { body: BodyInit; headers?: Record<string, string> }, codes: FoundryCodes): Promise<unknown> {
	const send = async () => {
		try {
			const token = await deps.token();
			return await (deps.fetch ?? fetch)(new URL(`openai/v1/${path}`, deps.endpoint), {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, ...init.headers },
				body: init.body,
			});
		} catch (error) {
			throw failure(codes.failed, `${(error as Error).name}: ${(error as Error).message}`);
		}
	};
	let res = await send();
	if (res.status === 429) {
		await (deps.sleep ?? wait)(retryDelayMs(res));
		res = await send();
	}
	const text = await res.text().catch(() => '');
	if (res.status === 400 && REFUSAL.test(text)) throw new AiFailure('refused', codes.refused);
	if (!res.ok) throw failure(codes.failed, `${res.status}: ${text}`);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw failure(codes.failed, 'the reply was not JSON');
	}
}

type ChatReply = { choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[] };

/** One chat completion whose answer must match a strict JSON schema. */
export type ChatAsk = { model: string; messages: unknown[]; name: string; schema: object };

/**
 * Asks a Foundry chat model for JSON that matches `ask.schema` and returns it parsed. A content filter stop or a
 * refusal is `codes.refused`; a reply that stopped early or is not JSON is `codes.failed`.
 */
export async function chatJson(deps: FoundryDeps, ask: ChatAsk, codes: FoundryCodes): Promise<unknown> {
	const body = JSON.stringify({
		model: ask.model,
		messages: ask.messages,
		response_format: { type: 'json_schema', json_schema: { name: ask.name, strict: true, schema: ask.schema } },
		reasoning_effort: 'low',
		max_completion_tokens: 4000,
	});
	const reply = (await postFoundry(deps, 'chat/completions', { body, headers: { 'content-type': 'application/json' } }, codes)) as ChatReply;
	const choice = reply?.choices?.[0];
	if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new AiFailure('refused', codes.refused);
	if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
		throw failure(codes.failed, `the reply stopped early: ${choice?.finish_reason ?? 'no choice'}`);
	}
	try {
		return JSON.parse(choice.message.content) as unknown;
	} catch {
		throw failure(codes.failed, 'the reply was not JSON');
	}
}
