import { createSimpleTransformer, DataSet, englishDataset, englishRecommendedBlacklistMatcherTransformers, englishRecommendedWhitelistMatcherTransformers, parseRawPattern, RegExpMatcher } from 'obscenity';

/**
 * Words the dataset leaves out, refused only as whole words so that "Fatima", "Michelle", "Nazia" and "Diego" stay fine:
 * insults aimed at a person, mild swearing, slurs, toilet words and threats.
 */
const WHOLE_WORDS = [
	'idiot', 'stupid', 'loser', 'dumb', 'ugly', 'fat', 'smelly', 'hate',
	'hell', 'damn', 'crap', 'bloody', 'bugger',
	'nazi', 'spaz', 'pikey', 'nonce', 'pedo', 'kys', 'kill', 'die',
	'poo', 'poop',
];

/** Words refused wherever they appear, because no real name holds them. The matcher squashes "tt" to "t" before it compares. */
const ANYWHERE = ['hitler', 'paedo', 'dumbass', 'buthead', 'poohead', 'killyourself'];

/**
 * Real given names and surnames that hold a word the dataset flags. Whole words only, so "Dickhead" stays refused.
 * Dick itself is left off, because as a whole word it is also the slang, and "Big Dick" would pass.
 */
const REAL_NAMES = ['dickson', 'analise', 'annalee', 'fagan', 'fagin', 'fukui', 'cummings', 'peniston', 'pissarro'];

const isWordCharacter = (code: number) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(code));

const dataset = new DataSet<{ originalWord?: string }>().addAll(englishDataset);
for (const word of WHOLE_WORDS) dataset.addPhrase((phrase) => phrase.addPattern(parseRawPattern(`|${word}|`)));
for (const word of ANYWHERE) dataset.addPhrase((phrase) => phrase.addPattern(parseRawPattern(word)));
const terms = dataset.build();

/**
 * obscenity's whitelist is a substring search. Padding each term with a space, and reading every non-letter in the
 * input as a space, makes it a whole-word search that still sees "Dick-Smith" and ignores "Dickhead".
 */
const matcher = (realNames: readonly string[]) =>
	new RegExpMatcher({
		blacklistedTerms: terms.blacklistedTerms,
		whitelistedTerms: [...(terms.whitelistedTerms ?? []), ...realNames],
		blacklistMatcherTransformers: englishRecommendedBlacklistMatcherTransformers,
		whitelistMatcherTransformers: [createSimpleTransformer((code) => (isWordCharacter(code) ? code : 32)), ...englishRecommendedWhitelistMatcherTransformers],
	});

const asWritten = matcher(REAL_NAMES.map((name) => ` ${name} `));
/** The joined name has no word edges left, so a real name counts wherever it sits. "Big Dick" is still refused as written. */
const joinedUp = matcher(REAL_NAMES);

/**
 * A word broken up to slip past the matcher ("s hit", "fu ck", "b.i.t.c.h") always has a piece of one or two letters,
 * so each such piece is joined to its neighbour. Whole words stay apart, because "Sana Ali" joined reads "anal".
 */
function joinFragments(name: string): string {
	const groups: string[] = [];
	let last = '';
	for (const piece of name.split(/[^\p{L}\p{N}]+/u).filter((part) => part !== '')) {
		if (groups.length > 0 && (piece.length <= 2 || last.length <= 2)) groups[groups.length - 1] += piece;
		else groups.push(piece);
		last = piece;
	}
	return groups.join(' ');
}

/** Whether a display name is fit for other children to read. The dataset already sees lookalike letters ("sh1t"). */
export function isKindName(name: string): boolean {
	return !asWritten.hasMatch(` ${name} `) && !joinedUp.hasMatch(` ${joinFragments(name)} `);
}
