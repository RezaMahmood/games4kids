import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { adminModule, createAdminApp, createPlayerApp, storageFor, type App, type Env } from '@g4k/host';
import { deliverQueues, MAX_DEQUEUE_COUNT } from '@g4k/host/node';
import { startFakeFoundry, VIKING_ROUND } from '../dev/fake-foundry.ts';
import { REFUSED } from '../games/timedetectives/admin/api/foundry.ts';
import { createAdminApi } from '../games/timedetectives/admin/api/index.ts';
import { MAX_ATTEMPTS } from '../games/timedetectives/admin/api/worker.ts';
import type { RoundContent } from '../games/timedetectives/data/content.ts';
import { topicId, roundId, type RoundId, type TopicId } from '../games/timedetectives/data/ids.ts';
import type { RoundState } from '../games/timedetectives/data/round.ts';
import { adminStore } from '../games/timedetectives/data/stores.ts';
import manifest from '../games/timedetectives/manifest.ts';
import { createPlayApi } from '../games/timedetectives/play/api/index.ts';
import { fakeGraph } from './support/graph.ts';
import { call, codeOf, JPEG, PNG, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world } from './support/world.ts';
import { ROUND } from './timedetectives/lindisfarne.ts';

const idp = await fakeIdp();
const foundry = await startFakeFoundry();
after(() => foundry.close());
const timedetectives = gameId('timedetectives');
const TODAY = NOW.toISOString().slice(0, 10);

type View = { id: string; confidence: string; paragraph: string; pictureAlt: string; questions: { kind: string; label: string; choices: string[]; answer: string; hint: string }[] };
type Saved = { points: number; right: Record<string, boolean>; total: number };
type AdminRound = { id: string; topicId: string; state: RoundState; hasPicture: boolean; etag: string };

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

