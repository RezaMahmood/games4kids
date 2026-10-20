import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, LINE_SIZES, PAPERS } from '../../games/letterjoin/play/web/activity.js';
import { GRID_SCALE, IPAD_STAGE_WIDTH, MIN_X_HEIGHT, SCORING_BYTES_PER_CELL, SCORING_MEMORY_BOUND, SHEET_MAX_HEIGHT, SHEET_MAX_WIDTH, SHEET_MIN_WIDTH, SIZE_STEPS, X_HEIGHT, layoutSheet, stepSize, maskSize, paperGuides } from '../../games/letterjoin/play/web/sheet.js';

/** Metrics of the fallback font as Chrome measured them (Arial Rounded MT Bold): x-height 0.53 em, about 0.49 em per character. */
const rounded = { family: 'Rounded', xHeight: 0.53, ascent: 0.728, descent: 0.21, measure: (s) => s.length * 0.49 };
/** Wider and taller than any real Latin font, to find the worst case. */
const huge = { family: 'Huge', xHeight: 0.45, ascent: 1, descent: 0.45, measure: (s) => s.length * 1.1 };

const IPAD_LANDSCAPE = IPAD_STAGE_WIDTH.landscape;
const IPAD_PORTRAIT = IPAD_STAGE_WIDTH.portrait;
/** 168 words. */
const PASSAGE = 'The North Wind and the Sun disputed which was the stronger, when a traveller came along wrapped in a warm cloak. '.repeat(8).trim();

test('the rendered x-height comes from the line size, whatever the font', () => {
  for (const lineSize of LINE_SIZES) {
    for (const face of [rounded, { ...rounded, xHeight: 0.62 }]) {
      const layout = layoutSheet('cat', { width: IPAD_LANDSCAPE, face, lineSize });
      assert.equal(layout.xHeight, X_HEIGHT[lineSize]);
      assert.ok(Math.abs(layout.fontSize * face.xHeight - X_HEIGHT[lineSize]) < 0.01, `${lineSize} at x-height ratio ${face.xHeight}`);
      assert.match(layout.font, new RegExp(`^${layout.fontSize}px ${face.family}$`));
    }
  }
  assert.ok(X_HEIGHT.small < X_HEIGHT.medium && X_HEIGHT.medium < X_HEIGHT.large);
});

test('the child\'s size scales the line size, a step at a time, and stops at the ends', () => {
  for (const lineSize of LINE_SIZES) {
    const layouts = SIZE_STEPS.map((size) => layoutSheet('cat', { width: IPAD_LANDSCAPE, face: rounded, lineSize, size }));
    assert.deepEqual(layouts.map((l) => l.xHeight), SIZE_STEPS.map((size) => Math.round(X_HEIGHT[lineSize] * size)), lineSize);
    layouts.slice(1).forEach((l, i) => assert.ok(l.fontSize > layouts[i].fontSize, `${lineSize}: each step is bigger`));
  }
  assert.equal(layoutSheet('cat', { width: IPAD_LANDSCAPE, face: rounded, lineSize: 'medium' }).xHeight, X_HEIGHT.medium, 'no size is 1');
  assert.equal(stepSize(1, 1), 1.25);
  assert.equal(stepSize(1, -1), 0.875);
  assert.equal(stepSize(SIZE_STEPS[0], -1), SIZE_STEPS[0]);
  assert.equal(stepSize(SIZE_STEPS.at(-1), 1), SIZE_STEPS.at(-1));
  assert.equal(stepSize(3, 1), 1.25, 'a size that is not a step starts again from 1');
  assert.ok(SIZE_STEPS.every((size) => Math.round(X_HEIGHT.small * size) >= MIN_X_HEIGHT));
});

test('a line break in the text is always a new line, and a blank line is kept', () => {
  const layout = layoutSheet('Rain fell.\nThe garden drank.\n\nSoon.', { width: IPAD_LANDSCAPE, face: rounded, lineSize: 'medium' });
  assert.deepEqual(layout.lines.map((l) => l.text), ['Rain fell.', 'The garden drank.', '', 'Soon.']);
});

test('long text wraps at spaces inside the margins and the lines stack at one pitch', () => {
  const layout = layoutSheet(PASSAGE, { width: IPAD_PORTRAIT, face: rounded, lineSize: 'medium' });
  const maxWidth = layout.width - 2 * layout.padX;
  assert.ok(layout.lines.length > 20, `${layout.lines.length} lines`);
  for (const line of layout.lines) {
    assert.ok(rounded.measure(line.text) * layout.fontSize <= maxWidth, line.text);
    assert.equal(line.text, line.text.trim());
  }
  assert.equal(layout.lines.map((l) => l.text).join(' '), PASSAGE.replace(/\s+/g, ' '), 'no word is lost or split');
  layout.lines.slice(1).forEach((line, i) => assert.ok(Math.abs(line.baseline - layout.lines[i].baseline - layout.lineHeight) < 1e-9));
  assert.ok(layout.lineHeight > layout.ascent + layout.descent, 'lines never overlap');
  assert.ok(layout.lines[0].baseline - layout.ascent > 0, 'the first line clears the top');
  assert.ok(layout.lines.at(-1).baseline + layout.descent < layout.height, 'the sheet ends below the last descender');
});

