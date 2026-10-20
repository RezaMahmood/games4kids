import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LEVEL, DEFAULT_LOOK, LEVELS, LEVEL_INFO, LIMITS, compareActivities, groupByLevel, parseActivity, parseActivityInput, toTraceText } from '../../games/letterjoin/play/web/activity.js';

const base = { title: 'Practice', status: 'published' };
const valid = (raw) => {
  const result = parseActivityInput({ ...base, ...raw });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return result.value;
};
const problems = (raw) => {
  const result = parseActivityInput(raw);
  assert.equal(result.ok, false, 'expected the activity to be rejected');
  return result.problems.join('\n');
};

test('letters trace as spaced letters repeated as a whole sequence', () => {
  assert.equal(toTraceText(valid({ type: 'letters', sequence: ['a', 'b', 'c'], repeat: 2 })), 'a b c a b c');
  assert.equal(toTraceText(valid({ type: 'letters', sequence: ['a'], repeat: 5 })), 'a a a a a');
  assert.equal(toTraceText(valid({ type: 'letters', sequence: ['ch', 'sh', '7'], repeat: 1 })), 'ch sh 7');
});

test('words trace space separated so the renderer can wrap them', () => {
  const words = valid({ type: 'words', category: 'Animals', words: ['cat', 'dog', "can't", 'x-ray'] });
  assert.equal(words.category, 'Animals');
  assert.equal(toTraceText(words), "cat dog can't x-ray");
});

test('sentences and paragraphs trace as written, trimmed, with line breaks kept in paragraphs', () => {
  assert.equal(toTraceText(valid({ type: 'sentence', text: '  The cat sat on the mat.  ' })), 'The cat sat on the mat.');
  assert.equal(toTraceText(valid({ type: 'paragraph', text: 'Rain fell.\r\nThe garden drank.\nSoon it bloomed.' })), 'Rain fell.\nThe garden drank.\nSoon it bloomed.');
});

test('description is optional and defaults to empty', () => {
  assert.equal(valid({ type: 'sentence', text: 'Hi there.' }).description, '');
  assert.equal(valid({ type: 'sentence', text: 'Hi there.', description: ' Say it out loud ' }).description, 'Say it out loud');
});

test('server-owned fields in the input are dropped', () => {
  const value = valid({ type: 'sentence', text: 'Hi.', id: 'mine', order: -5, updatedAt: '2000-01-01T00:00:00Z', etag: 'x' });
  assert.deepEqual(Object.keys(value).sort(), ['allowedStyles', 'description', 'letterStyle', 'level', 'lineSize', 'mode', 'paper', 'status', 'text', 'timeLimitSec', 'title', 'type']);
});

test('an activity is untimed unless it has a whole number of seconds from 5 to 3600', () => {
  assert.equal(valid({ type: 'sentence', text: 'Hi.' }).timeLimitSec, null);
  assert.equal(valid({ type: 'sentence', text: 'Hi.', timeLimitSec: null }).timeLimitSec, null);
  assert.equal(valid({ type: 'sentence', text: 'Hi.', timeLimitSec: 5 }).timeLimitSec, 5);
  assert.equal(valid({ type: 'sentence', text: 'Hi.', timeLimitSec: 3600 }).timeLimitSec, 3600);
  for (const bad of [0, 4, 3601, 90.5, '90', Number.NaN, Number.POSITIVE_INFINITY, -10]) {
    assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', timeLimitSec: bad }), /timeLimitSec must be null for no timer/, String(bad));
  }
});

test('an activity is traced only, unless it asks for an unaided copy after the trace', () => {
  assert.equal(valid({ type: 'sentence', text: 'Hi.' }).mode, 'trace');
  assert.equal(valid({ type: 'sentence', text: 'Hi.', mode: null }).mode, 'trace');
  assert.equal(valid({ type: 'words', category: 'Tricky', words: ['rhythm'], mode: 'traceThenCopy' }).mode, 'traceThenCopy');
  for (const bad of ['copy', 'TRACE', '', 1, true]) {
    assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', mode: bad }), /mode must be one of trace, traceThenCopy/, String(bad));
  }
});

