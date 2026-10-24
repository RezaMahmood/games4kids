import { isRecord, type Parsed } from './parse.ts';

/** The id of the tuning a game was played under: a `tuning` row key, or `default` before any row exists. */
export const DEFAULT_TUNING_ID = 'default';
export const TUNING_ID = /^[A-Za-z0-9-]{1,80}$/;

type FieldSpec = { readonly label: string; readonly min: number; readonly max: number; readonly integer: boolean; readonly default: number };

/** Every knob the admin turns, with its bounds. The admin page's rules.js holds the same table, and the parity test keeps them equal. */
export const TUNING_FIELDS = {
	openingTurns: { label: 'Opening turns where the word and its ink match', min: 0, max: 10, integer: true, default: 3 },
	startChance: { label: 'Chance of a mismatch in round 1', min: 0, max: 1, integer: false, default: 0.25 },
	perRound: { label: 'Added chance per round', min: 0, max: 0.5, integer: false, default: 0.1 },
	fastBonus: { label: 'Added chance when the child is answering fast', min: 0, max: 0.5, integer: false, default: 0.15 },
	fastMs: { label: 'Fast means a median answer under this many ms', min: 200, max: 5000, integer: true, default: 1200 },
	maxChance: { label: 'Highest chance of a mismatch', min: 0, max: 1, integer: false, default: 0.8 },
	firstTurns: { label: 'Words in round 1', min: 1, max: 20, integer: true, default: 5 },
	maxTurns: { label: 'Most words in a round', min: 1, max: 30, integer: true, default: 10 },
	firstSecondsPerTurn: { label: 'Seconds per word in round 1', min: 1, max: 10, integer: false, default: 4 },
	decay: { label: 'Seconds per word shrink by this factor each round', min: 0.5, max: 1, integer: false, default: 0.9 },
	minSecondsPerTurn: { label: 'Fewest seconds per word', min: 0.5, max: 10, integer: false, default: 1.2 },
	maxMistakes: { label: 'Mistakes in a row that end the game', min: 1, max: 10, integer: true, default: 3 },
	basePoints: { label: 'Points for a correct answer before bonuses', min: 1, max: 1000, integer: true, default: 100 },
	roundMultiplierStep: { label: 'Points multiplier grows by this each round', min: 0, max: 2, integer: false, default: 0.25 },
	hardMultiplier: { label: 'Points multiplier in hard mode', min: 1, max: 5, integer: false, default: 1.5 },
} as const satisfies Record<string, FieldSpec>;

export type TuningField = keyof typeof TUNING_FIELDS;
export type Tuning = { readonly [K in TuningField]: number };

export const TUNING_FIELD_NAMES = Object.keys(TUNING_FIELDS) as TuningField[];

export const DEFAULT_TUNING: Tuning = Object.fromEntries(TUNING_FIELD_NAMES.map((name) => [name, TUNING_FIELDS[name].default])) as Tuning;

export function parseTuning(raw: unknown): Parsed<Tuning> {
	if (!isRecord(raw)) return { ok: false, problems: ['tuning must be an object'] };
	const problems: string[] = [];
	const tuning: Record<string, number> = {};
	for (const name of TUNING_FIELD_NAMES) {
		const spec = TUNING_FIELDS[name];
		const value = raw[name];
		if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${name} must be a number`);
		else if (value < spec.min || value > spec.max) problems.push(`${name} must be between ${spec.min} and ${spec.max}`);
		else if (spec.integer && !Number.isInteger(value)) problems.push(`${name} must be a whole number`);
		else tuning[name] = value;
	}
	const atMost = (low: TuningField, high: TuningField) => {
		const a = tuning[low];
		const b = tuning[high];
		if (a !== undefined && b !== undefined && a > b) problems.push(`${low} must be at most ${high}`);
	};
	atMost('firstTurns', 'maxTurns');
	atMost('minSecondsPerTurn', 'firstSecondsPerTurn');
	atMost('startChance', 'maxChance');
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: tuning as Tuning };
}
