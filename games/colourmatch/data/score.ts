import { roundMultiplier, secondsPerTurn } from './schedule.ts';
import type { Mode } from './turn.ts';
import type { Tuning } from './tuning.ts';

/** 1 for an instant answer, falling to 0.5 at the round's seconds per word and staying there. */
export const speedFactor = (answerMs: number, perTurnMs: number): number => 0.5 + 0.5 * Math.max(0, 1 - answerMs / perTurnMs);

export function turnPoints(tuning: Tuning, mode: Mode, round: number, answerMs: number): number {
	const speed = speedFactor(answerMs, secondsPerTurn(tuning, round) * 1000);
	return Math.round(tuning.basePoints * speed * roundMultiplier(tuning, round) * (mode === 'hard' ? tuning.hardMultiplier : 1));
}
