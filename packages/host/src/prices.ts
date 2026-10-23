import type { AiModel, AiUse, TokensOf } from '@g4k/sdk';

/**
 * List prices, before any discount on the account, read 2026-10-23. Azure: the Retail Prices API,
 * https://prices.azure.com/api/retail/prices?$filter=armRegionName eq 'swedencentral' and contains(meterName,'<name>'),
 * Consumption, Global meters. TypeSafe: "$42 Per Billion input tokens" on https://typesafe.ai/, and output "currently
 * free of charge" on https://docs.typesafe.ai/api.md. Change this version with any rate, so old rows keep the price they used.
 */
export const PRICE_VERSION = 'azure-retail-2026-10-23';

/** USD per million tokens, which is micro-USD per token. Every model needs a rate for every token kind it bills on. */
export type Rates = { readonly [M in AiModel]: { readonly [K in keyof TokensOf[M]]: number } };

export const PRICES: Rates = {
	// 5.4 mini Inp / cd Inp / Opt Gl 1M Tokens, from 2026-03-01.
	'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
	// gpt img 1 mini inp txt / inp img / out img glbl, priced per 1K, from 2025-10-01.
	'gpt-image-1-mini': { textInput: 2, imageInput: 2.5, output: 8 },
	// Image 2 txt inp / img inp / img opt Gl 1M Tokens (the Azure OpenAI Media meters), from 2026-05-01.
	'gpt-image-2': { textInput: 5, imageInput: 8, output: 30 },
	'jev-1.14.0': { input: 0.042, output: 0 },
};

/** A call's estimated cost in integer micro-USD, rounded once over all its token kinds. */
export function costMicroUsd(use: AiUse<string>): number {
	const rates: Readonly<Record<string, number>> = PRICES[use.model];
	const tokens: Readonly<Record<string, number>> = use.tokens;
	return Math.round(Object.entries(rates).reduce((sum, [kind, rate]) => sum + (tokens[kind] ?? 0) * rate, 0));
}