async function setup(env: Env = { TIMEDETECTIVES_FOUNDRY_ENDPOINT: foundry.origin }) {
	const w = world();
	const apps: App[] = [];
	const accounts = deliverQueues(w.accounts, () => apps);
	const clock = { at: NOW };
	const logs: string[] = [];
	const telemetry = { ...w.telemetry, log: (_level: string, line: string) => void logs.push(line) };
	const tokens = async (service: string) => `tok-${service}`;
	const common = { telemetry, now: () => clock.at, accounts, tokens };
	const player = createPlayerApp({ ...common, issuers: [idp.games], manifest, create: createPlayApi, portal: w.reader, env: {} });
	const admin = createAdminApp({
		...common,
		issuer: idp.admin,
		store: w.admin,
		graph: () => fakeGraph().graph,
		games: [timedetectives],
		modules: [adminModule(manifest, createAdminApi)],
		env,
		gamesOrigin: 'https://games.example',
	});
	apps.push(player, admin);
	const adminObjectId = newObjectId();
	await seedAdmin(w, adminObjectId);
	const adminToken = await idp.adminToken(adminObjectId);
	const store = adminStore(storageFor(manifest, 'admin', w.accounts.open(timedetectives)));
	const child = (displayName: string, timeZone = 'Europe/London') => seedPlayer(w, idp, { games: [timedetectives], profile: { displayName, timeZone } });
	const as = (token: string) => (method: string, path: string, send: Send = {}) => call(player, method, `/api/g/timedetectives/${path}`, { token, ...send });
	const asAdmin = (method: string, path: string, send: Send = {}) => call(admin, method, `/api/admin/g/timedetectives/${path}`, { token: adminToken, ...send });
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

	const adminRound = async (id: string) => (await asAdmin('GET', `rounds/${id}`)).data as AdminRound;
	return { w, clock, store, child, as, asAda: as(ada.token), asAdmin, adminRound, ada, topic, round, settled: () => accounts.idle(), queue: accounts.open(timedetectives).queue('drafts'), rows: w.accounts.open(timedetectives).table('rounds'), logs, exceptions: w.telemetry.exceptions };
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

const callsSince = (before: number) => foundry.calls.slice(before).map((entry) => `${entry.path} ${entry.model}`);
const CHAT = 'chat/completions gpt-5.4-mini';
const IMAGE = 'images/generations gpt-image-1-mini';

async function adminTopic(s: Awaited<ReturnType<typeof setup>>, title = 'Vikings'): Promise<string> {
	const made = await s.asAdmin('POST', 'topics', { json: { title, guidance: 'Raids, longships and settlers.' } });
	assert.equal(made.status, 201, JSON.stringify(made.data));
	return (made.data as { id: string }).id;
}

async function drafted(s: Awaited<ReturnType<typeof setup>>, topic: string, focus = 'Lindisfarne'): Promise<AdminRound> {
	const queued = await s.asAdmin('POST', `topics/${topic}/rounds/draft`, { json: { focus } });
	assert.equal(queued.status, 202, JSON.stringify(queued.data));
	await s.settled();
	return s.adminRound((queued.data as AdminRound).id);
}

test('an admin drafts a round with AI through the worker, with the platform token, and children see it only once published', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const before = foundry.calls.length;
	const queued = await s.asAdmin('POST', `topics/${topic}/rounds/draft`, { json: { focus: '  Lindisfarne ' } });
	assert.deepEqual((queued.data as AdminRound).state, { kind: 'drafting', focus: 'Lindisfarne', source: 'ai' });
	await s.settled();

	const round = await s.adminRound((queued.data as AdminRound).id);
	assert.deepEqual(round.state, { kind: 'draft', content: ROUND, source: 'ai' });
	assert.equal(round.hasPicture, true);
	assert.deepEqual(callsSince(before), [CHAT, IMAGE]);
	assert.ok(foundry.calls.slice(before).every((entry) => entry.token === 'tok-cognitiveServices'));
	const picture = await s.asAdmin('GET', `rounds/${round.id}/picture`);
	assert.equal(picture.headers['content-type'], 'image/png');
	assert.deepEqual([...(picture.body as Uint8Array).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
	assert.deepEqual(((await s.asAdmin('GET', 'topics')).data as { topics: { title: string; rounds: number; published: number }[] }).topics.map(({ title, rounds, published }) => [title, rounds, published]), [['Vikings', 1, 0]]);

	assert.deepEqual((await s.asAda('GET', 'topics')).data, { topics: [] });
	assert.equal((await s.asAda('GET', `rounds/${round.id}/picture`)).status, 404);
	assert.equal((await s.asAdmin('POST', `rounds/${round.id}/publish`)).status, 200);
	assert.deepEqual(((await s.asAda('GET', 'topics')).data as { topics: { title: string }[] }).topics.map((t) => t.title), ['Vikings']);
	assert.equal(((await s.asAda('GET', `topics/${topic}/next?confidence=easy`)).data as View).id, round.id);
	assert.deepEqual(s.exceptions, []);
});

test('a refusal fails the round at once with a reason, and trying again only draws what is missing', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	let before = foundry.calls.length;
	foundry.refuseNext(1);
	const failed = await drafted(s, topic);
	assert.deepEqual(failed.state, { kind: 'failed', focus: 'Lindisfarne', source: 'ai', reason: REFUSED, content: ROUND });
	assert.equal(failed.hasPicture, false);
	assert.deepEqual(callsSince(before), [CHAT, IMAGE], 'a refusal is not retried');
	assert.equal((await s.asAdmin('POST', `rounds/${failed.id}/publish`)).status, 409);

	before = foundry.calls.length;
	assert.equal((await s.asAdmin('POST', `rounds/${failed.id}/retry`)).status, 202);
	await s.settled();
	assert.equal((await s.adminRound(failed.id)).state.kind, 'draft');
	assert.deepEqual(callsSince(before), [IMAGE], 'the words were not paid for twice');
	assert.equal((await s.asAdmin('POST', `rounds/${failed.id}/retry`)).status, 409, 'only a failed round is retried');
});

test('a refusal of the words fails the round at once without drawing, and the failed round can be deleted', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const before = foundry.calls.length;
	foundry.refuseNext(1, 'chat');
	const failed = await drafted(s, topic);
	assert.deepEqual(failed.state, { kind: 'failed', focus: 'Lindisfarne', source: 'ai', reason: REFUSED });
	assert.deepEqual(callsSince(before), [CHAT], 'a refusal is not retried, and nothing is drawn');
	assert.equal((await s.asAdmin('DELETE', `rounds/${failed.id}`)).status, 204);
	assert.equal((await s.asAdmin('GET', `rounds/${failed.id}`)).status, 404);
	assert.equal((await s.asAdmin('DELETE', `topics/${topic}`)).status, 204);
});