test('letters reject a bad repeat, an empty sequence, bad tokens and too many letters', () => {
  assert.match(problems({ ...base, type: 'letters', sequence: ['a'], repeat: 0 }), /repeat must be a whole number from 1 to 20/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['a'], repeat: 21 }), /repeat/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['a'], repeat: 1.5 }), /repeat/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['a'], repeat: '2' }), /repeat/);
  assert.match(problems({ ...base, type: 'letters', sequence: [], repeat: 1 }), /sequence must be a non-empty list/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['a b'], repeat: 1 }), /sequence entries/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['abcd'], repeat: 1 }), /sequence entries/);
  assert.match(problems({ ...base, type: 'letters', sequence: ['<'], repeat: 1 }), /sequence entries/);
  const twenty = 'abcdefghijklmnopqrst'.split('');
  assert.match(problems({ ...base, type: 'letters', sequence: twenty, repeat: 4 }), new RegExp(`at most ${LIMITS.tokens} letters`));
});

test('words need a category and real words', () => {
  assert.match(problems({ ...base, type: 'words', words: ['cat'] }), /category must be text/);
  assert.match(problems({ ...base, type: 'words', category: ' ', words: ['cat'] }), /category must not be empty/);
  assert.match(problems({ ...base, type: 'words', category: 'Pets', words: ['two words'] }), /words entries/);
  assert.match(problems({ ...base, type: 'words', category: 'Pets', words: 'cat dog' }), /words must be a non-empty list/);
  assert.match(problems({ ...base, type: 'words', category: 'Pets', words: Array(31).fill('cat') }), /at most 30 entries/);
});

test('sentences are one line and paragraphs have a length cap', () => {
  assert.match(problems({ ...base, type: 'sentence', text: 'one\ntwo' }), /single line/);
  assert.match(problems({ ...base, type: 'sentence', text: 'x'.repeat(201) }), /at most 200/);
  assert.match(problems({ ...base, type: 'paragraph', text: 'x'.repeat(2001) }), /at most 2000/);
  assert.match(problems({ ...base, type: 'paragraph', text: '   ' }), /text must not be empty/);
  assert.match(problems({ ...base, type: 'paragraph', text: 'tab\there' }), /plain text/);
});

test('unknown types, bad status, bad title and non-objects are rejected', () => {
  assert.match(problems({ ...base, type: 'poem', text: 'x' }), /type must be one of letters, words, sentence, paragraph/);
  assert.match(problems({ ...base, type: 'toString', text: 'x' }), /type must be one of/);
  assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', status: 'live' }), /status must be one of draft, published/);
  assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', title: '' }), /title must not be empty/);
  assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', title: 'a\nb' }), /title must be a single line/);
  assert.match(problems(null), /must be an object/);
  assert.match(problems([]), /must be an object/);
});

test('markup is kept as inert text, not stripped or interpreted', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const value = valid({ type: 'sentence', title: xss, description: '<script>alert(1)</script>', text: `${xss} is text.` });
  assert.equal(value.title, xss);
  assert.equal(toTraceText(value), `${xss} is text.`);
});

test('a stored activity also needs its server-owned fields', () => {
  const stored = { ...base, type: 'sentence', text: 'Hi.', id: 'a1', order: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(parseActivity({ ...stored, timeLimitSec: 90 }), { ok: true, value: { type: 'sentence', text: 'Hi.', title: 'Practice', description: '', status: 'published', timeLimitSec: 90, mode: 'trace', level: DEFAULT_LEVEL, ...DEFAULT_LOOK, id: 'a1', order: 3, updatedAt: '2026-01-01T00:00:00.000Z' } });
  const bad = parseActivity({ ...stored, id: '', order: '3', updatedAt: 'soon' });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join('\n'), /id[\s\S]*order[\s\S]*updatedAt/);
});

test('listing order is admin order, then updatedAt, then id', () => {
  const a = (id, order, updatedAt) => ({ id, order, updatedAt });
  const sorted = [a('c', 1, '2026-01-02'), a('b', 0, '2026-01-03'), a('a', 1, '2026-01-02'), a('d', 1, '2026-01-01')].sort(compareActivities);
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'd', 'a', 'c']);
});

test('an activity stored before letter styles and paper existed reads with the defaults', () => {
  const old = { type: 'paragraph', title: 'Rain', description: '', status: 'published', timeLimitSec: null, text: 'Rain fell.\nThe garden drank.', id: 'r1', order: 0, updatedAt: '2026-01-01T00:00:00.000Z' };
  const parsed = parseActivity(old);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.problems));
  assert.deepEqual(
    [parsed.value.letterStyle, parsed.value.allowedStyles, parsed.value.paper, parsed.value.lineSize],
    ['print', ['print', 'precursive', 'joined'], 'fourLine', 'medium'],
  );
  assert.equal(toTraceText(parsed.value), 'Rain fell.\nThe garden drank.', 'hard line breaks survive');
});

