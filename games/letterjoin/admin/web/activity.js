// Shared by the browser and the Function App. api/src/activity.js must stay a byte-for-byte copy.

/**
 * @typedef {'draft' | 'published'} Status
 * `traceThenCopy` asks for an unaided copy after the trace. The copy is saved for review, never scored.
 * @typedef {'trace' | 'traceThenCopy'} Mode
 * @typedef {{ type: 'letters', sequence: string[], repeat: number }} LettersBody
 * @typedef {{ type: 'words', category: string, words: string[] }} WordsBody
 * @typedef {{ type: 'sentence', text: string }} SentenceBody
 * @typedef {{ type: 'paragraph', text: string }} ParagraphBody
 * @typedef {LettersBody | WordsBody | SentenceBody | ParagraphBody} Body
 * @typedef {Body['type']} ActivityType
 * @typedef {'starter' | 'explorer' | 'champion'} Level
 * @typedef {'print' | 'precursive' | 'joined'} LetterStyle
 * @typedef {'baseline' | 'threeLine' | 'fourLine' | 'highlighted'} Paper
 * @typedef {'small' | 'medium' | 'large'} LineSize
 * How the sheet looks. `letterStyle` is the default the child starts with and is always one of `allowedStyles`.
 * @typedef {{ letterStyle: LetterStyle, allowedStyles: LetterStyle[], paper: Paper, lineSize: LineSize }} Look
 * What an admin submits. The server owns everything else. A null timeLimitSec means untimed.
 * @typedef {Body & Look & { title: string, description: string, status: Status, timeLimitSec: number | null, mode: Mode, level: Level }} ActivityInput
 * @typedef {ActivityInput & { id: string, order: number, updatedAt: string }} Activity
 * @typedef {{ ok: true, value: ActivityInput } | { ok: false, problems: string[] }} InputResult
 * @typedef {{ ok: true, value: Activity } | { ok: false, problems: string[] }} ActivityResult
 */

export const LIMITS = {
  title: 80,
  description: 200,
  category: 40,
  sequence: 26,
  tokenLength: 3,
  repeat: 20,
  tokens: 60,
  words: 30,
  wordLength: 30,
  sentence: 200,
  paragraph: 2000,
  minTimeSec: 5,
  maxTimeSec: 3600,
};
export const STATUSES = ['draft', 'published'];
/** @type {Mode[]} */
export const MODES = ['trace', 'traceThenCopy'];
/** @type {LetterStyle[]} */
export const LETTER_STYLES = ['print', 'precursive', 'joined'];
/** @type {Paper[]} */
export const PAPERS = ['baseline', 'threeLine', 'fourLine', 'highlighted'];
/** @type {LineSize[]} */
export const LINE_SIZES = ['small', 'medium', 'large'];
/**
 * How hard an activity is, by the age it suits. Lists are grouped in this order, and each level has its own colour in the app.
 * @type {Level[]}
 */
export const LEVELS = ['starter', 'explorer', 'champion'];
/** @type {Record<Level, { label: string, ages: string, blurb: string }>} */
export const LEVEL_INFO = {
  starter: { label: 'Starter', ages: 'Ages 8 to 9', blurb: 'Warm-ups and everyday tricky words' },
  explorer: { label: 'Explorer', ages: 'Ages 9 to 10', blurb: 'Longer words, sentences and short passages' },
  champion: { label: 'Champion', ages: 'Ages 10 to 11', blurb: 'The hardest words and longer passages' },
};
/** What an activity stored without a level reads as. */
export const DEFAULT_LEVEL = 'explorer';
/** What an activity stored before these fields existed reads as. */
export const DEFAULT_LOOK = Object.freeze({ letterStyle: 'print', allowedStyles: LETTER_STYLES, paper: 'fourLine', lineSize: 'medium' });

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const TOKEN = new RegExp(`^[\\p{L}\\p{N}]{1,${LIMITS.tokenLength}}$`, 'u');
const WORD = new RegExp(`^[\\p{L}\\p{N}'’-]{1,${LIMITS.wordLength}}$`, 'u');

function text(raw, field, { max, required = true, lines = false }, problems) {
  if (raw === undefined && !required) return '';
  if (typeof raw !== 'string') {
    problems.push(`${field} must be text`);
    return '';
  }
  const value = raw.replace(/\r\n?/g, '\n').trim();
  if (required && value === '') problems.push(`${field} must not be empty`);
  else if (value.length > max) problems.push(`${field} must be at most ${max} characters`);
  else if (CONTROL.test(value) || (!lines && value.includes('\n'))) problems.push(`${field} must be ${lines ? 'plain text' : 'a single line of plain text'}`);
  return value;
}

