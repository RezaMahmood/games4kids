import test from 'node:test';
import assert from 'node:assert/strict';
import { createHardMode, isHard, parseHardChoices, setAll, setCard } from '../../games/letterjoin/play/web/hard-mode.js';

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};
const blocked = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};
const sentence = { id: 's', type: 'sentence' };
const paragraph = { id: 'p', type: 'paragraph' };
const words = { id: 'w', type: 'words' };
const letters = { id: 'l', type: 'letters' };
const off = { all: false, cards: {} };

test('hard mode is off until someone turns it on', () => {
  for (const activity of [sentence, paragraph, words, letters]) assert.equal(isHard(off, activity), false, activity.type);
});

test('the site-wide switch puts every sentence, paragraph and words card in hard mode, and never letters', () => {
  const on = setAll(off, true);
  assert.deepEqual([sentence, paragraph, words, letters].map((a) => isHard(on, a)), [true, true, true, false]);
  assert.equal(isHard(setCard(on, 'l', true), letters), false, 'not even when the letters card is set by hand');
});

test('a card toggle changes that card only, either way', () => {
  const one = setCard(off, 's', true);
  assert.deepEqual([isHard(one, sentence), isHard(one, words)], [true, false]);
  const allButOne = setCard(setAll(off, true), 's', false);
  assert.deepEqual([isHard(allButOne, sentence), isHard(allButOne, words)], [false, true]);
});

test('turning the site-wide switch clears every card set by hand', () => {
  const custom = setCard(setCard(setAll(off, true), 's', false), 'w', false);
  const again = setAll(setAll(custom, false), true);
  assert.deepEqual([sentence, paragraph, words].map((a) => isHard(again, a)), [true, true, true]);
  assert.deepEqual(again, { all: true, cards: {} });
});

test('a card set back to the site-wide choice is not stored as a choice of its own', () => {
  const back = setCard(setCard(off, 's', true), 's', false);
  assert.deepEqual(back, off);
  assert.deepEqual(setCard(setAll(off, true), 's', true), { all: true, cards: {} });
});

test('stored choices are read back, and junk turns hard mode off', () => {
  assert.deepEqual(parseHardChoices('{"all":true,"cards":{"s":false,"w":true,"x":"yes","y":1}}'), { all: true, cards: { s: false } });
  assert.deepEqual(parseHardChoices('{"cards":{"s":true}}'), { all: false, cards: { s: true } });
  assert.deepEqual(parseHardChoices('{"all":"yes","cards":[true]}'), off);
  for (const junk of [null, '', 'not json', '[]', 'null', '42', '"on"', '{"cards":null}']) assert.deepEqual(parseHardChoices(junk), off, String(junk));
  assert.equal(isHard(parseHardChoices('{"all":false,"cards":{"__proto__":true,"constructor":true}}'), { id: 'constructor', type: 'sentence' }), true);
  assert.equal(isHard(parseHardChoices('{"all":false}'), { id: 'toString', type: 'sentence' }), false, 'an id that names an object built-in is not a choice');
});

test('choices are remembered on the device', () => {
  const storage = memory();
  const first = createHardMode(() => storage, 'k');
  first.setAll(true);
  first.setCard('s', false);
  const reloaded = createHardMode(() => storage, 'k');
  assert.equal(reloaded.all(), true);
  assert.deepEqual([reloaded.isHard(sentence), reloaded.isHard(words)], [false, true]);
  assert.equal(createHardMode(() => storage, 'other').all(), false, 'another key starts with hard mode off');
});

test('blocked or failing storage still lets choices hold for the page', () => {
  const hard = createHardMode(blocked, 'k');
  assert.equal(hard.isHard(sentence), false);
  hard.setAll(true);
  hard.setCard('w', false);
  assert.deepEqual([hard.all(), hard.isHard(sentence), hard.isHard(words)], [true, true, false]);
  const full = { getItem: () => '{"all":true}', setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); } };
  const quota = createHardMode(() => full, 'k');
  quota.setCard('s', false);
  assert.deepEqual([quota.isHard(sentence), quota.isHard(paragraph)], [false, true]);
});

test('a device that has chosen nothing starts where the admin set the site-wide switch, and its own choice then wins', () => {
  const kept = new Map();
  const storage = { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const fresh = createHardMode(() => storage, 'k', true);
  assert.deepEqual([fresh.all(), fresh.isHard(sentence), fresh.isHard(words)], [true, true, true]);
  fresh.setAll(false);
  const later = createHardMode(() => storage, 'k', true);
  assert.deepEqual([later.all(), later.isHard(sentence)], [false, false], 'turning it off on this device sticks');
  assert.equal(createHardMode(() => ({ getItem: () => 'not json', setItem() {} }), 'k', true).all(), false, 'a stored value that makes no sense reads as off');
});
