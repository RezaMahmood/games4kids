import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { adminModule, createAdminApp, createPlayerApp, type Env } from '@g4k/host';
import { startFakeVision } from '../dev/fake-vision.ts';
import { createAdminApi } from '../games/letterjoin/admin/api/index.ts';
import type { ActivityInput } from '../games/letterjoin/data/activity.ts';
import { buildReport, daysEndingAt, MAX_SEND_SECONDS, parseDay } from '../games/letterjoin/data/practice.ts';
import { applyReview, isPng, KEEP_PER_ACTIVITY, MAX_IMAGE_BYTES, NOT_REVIEWED, NOTE_MAX, PAGE_DEFAULT, parseReviewInput, parseSubmissionQuery, sortKey, submissionId } from '../games/letterjoin/data/submissions.ts';
import manifest from '../games/letterjoin/manifest.ts';
import { createPlayApi } from '../games/letterjoin/play/api/index.ts';
import { fakeGraph } from './support/graph.ts';
import { call, codeOf, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world } from './support/world.ts';
import { makePng } from './letterjoin/png.mjs';

const idp = await fakeIdp();
const vision = await startFakeVision();
after(() => vision.close());
const letterjoin = gameId('letterjoin');
const TODAY = NOW.toISOString().slice(0, 10);
const PNG = makePng();

type Problems = { problems: string[] };

