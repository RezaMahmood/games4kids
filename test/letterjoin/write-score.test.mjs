import test from 'node:test';
import assert from 'node:assert/strict';
import { padGeometry } from '../../games/letterjoin/play/web/write-pad.js';
import { alignWords, guidelineFit, textWords, writeScore } from '../../games/letterjoin/play/web/write-score.js';

const SENTENCE = textWords('The cat sat on the mat.');
const statuses = (alignment) => alignment.words.map((w) => w.status);

test('every word read right is correct, and the whole text is reached', () => {
  const a = alignWords(SENTENCE, ['The', 'cat', 'sat', 'on', 'the', 'mat.']);
  assert.deepEqual(statuses(a), Array(6).fill('correct'));
  assert.deepEqual([a.reached, a.extra], [6, []]);
});

test('a misspelt word is misread, with the text that was read', () => {
  const a = alignWords(textWords('Our mischievous neighbour tried'), ['Our', 'mischevous', 'nieghbour', 'tried']);
  assert.deepEqual(statuses(a), ['correct', 'misread', 'misread', 'correct']);
  assert.deepEqual(a.words.map((w) => w.read), ['Our', 'mischevous', 'nieghbour', 'tried']);
});

test('a skipped word is missing and the words after it still line up', () => {
  const a = alignWords(SENTENCE, ['The', 'cat', 'on', 'the', 'mat']);
  assert.deepEqual(statuses(a), ['correct', 'correct', 'missing', 'correct', 'correct', 'correct']);
  assert.equal(a.words[2].read, null);
});

test('an extra word is listed apart and does not shift the others', () => {
  const a = alignWords(SENTENCE, ['The', 'big', 'cat', 'sat', 'on', 'the', 'mat']);
  assert.deepEqual(statuses(a), Array(6).fill('correct'));
  assert.deepEqual(a.extra, [{ text: 'big', readIndex: 1 }]);
});

test('case, curly apostrophes and punctuation around a word do not matter, and lone punctuation is ignored', () => {
  const a = alignWords(textWords("Don't stop, Sam!"), ['don’t', '.', 'STOP', '"sam"']);
  assert.deepEqual(statuses(a), ['correct', 'correct', 'correct']);
  assert.deepEqual(a.words.map((w) => w.readIndex), [0, 2, 3], 'each word points at its place in the words read');
  assert.deepEqual(a.extra, []);
});

test('a partial attempt lines up with the start of the text and leaves the rest unreached', () => {
  const a = alignWords(SENTENCE, ['The', 'cat']);
  assert.equal(a.reached, 2);
  assert.deepEqual(statuses(a).slice(0, 2), ['correct', 'correct']);
  assert.deepEqual(a.extra, []);
  const b = alignWords(SENTENCE, ['The', 'cat', 'sot']);
  assert.equal(b.reached, 3, 'a garbled last word counts as an attempt at the next word');
  assert.deepEqual([b.words[2].status, b.words[2].read], ['misread', 'sot']);
  assert.deepEqual(alignWords(SENTENCE, []), { words: SENTENCE.map((expected) => ({ expected, status: 'missing', read: null, readIndex: null })), extra: [], reached: 0 });
});

const g = padGeometry({ width: 1000, xHeight: 40 });
/** A downstroke at x on `line`, from `from` to `to` (offsets within the line), as five evenly spaced points. */
const down = (x, line, from, to) => ({ line, points: [0, 1, 2, 3, 4].map((k) => ({ x, y: line * g.lineHeight + from + ((to - from) * k) / 4, t: 0 })) });
const xLine = g.baseline - g.xHeight;
/** Three x-height letters standing on the baseline, starting at x. */
const word = (x, line, lift = 0) => [0, 15, 30].map((dx) => down(x + dx, line, xLine - lift, g.baseline - lift));

test('letters standing on the baseline fit perfectly, on any line, dots and cross-bars included', () => {
  const iDot = down(20, 0, xLine - 15, xLine - 10);
  assert.equal(guidelineFit([...word(0, 0), iDot, ...word(300, 0), ...word(0, 1)], g), 1);
});

test('letters floating half an x-height above the baseline lose the baseline half of the fit', () => {
  const fit = guidelineFit(word(0, 0, g.xHeight / 2), g);
  assert.equal(fit, 0.5, 'still inside the lines, but the letters do not stand on the baseline');
});

test('ink running down into the next line counts against the fit for the points outside the lines', () => {
  const tail = down(15, 0, g.baseline, g.descender + 2 * g.xHeight);
  const fit = guidelineFit([down(0, 0, xLine, g.baseline), tail], g);
  assert.equal(fit, (7 / 10 + 1) / 2, '3 of 10 points are below the descender line; the letter stands on the baseline');
});

test('descenders are not penalised', () => {
  const bowls = [down(0, 0, xLine, g.baseline), down(25, 0, xLine, g.baseline)];
  const tails = [down(10, 0, g.baseline - 5, g.descender), down(35, 0, g.baseline - 5, g.descender)];
  assert.equal(guidelineFit([...bowls, ...tails], g), 1);
});

test('no ink fits nothing', () => {
  assert.equal(guidelineFit([], g), 0);
});

test('the score weighs words read right 60% and the guide lines 40%, or the lines alone when reading failed', () => {
  const alignment = alignWords(SENTENCE, ['The', 'cat', 'sot', 'on', 'the', 'mat']);
  assert.deepEqual(writeScore({ alignment, fit: 0.8, readable: true }), { score: 82, correct: 5, expected: 6, basis: 'readingAndLines' });
  assert.deepEqual(writeScore({ alignment, fit: 0.8, readable: false }), { score: 80, correct: 5, expected: 6, basis: 'linesOnly' });
  assert.equal(writeScore({ alignment: alignWords(SENTENCE, ['The', 'cat']), fit: 1, readable: true }).score, 60, 'words never written count against the score at the end');
});
