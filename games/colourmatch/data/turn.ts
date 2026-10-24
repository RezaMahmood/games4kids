import { COLOUR_IDS, type ColourId } from './palette.ts';
import { mismatchChance } from './schedule.ts';
import type { Tuning } from './tuning.ts';

export type Mode = 'normal' | 'hard';
export const MODES = ['normal', 'hard'] as const satisfies readonly Mode[];
export const isMode = (value: unknown): value is Mode => MODES.some((mode) => mode === value);

/** A number in [0, 1), like Math.random. Tests pass a seeded one. */
export type Rng = () => number;

export type Squares = readonly [ColourId, ColourId, ColourId, ColourId];
export type Turn = { readonly word: ColourId; readonly ink: ColourId; readonly squares: Squares };

/** Where the next word falls in the game: its round, how many words came before it, and how fast the recent correct answers were. */
export type TurnContext = { readonly round: number; readonly turnInGame: number; readonly recentCorrectMs: readonly number[] };

const pick = <T>(from: readonly T[], rng: Rng): T => {
	const chosen = from[Math.floor(rng() * from.length)];
	if (chosen === undefined) throw new Error('pick needs a non-empty list');
	return chosen;
};

function shuffle<T>(items: T[], rng: Rng): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const a = items[i];
		const b = items[j];
		if (a !== undefined && b !== undefined) [items[i], items[j]] = [b, a];
	}
	return items;
}

/** The colour the child must tap: what the word says in normal mode, the ink it is written in on hard. */
export const rightColour = (mode: Mode, turn: Turn): ColourId => (mode === 'normal' ? turn.word : turn.ink);

export const isCongruent = (turn: { readonly word: ColourId; readonly ink: ColourId }): boolean => turn.word === turn.ink;

/**
 * A word and four squares. The opening turns match word and ink. After them the ink differs with mismatchChance. The
 * squares always hold the word's colour and the ink's, so both the answer and the lure are on screen, plus random fillers.
 */
export function makeTurn(tuning: Tuning, context: TurnContext, rng: Rng): Turn {
	const word = pick(COLOUR_IDS, rng);
	const mismatch = context.turnInGame >= tuning.openingTurns && rng() < mismatchChance(tuning, context.round, context.recentCorrectMs);
	const ink = mismatch ? pick(COLOUR_IDS.filter((id) => id !== word), rng) : word;
	const chosen = [word, ...(ink === word ? [] : [ink])];
	while (chosen.length < 4) chosen.push(pick(COLOUR_IDS.filter((id) => !chosen.includes(id)), rng));
	const [a, b, c, d] = shuffle(chosen, rng);
	if (!a || !b || !c || !d) throw new Error('a turn has four squares');
	return { word, ink, squares: [a, b, c, d] };
}
