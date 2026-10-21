import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseActivityInput, toTraceText } from '../../games/letterjoin/data/activity.ts';
import { MAX_SEND_SECONDS } from '../../games/letterjoin/data/practice.ts';
import { parseActivityInput as parseInBrowser, toTraceText as traceInBrowser } from '../../games/letterjoin/play/web/activity.js';
import { MAX_SEND_SECONDS as PAGE_MAX } from '../../games/letterjoin/play/web/practice.js';

test('the server and the browser parse activities the same way', () => {
  const inputs = [
    { type: 'letters', title: 'ab', status: 'draft', sequence: ['a', 'b'], repeat: 3, level: 'starter' },
    { type: 'words', title: 'Pets', status: 'published', category: 'Pets', words: ['cat', "can't", 'x-ray'], timeLimitSec: 90, mode: 'traceThenCopy', allowedStyles: ['joined', 'print'], letterStyle: 'joined', paper: 'baseline', lineSize: 'large' },
    { type: 'sentence', title: 'S', status: 'published', text: 'A cat sat.' },
    { type: 'paragraph', title: 'P', status: 'published', text: 'One.\r\nTwo.' },
    { type: 'sentence', title: '', status: 'nope', text: 'x'.repeat(300), level: 'giant', timeLimitSec: 2 },
    { type: 'letters', title: 'x', status: 'draft', sequence: [], repeat: 0 },
    { type: 'words', title: 'w', status: 'draft', category: 'c', words: ['a b'], letterStyle: 'print', allowedStyles: ['joined'] },
    { type: 'unknown' },
    null,
    'text',
  ];
  for (const input of inputs) {
    const server = parseActivityInput(input);
    const browser = parseInBrowser(input);
    assert.deepEqual(server, browser, JSON.stringify(input));
    if (server.ok) assert.equal(toTraceText(server.value), traceInBrowser(browser.value));
  }
});

test('the admin pages hold byte for byte copies of the play modules they share, so a change to one cannot ship without the other', () => {
  const root = new URL('../../games/letterjoin/', import.meta.url);
  const shared = readdirSync(new URL('admin/web/', root)).filter((name) => name.endsWith('.js') && !['admin.js', 'admin-tabs.js', 'practice-report.js', 'api.js'].includes(name));
  assert.deepEqual(shared.sort(), ['activity.js', 'fonts.js', 'format.js', 'practice.js', 'progress.js', 'render.js', 'sections.js', 'sheet.js']);
  for (const name of shared) {
    assert.equal(readFileSync(new URL(`admin/web/${name}`, root), 'utf8'), readFileSync(new URL(`play/web/${name}`, root), 'utf8'), `copy play/web/${name} to admin/web/${name}`);
  }
});

test('the admin pages hold the same open fonts as the play pages, because the admin site is its own origin and loads them from admin/web', () => {
  const root = new URL('../../games/letterjoin/', import.meta.url);
  const play = readdirSync(new URL('play/web/open-fonts/', root)).sort();
  assert.deepEqual(readdirSync(new URL('admin/web/open-fonts/', root)).sort(), play);
  for (const name of play) {
    assert.ok(readFileSync(new URL(`admin/web/open-fonts/${name}`, root)).equals(readFileSync(new URL(`play/web/open-fonts/${name}`, root))), `copy play/web/open-fonts/${name} to admin/web/open-fonts/${name}`);
  }
});

test('the page never sends more practice seconds in one call than the server accepts', () => {
  assert.equal(PAGE_MAX, MAX_SEND_SECONDS);
});
