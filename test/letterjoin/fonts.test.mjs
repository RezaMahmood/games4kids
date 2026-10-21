import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { LETTER_STYLES } from '../../games/letterjoin/play/web/activity.js';
import { FALLBACK_FAMILY, FONT_REGISTRY, resolveFont, startingStyle } from '../../games/letterjoin/play/web/fonts.js';

function fakeFonts({ present }) {
  const faces = [];
  class FakeFontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      faces.push(this);
    }
    async load() {
      if (!present.some((file) => this.source.includes(file))) throw new Error('NetworkError');
      return this;
    }
  }
  const added = [];
  return { added, faces, env: { FontFace: FakeFontFace, fonts: { add: (face) => added.push(face) } } };
}

const everyFile = Object.values(FONT_REGISTRY).map(({ file }) => file);

test('every letter style has a font entry with a label', () => {
  assert.deepEqual(Object.keys(FONT_REGISTRY).sort(), [...LETTER_STYLES].sort());
  for (const style of LETTER_STYLES) assert.ok(FONT_REGISTRY[style].label && FONT_REGISTRY[style].family, style);
});

test('every registered font file is committed where the page loads it', () => {
  for (const { file } of Object.values(FONT_REGISTRY)) {
    assert.ok(existsSync(new URL(`../../games/letterjoin/play/web/open-fonts/${file}`, import.meta.url)), file);
  }
});

test('print and joined are different fonts, and pre-cursive is its own family so it never collides with joined', () => {
  assert.equal(FONT_REGISTRY.print.file, 'Andika-Regular.ttf');
  assert.equal(FONT_REGISTRY.joined.file, 'PlaywriteGBJ.ttf');
  assert.equal(new Set(Object.values(FONT_REGISTRY).map(({ family }) => family)).size, 3);
});

test('each style loads its own committed file under its own family', async () => {
  const { added, env } = fakeFonts({ present: everyFile });
  for (const style of LETTER_STYLES) {
    const { family, file } = FONT_REGISTRY[style];
    assert.deepEqual(await resolveFont(style, env), { family: `"${family}", ${FALLBACK_FAMILY}`, custom: true }, style);
    assert.equal(added.at(-1).family, family);
    assert.equal(added.at(-1).source, `url(open-fonts/${file})`);
  }
});

test('pre-cursive turns contextual alternates off so its letters stay unjoined, and the other styles do not', async () => {
  const { added, env } = fakeFonts({ present: everyFile });
  for (const style of LETTER_STYLES) await resolveFont(style, env);
  const byFamily = Object.fromEntries(added.map((face) => [face.family, face.descriptors]));
  assert.deepEqual(byFamily['Letterjoin Precursive'], { featureSettings: '"calt" 0' });
  assert.equal(byFamily['Letterjoin Print'], undefined);
  assert.equal(byFamily['Letterjoin Joined'], undefined);
});

test('a font that fails to load falls back to the rounded print font and registers nothing', async () => {
  const { added, env } = fakeFonts({ present: [] });
  for (const style of LETTER_STYLES) {
    assert.deepEqual(await resolveFont(style, env), { family: FALLBACK_FAMILY, custom: false }, style);
  }
  assert.equal(added.length, 0);
});

test('a style whose own file is missing falls back without borrowing another style\'s font', async () => {
  const { env } = fakeFonts({ present: ['PlaywriteGBJ.ttf'] });
  assert.equal((await resolveFont('print', env)).custom, false);
  assert.equal((await resolveFont('joined', env)).custom, true);
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
