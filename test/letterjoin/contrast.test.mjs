import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (part, name) => readFileSync(new URL(`../../games/letterjoin/${part}/web/${name}`, import.meta.url), 'utf8');
const tokens = (css) => Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, name, hex]) => [name, hex.toLowerCase()]));

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2 contrast ratio of two #rrggbb colours. */
export const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const app = read('play', 'style.css');
const admin = read('admin', 'admin.css');
const A = tokens(app);
const D = tokens(admin);
const WHITE = '#ffffff';

/** Text on its background. AA asks 4.5:1 for normal text; the app is for children so none of it may go lower. */
const PAIRS = [
  ['body text on the page', A.ink, A.bg],
  ['muted text on the page', A.muted, A.bg],
  ['muted text on a card', A.muted, A.paper],
  ['muted text on the soft blue panels', A.muted, A['accent-soft']],
  ['white on the blue buttons and the picked style', WHITE, A.accent],
  ['headings on the page', A['accent-dark'], A.bg],
  ['headings on the soft blue toolbar', A['accent-dark'], A['accent-soft']],
  ['white on the Starter heading', WHITE, A.starter],
  ['white on the Explorer heading', WHITE, A.explorer],
  ['white on the Champion heading', WHITE, A.champion],
  ['Starter cheer text on a card', A.starter, A.paper],
  ['Explorer cheer text on a card', A.explorer, A.paper],
  ['Champion cheer text on a card', A.champion, A.paper],
  ['ink on the Starter badge', A.ink, A['starter-soft']],
  ['ink on the Explorer badge', A.ink, A['explorer-soft']],
  ['ink on the Champion badge', A.ink, A['champion-soft']],
  ['white on the green Finish, Done and Next buttons', WHITE, A.good],
  ['white on the done pill and the good score circle', WHITE, A.good],
  ['white on the timer warning', WHITE, A.low],
  ['good result text on its panel', A['good-dark'], A['good-soft']],
  ['okay result text on its panel', '#8a5300', A['ok-soft']],
  ['gentle result text on its panel', '#5a35c9', A['champion-soft']],
  ['the score chip text on its gold', '#1f2a44', '#ffc933'],
  ['white on the scoreboard hero, orange end', WHITE, '#c2410c'],
  ['white on the scoreboard hero, pink middle', WHITE, '#c93a6e'],
  ['white on a card\'s hard mode toggle and the Hard mode badge', WHITE, A.hard],
  ['the hard mode switch hint when it is on', A.muted, A['hard-soft']],
  ['the hard mode switch label when it is on', A.ink, A['hard-soft']],
  ['white on the scoreboard hero, purple end', WHITE, '#6a3df0'],
  ['the cheer on its night-sky pill', WHITE, '#0a0e2e'],
  ['practice clock before it starts: ink on paper', A.ink, A.paper],
  ['practice clock running: white on green', WHITE, A.good],
  ['practice clock paused: brown on soft amber', '#8a5300', A['ok-soft']],
  ['practice clock done: dark green on soft green', A['good-dark'], A['good-soft']],
  ['time\'s up heading on its card', A['good-dark'], A.paper],
  ['time\'s up message on its card', A.ink, A.paper],
  ['white on the time\'s up OK button', WHITE, A.good],
  ['admin muted text on the admin page', D.muted, D.bg],
  ['admin practice goal reached on its tint', D.good, '#e3f6ea'],
  ['admin practice no-practice dash on a card', D.muted, D.paper],
  ['admin practice today header', WHITE, D.accent],
  ['admin Published badge on a card', D.good, D.paper],
  ['admin Draft badge and Delete on a card', D.danger, D.paper],
  ['admin white on the Starter heading', WHITE, D.starter],
  ['admin white on the Explorer heading', WHITE, D.explorer],
  ['admin white on the Champion heading', WHITE, D.champion],
];

for (const [name, fg, bg] of PAIRS) {
  test(`contrast: ${name}`, () => {
    assert.ok(fg && bg, 'both colours are defined');
    const r = ratio(fg, bg);
    assert.ok(r >= 4.5, `${fg} on ${bg} is ${r.toFixed(2)}:1, under 4.5:1`);
  });
}

test('the literal colours the contrast checks rely on are the ones the stylesheet really uses', () => {
  for (const hex of ['#8a5300', '#5a35c9', '#ffc933', '#c2410c', '#c93a6e', '#6a3df0', '#0a0e2e']) {
    assert.ok(app.toLowerCase().includes(hex) || app.toLowerCase().includes(`rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`), `${hex} is in style.css`);
  }
});

test('the fireworks dim the page behind them so the sparks show', () => {
  const dim = /#fireworks\.on\s*\{\s*background:\s*rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(app);
  assert.ok(dim, 'a dark backdrop is set while the show is on');
  const [r, g, b, alpha] = dim.slice(1).map(Number);
  assert.ok(alpha >= 0.7, `backdrop is ${alpha} opaque`);
  const night = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  assert.ok(luminance(night) < 0.02, `${night} is dark`);
  // A bright spark on a white page is 1.0:1 to 2:1 at best. On the dimmed page it must stand out strongly.
  const dimmed = (channelValue) => Math.round(255 * (1 - alpha) + channelValue * alpha);
  const page = `#${[r, g, b].map((v) => dimmed(v).toString(16).padStart(2, '0')).join('')}`;
  assert.ok(ratio('#ffd24d', page) >= 7, `a gold spark on the dimmed page is ${ratio('#ffd24d', page).toFixed(1)}:1`);
});
