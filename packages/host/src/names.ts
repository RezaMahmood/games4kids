import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

/** Insults aimed at a person that the dataset leaves out. Whole words only, so "Fatima" stays fine. */
const INSULTS: ReadonlySet<string> = new Set(['idiot', 'stupid', 'loser', 'dumb', 'ugly', 'fat', 'smelly', 'hate']);

const profanity = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

const SINGLE_CHARACTER_GAP = /(?<=(?:^| )[\p{L}\p{N}]) (?=[\p{L}\p{N}](?: |$))/gu;

/**
 * Whether a display name is fit for other children to read. The dataset sees lookalike letters ("sh1t") but not
 * letters spaced apart ("f u c k"), so it also reads the name with single characters joined. Joining every word
 * instead would refuse names like Anna-Lee.
 */
export function isKindName(name: string): boolean {
	const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
	if (words.some((word) => INSULTS.has(word))) return false;
	return !profanity.hasMatch(name) && !profanity.hasMatch(words.join(' ').replace(SINGLE_CHARACTER_GAP, ''));
}
