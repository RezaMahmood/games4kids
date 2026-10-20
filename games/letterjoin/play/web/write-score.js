import { wordGap } from './write-pad.js';

/**
 * How the "write it yourself" view scores the writing: how much of it the app could read as the right words, and
 * how well it sits on the guide lines. Pure.
 * @typedef {'correct' | 'misread' | 'missing'} WordStatus
 * `read` is the text read for this word and `readIndex` its place in the read words, or null when it is missing.
 * @typedef {{ expected: string, status: WordStatus, read: string | null, readIndex: number | null }} AlignedWord
 * Expected words from `reached` on come after the last word read: the part not written yet, or never written.
 * @typedef {{ words: AlignedWord[], extra: { text: string, readIndex: number }[], reached: number }} Alignment
 * @typedef {import('./write-pad.js').PadGeometry} PadGeometry
 * @typedef {import('./write-pad.js').PadStroke} PadStroke
 */

/** How a word is compared: case, curly apostrophes and the punctuation around it do not matter. */
export function normaliseWord(word) {
  return word.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** The words of a text as the child sees them, leaving out anything that is only punctuation. */
export const textWords = (text) => text.split(/\s+/).filter((w) => normaliseWord(w) !== '');

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const MATCH = 2;
const GAP = -1;
/** A read word in the place of an expected one scores between -1 and 1 by how alike they are, so it beats a skip plus an extra (-2). */
const pairScore = (a, b) => (a === b ? MATCH : 2 * (1 - editDistance(a, b) / Math.max(a.length, b.length)) - 1);

/**
 * Lines up the words read with the words expected (Needleman-Wunsch). It is semi-global: every read word must be
 * placed, but expected words after the last one read cost nothing, so a partial attempt lines up with the start
 * of the text.
 * @param {string[]} expected
 * @param {string[]} read
 * @returns {Alignment}
 */
export function alignWords(expected, read) {
  const exp = expected.map(normaliseWord);
  const kept = read.map((text, readIndex) => ({ text, readIndex, norm: normaliseWord(text) })).filter((w) => w.norm !== '');
  const n = exp.length;
  const m = kept.length;
  const score = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j * GAP : j === 0 ? i * GAP : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      score[i][j] = Math.max(score[i - 1][j - 1] + pairScore(exp[i - 1], kept[j - 1].norm), score[i - 1][j] + GAP, score[i][j - 1] + GAP);
    }
  }
  // On a tie the later end wins, so a garbled last word counts as a misread of the next word rather than an extra.
  let reached = 0;
  for (let i = 1; i <= n; i++) if (score[i][m] >= score[reached][m]) reached = i;

  /** @type {AlignedWord[]} */
  const words = expected.map((w) => ({ expected: w, status: 'missing', read: null, readIndex: null }));
  const extra = [];
  let i = reached;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && score[i][j] === score[i - 1][j - 1] + pairScore(exp[i - 1], kept[j - 1].norm)) {
      const { text, readIndex, norm } = kept[j - 1];
      words[i - 1] = { expected: expected[i - 1], status: norm === exp[i - 1] ? 'correct' : 'misread', read: text, readIndex };
      i--;
      j--;
    } else if (i > 0 && score[i][j] === score[i - 1][j] + GAP) {
      i--;
    } else {
      extra.unshift({ text: kept[j - 1].text, readIndex: kept[j - 1].readIndex });
      j--;
    }
  }
  return { words, extra, reached };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const extent = (stroke, axis) => {
  const values = stroke.points.map((p) => p[axis]);
  return { min: Math.min(...values), max: Math.max(...values) };
};

/** Strokes of one line as words: sorted left to right, split where the gap is wider than a space. */
function wordsOf(strokes, geometry) {
  const sorted = [...strokes].sort((a, b) => extent(a, 'x').min - extent(b, 'x').min);
  const words = [];
  let right = -Infinity;
  for (const stroke of sorted) {
    const { min, max } = extent(stroke, 'x');
    if (min - right > wordGap(geometry)) words.push([]);
    words.at(-1).push(stroke);
    right = Math.max(right, max);
  }
  return words;
}

/**
 * How well one word sits on its line, from 0 to 1: the mean of the share of its points between the ascender and
 * descender lines, and how close its letters stand to the baseline.
 * @param {PadStroke[]} word @param {PadGeometry} geometry
 */
function wordFit(word, geometry) {
  const top = word[0].line * geometry.lineHeight;
  const tolerance = 0.25 * geometry.xHeight;
  const points = word.flatMap((s) => s.points);
  const inBand = points.filter((p) => p.y >= top + geometry.ascender - tolerance && p.y <= top + geometry.descender + tolerance).length / points.length;
  const baseline = top + geometry.baseline;
  // Descenders go below the baseline on purpose, and dots and cross-bars sit above it, so neither says where the letters stand.
  const standing = word.filter((s) => {
    const { min, max } = extent(s, 'y');
    return max <= baseline + 0.5 * (geometry.descender - geometry.baseline) && max - min >= 0.5 * geometry.xHeight;
  });
  if (standing.length === 0) return inBand;
  const off = Math.abs(median(standing.map((s) => extent(s, 'y').max)) - baseline) / geometry.xHeight;
  return (inBand + Math.max(0, 1 - off / 0.5)) / 2;
}

/**
 * How well the writing sits on the guide lines, from 0 to 1: the mean over its words.
 * @param {PadStroke[]} strokes @param {PadGeometry} geometry
 */
export function guidelineFit(strokes, geometry) {
  const lines = new Map();
  for (const s of strokes) if (s.points.length) lines.set(s.line, [...(lines.get(s.line) ?? []), s]);
  const words = [...lines.values()].flatMap((line) => wordsOf(line, geometry));
  return words.length ? mean(words.map((w) => wordFit(w, geometry))) : 0;
}

/**
 * The score out of 100. When the writing could not be read, it is the guide lines alone and `basis` says so.
 * @param {{ alignment: Alignment, fit: number, readable: boolean }} input
 * @returns {{ score: number, correct: number, expected: number, basis: 'readingAndLines' | 'linesOnly' }}
 */
export function writeScore({ alignment, fit, readable }) {
  const expected = alignment.words.length;
  const correct = alignment.words.filter((w) => w.status === 'correct').length;
  if (!readable) return { score: Math.round(100 * fit), correct, expected, basis: 'linesOnly' };
  return { score: Math.round(100 * (0.6 * (expected ? correct / expected : 0) + 0.4 * fit)), correct, expected, basis: 'readingAndLines' };
}