async function setup(env: Env = { VISION_ENDPOINT: vision.origin }) {
	const w = world();
	const tokens = async (service: string) => `tok-${service}`;
	const clock = { at: NOW };
	const common = { telemetry: w.telemetry, now: () => clock.at };
	const player = createPlayerApp({ ...common, issuers: [idp.games], manifest, create: createPlayApi, portal: w.reader, accounts: w.accounts, tokens, env });
	const admin = createAdminApp({
		...common,
		issuer: idp.admin,
		store: w.admin,
		graph: () => fakeGraph().graph,
		games: [letterjoin],
		modules: [adminModule(manifest, createAdminApi)],
		accounts: w.accounts,
		tokens,
		env: {},
		gamesOrigin: 'https://games.example',
	});
	const adminObjectId = newObjectId();
	await seedAdmin(w, adminObjectId);
	const adminToken = await idp.adminToken(adminObjectId);
	const adminId = adminObjectId;
	const child = (displayName: string) => seedPlayer(w, idp, { games: [letterjoin], profile: { displayName, timeZone: 'Europe/London' } });
	const as = (token: string) => (method: string, path: string, send: Send = {}) => call(player, method, `/api/g/letterjoin/${path}`, { token, ...send });
	const asAdmin = (method: string, path: string, send: Send = {}) => call(admin, method, `/api/admin/g/letterjoin/${path}`, { token: adminToken, ...send });
	const ada = await child('Ada');
	return { w, clock, adminId, ada, child, asAda: as(ada.token), as, asAdmin, account: w.accounts.open(letterjoin), exceptions: w.telemetry.exceptions };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const sentence = (title: string, extra: Partial<ActivityInput> & Record<string, unknown> = {}) => ({ type: 'sentence', title, text: `${title} is here.`, status: 'published', timeLimitSec: null, ...extra });

async function publish({ asAdmin }: Setup, title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; etag: string }> {
	const made = await asAdmin('POST', 'activities', { json: sentence(title, extra) });
	assert.equal(made.status, 201, JSON.stringify(made.data));
	return made.data as { id: string; etag: string };
}

const attemptId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = (n: number, extra: Record<string, unknown> = {}) => ({ attemptId: attemptId(n), score: 80, timeMs: 5000, ...extra });
const listed = async (s: Setup, as = s.asAda) => ((await as('GET', 'activities')).data as { activities: { id: string; title: string; result: { score: number } | null }[] }).activities;

test('a child lists published activities with their own result, and only an admin sees drafts and etags', async () => {
	const s = await setup();
	const open = await publish(s, 'Open');
	await publish(s, 'Hidden', { status: 'draft' });
	assert.deepEqual((await listed(s)).map((a) => a.title), ['Open']);
	assert.equal(JSON.stringify((await s.asAda('GET', 'activities')).data).includes('etag'), false, 'a child is shown no etag');
	const forAdmin = (await s.asAdmin('GET', 'activities')).data as { activities: { title: string; etag: string; status: string }[] };
	assert.deepEqual(forAdmin.activities.map((a) => [a.title, a.status, a.etag.length > 0]), [['Open', 'published', true], ['Hidden', 'draft', true]]);

	assert.equal((await s.asAda('PUT', `activities/${open.id}/result`, { json: result(1) })).status, 200);
	const bea = await s.child('Bea');
	assert.deepEqual((await listed(s)).map((a) => a.result?.score), [80]);
	assert.deepEqual((await listed(s, s.as(bea.token))).map((a) => a.result), [null], 'each child sees only their own result');
});

test('the admin creates at the end with an id, order and time the server owns, edits with the current etag only, and deletes idempotently', async () => {
	const s = await setup();
	const first = await publish(s, 'One');
	const second = await publish(s, 'Two', { id: 'mine', order: 9, updatedAt: 'then' });
	const all = (await s.asAdmin('GET', 'activities')).data as { activities: { id: string; order: number; updatedAt: string; level: string; letterStyle: string }[] };
	assert.deepEqual(all.activities.map((a) => [a.order, a.updatedAt, a.level, a.letterStyle]), [[0, NOW.toISOString(), 'explorer', 'print'], [1, NOW.toISOString(), 'explorer', 'print']]);
	assert.notEqual(second.id, 'mine');

	const bad = await s.asAdmin('POST', 'activities', { json: { type: 'sentence', title: '', status: 'published' } });
	assert.equal(bad.status, 400);
	assert.match((bad.data as Problems).problems.join(), /title must not be empty/);

	const edited = await s.asAdmin('PUT', `activities/${first.id}`, { json: { ...sentence('One, edited'), etag: first.etag } });
	assert.equal(edited.status, 200);
	const stale = await s.asAdmin('PUT', `activities/${first.id}`, { json: { ...sentence('Late edit'), etag: first.etag } });
	assert.equal(stale.status, 412);
	assert.equal(codeOf(stale), 'changed');
	assert.equal((await s.asAdmin('PUT', `activities/${first.id}`, { json: sentence('No etag') })).status, 400);
	assert.equal((await s.asAdmin('PUT', 'activities/nope', { json: { ...sentence('x'), etag: 'e' } })).status, 404);
	assert.deepEqual((await listed(s)).map((a) => a.title), ['One, edited', 'Two']);

	assert.equal((await s.asAdmin('DELETE', `activities/${first.id}`)).status, 204);
	assert.equal((await s.asAdmin('DELETE', `activities/${first.id}`)).status, 204);
	assert.equal((await s.asAdmin('DELETE', 'activities/not-a-guid')).status, 204);
	assert.deepEqual((await listed(s)).map((a) => a.title), ['Two']);
});

test('reordering takes the whole list once, converges when repeated, and refuses lists that miss, repeat or invent an activity', async () => {
	const s = await setup();
	const ids = [(await publish(s, 'A')).id, (await publish(s, 'B')).id, (await publish(s, 'C')).id];
	const order = async () => ((await s.asAdmin('GET', 'activities')).data as { activities: { title: string }[] }).activities.map((a) => a.title).join('');
	for (let again = 0; again < 2; again++) {
		const moved = await s.asAdmin('PUT', 'activities/order', { json: { ids: [ids[2], ids[0], ids[1]] } });
		assert.equal(moved.status, 200);
		assert.equal(await order(), 'CAB');
	}
	for (const [list, why] of [[[ids[0]], /missing/], [[ids[0], ids[0], ids[1], ids[2]], /duplicates/], [[...ids, 'ghost'], /unknown/]] as const) {
		const refused = await s.asAdmin('PUT', 'activities/order', { json: { ids: list } });
		assert.equal(refused.status, 400);
		assert.match((refused.data as Problems).problems.join(), why);
	}
	assert.equal((await s.asAdmin('PUT', 'activities/order', { json: { ids: 'abc' } })).status, 400);
	assert.equal(await order(), 'CAB', 'a refused list changes nothing');
});

test('a result is saved for the caller from the token, replaces the earlier one, and adds one attempt per attemptId', async () => {
	const s = await setup();
	const { id } = await publish(s, 'Trace me', { type: 'words', category: 'Pets', words: ['cat', 'dog'], title: 'Pets', level: 'champion' });
	const saved = await s.asAda('PUT', `activities/${id}/result`, { json: result(1, { score: 86.46 }) });
	assert.deepEqual(saved.data, { score: 86.5, timeMs: 5000, hard: false, completedAt: NOW.toISOString() });
	await s.asAda('PUT', `activities/${id}/result`, { json: result(1, { score: 86.46 }) });
	await s.asAda('PUT', `activities/${id}/result`, { json: result(2, { score: 95 }) });
	assert.equal((await listed(s))[0]?.result?.score, 95, 'the latest attempt is the result');

	const progress = (await s.asAda('GET', 'progress')).data as { attempts: { id: string; level: string; chars: number; score: number; activityId: string }[] };
	assert.deepEqual(progress.attempts.map((a) => [a.id, a.level, a.chars, a.score]), [[attemptId(1), 'champion', 6, 86.5], [attemptId(2), 'champion', 6, 95]], 'a retry adds nothing; chars skip spaces');

	const bea = await s.child('Bea');
	assert.deepEqual(((await s.as(bea.token)('GET', 'progress')).data as { attempts: unknown[] }).attempts, [], 'nobody reads another child\'s progress');
	const forAdmin = await s.asAdmin('GET', `progress/${s.ada.userId}`);
	assert.deepEqual(((forAdmin.data as { attempts: { id: string }[] }).attempts).map((a) => a.id), [attemptId(1), attemptId(2)]);
	assert.equal((await s.asAdmin('GET', 'progress/not-a-guid')).status, 404);

	const current = ((await s.asAdmin('GET', 'activities')).data as { activities: { etag: string }[] }).activities[0];
	await s.asAdmin('PUT', `activities/${id}`, { json: { ...sentence('Retitled'), level: 'starter', etag: current?.etag } });
	await s.asAdmin('DELETE', `activities/${id}`);
	assert.deepEqual(await listed(s), [], 'a deleted activity leaves the list');
	const kept = ((await s.asAdmin('GET', `progress/${s.ada.userId}`)).data as { attempts: { level: string; chars: number }[] }).attempts;
	assert.deepEqual(kept.map((a) => [a.level, a.chars]), [['champion', 6], ['champion', 6]], 'an attempt keeps its snapshot of the activity');
});

test('results are validated: scores, times, the attemptId, hard, drafts and unknown activities', async () => {
	const s = await setup();
	const timed = await publish(s, 'Timed', { timeLimitSec: 10 });
	const draft = await publish(s, 'Draft', { status: 'draft' });
	const put = (id: string, body: unknown) => s.asAda('PUT', `activities/${id}/result`, { json: body });
	for (const body of [
		{ ...result(1), score: -1 }, { ...result(1), score: 100.5 }, { ...result(1), score: 'x' }, { ...result(1), timeMs: -1 }, { ...result(1), timeMs: 1.5 },
		{ ...result(1), attemptId: 'nope' }, { score: 80, timeMs: 1 }, { ...result(1), hard: 'yes' }, null,
	]) assert.equal((await put(timed.id, body)).status, 400, JSON.stringify(body));
	assert.equal((await put(timed.id, result(1, { timeMs: 12_000 }))).status, 200, 'a timed activity allows its limit plus two seconds');
	assert.equal((await put(timed.id, result(2, { timeMs: 12_001 }))).status, 400);
	assert.equal((await put(timed.id, result(3, { timeMs: 3_600_000, hard: true }))).status, 200, 'a hard result is held to the untimed bound only');
	assert.equal(((await put(timed.id, result(3, { timeMs: 3_600_000, hard: true }))).data as { hard: boolean }).hard, true);
	assert.equal((await put(draft.id, result(4))).status, 404);
	assert.equal((await put('5eed0000-0000-4000-8000-00000000000a', result(5))).status, 404);
	assert.equal((await put('nope', result(5))).status, 404);
	assert.equal((await listed(s))[0]?.title, 'Timed');
	const attempts = ((await s.asAda('GET', 'progress')).data as { attempts: unknown[] }).attempts;
	assert.equal(attempts.length, 2, 'refused results wrote no attempt');
});

test('practice adds up per child per day, comes back with the admin\'s minutes, and refuses a day far from today', async () => {
	const s = await setup();
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	assert.deepEqual((await s.asAda('GET', `practice?day=${TODAY}`)).data, { minutes: 0, usedSeconds: 0 });
	assert.equal((await s.asAdmin('PUT', 'settings', { json: { dailyPracticeMinutes: 20, hardModeDefault: true } })).status, 200);
	await s.asAda('POST', 'practice', { json: { day: TODAY, seconds: 30 } });
	assert.deepEqual((await s.asAda('POST', 'practice', { json: { day: TODAY, seconds: 45 } })).data, { minutes: 20, usedSeconds: 75 });
	assert.deepEqual((await asBea('GET', `practice?day=${TODAY}`)).data, { minutes: 20, usedSeconds: 0 }, 'time is counted for the caller only');
	assert.deepEqual((await s.asAda('GET', 'settings')).data, { dailyPracticeMinutes: 20, hardModeDefault: true });

	await Promise.all(Array.from({ length: 4 }, () => s.asAda('POST', 'practice', { json: { day: TODAY, seconds: 10 } })));
	assert.equal(((await s.asAda('GET', `practice?day=${TODAY}`)).data as { usedSeconds: number }).usedSeconds, 115, 'reports that arrive together all count');

	for (const day of ['', 'yesterday', '2026-10-16', '../x']) assert.equal((await s.asAda('GET', `practice?day=${day}`)).status, 400, day);
	assert.equal((await s.asAda('GET', 'practice')).status, 400);
	for (const body of [{ day: TODAY, seconds: 0 }, { day: TODAY, seconds: MAX_SEND_SECONDS + 1 }, { day: TODAY, seconds: 1.5 }, { day: '2026-10-10', seconds: 5 }, {}]) {
		assert.equal((await s.asAda('POST', 'practice', { json: body })).status, 400, JSON.stringify(body));
	}
	assert.equal(((await s.asAda('GET', `practice?day=${TODAY}`)).data as { usedSeconds: number }).usedSeconds, 115, 'refused reports change nothing');
	assert.equal((await s.asAda('POST', 'practice', { json: { day: '2026-10-18', seconds: 60 } })).status, 200, 'a day a time zone away is allowed');
});

test('settings accept whole minutes from 0 to 240 and a true or false hard mode default, and the clock is off until set', async () => {
	const s = await setup();
	assert.deepEqual((await s.asAdmin('GET', 'settings')).data, { dailyPracticeMinutes: 0, hardModeDefault: false });
	for (const body of [{ dailyPracticeMinutes: 241 }, { dailyPracticeMinutes: -1 }, { dailyPracticeMinutes: 1.5 }, { dailyPracticeMinutes: '15' }, { dailyPracticeMinutes: 5, hardModeDefault: 'on' }, {}]) {
		assert.equal((await s.asAdmin('PUT', 'settings', { json: body })).status, 400, JSON.stringify(body));
	}
	assert.deepEqual((await s.asAdmin('PUT', 'settings', { json: { dailyPracticeMinutes: 240 } })).data, { dailyPracticeMinutes: 240, hardModeDefault: false });
	assert.deepEqual((await s.asAda('GET', 'settings')).data, { dailyPracticeMinutes: 240, hardModeDefault: false });
});

test('the admin sees each child\'s last seven days by the name they chose, with zeros for a child who did nothing', async () => {
	const s = await setup();
	const zed = await s.child('Zed');
	await s.asAdmin('PUT', 'settings', { json: { dailyPracticeMinutes: 15 } });
	await s.asAda('POST', 'practice', { json: { day: TODAY, seconds: 60 } });
	await s.asAda('POST', 'practice', { json: { day: '2026-10-18', seconds: 30 } });
	await s.as(zed.token)('POST', 'practice', { json: { day: '2026-10-12', seconds: 5 } });
	const report = (await s.asAdmin('GET', `practice?day=${TODAY}`)).data as { days: string[]; goalMinutes: number; children: { userId: string; name: string; seconds: number[]; totalSeconds: number }[] };
	assert.deepEqual(report.days, daysEndingAt(TODAY));
	assert.equal(report.goalMinutes, 15);
	assert.deepEqual(report.children.map((c) => [c.name, c.seconds, c.totalSeconds]), [['Ada', [0, 0, 0, 0, 0, 30, 60], 90], ['Zed', [0, 0, 0, 0, 0, 0, 0], 0]], 'a day outside the window is not counted');
	assert.equal(JSON.stringify(report).includes('@'), false, 'no email reaches the report');
	assert.equal((await s.asAdmin('GET', 'practice?day=bad')).status, 400);
});

const STEP = 10 * 60 * 1000;
type BoardReply = { optedIn: boolean; days?: string[]; levels?: { level: string; children: { name: string; me: boolean; points: number[]; total: number }[] }[] };
const boardOf = async (s: Setup, as = s.asAda) => (await as('GET', `board?day=${TODAY}`)).data as BoardReply;
const lineFor = (reply: BoardReply, level: string) => reply.levels?.find((l) => l.level === level)?.children.map((c) => [c.name, c.me, c.total]);

test('a child who has not switched the board on sees nothing of it and is not on anyone else\'s', async () => {
	const s = await setup();
	const { id } = await publish(s, 'Trace me');
	const bea = await s.child('Bea');
	await s.as(bea.token)('PUT', 'board/me', { json: { on: true } });
	await s.asAda('PUT', `activities/${id}/result`, { json: result(1) });
	assert.deepEqual(await boardOf(s), { optedIn: false });
	s.clock.at = new Date(NOW.getTime() + STEP);
	await s.as(bea.token)('PUT', `activities/${id}/result`, { json: result(2, { score: 60 }) });
	assert.deepEqual(await boardOf(s), { optedIn: false }, 'no names, no points');
	assert.deepEqual(lineFor(await boardOf(s, s.as(bea.token)), 'explorer'), [['Bea', true, 60]], 'Ada scored but is not on the board');
});

test('a child on the board shows only what they scored since switching it on, with the best score for each activity each day', async () => {
	const s = await setup();
	const one = await publish(s, 'One', { level: 'starter' });
	const two = await publish(s, 'Two', { level: 'champion' });
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	await s.asAda('PUT', `activities/${one.id}/result`, { json: result(1, { score: 100 }) });

	s.clock.at = new Date(NOW.getTime() + STEP);
	assert.deepEqual((await s.asAda('PUT', 'board/me', { json: { on: true } })).data, { optedIn: true });
	assert.deepEqual(await boardOf(s), { optedIn: true, days: daysEndingAt(TODAY), levels: [{ level: 'starter', children: [] }, { level: 'explorer', children: [] }, { level: 'champion', children: [] }] }, 'the score from before does not count');

	s.clock.at = new Date(NOW.getTime() + 2 * STEP);
	await s.asAda('PUT', `activities/${one.id}/result`, { json: result(2, { score: 40 }) });
	await s.asAda('PUT', `activities/${one.id}/result`, { json: result(3, { score: 70 }) });
	await s.asAda('PUT', `activities/${one.id}/result`, { json: result(4, { score: 50 }) });
	await s.asAda('PUT', `activities/${two.id}/result`, { json: result(5, { score: 50, hard: true }) });
	await asBea('PUT', 'board/me', { json: { on: true } });
	await asBea('PUT', `activities/${one.id}/result`, { json: result(6, { score: 90 }) });

	const forBea = await boardOf(s, asBea);
	assert.deepEqual(lineFor(forBea, 'starter'), [['Bea', true, 90], ['Ada', false, 70]]);
	assert.deepEqual(lineFor(forBea, 'champion'), [['Ada', false, 60]], 'hard mode earns the bonus');
	assert.deepEqual(forBea.levels?.find((l) => l.level === 'starter')?.children[1]?.points, [0, 0, 0, 0, 0, 0, 70]);
	assert.equal(JSON.stringify(forBea).includes(s.ada.userId), false, 'no user id reaches another child');
	assert.deepEqual(lineFor(await boardOf(s), 'starter'), [['Bea', false, 90], ['Ada', true, 70]]);
});

test('switching the board off removes the child at once, and switching it on again counts only from then', async () => {
	const s = await setup();
	const { id } = await publish(s, 'Trace me');
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	await asBea('PUT', 'board/me', { json: { on: true } });
	await s.asAda('PUT', 'board/me', { json: { on: true } });
	s.clock.at = new Date(NOW.getTime() + STEP);
	await s.asAda('PUT', `activities/${id}/result`, { json: result(1, { score: 80 }) });
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [['Ada', false, 80]]);

	assert.deepEqual((await s.asAda('PUT', 'board/me', { json: { on: false } })).data, { optedIn: false });
	assert.deepEqual(await boardOf(s), { optedIn: false });
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [], 'gone from the others\' board');
	assert.deepEqual((await s.asAda('PUT', 'board/me', { json: { on: false } })).data, { optedIn: false }, 'off twice is still off');

	s.clock.at = new Date(NOW.getTime() + 2 * STEP);
	await s.asAda('PUT', `activities/${id}/result`, { json: result(2, { score: 60 }) });
	s.clock.at = new Date(NOW.getTime() + 3 * STEP);
	await s.asAda('PUT', 'board/me', { json: { on: true } });
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [], 'what was scored while off never comes back');
	s.clock.at = new Date(NOW.getTime() + 4 * STEP);
	await s.asAda('PUT', `activities/${id}/result`, { json: result(3, { score: 30 }) });
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [['Ada', false, 30]]);
});

