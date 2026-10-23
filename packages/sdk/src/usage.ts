/** Every AI model a game may call. A new model needs a price in @g4k/host's PRICES, which tsc enforces. */
export type AiModel = 'gpt-5.4-mini' | 'gpt-image-1-mini' | 'gpt-image-2' | 'jev-1.14.0';

export type ChatTokens = { readonly input: number; readonly cachedInput: number; readonly output: number };
export type ImageTokens = { readonly textInput: number; readonly imageInput: number; readonly output: number };
export type JudgeTokens = { readonly input: number; readonly output: number };

/** What each model bills on. A chat model can never report image tokens. */
export type TokensOf = {
	readonly 'gpt-5.4-mini': ChatTokens;
	readonly 'gpt-image-1-mini': ImageTokens;
	readonly 'gpt-image-2': ImageTokens;
	readonly 'jev-1.14.0': JudgeTokens;
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

export type GameUsage<Area extends string> = {
	/** Resolves within the host's time limit and never rejects. A lost write is logged with the whole entry. */
	record(call: AiCall<Area>): Promise<void>;
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
