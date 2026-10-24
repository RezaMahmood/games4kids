import { makeTurn, packTurn, rightColour, roundClockMs, turnsIn, type EndReason, type LoggedTurn, type Mode, type PackedTurn, type Rng, type Tuning } from '../../games/colourmatch/data/index.ts';

/** mulberry32, so a test's turns come out the same every run. */
export function seeded(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const DEVICE = { pointer: 'touch', width: 390, height: 844, dpr: 3, orientation: 'portrait', userAgent: 'test' } as const;

export type Simulation = {
	readonly tuning: Tuning;
	readonly mode: Mode;
	readonly rng: Rng;
	/** How many words the child sees. The last `maxMistakes` are wrong when `endReason` is mistakes; the last one times out when it is clock. */
	readonly turns: number;
	readonly endReason: EndReason;
	readonly answerMs?: number | ((index: number) => number);
	readonly wrongAt?: (index: number) => boolean;
	readonly startedAt?: string;
	readonly tuningId?: string;
};

export type WireLog = { mode: Mode; tuningId: string; startedAt: string; endReason: EndReason; device: typeof DEVICE; hiddenMs: number; turns: PackedTurn[] };

/** A game played by the rules, as the page would send it. */
export function simulateGame({ tuning, mode, rng, turns: count, endReason, answerMs = 700, wrongAt = () => false, startedAt = '2026-10-19T19:00:00.000Z', tuningId = 'default' }: Simulation): WireLog {
	const turns: LoggedTurn[] = [];
	const recentCorrectMs: number[] = [];
	let round = 1;
	let turn = 0;
	let clockLeft = roundClockMs(tuning, 1);
	let shownAt = 0;
	for (let index = 0; index < count; index++) {
		const made = makeTurn(tuning, { round, turnInGame: index, recentCorrectMs }, rng);
		const last = index === count - 1;
		const right = made.squares.indexOf(rightColour(mode, made));
		const wrong = wrongAt(index) || (endReason === 'mistakes' && index >= count - tuning.maxMistakes);
		const ms = typeof answerMs === 'function' ? answerMs(index) : answerMs;
		const timedOut = last && endReason === 'clock';
		clockLeft = timedOut ? 0 : clockLeft - ms;
		const answer = timedOut ? null : { tapped: wrong ? (right + 1) % 4 : right, answerMs: ms, x: 0.5, y: 0.5, pointer: 'touch' as const };
		if (answer && !wrong) recentCorrectMs.push(ms);
		turns.push({ round, turn, word: made.word, ink: made.ink, squares: made.squares, answer, shownAtMs: shownAt, clockLeftMs: clockLeft });
		shownAt += ms + 400;
		if (turn + 1 < turnsIn(tuning, round)) turn++;
		else {
			round++;
			turn = 0;
			clockLeft = roundClockMs(tuning, round);
		}
	}
	return { mode, tuningId, startedAt, endReason, device: DEVICE, hiddenMs: 0, turns: turns.map(packTurn) };
}