test('switching the board on twice keeps the first moment, and the board shows the name and time zone the child has now', async () => {
	const s = await setup();
	const { id } = await publish(s, 'Trace me');
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	await asBea('PUT', 'board/me', { json: { on: true } });
	await s.asAda('PUT', 'board/me', { json: { on: true } });
	s.clock.at = new Date(NOW.getTime() + STEP);
	await s.asAda('PUT', `activities/${id}/result`, { json: result(1, { score: 80 }) });
	s.clock.at = new Date(NOW.getTime() + 2 * STEP);
	await s.asAda('PUT', 'board/me', { json: { on: true } });
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [['Ada', false, 80]], 'the second switch on did not move since past the first score');

	await s.w.portal.setProfile(s.ada.userId, { displayName: 'Ada B', timeZone: 'Europe/London' }, s.w.now());
	assert.deepEqual(lineFor(await boardOf(s, s.asAda), 'explorer'), [['Ada B', true, 80]], 'her own board refreshes the name');
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [['Ada B', false, 80]]);
	const nextDay = new Date(s.w.now().getTime() + 24 * 60 * 60 * 1000);
	assert.equal(await s.w.portal.setProfile(s.ada.userId, { displayName: 'Ada B', timeZone: 'Pacific/Auckland' }, nextDay), 'ok', 'a renamed child may change time zone on a later day');
	await boardOf(s, s.asAda);
	assert.deepEqual(lineFor(await boardOf(s, asBea), 'explorer'), [], 'in Auckland that score fell on the 20th, past the window');
});

