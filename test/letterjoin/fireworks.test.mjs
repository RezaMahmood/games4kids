import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_MS, createBurst, fade, planShow, startFireworks, stepParticles } from '../../games/letterjoin/play/web/fireworks.js';

/** A small deterministic random source. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('the show is in the middle of the screen and bursts go off one after another within the show', () => {
  const plan = planShow(seeded(), { width: 1000, height: 800, bursts: 6 });
  assert.equal(plan.length, 6);
  for (const b of plan) {
    assert.ok(b.x >= 300 && b.x <= 700, `x ${b.x} is central`);
    assert.ok(b.y >= 200 && b.y <= 440, `y ${b.y} is in the upper middle`);
    assert.ok(b.at >= 0 && b.at < SHOW_MS, `at ${b.at}`);
  }
  assert.deepEqual(plan.map((b) => b.at), [...plan.map((b) => b.at)].sort((a, b) => a - b), 'launch times rise');
});

test('the same random source gives the same show', () => {
  assert.deepEqual(planShow(seeded(3), { width: 900, height: 700 }), planShow(seeded(3), { width: 900, height: 700 }));
});

test('a burst throws sparks in every direction from one point', () => {
  const burst = createBurst(seeded(), { x: 100, y: 200, hue: 40, count: 40 });
  assert.equal(burst.length, 40);
  assert.ok(burst.every((p) => p.x === 100 && p.y === 200 && p.age === 0));
  assert.ok(burst.some((p) => p.vx > 0) && burst.some((p) => p.vx < 0) && burst.some((p) => p.vy > 0) && burst.some((p) => p.vy < 0));
});

test('sparks move, fall and fade, and every one has died within three seconds of its burst', () => {
  let sparks = createBurst(seeded(), { x: 0, y: 0, hue: 40 });
  const moved = stepParticles(sparks, 0.1);
  assert.equal(moved.length, sparks.length, 'none die at once');
  assert.ok(moved.every((p, i) => p.age > 0 && (p.x !== sparks[i].x || p.y !== sparks[i].y)));
  assert.ok(fade(moved[0]) < fade(sparks[0]), 'older sparks are dimmer');
  for (let t = 0; t < 3; t += 0.05) sparks = stepParticles(sparks, 0.05);
  assert.equal(sparks.length, 0);
  assert.equal(fade({ age: 5, life: 1 }), 0);
});

test('a visitor who prefers reduced motion gets no show and nothing to wait for', async () => {
  const canvas = { getContext() { throw new Error('should not draw'); } };
  const show = startFireworks(canvas, { reduced: true });
  await show.done;
  show.stop();
});

test('the canvas show runs to the end by itself and clears the canvas', async () => {
  const calls = [];
  const ctx = { scale() {}, clearRect: () => calls.push('clear'), beginPath() {}, arc() {}, fill() {}, set fillStyle(v) {}, set globalCompositeOperation(v) {} };
  const canvas = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: () => ctx };
  let t = 0;
  const frames = [];
  const show = startFireworks(canvas, { rng: seeded(), now: () => t, requestFrame: (fn) => frames.push(fn), reduced: false });
  for (let i = 0; i < 400 && frames.length; i++) {
    t += 16;
    frames.shift()();
  }
  await show.done;
  assert.equal(frames.length, 0, 'no frame is left scheduled');
  assert.ok(t < SHOW_MS + 2500, `finished in ${t} ms`);
  assert.equal(calls.at(-1), 'clear');
});
