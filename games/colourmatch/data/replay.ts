import type { GameLog, LoggedTurn } from './log.ts';
import type { Parsed } from './parse.ts';
import { median, roundClockMs, turnsIn } from './schedule.ts';
import { turnPoints } from './score.ts';
import { isCongruent, rightColour } from './turn.ts';
import type { Tuning } from './tuning.ts';

/** What the server worked out about one logged word. */
export type TurnMark = { readonly correct: boolean; readonly points: number; readonly congruent: boolean };
export type MarkedTurn = LoggedTurn & TurnMark;

/** The per-game row the admin reads. Every number here is the server's, derived from the turns and the tuning they were played under. */
export type Summary = {
	readonly mode: GameLog['mode'];
	readonly tuningId: string;
	readonly endReason: GameLog['endReason'];
	readonly score: number;
	readonly roundsReached: number;
	readonly turns: number;
	readonly correct: number;
	/** correct / turns, 0 to 1. */
	readonly accuracy: number;
	readonly longestStreak: number;
	/** Median ms of correct answers where the ink matched the word, or null with none. */
	readonly medianCongruentMs: number | null;
	/** The same for mismatched words. The gap between the two is the Stroop cost. */
	readonly medianIncongruentMs: number | null;
	readonly timeouts: number;
	readonly hiddenMs: number;
	readonly pointer: GameLog['device']['pointer'];
	/** `<width>x<height>` CSS pixels. */
	readonly viewport: string;
	readonly startedAt: string;
};

export type Replayed = { readonly turns: readonly MarkedTurn[]; readonly summary: Summary };

/** The order the words must come in: each round's words from 0, then the next round. */
function checkSequence(tuning: Tuning, turns: readonly LoggedTurn[], problems: string[]): void {
	let expected = { round: 1, turn: 0 };
	for (const [index, { round, turn }] of turns.entries()) {
		if (round !== expected.round || turn !== expected.turn) {
			problems.push(`turns[${index}] is round ${round} word ${turn}, but round ${expected.round} word ${expected.turn} comes next`);
			return;
		}
		expected = turn + 1 < turnsIn(tuning, round) ? { round, turn: turn + 1 } : { round: round + 1, turn: 0 };
	}
}

function checkSquares(tuning: Tuning, turns: readonly LoggedTurn[], problems: string[]): void {
	for (const [index, { word, ink, squares }] of turns.entries()) {
		if (index < tuning.openingTurns && word !== ink) problems.push(`turns[${index}] is an opening word, so its ink must match`);
		if (new Set(squares).size !== 4) problems.push(`turns[${index}] must show four different colours`);
		if (!squares.includes(word) || !squares.includes(ink)) problems.push(`turns[${index}] must show the word's colour and the ink's`);
	}
}

/** A round's answers cannot outlast its clock, and the clock ends only the last word. */
function checkClock(tuning: Tuning, log: GameLog, problems: string[]): void {
	const spent = new Map<number, number>();
	for (const [index, { round, answer, clockLeftMs }] of log.turns.entries()) {
		const clock = roundClockMs(tuning, round);
		if (clockLeftMs > clock) problems.push(`turns[${index}] has more clock left than round ${round} has`);
		if (answer === null) {
			if (index !== log.turns.length - 1 || log.endReason !== 'clock') problems.push(`turns[${index}] ran out of clock, which ends the game`);
			continue;
		}
		const before = spent.get(round) ?? 0;
		spent.set(round, before + answer.answerMs);
		if (before <= clock && before + answer.answerMs > clock) problems.push(`turns[${index}] was answered after round ${round}'s clock ran out`);
	}
	if (log.endReason === 'clock' && log.turns.at(-1)?.answer !== null) problems.push('a game the clock ended ends on a word the clock ran out on');
}

/** A timeout is not a mistake: the clock running out ends the game by the clock, whatever came before it. */
function checkMistakes(tuning: Tuning, log: GameLog, marks: readonly MarkedTurn[], problems: string[]): void {
	let streak = 0;
	for (const [index, mark] of marks.entries()) {
		if (mark.answer === null) continue;
		streak = mark.correct ? 0 : streak + 1;
		if (streak >= tuning.maxMistakes && index !== marks.length - 1) problems.push(`turns[${index}] was the ${tuning.maxMistakes}th mistake in a row, which ends the game`);
	}
	if (log.endReason === 'mistakes' && streak < tuning.maxMistakes) problems.push(`a game ended by mistakes ends on the ${tuning.maxMistakes}th mistake in a row`);
	if (log.endReason !== 'mistakes' && streak >= tuning.maxMistakes) problems.push(`${tuning.maxMistakes} mistakes in a row end the game, so endReason must be mistakes`);
}

function longestRun(marks: readonly TurnMark[]): number {
	let best = 0;
	let run = 0;
	for (const mark of marks) {
		run = mark.correct ? run + 1 : 0;
		best = Math.max(best, run);
	}
	return best;
}

/**
 * Marks the whole log again from the turns and the tuning it names, so no score comes from the page. A log that could
 * not have come from a game played by the rules is refused with each thing wrong.
 */
export function replayGame(tuning: Tuning, log: GameLog): Parsed<Replayed> {
	const problems: string[] = [];
	checkSequence(tuning, log.turns, problems);
	checkSquares(tuning, log.turns, problems);
	checkClock(tuning, log, problems);
	const marked = log.turns.map((turn): MarkedTurn => {
		const correct = turn.answer !== null && turn.squares[turn.answer.tapped] === rightColour(log.mode, turn);
		const points = correct && turn.answer ? turnPoints(tuning, log.mode, turn.round, turn.answer.answerMs) : 0;
		return { ...turn, correct, points, congruent: isCongruent(turn) };
	});
	checkMistakes(tuning, log, marked, problems);
	if (problems.length > 0) return { ok: false, problems };
	const correctMs = (congruent: boolean) => marked.flatMap((turn) => (turn.correct && turn.answer && turn.congruent === congruent ? [turn.answer.answerMs] : []));
	const correct = marked.filter((turn) => turn.correct).length;
	return {
		ok: true,
		value: {
			turns: marked,
			summary: {
				mode: log.mode,
				tuningId: log.tuningId,
				endReason: log.endReason,
				score: marked.reduce((sum, turn) => sum + turn.points, 0),
				roundsReached: log.turns.at(-1)?.round ?? 0,
				turns: log.turns.length,
				correct,
				accuracy: correct / log.turns.length,
				longestStreak: longestRun(marked),
				medianCongruentMs: median(correctMs(true)),
				medianIncongruentMs: median(correctMs(false)),
				timeouts: log.turns.filter((turn) => turn.answer === null).length,
				hiddenMs: log.hiddenMs,
				pointer: log.device.pointer,
				viewport: `${log.device.width}x${log.device.height}`,
				startedAt: log.startedAt,
			},
		},
	};
}
