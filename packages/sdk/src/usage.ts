/** Every AI model a game may call. A new model needs a price in @g4k/host's PRICES, which tsc enforces. */
export type AiModel = 'gpt-5.4-mini' | 'gpt-image-1-mini' | 'gpt-image-2' | 'jev-1.14.0' | 'azure-vision-read' | 'azure-vision-read-free';

export type ChatTokens = { readonly input: number; readonly cachedInput: number; readonly output: number };
export type ImageTokens = { readonly textInput: number; readonly imageInput: number; readonly output: number };
export type JudgeTokens = { readonly input: number; readonly output: number };
/** A service that bills per request, such as AI Vision, where one analyze call with one feature is one transaction. */
export type Transactions = { readonly transactions: number };

/** What each model bills on. A chat model can never report image tokens. */
export type TokensOf = {
	readonly 'gpt-5.4-mini': ChatTokens;
	readonly 'gpt-image-1-mini': ImageTokens;
	readonly 'gpt-image-2': ImageTokens;
	readonly 'jev-1.14.0': JudgeTokens;
	/** Image Analysis 4.0 Read on a standard (S1) account. */
	readonly 'azure-vision-read': Transactions;
	/** The same call on a free (F0) account, which bills nothing. */
	readonly 'azure-vision-read-free': Transactions;
};

/** The thing a call was for, in the game's own ids. `item` is a round or a job. `group` is what it sums into, such as a topic. */
export type UsageSubject = { readonly item: string; readonly group?: string };

/** One AI request's tokens as the reply reported them. A game reports tokens and never a price. */
export type AiUse<Area extends string> = {
	readonly [M in AiModel]: {
		readonly area: Area;
		readonly model: M;
		readonly tokens: TokensOf[M];
		/** The model name the reply gave, such as a dated version. Stored only for the record. */
		readonly replyModel?: string;
	};
}[AiModel];

export type AiCall<Area extends string> = AiUse<Area> & { readonly subject: UsageSubject };

export type Spend = { readonly microUsd: number; readonly calls: number };
/** Spend for a page to show. `text` reads like "est. $0.042". */
export type CostView = Spend & { readonly text: string };

/** A billed reply whose usage could not be read, so it has no price. `reason` says what was missing. */
export type Unmetered<Area extends string> = { readonly area: Area; readonly model: AiModel; readonly reason: string };

/** What a game reports for one billed reply: its tokens, or why there are none. */
export type Metered<Area extends string> = AiUse<Area> | Unmetered<Area>;

/** Hears every billed reply of one subject, once, with its tokens or why it has none. Never rejects. */
export type Meter<Area extends string> = (reply: Metered<Area>) => Promise<void>;

export const isUnmetered = <Area extends string>(reply: Metered<Area>): reply is Unmetered<Area> => 'reason' in reply;

export type GameUsage<Area extends string> = {
	/** Resolves within the host's time limit and never rejects. A lost write is logged with the whole entry. */
	record(call: AiCall<Area>): Promise<void>;
	/** Reports a billed call whose usage could not be read. It adds no row and no cost, only a logged exception naming the call, and never rejects. */
	unmetered(call: Unmetered<Area> & { readonly subject: UsageSubject }): Promise<void>;
	/** This game's ledger, summed by group and by item. Rows of deleted items still count in their group. */
	spend(): Promise<{ readonly byGroup: ReadonlyMap<string, Spend>; readonly byItem: ReadonlyMap<string, Spend> }>;
};

/** Every figure is an estimate from token counts at list prices, so it always says so. */
export function estimateText(microUsd: number): string {
	if (microUsd <= 0) return 'est. $0.00';
	if (microUsd < 1_000) return 'est. <$0.001';
	const usd = microUsd / 1_000_000;
	return `est. $${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

export const costView = (spend: Spend): CostView => ({ ...spend, text: estimateText(spend.microUsd) });

/** Sends every reply of `subject` to the ledger: tokens as a row, a reply without them as an unmetered report. */
export const meterTo =
	<Area extends string>(usage: GameUsage<Area>, subject: UsageSubject): Meter<Area> =>
	(reply) =>
		isUnmetered(reply) ? usage.unmetered({ ...reply, subject }) : usage.record({ ...reply, subject });

/** The models that bill on this kind of token, so a chat call can only name a chat model. */
export type BilledAs<T> = { [M in AiModel]: TokensOf[M] extends T ? M : never }[AiModel];

const at = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const replyModel = (reply: unknown) => {
	const model = at(reply, 'model');
	return typeof model === 'string' ? { replyModel: model } : {};
};

/** Chat usage. Cached prompt tokens bill at their own rate, and reasoning tokens are already part of completion_tokens. */
export function parseChatUsage(reply: unknown): ChatTokens | undefined {
	const usage = at(reply, 'usage');
	const prompt = count(at(usage, 'prompt_tokens'));
	const output = count(at(usage, 'completion_tokens'));
	const cached = count(at(at(usage, 'prompt_tokens_details'), 'cached_tokens')) ?? 0;
	if (prompt === undefined || output === undefined || cached > prompt) return undefined;
	return { input: prompt - cached, cachedInput: cached, output };
}

/** Image usage, which the docs give for gpt-image-1-series models. Input with no text and image split bills as text. */
export function parseImageUsage(reply: unknown): ImageTokens | undefined {
	const usage = at(reply, 'usage');
	const input = count(at(usage, 'input_tokens'));
	const output = count(at(usage, 'output_tokens'));
	if (input === undefined || output === undefined) return undefined;
	const details = at(usage, 'input_tokens_details');
	const text = count(at(details, 'text_tokens'));
	const image = count(at(details, 'image_tokens'));
	return text !== undefined && image !== undefined ? { textInput: text, imageInput: image, output } : { textInput: input, imageInput: 0, output };
}

const NO_USAGE = 'the reply carried no readable usage';

/** What a chat completion reply billed, or why it has no usage. */
export function chatUse<Area extends string>(area: Area, model: BilledAs<ChatTokens>, reply: unknown): Metered<Area> {
	const tokens = parseChatUsage(reply);
	if (!tokens) return { area, model, reason: NO_USAGE };
	return { area, model, tokens, ...replyModel(reply) };
}

/** What an image generation or edit reply billed, or why it has no usage. */
export function imageUse<Area extends string>(area: Area, model: BilledAs<ImageTokens>, reply: unknown): Metered<Area> {
	const tokens = parseImageUsage(reply);
	if (!tokens) return { area, model, reason: NO_USAGE };
	const use: AiUse<Area> = { area, model, tokens, ...replyModel(reply) };
	return use;
}

/** What a TypeSafe judge reply billed, or why it has no usage. */
export function judgeUse<Area extends string>(area: Area, model: 'jev-1.14.0', reply: unknown): Metered<Area> {
	const tokens = parseJudgeUsage(reply);
	if (!tokens) return { area, model, reason: NO_USAGE };
	return { area, model, tokens, ...replyModel(reply) };
}

/** TypeSafe's usage: billable input tokens, and output tokens that are free for now. */
export function parseJudgeUsage(reply: unknown): JudgeTokens | undefined {
	const usage = at(reply, 'usage');
	const input = count(at(usage, 'input_tokens'));
	const output = count(at(usage, 'output_tokens'));
	return input === undefined || output === undefined ? undefined : { input, output };
}
