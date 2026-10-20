/**
 * The tracing sheet: one tall page of guide lines with the text laid out once. Pure, so it runs under node:test
 * with a fake face. Sheet units are CSS pixels at the width the sheet was laid out for; strokes are stored in
 * them, so scrolling, rotating and resizing only change how the sheet is shown.
 *
 * @typedef {import('./activity.js').Paper} Paper
 * @typedef {import('./activity.js').LineSize} LineSize
 * @typedef {Pick<import('./fonts.js').Face, 'family' | 'xHeight' | 'ascent' | 'descent' | 'measure'>} Face
 * @typedef {{ text: string, baseline: number }} SheetLine
 * @typedef {{ width: number, height: number, padX: number, font: string, fontSize: number, xHeight: number, ascent: number, descent: number, lineHeight: number, lines: SheetLine[] }} Layout
 */

/** Target x-height per line size, in CSS px. On an 11 inch iPad (132 CSS px per inch) that is about 6, 8 and 10 mm. */
export const X_HEIGHT = { small: 32, medium: 40, large: 52 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const MIN_X_HEIGHT = 20;

/** The child's letter size, as a multiple of the admin's line size. 1 is the line size as set. */
export const SIZE_STEPS = [0.75, 0.875, 1, 1.25, 1.5, 1.75, 2];

/**
 * The size one step smaller (`-1`) or bigger (`1`), staying at the ends. A size that is not a step, such as a
 * stale value kept on the device, counts as 1.
 * @param {number} size @param {-1 | 1} by
 */
export function stepSize(size, by) {
  const at = SIZE_STEPS.includes(size) ? SIZE_STEPS.indexOf(size) : SIZE_STEPS.indexOf(1);
  return SIZE_STEPS[clamp(at + by, 0, SIZE_STEPS.length - 1)];
}

/** The stage width on an 11 inch iPad (1194 x 834 CSS px), less the stage margins. */
export const IPAD_STAGE_WIDTH = { landscape: 1158, portrait: 798 };
export const SHEET_MIN_WIDTH = 600;
export const SHEET_MAX_WIDTH = 1400;
/** Text that would run longer than this is set smaller, which bounds the scoring memory for any allowed text. */
export const SHEET_MAX_HEIGHT = 16000;

/** Scoring works on a grid at half the sheet resolution. */
export const GRID_SCALE = 0.5;
/** Per grid cell while scoring: the mask (Uint8), its distance field (Float32), the ink (Uint8) and its distance field (Float32). */
export const SCORING_BYTES_PER_CELL = 1 + 4 + 1 + 4;

const MARGIN = 0.05;
const GAP = 0.6;
const PAD_TOP = 0.8;
const PAD_BOTTOM = 1.5;


/** Words wrap at spaces, a `\n` is a hard break, and a word wider than the line breaks between letters. */
export function wrap(text, maxWidth, measure) {
  const lines = [];
  for (const hardLine of text.split('\n')) {
    let line = '';
    for (const word of hardLine.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && measure(line + ch) > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** @returns {Layout} */
function place(text, width, face, xHeight) {
  const fontSize = Math.round((xHeight / face.xHeight) * 100) / 100;
  const padX = Math.round(width * MARGIN);
  const texts = wrap(text, width - 2 * padX, (s) => face.measure(s) * fontSize);
  const ascent = face.ascent * fontSize;
  const descent = face.descent * fontSize;
  const lineHeight = ascent + descent + GAP * xHeight;
  const top = PAD_TOP * xHeight + ascent;
  const lines = texts.map((t, i) => ({ text: t, baseline: top + i * lineHeight }));
  const height = Math.ceil(lines[lines.length - 1].baseline + descent + PAD_BOTTOM * xHeight);
  return { width, height, padX, font: `${fontSize}px ${face.family}`, fontSize, xHeight, ascent, descent, lineHeight, lines };
}

/**
 * Lays the text out once for a stage `width` CSS px wide, at the x-height the line size asks for times the child's `size`.
 * @param {string} text
 * @param {{ width: number, face: Face, lineSize: LineSize, size?: number }} options
 * @returns {Layout}
 */
export function layoutSheet(text, { width, face, lineSize, size = 1 }) {
  const sheetWidth = clamp(Math.round(width), SHEET_MIN_WIDTH, SHEET_MAX_WIDTH);
  for (let xHeight = Math.max(MIN_X_HEIGHT, Math.round(X_HEIGHT[lineSize] * size)); ; xHeight = Math.max(MIN_X_HEIGHT, xHeight - 2)) {
    const layout = place(text, sheetWidth, face, xHeight);
    if (layout.height <= SHEET_MAX_HEIGHT || xHeight === MIN_X_HEIGHT) return layout;
  }
}

/** Which guide lines each paper draws, as offsets from the baseline. */
const RULES = {
  ascender: (l) => -l.ascent,
  xLine: (l) => -l.xHeight,
  baseline: () => 0,
  descender: (l) => l.descent,
};
/** @type {Record<Paper, { rules: (keyof typeof RULES)[], band: boolean }>} */
const PAPER = {
  baseline: { rules: ['baseline'], band: false },
  threeLine: { rules: ['ascender', 'xLine', 'baseline'], band: false },
  fourLine: { rules: ['ascender', 'xLine', 'baseline', 'descender'], band: false },
  highlighted: { rules: ['xLine', 'baseline'], band: true },
};

/**
 * @param {Layout} layout
 * @param {Paper} paper
 * @returns {{ rules: { kind: keyof typeof RULES, y: number }[], bands: { y: number, height: number }[] }}
 */
export function paperGuides(layout, paper) {
  const { rules, band } = PAPER[paper];
  return {
    rules: layout.lines.flatMap((line) => rules.map((kind) => ({ kind, y: line.baseline + RULES[kind](layout) }))),
    bands: band ? layout.lines.map((line) => ({ y: line.baseline - layout.xHeight, height: layout.xHeight })) : [],
  };
}

/** @param {{ width: number, height: number }} layout */
export const maskSize = (layout) => ({ width: Math.ceil(layout.width * GRID_SCALE), height: Math.ceil(layout.height * GRID_SCALE) });

/** The most memory scoring can take for any sheet, in bytes. */
export const SCORING_MEMORY_BOUND = (() => {
  const { width, height } = maskSize({ width: SHEET_MAX_WIDTH, height: SHEET_MAX_HEIGHT });
  return width * height * SCORING_BYTES_PER_CELL;
})();
