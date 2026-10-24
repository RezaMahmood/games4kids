import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as server from '../../games/colourmatch/data/index.ts';
import * as page from '../../games/colourmatch/play/web/rules.js';
import { seeded } from './support.ts';

const TUNINGS = [
  server.DEFAULT_TUNING,
  { ...server.DEFAULT_TUNING, openingTurns: 0, startChance: 0.6, maxChance: 1, firstTurns: 3, maxTurns: 4, decay: 0.7, minSecondsPerTurn: 0.5 },
  { ...server.DEFAULT_TUNING, openingTurns: 10, perRound: 0.5, fastBonus: 0.5, fastMs: 5000, firstSecondsPerTurn: 10, hardMultiplier: 5, roundMultiplierStep: 2, basePoints: 7 },
];

test('the page and the server share the tuning table, its defaults and its parser, and the palette', () => {
  assert.deepEqual(page.TUNING_FIELDS, server.TUNING_FIELDS);
  assert.deepEqual(page.DEFAULT_TUNING, server.DEFAULT_TUNING);
  assert.deepEqual(page.COLOURS, server.COLOURS);
  assert.equal(page.WORD_BACKGROUND, server.WORD_BACKGROUND);
  for (const raw of [...TUNINGS, { ...server.DEFAULT_TUNING, decay: 2, maxTurns: 1 }, { ...server.DEFAULT_TUNING, fastMs: 1.5, basePoints: 'x' }, null, [], {}]) {
    assert.deepEqual(page.parseTuning(raw), server.parseTuning(raw), JSON.stringify(raw));
  }
});

test('the page schedules rounds, scores words and judges speed the way the server does', () => {
  for (const tuning of TUNINGS) {
    for (let round = 1; round <= 40; round++) {
      assert.equal(page.turnsIn(tuning, round), server.turnsIn(tuning, round));
      assert.equal(page.secondsPerTurn(tuning, round), server.secondsPerTurn(tuning, round));
      assert.equal(page.roundClockMs(tuning, round), server.roundClockMs(tuning, round));
      assert.equal(page.roundMultiplier(tuning, round), server.roundMultiplier(tuning, round));
      for (const recent of [[], [100], [3000, 100, 900], [100, 100, 100, 9000, 9000]]) assert.equal(page.mismatchChance(tuning, round, recent), server.mismatchChance(tuning, round, recent));
      for (const mode of ['normal', 'hard']) for (const ms of [0, 1, 333, 1199, 1200, 2500, 4000, 60_000]) assert.equal(page.turnPoints(tuning, mode, round, ms), server.turnPoints(tuning, mode, round, ms), `${mode} round ${round} ${ms} ms`);
    }
  }
});

test('the page deals the same words as the server from the same random numbers', () => {
  for (const tuning of TUNINGS) {
    for (let seed = 1; seed <= 25; seed++) {
      const theirs = seeded(seed);
      const ours = seeded(seed);
      const recent = [];
      for (let i = 0; i < 60; i++) {
        const context = { round: 1 + Math.floor(i / 5), turnInGame: i, recentCorrectMs: recent };
        const a = page.makeTurn(tuning, context, ours);
        const b = server.makeTurn(tuning, context, theirs);
        assert.deepEqual(a, b, `seed ${seed} word ${i}`);
        assert.equal(page.rightColour('hard', a), server.rightColour('hard', b));
        recent.push(300 + ((seed * i) % 1500));
      }
    }
  }
});

test('the page packs a turn into the 15 slots the server reads', () => {
  const turn = { round: 2, turn: 3, word: 'red', ink: 'blue', squares: ['red', 'blue', 'pink', 'brown'], answer: { tapped: 1, answerMs: 876, x: 0.25, y: 0.75, pointer: 'touch' }, shownAtMs: 12_345, clockLeftMs: 9_000 };
  assert.deepEqual(page.packTurn(turn), server.packTurn(turn));
  const timedOut = { ...turn, answer: null, clockLeftMs: 0 };
  assert.deepEqual(page.packTurn(timedOut), server.packTurn(timedOut));
  assert.equal(page.packTurn(turn).length, 15);
});

test('the admin page holds a byte for byte copy of the play rules, so its preview cannot drift from what a child plays', () => {
  const root = new URL('../../games/colourmatch/', import.meta.url);
  assert.equal(readFileSync(new URL('admin/web/rules.js', root), 'utf8'), readFileSync(new URL('play/web/rules.js', root), 'utf8'), 'copy play/web/rules.js to admin/web/rules.js');
});
