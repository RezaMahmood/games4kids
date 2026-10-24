// The game as a state machine. Pure: time comes in as `now` (ms, any monotonic clock) and randomness as `rng`.
import { makeTurn, packTurn, rightColour, roundClockMs, turnPoints, turnsIn } from './rules.js';

/**
 * @typedef {{ mode: 'normal' | 'hard', tuningId: string, tuning: Record<string, number>, startedAt: string, startedNow: number,
 *   round: number, turn: number, turnInGame: number, clockLeftMs: number, score: number, correct: number, mistakes: number,
 *   recentCorrectMs: number[], turns: unknown[][], hiddenMs: number }} Game
 *   `turn` counts words within the round, `turnInGame` across the game, `mistakes` is the run of wrong answers so far.
 * @typedef {{ kind: 'roundIntro', game: Game }
 *   | { kind: 'showing', game: Game, word: { word: string, ink: string, squares: string[] }, shownAtNow: number, hiddenAtNow: number | null }
 *   | { kind: 'feedback', game: Game, outcome: 'correct' | 'wrong', points: number, tapped: number, right: number }
 *   | { kind: 'over', game: Game, reason: 'mistakes' | 'clock' | 'left' }} State
 */

/** @returns {State} */
export function startGame({ mode, tuningId, tuning, startedAt, now }) {
  return { kind: 'roundIntro', game: { mode, tuningId, tuning, startedAt, startedNow: now, round: 1, turn: 0, turnInGame: 0, clockLeftMs: roundClockMs(tuning, 1), score: 0, correct: 0, mistakes: 0, recentCorrectMs: [], turns: [], hiddenMs: 0 } };
}

/**
 * From the round intro or a flash to the next word, or to the next round's intro once the round's words are done. A word
 * dealt while the page is `hidden` starts with its clock stopped, as if hidden the moment it appeared.
 */
export function advance(state, rng, now, hidden = false) {
  const { game } = state;
  if (state.kind === 'feedback' && game.turn >= turnsIn(game.tuning, game.round)) {
    const round = game.round + 1;
    return { kind: 'roundIntro', game: { ...game, round, turn: 0, clockLeftMs: roundClockMs(game.tuning, round) } };
  }
  const word = makeTurn(game.tuning, { round: game.round, turnInGame: game.turnInGame, recentCorrectMs: game.recentCorrectMs }, rng);
  return { kind: 'showing', game, word, shownAtNow: now, hiddenAtNow: hidden ? now : null };
}

const logged = (state, answer, clockLeftMs) => ({
  round: state.game.round, turn: state.game.turn, ...state.word, answer, shownAtMs: Math.max(0, Math.round(state.shownAtNow - state.game.startedNow)), clockLeftMs,
});

/** A tap on square `index`. One that lands after the round clock ran out counts as the clock running out. */
export function tap(state, { index, x, y, pointer }, now) {
  const { game } = state;
  const answerMs = Math.max(0, Math.round(now - state.shownAtNow));
  if (answerMs >= game.clockLeftMs) return clockOut(state);
  const right = state.word.squares.indexOf(rightColour(game.mode, state.word));
  const correct = index === right;
  const points = correct ? turnPoints(game.tuning, game.mode, game.round, answerMs) : 0;
  const clockLeftMs = game.clockLeftMs - answerMs;
  const answer = { tapped: index, answerMs, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), pointer };
  const next = {
    ...game,
    turn: game.turn + 1,
    turnInGame: game.turnInGame + 1,
    clockLeftMs,
    score: game.score + points,
    correct: game.correct + (correct ? 1 : 0),
    mistakes: correct ? 0 : game.mistakes + 1,
    recentCorrectMs: correct ? [...game.recentCorrectMs.slice(-2), answerMs] : game.recentCorrectMs,
    turns: [...game.turns, packTurn(logged(state, answer, clockLeftMs))],
  };
  if (next.mistakes >= game.tuning.maxMistakes) return { kind: 'over', game: next, reason: 'mistakes' };
  return { kind: 'feedback', game: next, outcome: correct ? 'correct' : 'wrong', points, tapped: index, right };
}

/** The round clock reached zero while a word was on screen, which ends the game. */
export function clockOut(state) {
  return { kind: 'over', game: { ...state.game, turns: [...state.game.turns, packTurn(logged(state, null, 0))] }, reason: 'clock' };
}

/** What is left of the round clock at `now`, in ms. */
export function clockLeftAt(state, now) {
  if (state.kind !== 'showing') return state.game.clockLeftMs;
  const since = state.hiddenAtNow ?? now;
  return Math.max(0, state.game.clockLeftMs - (since - state.shownAtNow));
}

/** The page went out of sight: the clock stops. */
export function hide(state, now) {
  return state.kind === 'showing' && state.hiddenAtNow === null ? { ...state, hiddenAtNow: now } : state;
}

/** The page came back: the time away is kept off the clock and counted as hidden. */
export function unhide(state, now) {
  if (state.kind !== 'showing' || state.hiddenAtNow === null) return state;
  const away = now - state.hiddenAtNow;
  return { ...state, shownAtNow: state.shownAtNow + away, hiddenAtNow: null, game: { ...state.game, hiddenMs: state.game.hiddenMs + Math.round(away) } };
}

/** The child left mid-game. A game with no words yet has nothing worth saving. */
export function leave(state) {
  return state.kind === 'over' || state.game.turns.length === 0 ? state : { kind: 'over', game: state.game, reason: 'left' };
}

/** The log as the server reads it. */
export function toLog(state, device) {
  const { game } = state;
  return { mode: game.mode, tuningId: game.tuningId, startedAt: game.startedAt, endReason: state.reason, device, hiddenMs: game.hiddenMs, turns: game.turns };
}
