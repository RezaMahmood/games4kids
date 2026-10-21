import { createSimpleTransformer, englishDataset, englishRecommendedBlacklistMatcherTransformers, englishRecommendedWhitelistMatcherTransformers, RegExpMatcher } from 'obscenity';

/** Insults aimed at a person that the dataset leaves out. Whole words only, so "Fatima" stays fine. */
const INSULTS: ReadonlySet<string> = new Set(['idiot', 'stupid', 'loser', 'dumb', 'ugly', 'fat', 'smelly', 'hate']);

/**
 * Real given names and surnames that hold a word the dataset flags. Whole words only, so "Dickhead" stays refused.
 * Dick itself is left off, because as a whole word it is also the slang, and "Big Dick" would pass.
 */
const REAL_NAMES = ['dickson','analise', 'annalee', 'fagan', 'fagin', 'fukui', 'cummings', 'peniston', 'pissarro'];

const isWordCharacter = (code: number) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(code));

/**
 * obscenity's whitelist is a substring search. Padding each term with a space, and reading every non-letter in the
 * input as a space, makes it a whole-word search that still sees "Dick-Smith" and ignores "Dickhead".
 */
const dataset = englishDataset.build();
const profanity = new RegExpMatcher({
	blacklistedTerms: dataset.blacklistedTerms,
	whitelistedTerms: [...(dataset.whitelistedTerms ?? []),...REAL_NAMES.map((name) => ` ${name} `)],
	blacklistMatcherTransformers: englishRecommendedBlacklistMatcherTransformers,
	whitelistMatcherTransformers: [createSimpleTransformer((code) => (isWordCharacter(code) ? code : 32)), ...englishRecommendedWhitelistMatcherTransformers],
});

const flagged = (text: string) => profanity.hasMatch(` ${text} `);

const SINGLE_CHARACTER_GAP = /(?<=(?:^| )[\p{L}\p{N}]) (?=[\p{L}\p{N}](?: |$))/gu;

/**
 * Whether a display name is fit for other children to read. The dataset sees lookalike letters ("sh1t") but not
 * letters spaced apart ("f u c k"), so it also reads the name with single characters joined. Joining every word
 * instead would refuse names like Anna-Lee.
 */
export function isKindName(name: string): boolean {
	const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
	if (words.some((word) => INSULTS.has(word))) return false;
	return !flagged(name) && !flagged(words.join(' ').replace(SINGLE_CHARACTER_GAP, ''));
}