test('words the AI never answers with fail the round after the last attempt', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const before = foundry.calls.length;
	foundry.failNext(MAX_ATTEMPTS, 503, 'chat');
	const failed = await drafted(s, topic);
	assert.equal(failed.state.kind, 'failed');
	assert.match((failed.state as { reason: string }).reason, /^The AI did not answer after 3 tries/);
	assert.deepEqual(callsSince(before), [CHAT, CHAT, CHAT]);
});

test('any other failure is tried again from the step it stopped at, until the last attempt fails the round', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	let before = foundry.calls.length;
	foundry.failNext(1);
	assert.equal((await drafted(s, topic)).state.kind, 'draft');
	assert.deepEqual(callsSince(before), [CHAT, IMAGE, IMAGE]);

	before = foundry.calls.length;
	foundry.failNext(MAX_ATTEMPTS);
	const doomed = await drafted(s, topic);
	assert.equal(doomed.state.kind, 'failed');
	assert.match((doomed.state as { reason: string }).reason, /^The AI did not answer after 3 tries/);
	assert.deepEqual(callsSince(before), [CHAT, IMAGE, IMAGE, IMAGE]);
});

test('an answer that is not a usable round is asked for once more, then fails the round without drawing it', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const twoQuestions = { ...VIKING_ROUND, questions: VIKING_ROUND.questions.slice(0, 2) };
	let before = foundry.calls.length;
	foundry.answerNextRounds(twoQuestions);
	assert.equal((await drafted(s, topic)).state.kind, 'draft');
	assert.deepEqual(callsSince(before), [CHAT, CHAT, IMAGE]);

	before = foundry.calls.length;
	foundry.answerNextRounds(twoQuestions, { ...VIKING_ROUND, picturePrompt: ' ' });
	const failed = await drafted(s, topic);
	assert.equal(failed.state.kind, 'failed');
	assert.match((failed.state as { reason: string }).reason, /not usable: picturePrompt must not be empty/);
	assert.deepEqual(callsSince(before), [CHAT, CHAT]);
});

test('a round written by hand needs a picture to publish, stays published through an edit, and refuses a stale edit', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const made = await s.asAdmin('POST', `topics/${topic}/rounds`, { json: { content: VIKING_ROUND } });
	assert.equal(made.status, 201);
	const round = made.data as AdminRound;
	assert.deepEqual([round.state.kind, round.hasPicture], ['draft', false]);
	const unready = await s.asAdmin('POST', `rounds/${round.id}/publish`);
	assert.equal(unready.status, 409);
	assert.equal(codeOf(unready), 'not_ready');

	const uploaded = await s.asAdmin('POST', `rounds/${round.id}/picture/jpeg`, { jpeg: JPEG });
	assert.equal((uploaded.data as AdminRound).hasPicture, true);
	assert.equal((await s.asAdmin('GET', `rounds/${round.id}/picture`)).headers['content-type'], 'image/jpeg');
	assert.equal((await s.asAdmin('POST', `rounds/${round.id}/picture/png`, { jpeg: JPEG })).status, 415);
	const live = (await s.asAdmin('POST', `rounds/${round.id}/publish`)).data as AdminRound;
	assert.equal(live.state.kind, 'published');
	assert.equal((await s.asAda('GET', `rounds/${round.id}/picture`)).headers['content-type'], 'image/jpeg');

	const edit = (etag: string, content: unknown = { ...VIKING_ROUND, brief: 'A new beginning.' }) => s.asAdmin('PUT', `rounds/${round.id}`, { json: { content, etag } });
	const edited = await edit(live.etag);
	assert.equal(edited.status, 200);
	assert.deepEqual([(edited.data as AdminRound).state.kind, (edited.data as { state: { source: string } }).state.source], ['published', 'human']);
	assert.equal(((await s.asAda('GET', `topics/${topic}/next?confidence=lots`)).data as View).paragraph, 'A new beginning.');
	const stale = await edit(live.etag);
	assert.equal(stale.status, 412);
	assert.equal(codeOf(stale), 'changed');
	assert.equal((await edit((edited.data as AdminRound).etag, { ...VIKING_ROUND, questions: [] })).status, 400);
	assert.equal((await edit('')).status, 400);

	assert.equal(((await s.asAdmin('POST', `rounds/${round.id}/unpublish`)).data as AdminRound).state.kind, 'draft');
	assert.deepEqual((await s.asAda('GET', 'topics')).data, { topics: [] });
	assert.equal((await s.asAda('GET', `rounds/${round.id}/picture`)).status, 404);
});

