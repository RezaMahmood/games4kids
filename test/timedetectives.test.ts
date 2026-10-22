import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPlayerApp, storageFor } from '@g4k/host';
import type { RoundContent } from '../games/timedetectives/data/content.ts';
import { topicId, roundId, type RoundId, type TopicId } from '../games/timedetectives/data/ids.ts';
import type { RoundState } from '../games/timedetectives/data/round.ts';
import { adminStore } from '../games/timedetectives/data/stores.ts';
import manifest from '../games/timedetectives/manifest.ts';
import { createPlayApi } from '../games/timedetectives/play/api/index.ts';
import { call, codeOf, PNG, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { NOW, seedPlayer, world } from './support/world.ts';
import { ROUND } from './timedetectives/lindisfarne.ts';

const idp = await fakeIdp();
const timedetectives = gameId('timedetectives');
const TODAY = NOW.toISOString().slice(0, 10);

type View = { id: string; confidence: string; paragraph: string; pictureAlt: string; questions: { kind: string; label: string; choices: string[]; answer: string; hint: string }[] };
type Saved = { points: number; right: Record<string, boolean>; total: number };

const perfect = [
	{ kind: 'who', tries: ['Vikings'], hint: false },
	{ kind: 'where', tries: ['Lindisfarne'], hint: false },
	{ kind: 'when', tries: ['AD 793'], hint: false },
];
const mixed = [
	{ kind: 'who', tries: ['Romans', 'Vikings'], hint: false },
	{ kind: 'where', tries: ['Lindisfarne'], hint: true },
	{ kind: 'when', tries: ['AD 793'], hint: false },
];

async function setup() {
	const w = world();
	const clock = { at: NOW };
	const tokens = async (service: string) => `tok-${service}`;
	const player = createPlayerApp({ telemetry: w.telemetry, now: () => clock.at, issuers: [idp.games], manifest, create: createPlayApi, portal: w.reader, accounts: w.accounts, tokens, env: {} });
	const store = adminStore(storageFor(manifest, 'admin', w.accounts.open(timedetectives)));
	const child = (displayName: string, timeZone = 'Europe/London') => seedPlayer(w, idp, { games: [timedetectives], profile: { displayName, timeZone } });
	const as = (token: string) => (method: string, path: string, send: Send = {}) => call(player, method, `/api/g/timedetectives/${path}`, { token, ...send });
	const ada = await child('Ada');

	async function topic(title: string, order = 0): Promise<TopicId> {
		const id = topicId(randomUUID());
		assert.ok(id);
		await store.createTopic({ id, title, guidance: '', order });
		return id;
	}

	async function round(topicOf: TopicId, state: RoundState = published(), hasPicture = true): Promise<RoundId> {
		const id = roundId(randomUUID());
		assert.ok(id);
		await store.createRound({ id, topicId: topicOf, state, hasPicture, updatedAt: NOW.toISOString() });
		if (hasPicture) await store.putPicture(id, PNG, 'image/png');
		return id;
	}

	return { w, clock, store, child, as, asAda: as(ada.token), ada, topic, round, exceptions: w.telemetry.exceptions };
}

const published = (content: RoundContent = ROUND): RoundState => ({ kind: 'published', content, source: 'ai', publishedAt: NOW.toISOString() });
const attemptId = () => randomUUID();

test('a child sees only topics with a published round, in order, and never a draft, a failed or a drafting round', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings', 1);
	const egypt = await s.topic('Egyptians', 0);
	const greeks = await s.topic('Ancient Greeks', 2);
	await s.round(vikings);
	await s.round(egypt);
	const draft = await s.round(greeks, { kind: 'draft', content: ROUND, source: 'human' });
	const failed = await s.round(greeks, { kind: 'failed', focus: '', source: 'ai', reason: 'refused', content: ROUND });
	await s.round(greeks, { kind: 'drafting', focus: 'Olympia', source: 'ai' }, false);

	const topics = (await s.asAda('GET', 'topics')).data as { topics: { id: string; title: string }[] };
	assert.deepEqual(topics.topics, [{ id: egypt, title: 'Egyptians' }, { id: vikings, title: 'Vikings' }]);
	const none = await s.asAda('GET', `topics/${greeks}/next?confidence=bit`);
	assert.equal(none.status, 404);
	assert.equal(codeOf(none), 'no_rounds');
	for (const id of [draft, failed]) {
		assert.equal((await s.asAda('GET', `rounds/${id}/picture`)).status, 404);
		assert.equal((await s.asAda('PUT', `rounds/${id}/attempts/${attemptId()}`, { json: { confidence: 'bit', answers: perfect } })).status, 404);
	}
	assert.equal((await s.asAda('GET', 'rounds/not-a-guid/picture')).status, 404);
});

