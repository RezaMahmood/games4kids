import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TUNING, parseGameLog, replayGame, roundClockMs, turnsIn } from '../../games/colourmatch/data/index.ts';
import { advance, clockLeftAt, clockOut, hide, leave, startGame, tap, toLog, unhide } from '../../games/colourmatch/play/web/game.js';
import { rightColour } from '../../games/colourmatch/play/web/rules.js';
import { DEVICE, seeded } from './support.ts';

const T = DEFAULT_TUNING;
const GAME_ID = '0b5f6c7a-1111-4222-8333-444455556666';
const STARTED = '2026-10-19T19:59:00.000Z';
const NOW = new Date('2026-10-19T20:00:00Z');

const begin = (mode = 'normal') => startGame({ mode, tuningId: 'default', tuning: T, startedAt: STARTED, now: 1000 });
const rightIndex = (state) => state.word.squares.indexOf(rightColour(state.game.mode, state.word));
const at = (state, index, ms) => tap(state, { index, x: 0.5, y: 0.5, pointer: 'touch' }, state.shownAtNow + ms);

/** The server's verdict on the page's log. */
function serverSays(state) {
  const log = parseGameLog(GAME_ID, toLog(state, DEVICE), NOW);
  assert.ok(log.ok, log.ok ? '' : log.problems.join('; '));
  const replayed = replayGame(T, log.value);
  assert.ok(replayed.ok, replayed.ok ? '' : replayed.problems.join('; '));
  return replayed.value.summary;
}

test('a game opens on the round intro, deals a word, scores a right tap by its speed and flashes, and the next round starts once the words are done', () => {
  const rng = seeded(1);
  let state = begin();
  assert.equal(state.kind, 'roundIntro');
  assert.deepEqual([state.game.round, state.game.clockLeftMs, state.game.score], [1, 20_000, 0]);
  state = advance(state, rng, 5000);
  assert.equal(state.kind, 'showing');
  assert.equal(state.word.word, state.word.ink, 'an opening word matches its ink');
  state = at(state, rightIndex(state), 2000);
  assert.deepEqual([state.kind, state.outcome, state.points, state.game.score, state.game.clockLeftMs, state.game.correct, state.game.mistakes], ['feedback', 'correct', 75, 75, 18_000, 1, 0]);
  for (let i = 1; i < turnsIn(T, 1); i++) {
    state = advance(state, rng, 10_000 + i * 1000);
    assert.equal(state.kind, 'showing');
    state = at(state, rightIndex(state), 500);
  }
  state = advance(state, rng, 20_000);
  assert.deepEqual([state.kind, state.game.round, state.game.turn, state.game.clockLeftMs], ['roundIntro', 2, 0, roundClockMs(T, 2)]);
  assert.equal(state.game.turns.length, 5);
});

test('a wrong tap flashes and moves on, the third in a row ends the game, and the server agrees with the page about the score', () => {
  const rng = seeded(2);
  let state = advance(begin('hard'), rng, 2000);
  for (let i = 0; i < 4; i++) {
    state = at(state, rightIndex(state), 700);
    state = advance(state, rng, 4000 + i * 2000);
  }
  state = at(state, (rightIndex(state) + 1) % 4, 900);
  assert.deepEqual([state.kind, state.outcome, state.points, state.game.mistakes], ['feedback', 'wrong', 0, 1]);
  state = advance(state, rng, 30_000);
  assert.equal(state.kind, 'roundIntro', 'the wrong word was the round\'s last');
  state = advance(state, rng, 32_000);
  state = at(state, (rightIndex(state) + 1) % 4, 900);
  state = advance(state, rng, 35_000);
  state = at(state, (rightIndex(state) + 2) % 4, 900);
  assert.deepEqual([state.kind, state.reason, state.game.turns.length], ['over', 'mistakes', 7]);
  const server = serverSays(state);
  assert.deepEqual([server.score, server.correct, server.roundsReached, server.endReason, server.mode], [state.game.score, 4, 2, 'mistakes', 'hard']);
  assert.ok(state.game.score > 0);
});

test('the round clock counts only while a word is on screen, pauses while the page is hidden, and ends the game at zero', () => {
  const rng = seeded(3);
  let state = advance(begin(), rng, 1000);
  assert.equal(clockLeftAt(state, 1000), 20_000);
  assert.equal(clockLeftAt(state, 4000), 17_000);
  state = hide(state, 4000);
  assert.equal(clockLeftAt(state, 9000), 17_000, 'hidden time does not count');
  state = unhide(state, 9000);
  assert.equal(clockLeftAt(state, 9500), 16_500);
  assert.equal(state.game.hiddenMs, 5000);
  state = at(state, rightIndex(state), 3500);
  assert.equal(state.game.clockLeftMs, 16_500, 'the answer took 3.5 s of clock, none of it while hidden');
  state = advance(state, rng, 20_000);
  const late = at(state, rightIndex(state), 16_500);
  assert.deepEqual([late.kind, late.reason], ['over', 'clock'], 'a tap after the clock ran out is the clock running out');
  const out = clockOut(state);
  assert.deepEqual([out.kind, out.reason, out.game.turns.at(-1)[8], out.game.turns.at(-1)[14]], ['over', 'clock', null, 0]);
  const server = serverSays(out);
  assert.deepEqual([server.timeouts, server.hiddenMs, server.turns], [1, 5000, 2]);
});

test('two wrong taps and then the clock running out end the game by the clock, and the server takes the page\'s log', () => {
  const rng = seeded(5);
  let state = advance(begin(), rng, 1000);
  for (let i = 0; i < 2; i++) {
    state = at(state, (rightIndex(state) + 1) % 4, 900);
    assert.equal(state.kind, 'feedback');
    state = advance(state, rng, 10_000 + i * 2000);
  }
  state = clockOut(state);
  assert.deepEqual([state.kind, state.reason, state.game.mistakes], ['over', 'clock', 2]);
  const server = serverSays(state);
  assert.deepEqual([server.endReason, server.timeouts, server.correct, server.turns], ['clock', 1, 0, 3]);
});

test('a word dealt while the page is hidden waits with its clock stopped until the child is back', () => {
  const rng = seeded(6);
  let state = advance(begin(), rng, 1000);
  state = at(state, rightIndex(state), 1000);
  assert.equal(state.kind, 'feedback');
  state = advance(state, rng, 3000, true);
  assert.equal(clockLeftAt(state, 60_000), 19_000, 'the clock does not run while the child is away');
  state = unhide(state, 60_000);
  assert.equal(clockLeftAt(state, 61_000), 18_000);
  assert.equal(state.game.hiddenMs, 57_000);
});

test('leaving mid-game ends it as left when there is a word to save, and a game with no words has nothing to save', () => {
  const rng = seeded(4);
  const intro = begin();
  assert.equal(leave(intro), intro);
  let state = advance(intro, rng, 1000);
  assert.equal(leave(state), state, 'a word on screen with no answer yet is not a turn');
  state = at(state, rightIndex(state), 400);
  const left = leave(state);
  assert.deepEqual([left.kind, left.reason], ['over', 'left']);
  assert.equal(serverSays(left).endReason, 'left');
  assert.equal(leave(left), left);
});