test('the board asks for a device day within a day of today and the switch for true or false', async () => {
	const s = await setup();
	assert.equal((await s.asAda('GET', 'board')).status, 400);
	assert.equal((await s.asAda('GET', 'board?day=2026-10-30')).status, 400);
	for (const json of [{}, { on: 'yes' }, { on: 1 }, null]) assert.equal((await s.asAda('PUT', 'board/me', { json })).status, 400, JSON.stringify(json));
	assert.deepEqual(await boardOf(s), { optedIn: false }, 'a bad request never switches it on');
});

test('a copy is a PNG for a trace then copy activity; each child keeps the newest three and the oldest is replaced', async () => {
	const s = await setup();
	const copy = await publish(s, 'Copy me', { mode: 'traceThenCopy' });
	const plain = await publish(s, 'Trace only');
	const draft = await publish(s, 'Draft', { mode: 'traceThenCopy', status: 'draft' });
	const send = (id: string, send: Send = { png: PNG }) => s.asAda('POST', `activities/${id}/submission`, send);
	const receipt = await send(copy.id);
	assert.equal(receipt.status, 201);
	assert.deepEqual(Object.keys(receipt.data as object).sort(), ['createdAt', 'id']);
	assert.equal((await send(plain.id)).status, 409);
	assert.equal((await send(draft.id)).status, 404);
	assert.equal((await send('nope')).status, 404);
	assert.equal((await send(copy.id, { png: PNG, headers: { 'content-type': 'image/jpeg' } })).status, 415);
	assert.equal((await send(copy.id, { png: PNG.subarray(0, 20) })).status, 400, 'a body with a PNG signature and no image is refused');
	assert.equal((await send(copy.id, { png: new Uint8Array(MAX_IMAGE_BYTES + 100).fill(0).map((_, i) => PNG[i] ?? 0) })).status, 413);

	for (let again = 0; again < KEEP_PER_ACTIVITY + 2; again++) await send(copy.id);
	const bea = await s.child('Bea');
	await s.as(bea.token)('POST', `activities/${copy.id}/submission`, { png: PNG });
	const shown = (await s.asAdmin('GET', 'submissions')).data as { submissions: { userName: string; id: string }[] };
	assert.deepEqual(shown.submissions.map((x) => x.userName).sort(), ['Ada', 'Ada', 'Ada', 'Bea'], `${KEEP_PER_ACTIVITY} for Ada, one for Bea`);
	const blobs = await s.account.container('submissions').list('');
	assert.equal(blobs.length, KEEP_PER_ACTIVITY + 1, 'a replaced copy takes its image with it');
});

