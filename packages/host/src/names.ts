import { createSimpleTransformer, DataSet, englishDataset, englishRecommendedBlacklistMatcherTransformers, englishRecommendedWhitelistMatcherTransformers, parseRawPattern, RegExpMatcher } from 'obscenity';

/**
 * Bad words a name must not be, or be built from. Each one is refused as a whole word, with any ending in ENDINGS, and
 * also when it is split into pieces ("fuc ker", "pa ki"). Whole words only, so "Fatima", "Pakistan" and "Raccoon" pass.
 */
const ROOTS = [
	'fuck', 'fuk', 'fuq', 'phuck', 'fcuk', 'frick', 'frig', 'shit', 'shyt', 'bitch', 'biatch', 'beyotch', 'bastard', 'wank', 'wanker', 'cunt', 'dick', 'cock', 'prick', 'twat',
	'slut', 'sloot', 'whore', 'hoe', 'thot', 'piss', 'crap', 'arse', 'ass', 'azz', 'tosser', 'bollock', 'bollocks', 'bellend', 'knob', 'jackass', 'dumbass', 'retard', 'spaz', 'spacker',
	'penis', 'vagina', 'boob', 'tit', 'porn', 'sex', 'nude', 'naked', 'horny', 'incel', 'minger', 'slag', 'skank', 'stfu', 'wtf', 'gtfo', 'lmfao',
	'nigger', 'nigga', 'fag', 'faggot', 'paki', 'spic', 'coon', 'gook', 'wog', 'golliwog', 'kike', 'pikey', 'raghead', 'towelhead', 'lesbo', 'homo', 'shemale', 'batty',
	'nazi', 'hitler', 'heil', 'fuhrer', 'fuehrer', 'pedo', 'paedo', 'nonce', 'groomer', 'pedophile', 'paedophile', 'peadophile', 'pedobear',
	'idiot', 'stupid', 'loser', 'dumb', 'ugly', 'fat', 'fatty', 'smelly', 'hate', 'hell', 'damn', 'bloody', 'bugger',
	'kill', 'killa', 'murder', 'suicide', 'stab', 'shoot', 'bomb', 'terrorist', 'jihad', 'die', 'kys',
	'poo', 'poop', 'pee', 'wee', 'bum', 'fart', 'butt', 'pussy', 'simp',
];

/** Endings and compounds a child adds to a bad word: "fucker", "shithead", "Naziboy", "Killer". */
const ENDINGS = ['', 's', 'er', 'ers', 'ing', 'ed', 'y', 'ty', 'ie', 'it', 'head', 'heads', 'face', 'hole', 'sucker', 'bag', 'wit', 'boy', 'girl', 'man', 'you', 'bunny', 'power', 'bear'];

/** Bad phrases that are not a root with an ending. Each is matched with its spaces taken out. */
const PHRASES = ['siegheil', 'whitepower', 'junglebunny', 'battyboy', 'ihateyou', 'ikillyou', 'killyourself', 'shootyou', 'idiotface', 'crappy', 'gunman'];

/** Words refused wherever they appear, even inside a longer word, because no real name holds them. */
const ANYWHERE = ['hitler', 'paedo', 'siegheil', 'whitepower'];

/**
 * Checked on the name as typed, because the matcher drops digits and reads "KKK" as one "k", so "Kit" and "King"
 * would look like "KKK" with an ending.
 */
const AS_TYPED = /1488|(?:^|[^\p{L}])k[^\p{L}\p{N}]*k[^\p{L}\p{N}]*k(?:[^\p{L}]|$)/iu;

/**
 * Real given names and surnames that hold a word the dataset flags. Whole words only, so "Dickhead" stays refused.
 * Dick itself is left off, because as a whole word it is also the slang, and "Big Dick" would pass. Butt is a common
 * surname, so it is allowed alone and refused only with an ending ("Butthead").
 */
const REAL_NAMES = ['dickson', 'analise', 'annalee', 'analia', 'fagan', 'fagin', 'fukui', 'fukuda', 'cummings', 'cumhur', 'peniston', 'pissarro', 'harshit', 'shitanshu', 'dikshit', 'shitara', 'bich', 'butt'];

const LONGEST_SPLIT = 6;

const isWordCharacter = (code: number) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(code));
const wholeWordWhitelist = createSimpleTransformer((code) => (isWordCharacter(code) ? code : 32));
/**
 * Before it compares, the matcher cuts a run of b, e, g, l, o or s down to two letters, and a run of any other letter
 * down to one, so each word is listed the same way. That is why "Gunn" reads as "gun", and why gun is not a root.
 */
const squashed = (word: string) => word.replace(/([acdfhijkmnpqrtuvwxyz])\1+/gu, '$1').replace(/([beglos])\1{2,}/gu, '$1$1');

const matcherFor = (dataset: DataSet<unknown>, whitelist: readonly string[]) => {
	const { blacklistedTerms, whitelistedTerms = [] } = dataset.build();
	return new RegExpMatcher({
		blacklistedTerms,
		whitelistedTerms: [...whitelistedTerms, ...whitelist],
		blacklistMatcherTransformers: englishRecommendedBlacklistMatcherTransformers,
		whitelistMatcherTransformers: [wholeWordWhitelist, ...englishRecommendedWhitelistMatcherTransformers],
	});
};

const anywhere = new DataSet<unknown>().addAll(englishDataset);
for (const word of ANYWHERE) anywhere.addPhrase((phrase) => phrase.addPattern(parseRawPattern(word)));
/** The library's own list, which matches inside longer words, plus ANYWHERE. Real names are let through as whole words. */
const asWritten = matcherFor(anywhere, REAL_NAMES.map((name) => ` ${name} `));

const wholeWords = new DataSet<unknown>();
/** "stab" + "er" is also written "stabber", so an ending that starts with a vowel is added to the doubled last letter too. */
const withEnding = (root: string, ending: string) => (/^[aeiouy]/u.test(ending) ? [root + ending, root + root.at(-1) + ending] : [root + ending]);
const badWords = new Set([...ROOTS.flatMap((root) => ENDINGS.flatMap((ending) => withEnding(root, ending))), ...PHRASES]);
for (const word of new Set([...badWords].map(squashed))) wholeWords.addPhrase((phrase) => phrase.addPattern(parseRawPattern(`|${word}|`)));
/** Matches a whole piece, or a run of pieces joined, only when it is exactly a bad word, so "Anna Li" ("annali") passes. */
const exactly = matcherFor(wholeWords, []);

const realName = new Set(REAL_NAMES);

/** Every run of up to LONGEST_SPLIT neighbouring pieces of the name, joined with nothing between them. */
function runs(name: string): string[] {
	const pieces = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((piece) => piece !== '');
	return pieces.flatMap((_, start) => pieces.slice(start, start + LONGEST_SPLIT).map((__, length) => pieces.slice(start, start + length + 1).join('')));
}

/**
 * Whether a display name is fit for other children to read. The library sees lookalike letters ("sh1t", "c00n") and
 * repeated letters ("fuuuck"). A word split up to slip past it ("fuc ker", "b.i.t.c.h") is caught by joining
 * neighbouring pieces and asking whether the result is exactly a bad word.
 */
export function isKindName(name: string): boolean {
	if (AS_TYPED.test(name) || asWritten.hasMatch(` ${name} `)) return false;
	return !runs(name).some((run) => !realName.has(run) && exactly.hasMatch(` ${run} `));
}
