// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { score, toleranceFor } from '../../games/letterjoin/play/web/scoring.js';

const W = 420;
const H = 200;
const FONT = 80;
const STROKE_WIDTH = 12;
const TOL = toleranceFor(FONT);

const target = [
  { x: 20, y: 160 }, { x: 20, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 100 },
  { x: 180, y: 100 }, { x: 180, y: 170 }, { x: 260, y: 170 }, { x: 260, y: 40 },
];

const segDist = (px, py, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
};

const maskFromPolyline = (poly, width) => {
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let i = 1; i < poly.length; i++) {
        if (segDist(x, y, poly[i - 1], poly[i]) <= width / 2) {
          mask[y * W + x] = 1;
          break;
        }
      }
    }
  }
  return mask;
};

const dense = (poly, step) => {
  const out = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let s = 1; s <= n; s++) out.push({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
  }
  return out;
};

const mask = maskFromPolyline(target, STROKE_WIDTH);
const run = (strokes, tolerance = TOL) => score({ mask, width: W, height: H, strokes, tolerance });

test('a perfect trace scores at least 90', () => {
  const r = run([dense(target, 3)]);
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.ok(r.coverage > 0.95 && r.precision > 0.95);
});

test('tracing half the target scores clearly lower and coverage shows it', () => {
  const full = run([dense(target, 3)]);
  const half = run([dense(target.slice(0, 4), 3)]);
  assert.ok(half.coverage > 0.35 && half.coverage < 0.65, `coverage ${half.coverage}`);
  assert.ok(half.precision > 0.95);
  assert.ok(half.score < full.score - 20, `half ${half.score} vs full ${full.score}`);
  assert.ok(half.score < 75);
});

test('scribbling far from the target scores under 20', () => {
  const scribble = [];
  for (let i = 0; i < 40; i++) scribble.push({ x: 300 + (i % 2) * 100, y: 100 + i * 2.2 });
  const r = run([scribble]);
  assert.ok(r.score < 20, `score ${r.score}`);
  assert.ok(r.precision < 0.2);
});

test('a faithful trace plus scribbling outside scores lower than the faithful trace alone', () => {
  const noise = [];
  for (let i = 0; i < 60; i++) noise.push({ x: 280 + (i % 2) * 120, y: 20 + i * 2.8 });
  const faithful = run([dense(target, 3)]);
  const messy = run([dense(target, 3), noise]);
  assert.ok(messy.coverage > 0.95);
  assert.ok(messy.precision < 0.8, `precision ${messy.precision}`);
  assert.ok(messy.score < faithful.score - 10);
});

test('a wobbly trace within tolerance still scores high', () => {
  const wobbly = [];
  for (let i = 1; i < target.length; i++) {
    const a = target[i - 1];
    const b = target[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4);
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const off = Math.sin((wobbly.length + s) * 0.9) * 3;
      wobbly.push({ x: a.x + (b.x - a.x) * t + off, y: a.y + (b.y - a.y) * t - off });
    }
  }
  const r = run([wobbly]);
  assert.ok(r.score >= 85, `score ${r.score}`);
});

test('fast sparse pointer samples with large gaps score like a dense trace', () => {
  const sparse = run([target]);
  const full = run([dense(target, 3)]);
  assert.ok(sparse.score >= 90, `score ${sparse.score}`);
  assert.ok(Math.abs(sparse.score - full.score) < 2);
});

test('no strokes score zero', () => {
  assert.deepEqual(run([]), { coverage: 0, precision: 0, score: 0 });
});

test('tolerance scales with font size so the same offset passes on large text only', () => {
  const offset = target.map((p) => ({ x: p.x, y: p.y + 12 }));
  const small = run([offset], toleranceFor(40));
  const large = run([offset], toleranceFor(120));
  assert.ok(small.score < 60, `small ${small.score}`);
  assert.ok(large.score >= 90, `large ${large.score}`);
});

test('strokes outside the grid are misses and do not throw', () => {
  const r = run([[{ x: -50, y: -50 }, { x: -10, y: -10 }]]);
  assert.equal(r.score, 0);
});
