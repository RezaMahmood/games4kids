import type { Tuning } from './tuning.ts';

export const turnsIn = (tuning: Tuning, round: number): number => Math.min(tuning.maxTurns, tuning.firstTurns + round - 1);

export const secondsPerTurn = (tuning: Tuning, round: number): number => Math.max(tuning.minSecondsPerTurn, tuning.firstSecondsPerTurn * tuning.decay ** (round - 1));

/** The round's whole clock, which runs only while a word is on screen. */
export const roundClockMs = (tuning: Tuning, round: number): number => Math.round(turnsIn(tuning, round) * secondsPerTurn(tuning, round) * 1000);

export const roundMultiplier = (tuning: Tuning, round: number): number => 1 + tuning.roundMultiplierStep * (round - 1);

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** The chance the next word is written in another colour. It climbs with the round, and faster when the child's last three correct answers were quick. */
export function mismatchChance(tuning: Tuning, round: number, recentCorrectMs: readonly number[]): number {
	const recent = median(recentCorrectMs.slice(-3));
	const fast = recent !== null && recent < tuning.fastMs;
	return Math.min(tuning.maxChance, tuning.startChance + tuning.perRound * (round - 1) + (fast ? tuning.fastBonus : 0));
}
