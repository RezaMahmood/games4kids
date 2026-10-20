import test from 'node:test';
import assert from 'node:assert/strict';
import { WORD_END_MS, initialPad, padGeometry, padReducer, strokesOn } from '../../games/letterjoin/play/web/write-pad.js';

const g = padGeometry({ width: 1000, xHeight: 40 });
const zone = g.width - g.edgeMargin;

/** A child at the pad: every event goes through the reducer and the effects are collected. */
function pad() {
  let state = initialPad();
  const effects = [];
  const send = (event) => {
    const out = padReducer(g, state, event);
    state = out.state;
    effects.push(...out.effects);
    return out.effects;
  };
  return {
    get state() { return state; },
    effects,
    tick: (t) => send({ type: 'tick', t }),
    newLine: () => send({ type: 'newLine' }),
    /** One stroke from x0 to x1 across the x-height of `line`, pen down at t and up 100 ms later. */
    stroke(x0, x1, line, t) {
      const top = line * g.lineHeight;
      const points = [0, 0.5, 1].map((k) => ({ x: x0 + (x1 - x0) * k, y: top + g.baseline - g.xHeight * (1 - k), t: t + 100 * k }));
      const down = send({ type: 'penDown', point: points[0] });
      const phaseWhileDown = state.phase.kind;
      const up = send({ type: 'penUp', points });
      return { effects: [...down, ...up], phaseWhileDown };
    },
  };
}

test('words written away from the edge never move the pad, however long the pen rests', () => {
  const p = pad();
  p.stroke(20, 120, 0, 0);
  p.stroke(160, 300, 0, 1000);
  assert.equal(p.state.phase.kind, 'writing');
  assert.deepEqual(p.tick(60_000), []);
  assert.equal(p.state.line, 0);
});

test('a word finished in the edge zone moves the child to the next line once the pen has rested', () => {
  const p = pad();
  p.stroke(20, 300, 0, 0);
  const into = p.stroke(zone - 40, zone + 30, 0, 1000);
  assert.equal(into.phaseWhileDown, 'writing');
  assert.equal(p.state.phase.kind, 'awaitingWordEnd', 'a stroke that ran into the zone is noticed when the pen lifts');
  const inside = p.stroke(zone + 40, zone + 60, 0, 1200);
  assert.equal(inside.phaseWhileDown, 'nearEdge', 'a stroke started in the zone is noticed while the pen is down');
  const lifted = 1300;
  assert.deepEqual(p.tick(lifted + WORD_END_MS - 1), [], 'a short pause between letters is not the end of the word');
  assert.deepEqual(p.tick(lifted + WORD_END_MS), [{ type: 'advance', from: 0 }, { type: 'read', line: 0 }]);
  assert.equal(p.state.line, 1);
  assert.equal(p.state.view, 1, 'the paper moves with it');
  assert.equal(p.state.phase.kind, 'writing');
  p.stroke(20, 100, 1, 3000);
  assert.equal(strokesOn(p.state, 1).length, 1, 'the next word is on the new line');
  assert.equal(strokesOn(p.state, 0).length, 3);
});

test('going back into the last word, to dot an i, restarts the wait', () => {
  const p = pad();
  p.stroke(zone - 40, zone + 30, 0, 0);
  p.stroke(zone, zone + 2, 0, 400);
  assert.deepEqual(p.tick(100 + WORD_END_MS), [], 'the first lift no longer counts');
  assert.equal(p.tick(500 + WORD_END_MS).length, 2);
  assert.equal(p.state.line, 1);
});

test('a new word started in the edge zone stays on its line until that word ends', () => {
  const p = pad();
  p.stroke(zone - 100, zone + 10, 0, 0);
  const next = p.stroke(zone + 60, zone + 100, 0, 300);
  assert.deepEqual(next.effects, [], 'the paper does not move under a word just begun');
  assert.equal(strokesOn(p.state, 0).length, 2);
  assert.equal(p.tick(400 + WORD_END_MS).length, 2);
});

test('starting to write on the line below reads the line left behind at once, and the paper waits for a rest', () => {
  const p = pad();
  p.stroke(20, 200, 0, 0);
  const { effects } = p.stroke(20, 120, 1, 500);
  assert.deepEqual(effects, [{ type: 'read', line: 0 }]);
  assert.equal(p.state.line, 1);
  assert.deepEqual(strokesOn(p.state, 1).map((s) => s.points[0].x), [20], 'the stroke belongs to the line it started on');
  p.stroke(140, 220, 1, 700);
  assert.deepEqual(p.tick(800 + WORD_END_MS - 1), [], 'no scroll between the letters of the word');
  assert.equal(p.state.view, 0);
  assert.deepEqual(p.tick(800 + WORD_END_MS), [{ type: 'advance', from: 0 }]);
  assert.equal(p.state.view, 1);
});

test('ink started on a line already left counts on the current line', () => {
  const p = pad();
  p.stroke(20, 200, 0, 0);
  p.newLine();
  p.stroke(20, 120, 0, 500);
  assert.equal(strokesOn(p.state, 0).length, 1, 'the finished line is unchanged');
  assert.equal(strokesOn(p.state, 1).length, 1);
});

test('New line moves on and reads the line, and an empty line is skipped without a read', () => {
  const p = pad();
  p.stroke(20, 200, 0, 0);
  assert.deepEqual(p.newLine(), [{ type: 'advance', from: 0 }, { type: 'read', line: 0 }]);
  assert.deepEqual(p.newLine(), [{ type: 'advance', from: 1 }]);
  assert.equal(p.state.line, 2);
});