test('the round a child gets has the paragraph and the choices their confidence asks for, with the answers for instant marking', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings');
	const id = await s.round(vikings);
	const view = async (confidence: string) => (await s.asAda('GET', `topics/${vikings}/next?confidence=${confidence}`)).data as View;

	const sure = await view('lots');
	assert.deepEqual({ id: sure.id, paragraph: sure.paragraph, pictureAlt: sure.pictureAlt }, { id, paragraph: ROUND.brief, pictureAlt: ROUND.pictureAlt });
	assert.deepEqual(sure.questions.map((q) => [q.kind, q.label, q.choices.length]), [['who', 'Who is it?', 4], ['where', 'Where is it?', 4], ['when', 'When was it?', 4]]);
	assert.equal((await view('bit')).paragraph, ROUND.full);
	const easy = await view('easy');
	assert.equal(easy.paragraph, ROUND.full);
	assert.deepEqual(easy.questions[0], { kind: 'who', label: 'Who is it?', choices: ['Vikings', 'Romans', 'Normans'], answer: 'Vikings', hint: ROUND.questions[0]?.hint });
	assert.equal(JSON.stringify(easy).includes(ROUND.title), false, 'the admin\'s title stays with the admin');

	for (const bad of ['', 'confidence=sure']) assert.equal((await s.asAda('GET', `topics/${vikings}/next?${bad}`)).status, 400);
});

test('the next round is one the child has not played yet, until they have played them all', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings');
	const first = await s.round(vikings);
	const second = await s.round(vikings, published({ ...ROUND, title: 'Again' }));
	const next = async () => ((await s.asAda('GET', `topics/${vikings}/next?confidence=bit`)).data as View).id;

	assert.equal((await s.asAda('PUT', `rounds/${first}/attempts/${attemptId()}`, { json: { confidence: 'bit', answers: perfect } })).status, 200);
	for (let n = 0; n < 8; n++) assert.equal(await next(), second);
	await s.asAda('PUT', `rounds/${second}/attempts/${attemptId()}`, { json: { confidence: 'bit', answers: perfect } });
	const seen = new Set<string>();
	for (let n = 0; n < 30; n++) seen.add(await next());
	assert.deepEqual([...seen].sort(), [first, second].sort(), 'once every round is played, any of them comes up');
});

test('a round\'s picture comes with an ETag the page revalidates', async () => {
	const s = await setup();
	const id = await s.round(await s.topic('Vikings'));
	const picture = await s.asAda('GET', `rounds/${id}/picture`);
	assert.equal(picture.status, 200);
	assert.equal(picture.headers['content-type'], 'image/png');
	assert.equal(picture.headers['cache-control'], 'private, no-cache');
	assert.deepEqual(picture.body, PNG);
	assert.equal((await s.asAda('GET', `rounds/${id}/picture`, { headers: { 'if-none-match': picture.headers['etag'] ?? '' } })).status, 304);
});

test('the server marks the whole round again, saves it once per attemptId, and says what the child has scored today', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings');
	const first = await s.round(vikings);
	const second = await s.round(vikings);
	const put = (id: RoundId, attempt: string, body: unknown) => s.asAda('PUT', `rounds/${id}/attempts/${attempt}`, { json: body });

	const once = attemptId();
	const saved = await put(first, once, { confidence: 'bit', answers: mixed });
	assert.equal(saved.status, 200);
	assert.deepEqual(saved.data, { points: 26, right: { who: true, where: true, when: true }, total: 26 });
	assert.deepEqual((await put(first, once, { confidence: 'lots', answers: perfect })).data, { points: 26, right: { who: true, where: true, when: true }, total: 26 }, 'a repeat keeps the points saved first');
	assert.equal(((await put(first, attemptId(), { confidence: 'easy', answers: perfect })).data as Saved).total, 30, 'only the best go at a round counts on a day');
	assert.equal(((await put(second, attemptId(), { confidence: 'lots', answers: perfect })).data as Saved).total, 75);

	s.clock.at = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
	assert.equal(((await put(second, attemptId(), { confidence: 'easy', answers: mixed })).data as Saved).total, 22, 'a new day starts from nothing');
	assert.deepEqual(s.exceptions, []);
});