test('the admin lists copies by child and activity with a page cursor, reviews them with a note, and discards one without touching the player\'s data', async () => {
	const s = await setup();
	const a = await publish(s, 'A', { mode: 'traceThenCopy' });
	const b = await publish(s, 'B', { mode: 'traceThenCopy' });
	const bea = await s.child('Bea');
	const ids: string[] = [];
	for (const [who, act] of [[s.asAda, a], [s.as(bea.token), a], [s.asAda, b]] as const) {
		const made = await who('POST', `activities/${act.id}/submission`, { png: PNG });
		ids.push((made.data as { id: string }).id);
	}
	type Page = { submissions: { id: string; userName: string; reviewed: boolean; note: string; bytes: number }[]; next: string | null };
	const list = async (query = '') => (await s.asAdmin('GET', `submissions${query}`)).data as Page;

	const first = await list('?limit=2');
	assert.equal(first.submissions.length, 2);
	assert.ok(first.next);
	const second = await list(`?limit=2&after=${first.next}`);
	assert.equal(second.next, null);
	assert.equal(new Set([...first.submissions, ...second.submissions].map((x) => x.id)).size, 3, 'the pages cover every copy once');
	assert.equal((await list(`?userId=${bea.userId}`)).submissions.length, 1);
	assert.equal((await list(`?activityId=${a.id}`)).submissions.length, 2);
	assert.equal((await s.asAdmin('GET', 'submissions?limit=51')).status, 400);
	assert.equal((await s.asAdmin('GET', 'submissions?userId=amy@example.com')).status, 400);

	const target = ids[0] ?? '';
	const image = await s.asAdmin('GET', `submissions/${target}/image`);
	assert.deepEqual(image.body, PNG);
	assert.equal(image.headers['content-type'], 'image/png');
	assert.match(image.headers['cache-control'] ?? '', /no-store/);

	const reviewed = (await s.asAdmin('PATCH', `submissions/${target}`, { json: { reviewed: true, note: ' Neat. ' } })).data as { reviewed: boolean; reviewedBy: string; reviewedAt: string; note: string };
	assert.deepEqual([reviewed.reviewed, reviewed.note, reviewed.reviewedBy === s.adminId, reviewed.reviewedAt], [true, 'Neat.', true, NOW.toISOString()]);
	assert.equal((await s.asAdmin('PATCH', `submissions/${target}`, { json: { reviewed: 'yes' } })).status, 400);
	assert.equal((await list('?unreviewed=true')).submissions.length, 2);

	assert.equal((await s.asAdmin('DELETE', `submissions/${target}`)).status, 204);
	assert.equal((await s.asAdmin('DELETE', `submissions/${target}`)).status, 204);
	assert.equal((await s.asAdmin('DELETE', 'submissions/not-a-guid')).status, 204);
	assert.equal((await list()).submissions.length, 2, 'a discarded copy leaves the review list');
	assert.equal((await s.asAdmin('GET', `submissions/${target}/image`)).status, 404);
	assert.equal((await s.asAdmin('PATCH', `submissions/${target}`, { json: { reviewed: true } })).status, 404);
	const stillStored = await s.account.table('submissions').inPartition('all');
	assert.equal(stillStored.length, 3, 'the player\'s own table still holds it');
	assert.equal((await s.account.container('submissions').list('')).length, 3);
	assert.deepEqual(await s.account.table('reviews').get('review', target).then((row) => row?.['discarded']), true);
});