test('the admin picks the default style, the offered styles, the paper and the line size', () => {
  const value = valid({ type: 'sentence', text: 'Hi.', letterStyle: 'joined', allowedStyles: ['joined', 'precursive'], paper: 'highlighted', lineSize: 'large' });
  assert.deepEqual([value.letterStyle, value.allowedStyles, value.paper, value.lineSize], ['joined', ['precursive', 'joined'], 'highlighted', 'large']);
  assert.deepEqual(valid({ type: 'sentence', text: 'Hi.', allowedStyles: ['print', 'print'] }).allowedStyles, ['print'], 'duplicates collapse, order is canonical');
  for (const paper of ['baseline', 'threeLine', 'fourLine', 'highlighted']) assert.equal(valid({ type: 'sentence', text: 'Hi.', paper }).paper, paper);
  for (const lineSize of ['small', 'medium', 'large']) assert.equal(valid({ type: 'sentence', text: 'Hi.', lineSize }).lineSize, lineSize);
});

test('a parsed look is a fresh copy, so callers cannot change the defaults', () => {
  const value = valid({ type: 'sentence', text: 'Hi.' });
  value.allowedStyles.push('cursive');
  assert.deepEqual(valid({ type: 'sentence', text: 'Hi.' }).allowedStyles, ['print', 'precursive', 'joined']);
});

test('bad styles, papers and line sizes are rejected', () => {
  const sentence = { ...base, type: 'sentence', text: 'Hi.' };
  assert.match(problems({ ...sentence, letterStyle: 'cursive' }), /letterStyle must be one of print, precursive, joined/);
  assert.match(problems({ ...sentence, letterStyle: null }), /letterStyle must be one of/);
  assert.match(problems({ ...sentence, allowedStyles: [] }), /allowedStyles must be a non-empty list of print, precursive, joined/);
  assert.match(problems({ ...sentence, allowedStyles: 'print' }), /allowedStyles must be a non-empty list/);
  assert.match(problems({ ...sentence, allowedStyles: ['print', 'italic'] }), /allowedStyles must be a non-empty list/);
  assert.match(problems({ ...sentence, paper: 'grid' }), /paper must be one of baseline, threeLine, fourLine, highlighted/);
  assert.match(problems({ ...sentence, lineSize: 'huge' }), /lineSize must be one of small, medium, large/);
  assert.match(problems({ ...sentence, lineSize: 40 }), /lineSize must be one of/);
});

test('the offered styles must include the default style', () => {
  assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', letterStyle: 'joined', allowedStyles: ['print'] }), /allowedStyles must include the default letterStyle \(joined\)/);
  assert.match(problems({ ...base, type: 'sentence', text: 'Hi.', allowedStyles: ['joined'] }), /must include the default letterStyle \(print\)/, 'an omitted default is print');
});

test('an activity without a level reads as the middle level, and an unknown level is rejected', () => {
  const sentence = { type: 'sentence', text: 'Hello.' };
  assert.equal(valid(sentence).level, DEFAULT_LEVEL);
  for (const level of LEVELS) assert.equal(valid({ ...sentence, level }).level, level);
  assert.match(problems({ ...base, ...sentence, level: 'expert' }), /level must be one of starter, explorer, champion/);
  assert.match(problems({ ...base, ...sentence, level: 3 }), /level must be one of/);
});

test('every level has a label, the ages it suits and a blurb', () => {
  for (const level of LEVELS) assert.ok(Object.values(LEVEL_INFO[level]).every((v) => typeof v === 'string' && v !== ''), level);
});

test('groupByLevel returns every level easiest first, each group in admin order, and drops nothing', () => {
  const at = (id, level, order) => ({ id, level, order, updatedAt: '2026-01-01T00:00:00.000Z' });
  const all = [at('a', 'champion', 0), at('b', 'starter', 5), at('c', 'explorer', 2), at('d', 'starter', 1), at('e', 'champion', 3)];
  const groups = groupByLevel(all);
  assert.deepEqual(groups.map((g) => g.level), ['starter', 'explorer', 'champion']);
  assert.deepEqual(groups.map((g) => g.items.map((a) => a.id)), [['d', 'b'], ['c'], ['a', 'e']]);
  assert.deepEqual(groupByLevel([]).map((g) => g.items), [[], [], []], 'empty levels are still returned');
  assert.deepEqual(all.map((a) => a.id), ['a', 'b', 'c', 'd', 'e'], 'the input is not reordered');
});