test('a redraw keeps the words, takes the round away from children while it works, and draws only a picture', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const round = await drafted(s, topic);
	await s.asAdmin('POST', `rounds/${round.id}/publish`);
	const before = foundry.calls.length;
	const hold = foundry.holdNext();
	const redraw = await s.asAdmin('POST', `rounds/${round.id}/redraw`);
	assert.equal(redraw.status, 202);
	await hold.arrived;
	assert.deepEqual((await s.adminRound(round.id)).state, { kind: 'drafting', focus: '', source: 'ai', content: ROUND });
	assert.deepEqual((await s.asAda('GET', 'topics')).data, { topics: [] });
	const busy = await s.asAdmin('PUT', `rounds/${round.id}`, { json: { content: VIKING_ROUND, etag: (redraw.data as AdminRound).etag } });
	assert.equal(busy.status, 409);
	assert.equal((await s.asAdmin('POST', `rounds/${round.id}/picture/png`, { png: PNG })).status, 409);
	hold.release();
	await s.settled();
	const redrawn = await s.adminRound(round.id);
	assert.deepEqual([redrawn.state.kind, redrawn.hasPicture], ['draft', true]);
	assert.deepEqual(callsSince(before), [IMAGE]);
});

test('a round deleted while its picture is drawn leaves no row and no picture behind', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	const hold = foundry.holdNext();
	const queued = (await s.asAdmin('POST', `topics/${topic}/rounds/draft`, { json: {} })).data as AdminRound;
	await hold.arrived;
	assert.equal((await s.asAdmin('DELETE', `rounds/${queued.id}`)).status, 204);
	hold.release();
	await s.settled();
	assert.equal((await s.asAdmin('GET', `rounds/${queued.id}`)).status, 404);
	assert.deepEqual(await s.w.accounts.open(timedetectives).container('pictures').list(''), []);
	assert.deepEqual(s.exceptions, []);
});

test('drafting needs a Foundry account, stops at 10 rounds at work, and checks the request before anything is queued', async () => {
	const unset = await setup({});
	const topicOff = await adminTopic(unset);
	const off = await unset.asAdmin('POST', `topics/${topicOff}/rounds/draft`, { json: {} });
	assert.equal(off.status, 503);
	assert.equal(codeOf(off), 'ai_unavailable');

	const s = await setup();
	const topic = await adminTopic(s);
	const typedTopic = topicId(topic);
	assert.ok(typedTopic);
	for (let n = 0; n < 10; n++) await s.round(typedTopic, { kind: 'drafting', focus: '', source: 'ai' }, false);
	const full = await s.asAdmin('POST', `topics/${topic}/rounds/draft`, { json: {} });
	assert.equal(full.status, 429);
	assert.equal(codeOf(full), 'too_many_drafts');
	assert.equal((await s.asAdmin('POST', `topics/${topic}/rounds/draft`, { json: { focus: 'x'.repeat(121) } })).status, 400);
	assert.equal((await s.asAdmin('POST', `topics/${randomUUID()}/rounds/draft`, { json: {} })).status, 404);
	assert.equal(s.w.accounts.messages(timedetectives, 'drafts').length, 0);
});

test('a topic is named and guided by the admin, edited with its etag, and deleted only once it has no rounds', async () => {
	const s = await setup();
	const topic = await adminTopic(s);
	await adminTopic(s, 'Ancient Greeks');
	const listed = (await s.asAdmin('GET', 'topics')).data as { topics: { id: string; title: string; guidance: string; order: number; etag: string }[] };
	assert.deepEqual(listed.topics.map(({ title, order }) => [title, order]), [['Vikings', 0], ['Ancient Greeks', 1]]);
	const vikings = listed.topics[0];
	assert.ok(vikings);
	const renamed = await s.asAdmin('PUT', `topics/${topic}`, { json: { title: 'The Vikings', guidance: '', etag: vikings.etag } });
	assert.deepEqual([(renamed.data as { title: string }).title, (renamed.data as { order: number }).order], ['The Vikings', 0]);
	assert.equal((await s.asAdmin('PUT', `topics/${topic}`, { json: { title: 'Again', etag: vikings.etag } })).status, 412);
	assert.equal((await s.asAdmin('POST', 'topics', { json: { title: '' } })).status, 400);

	const round = (await s.asAdmin('POST', `topics/${topic}/rounds`, { json: { content: VIKING_ROUND } })).data as AdminRound;
	const refused = await s.asAdmin('DELETE', `topics/${topic}`);
	assert.equal(refused.status, 409);
	assert.equal(codeOf(refused), 'has_rounds');
	await s.asAdmin('DELETE', `rounds/${round.id}`);
	assert.equal((await s.asAdmin('DELETE', `topics/${topic}`)).status, 204);
	assert.deepEqual(((await s.asAdmin('GET', 'topics')).data as { topics: { title: string }[] }).topics.map((t) => t.title), ['Ancient Greeks']);
});