test('a word wider than the line breaks between letters', () => {
  const layout = layoutSheet('x'.repeat(200), { width: SHEET_MIN_WIDTH, face: rounded, lineSize: 'large' });
  assert.ok(layout.lines.length > 1);
  assert.equal(layout.lines.map((l) => l.text).join(''), 'x'.repeat(200));
});

test('the sheet is laid out at the stage width, between a minimum and a maximum', () => {
  assert.equal(layoutSheet('a', { width: IPAD_LANDSCAPE, face: rounded, lineSize: 'medium' }).width, IPAD_LANDSCAPE);
  assert.equal(layoutSheet('a', { width: IPAD_PORTRAIT, face: rounded, lineSize: 'medium' }).width, IPAD_PORTRAIT);
  assert.equal(layoutSheet('a', { width: 320, face: rounded, lineSize: 'medium' }).width, SHEET_MIN_WIDTH);
  assert.equal(layoutSheet('a', { width: 2560, face: rounded, lineSize: 'medium' }).width, SHEET_MAX_WIDTH);
});

test('a 170 word passage fits on an 11 inch iPad sheet at its chosen size', () => {
  for (const width of [IPAD_LANDSCAPE, IPAD_PORTRAIT]) {
    for (const lineSize of LINE_SIZES) {
      const layout = layoutSheet(PASSAGE, { width, face: rounded, lineSize });
      assert.equal(layout.xHeight, X_HEIGHT[lineSize], `${width} ${lineSize} keeps its size (${layout.height} px tall)`);
    }
  }
});

test('the longest allowed text stays inside the sheet and scoring memory bound, even in an oversized font', () => {
  const longest = 'W'.repeat(LIMITS.paragraph);
  for (const face of [rounded, huge]) {
    for (const lineSize of LINE_SIZES) {
      for (const size of [1, SIZE_STEPS.at(-1)]) {
        const layout = layoutSheet(longest, { width: SHEET_MIN_WIDTH, face, lineSize, size });
        assert.ok(layout.height <= SHEET_MAX_HEIGHT, `${face.family} ${lineSize} at ${size}: ${layout.height} px`);
        assert.ok(layout.xHeight >= MIN_X_HEIGHT);
        const { width, height } = maskSize(layout);
        assert.ok(width * height * SCORING_BYTES_PER_CELL <= SCORING_MEMORY_BOUND);
      }
    }
  }
  assert.deepEqual(maskSize({ width: SHEET_MAX_WIDTH, height: SHEET_MAX_HEIGHT }), { width: SHEET_MAX_WIDTH * GRID_SCALE, height: SHEET_MAX_HEIGHT * GRID_SCALE });
  assert.equal(SCORING_MEMORY_BOUND, 700 * 8000 * 10, 'at most 56 MB of scoring buffers');
});

test('text that would run past the maximum height is set smaller instead', () => {
  const longest = 'W'.repeat(LIMITS.paragraph);
  const layout = layoutSheet(longest, { width: SHEET_MIN_WIDTH, face: huge, lineSize: 'large' });
  assert.ok(layout.xHeight < X_HEIGHT.large, `shrunk to x-height ${layout.xHeight}`);
});

test('each paper draws its own guide lines for every line of text', () => {
  const layout = layoutSheet('one\ntwo\nthree', { width: IPAD_LANDSCAPE, face: rounded, lineSize: 'medium' });
  const kinds = (paper) => {
    const { rules } = paperGuides(layout, paper);
    const perLine = rules.length / layout.lines.length;
    return rules.slice(perLine, 2 * perLine).map((r) => r.kind);
  };
  assert.deepEqual(kinds('baseline'), ['baseline']);
  assert.deepEqual(kinds('threeLine'), ['ascender', 'xLine', 'baseline']);
  assert.deepEqual(kinds('fourLine'), ['ascender', 'xLine', 'baseline', 'descender']);
  assert.deepEqual(kinds('highlighted'), ['xLine', 'baseline']);
  for (const paper of PAPERS) assert.equal(paperGuides(layout, paper).rules.length % layout.lines.length, 0, `${paper} repeats per line`);

  const four = paperGuides(layout, 'fourLine').rules.slice(0, 4).map((r) => r.y);
  const base = layout.lines[0].baseline;
  assert.deepEqual(four, [base - layout.ascent, base - layout.xHeight, base, base + layout.descent]);
  assert.ok(four[0] < four[1] && four[1] < four[2] && four[2] < four[3]);
});

test('highlighted paper shades the x-height band of each line', () => {
  const layout = layoutSheet('one\ntwo', { width: IPAD_LANDSCAPE, face: rounded, lineSize: 'large' });
  assert.deepEqual(paperGuides(layout, 'highlighted').bands, layout.lines.map((l) => ({ y: l.baseline - 52, height: 52 })));
  for (const paper of ['baseline', 'threeLine', 'fourLine']) assert.deepEqual(paperGuides(layout, paper).bands, []);
});