test('handwriting is read by the vision service with the platform token, and every failure says what it is', async () => {
	const s = await setup();
	vision.say([{ text: 'The' }, { text: 'cat', confidence: 0.5 }]);
	const read = await s.asAda('POST', 'read', { png: PNG.subarray(0, 20) });
	assert.equal(read.status, 400, 'a PNG signature is not enough');
	const image = makePng();
	const found = await s.asAda('POST', 'read', { png: image });
	assert.equal(found.status, 200);
	assert.deepEqual((found.data as { words: { text: string; confidence: number }[] }).words.map((w) => [w.text, w.confidence]), [['The', 0.99], ['cat', 0.5]]);
	const lastCall = vision.calls.at(-1);
	assert.deepEqual([lastCall?.token, lastCall?.bytes], ['tok-cognitiveServices', image.length]);
	assert.equal((await s.asAda('POST', 'read', { png: image, headers: { 'content-type': 'image/jpeg' } })).status, 415);

	vision.failNext(1, 503);
	const outage = await s.asAda('POST', 'read', { png: image });
	assert.deepEqual([outage.status, codeOf(outage)], [502, 'reader_unavailable']);
	vision.failNext(1, 401);
	const refused = await s.asAda('POST', 'read', { png: image });
	assert.equal(refused.status, 500, 'a request the service refuses as wrong is not an outage');
	assert.equal(s.exceptions.length, 2, 'the outage and the refusal are both faults to look into');

	const off = await setup({});
	const none = await off.asAda('POST', 'read', { png: image });
	assert.deepEqual([none.status, codeOf(none)], [503, 'reader_off']);
});