test('a log that breaks the rules of play, or is not a log at all, is refused and saves nothing', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings');
	const id = await s.round(vikings);
	const put = (attempt: string, body: unknown) => s.asAda('PUT', `rounds/${id}/attempts/${attempt}`, { json: body });
	const thirdDecoy = [{ kind: 'who', tries: ['Ancient Egyptians', 'Vikings'], hint: false }, ...perfect.slice(1)];
	for (const [attempt, body] of [
		[attemptId(), { confidence: 'easy', answers: thirdDecoy }],
		[attemptId(), { confidence: 'bit', answers: perfect.slice(1) }],
		[attemptId(), { confidence: 'bit', answers: [{ kind: 'who', tries: ['Romans'], hint: false }, ...perfect.slice(1)] }],
		[attemptId(), { confidence: 'sure', answers: perfect }],
		[attemptId(), null],
		['not-a-guid', { confidence: 'bit', answers: perfect }],
	] as const) assert.equal((await put(attempt, body)).status, 400, JSON.stringify(body));
	const view = (await s.asAda('GET', `topics/${vikings}/next?confidence=bit`)).data as View;
	assert.equal(view.id, id, 'the round still counts as unplayed');
	assert.equal(((await put(attemptId(), { confidence: 'bit', answers: thirdDecoy })).data as Saved).points, 30);
});

test('a child who switches the board on sees each child on it by name, from the moment they switched it on, and never a user id', async () => {
	const s = await setup();
	const id = await s.round(await s.topic('Vikings'));
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	const play = (as: typeof asBea, answers = perfect) => as('PUT', `rounds/${id}/attempts/${attemptId()}`, { json: { confidence: 'easy', answers } });

	await play(s.asAda);
	assert.deepEqual((await s.asAda('GET', `board?day=${TODAY}`)).data, { optedIn: false });
	assert.deepEqual((await s.asAda('GET', 'board/me')).data, { optedIn: false });
	s.clock.at = new Date(NOW.getTime() + 60_000);
	assert.deepEqual((await s.asAda('PUT', 'board/me', { json: { on: true } })).data, { optedIn: true });
	await asBea('PUT', 'board/me', { json: { on: true } });
	s.clock.at = new Date(NOW.getTime() + 120_000);
	await play(asBea, mixed);

	const board = (await s.asAda('GET', `board?day=${TODAY}`)).data as { optedIn: boolean; days: string[]; children: { name: string; me: boolean; points: number[]; total: number }[] };
	assert.equal(board.days.at(-1), TODAY);
	assert.deepEqual(board.children.map(({ name, me, total }) => [name, me, total]), [['Bea', false, 22]], 'Ada\'s round before she switched it on does not count');
	assert.equal(JSON.stringify(board).includes(bea.userId), false);
	assert.equal(JSON.stringify(board).includes('userId'), false);

	await play(s.asAda);
	const later = (await asBea('GET', `board?day=${TODAY}`)).data as typeof board;
	assert.deepEqual(later.children.map(({ name, me, total }) => [name, me, total]), [['Ada', false, 30], ['Bea', true, 22]]);
	await s.asAda('PUT', 'board/me', { json: { on: false } });
	assert.deepEqual(((await asBea('GET', `board?day=${TODAY}`)).data as typeof board).children.map((line) => line.name), ['Bea']);
	assert.equal((await s.asAda('GET', 'board?day=2020-01-01')).status, 400);
	assert.equal((await s.asAda('PUT', 'board/me', { json: { on: 'yes' } })).status, 400);
});
