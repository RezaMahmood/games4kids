import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_STYLES } from '../../games/letterjoin/play/web/activity.js';
import { FALLBACK_FAMILY, FONT_REGISTRY, fontSources, resolveFont, startingStyle } from '../../games/letterjoin/play/web/fonts.js';

function fakeFonts({ present }) {
  const added = [];
  class FakeFontFace {
    constructor(family, source) {
      this.family = family;
      this.source = source;
    }
    async load() {
      if (this.source.includes(',')) return new Promise(() => {});
      if (!present.some((file) => this.source.includes(file))) throw new Error('NetworkError');
      return this;
    }
  }
  return { added, env: { FontFace: FakeFontFace, fonts: { add: (face) => added.push(face) } } };
}

test('every letter style has a font entry with a label', () => {
  assert.deepEqual(Object.keys(FONT_REGISTRY).sort(), [...LETTER_STYLES].sort());
  for (const style of LETTER_STYLES) assert.ok(FONT_REGISTRY[style].label && FONT_REGISTRY[style].family, style);
});

test('a style with no font file falls back to the rounded print font, and joined to the open font first', async () => {
  const { added, env } = fakeFonts({ present: [] });
  for (const style of ['print', 'precursive']) {
    assert.deepEqual(await resolveFont(style, env), { family: FALLBACK_FAMILY, custom: false }, style);
  }
  assert.equal(added.length, 0, 'nothing is registered when no file loads');
});

test('joined uses the open Playwrite GB J font when the owner has supplied none', async () => {
  const { added, env } = fakeFonts({ present: ['open-fonts/PlaywriteGBJ.ttf'] });
  assert.deepEqual(await resolveFont('joined', env), { family: `"Letterjoin Joined", ${FALLBACK_FAMILY}`, custom: true });
  assert.equal(added.length, 1);
});

test('a font file the owner dropped in web/fonts is loaded and used first, with the fallback behind it', async () => {
  const { added, env } = fakeFonts({ present: ['fonts/joined.'] });
  const joined = await resolveFont('joined', env);
  assert.deepEqual(joined, { family: `"Letterjoin Joined", ${FALLBACK_FAMILY}`, custom: true });
  assert.deepEqual(added.map((f) => f.family), ['Letterjoin Joined']);
  assert.equal((await resolveFont('print', env)).custom, false, 'other styles still fall back');
});

test('each style looks for woff2, woff, otf and ttf files named after it, one source per load', () => {
  assert.deepEqual(fontSources('print'), ['woff2', 'woff', 'otf', 'ttf'].map((ext) => `url(fonts/print.${ext}) format("${{ otf: 'opentype', ttf: 'truetype' }[ext] ?? ext}")`));
  assert.equal(fontSources('joined').at(-1), 'url(open-fonts/PlaywriteGBJ.ttf) format("truetype")');
});

test('an attempt starts in the style this device last picked, if the activity offers it', () => {
  const all = { letterStyle: 'print', allowedStyles: ['print', 'precursive', 'joined'] };
  assert.equal(startingStyle(all, 'joined'), 'joined');
  assert.equal(startingStyle(all, null), 'joined', 'nothing remembered: joined, whatever the activity default is');
  assert.equal(startingStyle({ letterStyle: 'print', allowedStyles: ['print', 'precursive'] }, null), 'print', 'joined not offered: the activity default');
  assert.equal(startingStyle({ letterStyle: 'precursive', allowedStyles: ['precursive', 'print'] }, 'joined'), 'precursive', 'not offered: the activity default');
  assert.equal(startingStyle(all, 'print'), 'print', 'a remembered choice still wins');
  assert.equal(startingStyle(all, 'toString'), 'joined', 'junk in storage is ignored');
});