test('the admin app reads the children from the roster, with names only', async () => {
	const s = await setup();
	await s.child('Zed');
	await seedPlayer(s.w, idp, { games: [letterjoin], profile: null });
	await seedPlayer(s.w, idp, { games: [], profile: { displayName: 'Elsewhere', timeZone: 'UTC' } });
	const children = ((await s.asAdmin('GET', 'children')).data as { children: { userId: string; name: string }[] }).children;
	assert.deepEqual(children.map((c) => c.name).sort(), ['Ada', 'No name yet', 'Zed']);
	assert.equal(JSON.stringify(children).includes('@'), false);
});

test('a submission id is a version 7 GUID that carries its creation time, and newer sort first', () => {
	const at = new Date('2026-03-01T10:00:00.000Z');
	const id = submissionId(at);
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(id.slice(0, 13).replace('-', ''), at.getTime().toString(16).padStart(12, '0'));
	assert.notEqual(submissionId(at), id);
	const ids = [0, 1, 1000, 86_400_000].map((ms) => submissionId(new Date(at.getTime() + ms)));
	assert.deepEqual([...ids].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1)), [...ids].reverse());
});

test('only bytes that start with the PNG signature and IHDR count as a PNG', () => {
	assert.equal(isPng(PNG), true);
	assert.equal(isPng(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(64))), false);
	assert.equal(isPng(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array(60).fill(0)])), false);
	const noHeader = PNG.slice();
	noHeader[12] = 0x78;
	assert.equal(isPng(noHeader), false);
	assert.equal(isPng(PNG.subarray(0, 20)), false);
	assert.equal(isPng(new Uint8Array(0)), false);
});