function list(raw, field, { max, pattern, describe }, problems) {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${field} must be a non-empty list`);
    return [];
  }
  if (raw.length > max) problems.push(`${field} must have at most ${max} entries`);
  const bad = raw.filter((v) => typeof v !== 'string' || !pattern.test(v));
  if (bad.length) problems.push(`${field} entries must be ${describe} (bad: ${bad.slice(0, 3).map((v) => JSON.stringify(v)).join(', ')})`);
  return raw;
}

function oneOf(raw, field, values, problems) {
  if (raw === undefined) return DEFAULT_LOOK[field];
  if (!values.includes(raw)) problems.push(`${field} must be one of ${values.join(', ')}`);
  return raw;
}

/** @returns {Look} Missing fields take their defaults, so activities stored before these fields existed stay valid. */
function parseLook(raw, problems) {
  const letterStyle = oneOf(raw.letterStyle, 'letterStyle', LETTER_STYLES, problems);
  let allowedStyles = DEFAULT_LOOK.allowedStyles;
  if (raw.allowedStyles !== undefined) {
    const given = raw.allowedStyles;
    if (!Array.isArray(given) || given.length === 0 || given.some((s) => !LETTER_STYLES.includes(s))) {
      problems.push(`allowedStyles must be a non-empty list of ${LETTER_STYLES.join(', ')}`);
    } else {
      allowedStyles = LETTER_STYLES.filter((s) => given.includes(s));
    }
  }
  if (LETTER_STYLES.includes(letterStyle) && !allowedStyles.includes(letterStyle)) problems.push(`allowedStyles must include the default letterStyle (${letterStyle})`);
  const paper = oneOf(raw.paper, 'paper', PAPERS, problems);
  const lineSize = oneOf(raw.lineSize, 'lineSize', LINE_SIZES, problems);
  return { letterStyle, allowedStyles: [...allowedStyles], paper, lineSize };
}

/** One entry per activity type: how to read its fields and the text it asks the child to trace. */
const TYPES = {
  letters: {
    label: 'Letters',
    parse(raw, problems) {
      const sequence = list(raw.sequence, 'sequence', { max: LIMITS.sequence, pattern: TOKEN, describe: `1 to ${LIMITS.tokenLength} letters or digits` }, problems);
      const { repeat } = raw;
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > LIMITS.repeat) problems.push(`repeat must be a whole number from 1 to ${LIMITS.repeat}`);
      else if (sequence.length * repeat > LIMITS.tokens) problems.push(`sequence times repeat must be at most ${LIMITS.tokens} letters`);
      return { type: 'letters', sequence, repeat };
    },
    trace: (a) => Array.from({ length: a.repeat }, () => a.sequence).flat().join(' '),
  },
  words: {
    label: 'Words',
    parse(raw, problems) {
      const category = text(raw.category, 'category', { max: LIMITS.category }, problems);
      const words = list(raw.words, 'words', { max: LIMITS.words, pattern: WORD, describe: 'single words of letters, digits, hyphens or apostrophes' }, problems);
      return { type: 'words', category, words };
    },
    trace: (a) => a.words.join(' '),
  },
  sentence: {
    label: 'Sentence',
    parse: (raw, problems) => ({ type: 'sentence', text: text(raw.text, 'text', { max: LIMITS.sentence }, problems) }),
    trace: (a) => a.text,
  },
  paragraph: {
    label: 'Paragraph',
    parse: (raw, problems) => ({ type: 'paragraph', text: text(raw.text, 'text', { max: LIMITS.paragraph, lines: true }, problems) }),
    trace: (a) => a.text,
  },
};

export const ACTIVITY_TYPES = /** @type {ActivityType[]} */ (Object.keys(TYPES));
export const typeLabel = (type) => TYPES[type].label;

/** The only thing the renderer and scoring ever see. */
export function toTraceText(activity) {
  return TYPES[activity.type].trace(activity);
}

/** @returns {InputResult} */
export function parseActivityInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problems: ['activity must be an object'] };
  if (!Object.hasOwn(TYPES, raw.type)) return { ok: false, problems: [`type must be one of ${ACTIVITY_TYPES.join(', ')}`] };
  const problems = [];
  const title = text(raw.title, 'title', { max: LIMITS.title }, problems);
  const description = text(raw.description, 'description', { max: LIMITS.description, required: false }, problems);
  if (!STATUSES.includes(raw.status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
  const timeLimitSec = raw.timeLimitSec ?? null;
  if (timeLimitSec !== null && !(Number.isInteger(timeLimitSec) && timeLimitSec >= LIMITS.minTimeSec && timeLimitSec <= LIMITS.maxTimeSec)) {
    problems.push(`timeLimitSec must be null for no timer, or a whole number of seconds from ${LIMITS.minTimeSec} to ${LIMITS.maxTimeSec}`);
  }
  const mode = raw.mode ?? 'trace';
  if (!MODES.includes(mode)) problems.push(`mode must be one of ${MODES.join(', ')}`);
  const level = raw.level ?? DEFAULT_LEVEL;
  if (!LEVELS.includes(level)) problems.push(`level must be one of ${LEVELS.join(', ')}`);
  const look = parseLook(raw, problems);
  const body = TYPES[raw.type].parse(raw, problems);
  return problems.length ? { ok: false, problems } : { ok: true, value: { ...body, title, description, status: raw.status, timeLimitSec, mode, level, ...look } };
}

/** @returns {ActivityResult} */
export function parseActivity(raw) {
  const input = parseActivityInput(raw);
  const problems = input.ok ? [] : [...input.problems];
  if (typeof raw?.id !== 'string' || raw.id === '') problems.push('id must be a non-empty string');
  if (!Number.isInteger(raw?.order)) problems.push('order must be a whole number');
  if (typeof raw?.updatedAt !== 'string' || Number.isNaN(Date.parse(raw.updatedAt))) problems.push('updatedAt must be a timestamp');
  return problems.length ? { ok: false, problems } : { ok: true, value: { ...input.value, id: raw.id, order: raw.order, updatedAt: raw.updatedAt } };
}

/** Admin order, then updatedAt, then id, so every listing is deterministic. */
export function compareActivities(a, b) {
  return a.order - b.order || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

/**
 * Activities as the child and the admin both see them: one group per level, easiest first, each in admin order.
 * Every level is returned, so the admin can see an empty one.
 * @template {{ level: Level, order: number, updatedAt: string, id: string }} T
 * @param {T[]} activities
 * @returns {{ level: Level, items: T[] }[]}
 */
export function groupByLevel(activities) {
  return LEVELS.map((level) => ({ level, items: activities.filter((a) => a.level === level).sort(compareActivities) }));
}