test('a queue message that names no round, or a round that is not drafting, is left alone', async () => {
	const s = await setup();
	const before = foundry.calls.length;
	const topic = topicId(await adminTopic(s));
	assert.ok(topic);
	const done = await s.round(topic);
	for (const message of ['not json', {}, { roundId: 'nope' }, { roundId: randomUUID() }, { roundId: done }]) await s.queue.send(message);
	await s.settled();
	assert.equal(foundry.calls.length, before);
	assert.deepEqual(s.exceptions, []);
});

test('a stored round that no longer parses is skipped and logged for children, and shows as broken to the admin until deleted', async () => {
	const s = await setup();
	const vikings = await s.topic('Vikings');
	const greeks = await s.topic('Ancient Greeks', 1);
	await s.round(vikings);
	const good = await s.round(greeks);
	const row = { partitionKey: 'round', topicId: greeks, source: 'ai', hasPicture: true, publishedAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
	const badContent = randomUUID();
	const badState = randomUUID();
	await s.rows.put({ ...row, rowKey: badContent, state: 'published', content: JSON.stringify({ ...ROUND, questions: [] }) });
	await s.rows.put({ ...row, rowKey: badState, state: 'archived', content: JSON.stringify(ROUND) });

	const topics = await s.asAda('GET', 'topics');
	assert.equal(topics.status, 200);
	assert.deepEqual((topics.data as { topics: { title: string }[] }).topics.map((t) => t.title), ['Vikings', 'Ancient Greeks']);
	for (let n = 0; n < 6; n++) assert.equal(((await s.asAda('GET', `topics/${greeks}/next?confidence=bit`)).data as View).id, good);
	assert.equal((await s.asAda('PUT', `rounds/${badContent}/attempts/${attemptId()}`, { json: { confidence: 'bit', answers: perfect } })).status, 404);
	assert.ok(s.logs.some((line) => line.includes(badContent) && line.includes('questions')), 'the skipped round is logged with why');
	assert.ok(s.logs.some((line) => line.includes(badState) && line.includes('archived')));

	const listed = ((await s.asAdmin('GET', `topics/${greeks}/rounds`)).data as { rounds: { id: string; broken?: string[] }[] }).rounds;
	assert.deepEqual(listed.filter((r) => r.broken).map((r) => r.id).sort(), [badContent, badState].sort());
	const one = await s.asAdmin('GET', `rounds/${badState}`);
	assert.equal(one.status, 200);
	assert.deepEqual(one.data, { id: badState, topicId: greeks, broken: [`state "archived" is not one a round can be in`] });
	assert.equal(codeOf(await s.asAdmin('POST', `rounds/${badContent}/publish`)), 'broken');
	assert.deepEqual(((await s.asAdmin('GET', 'topics')).data as { topics: { title: string; rounds: number }[] }).topics.map(({ title, rounds }) => [title, rounds]), [['Vikings', 1], ['Ancient Greeks', 3]]);

	for (const id of [good, badContent, badState]) assert.equal((await s.asAdmin('DELETE', `rounds/${id}`)).status, 204);
	assert.equal((await s.asAdmin('DELETE', `topics/${greeks}`)).status, 204);
	assert.deepEqual(s.exceptions, []);
});

test('the admin app gives up on a message after the attempts the worker fails its round on', () => {
	const host = JSON.parse(readFileSync(new URL('../apps/admin/api/host.json', import.meta.url), 'utf8')) as { extensions: { queues: Record<string, unknown> } };
	assert.equal(host.extensions.queues['maxDequeueCount'], MAX_ATTEMPTS);
	assert.equal(MAX_DEQUEUE_COUNT, MAX_ATTEMPTS);
});