test('a review needs reviewed true or false and a short plain note, and stamps who and when only when reviewed changes', () => {
	assert.deepEqual(parseReviewInput({ reviewed: false, note: '  Good k.\r\nTry again. ' }), { ok: true, value: { reviewed: false, note: 'Good k.\nTry again.' } });
	for (const [body, why] of [[{}, /reviewed/], [{ reviewed: true, note: 5 }, /note must be text/], [{ reviewed: true, note: 'x'.repeat(NOTE_MAX + 1) }, /at most 500/], [{ reviewed: true, note: 'tab\there' }, /plain text/]] as const) {
		const parsed = parseReviewInput(body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.ok ? '' : parsed.problems.join('\n'), why);
	}
	const later = new Date('2026-03-02T00:00:00.000Z');
	const done = applyReview(NOT_REVIEWED, { reviewed: true, note: 'Neat.' }, 'admin-1', later);
	assert.deepEqual(done, { reviewed: true, discarded: false, reviewedBy: 'admin-1', reviewedAt: later.toISOString(), note: 'Neat.' });
	assert.deepEqual(applyReview(done, { reviewed: true }, 'admin-2', new Date('2026-03-03T00:00:00.000Z')), done, 'the same review twice changes nothing');
	assert.deepEqual(applyReview(done, { reviewed: false }, 'admin-2', later), { reviewed: false, discarded: false, note: 'Neat.' });
});

test('list queries accept known filters with bounds and reject anything else', () => {
	const query = (text: string) => parseSubmissionQuery(new URLSearchParams(text));
	const id = '5eed0000-0000-4000-8000-00000000000a';
	const cursor = sortKey(submissionId(new Date('2026-03-01T10:00:00.000Z')));
	assert.deepEqual(query(''), { ok: true, value: { limit: PAGE_DEFAULT } });
	assert.deepEqual(query(`userId=${id.toUpperCase()}&activityId=${id}&unreviewed=true&limit=5&after=${cursor}`), { ok: true, value: { limit: 5, userId: id, activityId: id, unreviewed: true, after: cursor } });
	assert.deepEqual(query('unreviewed=false&userId='), { ok: true, value: { limit: PAGE_DEFAULT } });
	for (const bad of ['userId=nope', 'activityId=x', 'unreviewed=1', 'limit=51', 'limit=0', 'after=PartitionKey']) assert.equal(query(bad).ok, false, bad);
});

test('days a time zone away from the server\'s UTC date are allowed, two days away are not, and the report window is seven days', () => {
	const now = new Date('2026-12-31T23:30:00Z');
	assert.equal(parseDay('2027-01-01', now), '2027-01-01');
	assert.equal(parseDay('2026-12-30', now), '2026-12-30');
	assert.equal(parseDay('2027-01-02', now), null);
	assert.equal(parseDay('2026-12-29', now), null);
	assert.equal(parseDay('2026-02-29', new Date('2026-03-01T00:00:00Z')), null, 'not a real date');
	assert.deepEqual(daysEndingAt('2026-03-02'), ['2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
	assert.deepEqual(daysEndingAt('2028-03-01', 2), ['2028-02-29', '2028-03-01']);
});

test('the report sorts children by name, counts only the days in its window and gives a child who did nothing a row of zeros', () => {
	const days = daysEndingAt('2026-10-17');
	const report = buildReport({
		days,
		goalMinutes: 15,
		children: [
			{ userId: 'z', name: 'Zed', rows: [] },
			{ userId: 'a', name: 'Amy', rows: [{ day: '2026-10-17', seconds: 900 }, { day: '2026-10-15', seconds: 120 }, { day: '2026-09-01', seconds: 5000 }] },
		],
	});
	assert.deepEqual(report.children.map((c) => c.name), ['Amy', 'Zed']);
	assert.deepEqual(report.children[0]?.seconds, [0, 0, 0, 0, 120, 0, 900]);
	assert.equal(report.children[0]?.totalSeconds, 1020);
	assert.deepEqual(report.children[1], { userId: 'z', name: 'Zed', seconds: [0, 0, 0, 0, 0, 0, 0], totalSeconds: 0 });
	assert.deepEqual(buildReport({ days, children: [], goalMinutes: 0 }).children, []);
});
