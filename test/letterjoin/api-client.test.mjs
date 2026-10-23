import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../../apps/shared/api-client.ts';
import { createApi as createAdminApi } from '../../games/letterjoin/admin/web/api.js';
import { createApi as createPlayApi } from '../../games/letterjoin/play/web/api.js';
import { makePng } from './png.mjs';

const BASE = 'https://api.example/api/g/letterjoin';
const ADMIN_BASE = 'https://api.example/api/admin/g/letterjoin';

/** The shell's client over a fetch that records what was sent. */
function recorded(baseUrl, respond) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body, keepalive: init.keepalive });
    return respond(url, init);
  };
  const client = createApiClient({ baseUrl, tokens: { token: async () => 'tok', reauthenticate: async () => {} }, fetchImpl });
  return { sent, play: createPlayApi(client), admin: createAdminApi(client) };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status, message, problems) => json(status, { error: 'refused', message, ...(problems && { problems }) });

test('submitCopy posts the PNG bytes as image/png with the bearer token and returns the receipt', async () => {
  const { sent, play } = recorded(BASE, () => json(201, { id: 'sub-1', createdAt: '2026-03-01T10:00:00.000Z' }));
  const png = new Blob([makePng()], { type: 'image/png' });
  assert.deepEqual(await play.submitCopy('act/1', png), { id: 'sub-1', createdAt: '2026-03-01T10:00:00.000Z' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${BASE}/activities/act%2F1/submission`);
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual([sent[0].headers.authorization, sent[0].headers['content-type']], ['Bearer tok', 'image/png']);
  assert.equal(sent[0].body, png, 'the Blob itself is sent, not JSON');
});

test('a refusal reaches the page with the server message and its problems', async () => {
  const { play } = recorded(BASE, () => refusal(413, 'The image must be at most 2 MB.', ['too big']));
  const err = await play.submitCopy('a', new Blob([makePng()], { type: 'image/png' })).catch((e) => e);
  assert.deepEqual([err.status, err.message, err.problems], [413, 'The image must be at most 2 MB.', ['too big']]);
});

test('practice calls carry the local day and seconds, and a report at page exit asks to outlive the page', async () => {
  const { sent, play } = recorded(BASE, () => json(200, { minutes: 15, usedSeconds: 75 }));
  assert.deepEqual(await play.practice('2026-10-17'), { minutes: 15, usedSeconds: 75 });
  await play.addPractice('2026-10-17', 15);
  await play.addPractice('2026-10-17', 20, { keepalive: true });
  assert.equal(sent[0].url, `${BASE}/practice?day=2026-10-17`);
  assert.deepEqual([sent[1].method, JSON.parse(sent[1].body), sent[1].keepalive], ['POST', { day: '2026-10-17', seconds: 15 }, undefined]);
  assert.equal(sent[2].keepalive, true);
});

test('the board is asked for with the local day, a child who is off it gets nothing else, and a malformed board is refused', async () => {
  const on = { optedIn: true, days: ['2026-10-16', '2026-10-17'], levels: [{ level: 'starter', children: [{ name: 'Amy', me: true, points: [0, 80], total: 80 }] }] };
  const { sent, play } = recorded(BASE, () => json(200, on));
  assert.deepEqual(await play.board('2026-10-17'), on);
  assert.equal(sent[0].url, `${BASE}/board?day=2026-10-17`);
  const { play: off } = recorded(BASE, () => json(200, { optedIn: false, levels: [{ level: 'starter', children: [] }] }));
  assert.deepEqual(await off.board('2026-10-17'), { optedIn: false });
  for (const bad of [{}, { optedIn: true }, { ...on, levels: [{ level: 'novice', children: [] }] }, { ...on, levels: [{ level: 'starter', children: [{ name: 'Amy', me: true, points: ['x'], total: 1 }] }] }]) {
    const { play: next } = recorded(BASE, () => json(200, bad));
    assert.equal((await next.board('2026-10-17').catch((e) => e)).status, 502, JSON.stringify(bad));
  }
});

test('switching the board sends on as true or false', async () => {
  const { sent, play } = recorded(BASE, (url, init) => json(200, { optedIn: JSON.parse(init.body).on }));
  assert.deepEqual(await play.setBoard(true), { optedIn: true });
  assert.deepEqual(await play.setBoard(false), { optedIn: false });
  assert.deepEqual(sent.map((c) => [c.method, c.url, JSON.parse(c.body)]), [['PUT', `${BASE}/board/me`, { on: true }], ['PUT', `${BASE}/board/me`, { on: false }]]);
});

test('the admin saves settings and reads the practice report for a day, and a malformed report is refused', async () => {
  const good = { days: ['2026-10-16', '2026-10-17'], goalMinutes: 15, children: [{ userId: 'u1', name: 'Amy', seconds: [0, 900], totalSeconds: 900 }] };
  const { sent, admin } = recorded(ADMIN_BASE, () => json(200, good));
  assert.deepEqual(await admin.practiceReport('2026-10-17'), good);
  assert.equal(sent[0].url, `${ADMIN_BASE}/practice?day=2026-10-17`);
  await admin.saveSettings({ dailyPracticeMinutes: 20, hardModeDefault: true });
  assert.deepEqual([sent[1].method, sent[1].url, JSON.parse(sent[1].body)], ['PUT', `${ADMIN_BASE}/settings`, { dailyPracticeMinutes: 20, hardModeDefault: true }]);
  for (const bad of [{}, { ...good, goalMinutes: 'x' }, { ...good, children: [{ userId: 'a', name: 'A', seconds: [1], totalSeconds: 1 }] }, { ...good, children: [{ name: 'A', seconds: [1, 2], totalSeconds: 3 }] }]) {
    const { admin: next } = recorded(ADMIN_BASE, () => json(200, bad));
    await assert.rejects(next.practiceReport('2026-10-17'), (err) => err.name === 'ApiError' && err.status === 502);
  }
});

test('the admin review calls send filters as a query, fetch the image as a Blob and patch reviews', async () => {
  const png = makePng();
  const { sent, admin } = recorded(ADMIN_BASE, (url) => (url.endsWith('/image') ? new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) : json(200, { submissions: [], next: null })));
  await admin.submissions({ userId: 'u1', unreviewed: true, activityId: '', after: undefined });
  await admin.submissions();
  assert.deepEqual(sent.map((s) => s.url), [`${ADMIN_BASE}/submissions?userId=u1&unreviewed=true`, `${ADMIN_BASE}/submissions`]);
  const image = await admin.submissionImage('s1');
  assert.equal(image.type, 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  await admin.reviewSubmission('s1', { reviewed: true, note: 'Neat.' });
  assert.deepEqual([sent.at(-1).method, sent.at(-1).url, JSON.parse(sent.at(-1).body)], ['PATCH', `${ADMIN_BASE}/submissions/s1`, { reviewed: true, note: 'Neat.' }]);
  await admin.discardSubmission('s1');
  assert.deepEqual([sent.at(-1).method, sent.at(-1).url], ['DELETE', `${ADMIN_BASE}/submissions/s1`]);
});

test('an image the server refuses is an error, not a broken picture', async () => {
  const { admin } = recorded(ADMIN_BASE, () => refusal(404, 'There is no such copy.'));
  await assert.rejects(admin.submissionImage('gone'), (err) => err.status === 404);
});

const attempt = { id: '00000000-0000-4000-8000-000000000001', activityId: 'a', level: 'champion', chars: 40, score: 86.5, timeMs: 12000, completedAt: '2026-10-16T09:00:00.000Z' };

test('progress reads GET progress and returns the attempts as sent', async () => {
  const { sent, play } = recorded(BASE, () => json(200, { attempts: [attempt] }));
  assert.deepEqual(await play.progress(), [attempt]);
  assert.deepEqual([sent[0].url, sent[0].method, sent[0].headers.authorization], [`${BASE}/progress`, 'GET', 'Bearer tok']);
});

test('the admin reads one child\'s progress by the child id in the path', async () => {
  const { sent, admin } = recorded(ADMIN_BASE, () => json(200, { attempts: [] }));
  assert.deepEqual(await admin.childProgress('2b1c/x'), []);
  assert.equal(sent[0].url, `${ADMIN_BASE}/progress/2b1c%2Fx`);
});

test('an attempt the app does not understand is a 502, not a silent hole in the list', async () => {
  const bad = [
    { ...attempt, level: 'hard' },
    { ...attempt, score: 101 },
    { ...attempt, chars: 1.5 },
    { ...attempt, timeMs: -1 },
    { ...attempt, completedAt: 'yesterday' },
    { ...attempt, id: undefined },
    null,
  ];
  for (const row of bad) {
    const { play } = recorded(BASE, () => json(200, { attempts: [attempt, row] }));
    await assert.rejects(play.progress(), (err) => err.name === 'ApiError' && err.status === 502, JSON.stringify(row));
  }
  for (const body of [{}, { attempts: 'none' }, null]) {
    const { play } = recorded(BASE, () => json(200, body));
    await assert.rejects(play.progress(), (err) => err.name === 'ApiError' && err.status === 502);
  }
});

test('saveResult sends the attemptId the caller made', async () => {
  const { sent, play } = recorded(BASE, () => json(200, { score: 80, timeMs: 5000, completedAt: '2026-10-16T09:00:00.000Z' }));
  await play.saveResult('act', { attemptId: attempt.id, score: 80, timeMs: 5000 });
  assert.deepEqual([sent[0].method, JSON.parse(sent[0].body)], ['PUT', { attemptId: attempt.id, score: 80, timeMs: 5000 }]);
});

test('a saved or listed result says whether it was hard, and one from before hard mode is not', async () => {
  let answer = { score: 80, timeMs: 5000, hard: true, completedAt: '2026-10-16T09:00:00.000Z' };
  const { sent, play } = recorded(BASE, () => json(200, answer));
  const saved = await play.saveResult('act', { attemptId: attempt.id, score: 80, timeMs: 5000, hard: true });
  assert.equal(JSON.parse(sent[0].body).hard, true);
  assert.equal(saved.hard, true);
  answer = { score: 80, timeMs: 5000, completedAt: '2026-10-16T09:00:00.000Z' };
  assert.equal((await play.saveResult('act', { attemptId: attempt.id, score: 80, timeMs: 5000 })).hard, false);
});

test('the activities a child lists carry their own result, and the admin list carries the etag', async () => {
  const activity = { id: 'a1', type: 'sentence', text: 'A cat sat.', title: 'Cat', description: '', status: 'published', timeLimitSec: null, mode: 'trace', level: 'starter', order: 0, updatedAt: '2026-10-16T09:00:00.000Z' };
  const done = { score: 90, timeMs: 4000, hard: false, completedAt: '2026-10-16T09:00:00.000Z' };
  const { play } = recorded(BASE, () => json(200, { activities: [{ ...activity, result: done }, { ...activity, id: 'a2', result: null }] }));
  assert.deepEqual((await play.activities()).map((a) => [a.id, a.result]), [['a1', done], ['a2', null]]);
  const { admin } = recorded(ADMIN_BASE, () => json(200, { activities: [{ ...activity, etag: 'W/"1"' }] }));
  assert.equal((await admin.activities())[0].etag, 'W/"1"');
});

test('readHandwriting posts the PNG of a line to its activity and returns the words read with their boxes', async () => {
  const words = [{ text: 'cat', confidence: 0.98, box: { x: 10, y: 20, w: 90, h: 60 } }];
  const { sent, play } = recorded(BASE, () => json(200, { words }));
  const png = new Blob([makePng()], { type: 'image/png' });
  assert.deepEqual(await play.readHandwriting('a1', png), { words });
  assert.deepEqual([sent[0].method, sent[0].url, sent[0].headers['content-type'], sent[0].body], ['POST', `${BASE}/activities/a1/read`, 'image/png', png]);
});

test('readHandwriting refuses a reading it does not understand, and passes on a reader outage', async () => {
  let answer = () => json(200, { words: [{ text: 'cat', confidence: 1 }] });
  const { play } = recorded(BASE, () => answer());
  const png = new Blob([makePng()], { type: 'image/png' });
  assert.equal((await play.readHandwriting('a1', png).catch((e) => e)).status, 502);
  answer = () => refusal(503, 'Reading handwriting is not switched on.');
  const err = await play.readHandwriting('a1', png).catch((e) => e);
  assert.deepEqual([err.status, err.message], [503, 'Reading handwriting is not switched on.']);
});
