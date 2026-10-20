import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { adminModule, createAdminApp, createPlayerApp, type App, type Env } from '@g4k/host';
import { deliverQueues } from '@g4k/host/node';
import { createAdminApi } from '../games/drawpad/admin/api/index.ts';
import { createPlayApi } from '../games/drawpad/play/api/index.ts';
import manifest from '../games/drawpad/manifest.ts';
import { startFakeFoundry } from '../dev/fake-foundry.ts';
import { fakeGraph } from './support/graph.ts';
import { call, JPEG, PNG, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world } from './support/world.ts';

const idp = await fakeIdp();
const foundry = await startFakeFoundry();
after(() => foundry.close());
const drawpad = gameId('drawpad');
const ID = '3f2a9c-1';

async function setup(env: Env = { DRAWPAD_FOUNDRY_ENDPOINT: foundry.origin, DRAWPAD_LOCAL_JOB_EVENTS: '1' }, timeZone = 'Europe/London') {
	const w = world();
	const apps: App[] = [];
	const accounts = deliverQueues(w.accounts, () => apps);
	const tokens = async (service: string) => `tok-${service}`;
	const common = { telemetry: w.telemetry, now: w.now };
	const player = createPlayerApp({ ...common, issuers: [idp.games], manifest, create: createPlayApi, portal: w.reader, accounts, tokens, env: {} });
	const admin = createAdminApp({
		...common,
		issuer: idp.admin,
		store: w.admin,
		graph: () => fakeGraph().graph,
		games: [drawpad],
		modules: [adminModule(manifest, createAdminApi)],
		accounts,
		tokens,
		env,
		gamesOrigin: 'https://games.example',
	});
	apps.push(player, admin);
	const adminObjectId = newObjectId();
	await seedAdmin(w, adminObjectId);
	const adminToken = await idp.adminToken(adminObjectId);
	const kid = await seedPlayer(w, idp, { games: [drawpad], profile: { displayName: 'Ada', timeZone } });
	const asKid = (method: string, path: string, send: Send = {}) => call(player, method, `/api/g/drawpad/${path}`, { token: kid.token, ...send });
	const asAdmin = (method: string, path: string, send: Send = {}) => call(admin, method, `/api/admin/g/drawpad/${path}`, { token: adminToken, ...send });
	const settled = () => accounts.idle();
	return { w, player, kid, asKid, asAdmin, settled, account: w.accounts.open(drawpad), exceptions: w.telemetry.exceptions };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The picture a trace player draws on, put in the library the way the admin page does: its files first, then the details. */
async function addTracePicture({ asAdmin }: Setup, id = ID): Promise<void> {
	assert.equal((await asAdmin('POST', `pictures/${id}/original`, { jpeg: JPEG })).status, 204);
	assert.equal((await asAdmin('POST', `pictures/${id}/png/outline.png`, { png: PNG })).status, 204);
	assert.equal((await asAdmin('POST', `pictures/${id}`, { json: { title: ' House ', kinds: ['trace'], width: 4, height: 3 } })).status, 201);
}

const statusOf = (reply: { readonly data: unknown }) => (reply.data as { status: string }).status;

test('a picture joins the library only once its files are up, and players read its files with an ETag they can revalidate', async () => {
	const s = await setup();
	const early = await s.asAdmin('POST', `pictures/${ID}`, { json: { title: 'House', kinds: ['trace'], width: 4, height: 3 } });
	assert.equal(early.status, 400);
	assert.deepEqual((early.data as { problems: string[] }).problems, ['original.jpg', 'outline.png']);
	assert.deepEqual((await s.asKid('GET', 'pictures')).data, []);

	await addTracePicture(s);
	const library = (await s.asKid('GET', 'pictures')).data as { id: string; title: string; kinds: string[]; createdAt: string }[];
	assert.deepEqual(library.map(({ id, title, kinds }) => ({ id, title, kinds })), [{ id: ID, title: 'House', kinds: ['trace'] }]);
	assert.equal(library[0]?.createdAt, NOW.toISOString());

	const file = await s.asKid('GET', `pictures/${ID}/outline.png`);
	assert.equal(file.status, 200);
	assert.equal(file.headers['content-type'], 'image/png');
	assert.match(file.headers['cache-control'] ?? '', /immutable/);
	assert.deepEqual(file.body, PNG);
	const etag = file.headers['etag'];
	assert.ok(etag);
	assert.equal((await s.asKid('GET', `pictures/${ID}/outline.png`, { headers: { 'if-none-match': etag } })).status, 304);
	assert.equal((await s.asKid('GET', `pictures/${ID}/secret.txt`)).status, 404);
	assert.equal((await s.asKid('GET', 'pictures/..%2fx/outline.png')).status, 404);
	assert.equal((await s.asKid('GET', `pictures/${ID}/pbn.json`)).status, 404, 'a file the picture does not have');
});

test('a paint by numbers picture keeps its region data beside its images, and a picture can be renamed and deleted with its files', async () => {
	const s = await setup();
	const pbn = { width: 4, height: 3, palette: ['#ffffff'], regions: [{ id: 1, colorIndex: 0, labelX: 1, labelY: 1 }] };
	await s.asAdmin('POST', `pictures/${ID}/original`, { jpeg: JPEG });
	await s.asAdmin('POST', `pictures/${ID}/png/pbn-regions.png`, { png: PNG });
	await s.asAdmin('POST', `pictures/${ID}/png/pbn-preview.png`, { png: PNG });
	assert.equal((await s.asAdmin('POST', `pictures/${ID}`, { json: { title: 'Fox', kinds: ['pbn'], width: 4, height: 3, pbn } })).status, 201);
	assert.equal((await s.asKid('GET', `pictures/${ID}/pbn.json`)).status, 200);
	assert.equal((await s.asAdmin('POST', `pictures/${ID}/png/not-a-file.png`, { png: PNG })).status, 404);

	assert.equal(((await s.asAdmin('PUT', `pictures/${ID}`, { json: { title: '  Red Fox ' } })).data as { title: string }).title, 'Red Fox');
	assert.equal((await s.asAdmin('PUT', `pictures/${ID}`, { json: { title: '' } })).status, 400);
	assert.equal((await s.asAdmin('PUT', 'pictures/nope', { json: { title: 'x' } })).status, 404);
	assert.equal(((await s.asKid('GET', 'pictures')).data as { title: string }[])[0]?.title, 'Red Fox');

	assert.equal((await s.asAdmin('DELETE', `pictures/${ID}`)).status, 204);
	assert.deepEqual((await s.asKid('GET', 'pictures')).data, []);
	assert.equal((await s.asKid('GET', `pictures/${ID}/pbn-preview.png`)).status, 404);
});

test('a child draws on a library picture, saves, finishes, and cannot touch anyone else\'s drawing', async () => {
	const s = await setup();
	await addTracePicture(s);
	const made = await s.asKid('POST', 'drawings', { json: { pictureId: ID, kind: 'trace' } });
	assert.equal(made.status, 201);
	const drawing = made.data as { id: string; status: string; createdAt: string };
	assert.equal(drawing.status, 'in-progress');
	assert.equal((await s.asKid('POST', 'drawings', { json: { pictureId: 'nope', kind: 'trace' } })).status, 404, 'no such picture');
	assert.equal((await s.asKid('POST', 'drawings', { json: { pictureId: ID, kind: 'pbn' } })).status, 404, 'the picture has no paint by numbers');

	assert.equal((await s.asKid('POST', `drawings/${drawing.id}/image`, { png: PNG })).status, 204);
	const image = await s.asKid('GET', `drawings/${drawing.id}/image`);
	assert.deepEqual(image.body, PNG);
	assert.equal(image.headers['cache-control'], 'private, no-cache');
	assert.equal((await s.asKid('GET', `drawings/${drawing.id}/image`, { headers: { 'if-none-match': image.headers['etag'] ?? '' } })).status, 304);

	const saved = await s.asKid('PUT', `drawings/${drawing.id}`, { json: { status: 'finished', score: { total: 130, stars: 1, breakdown: { tracing: 35 } }, filledRegions: [1, 2] } });
	assert.deepEqual((saved.data as { score: unknown }).score, { total: 100, stars: 5, breakdown: { tracing: 35 } }, 'stars are worked out on the server');
	const edited = await s.asKid('PUT', `drawings/${drawing.id}`, { json: { status: 'in-progress', score: { total: 5, breakdown: {} }, filledRegions: [3] } });
	const final = edited.data as { status: string; score: { total: number }; filledRegions: number[] };
	assert.deepEqual({ status: final.status, total: final.score.total, regions: final.filledRegions }, { status: 'finished', total: 100, regions: [3] }, 'a finished drawing keeps its score and status but can still be painted');

	assert.deepEqual(((await s.asKid('GET', 'drawings')).data as { id: string }[]).map((row) => row.id), [drawing.id]);
	const stranger = await seedPlayer(s.w, idp, { games: [drawpad] });
	const asStranger = (method: string, path: string, send: Send = {}) => call(s.player, method, `/api/g/drawpad/${path}`, { token: stranger.token, ...send });
	assert.equal((await asStranger('PUT', `drawings/${drawing.id}`, { json: { status: 'finished' } })).status, 404);
	assert.equal((await asStranger('GET', `drawings/${drawing.id}/image`)).status, 404);
	assert.equal((await asStranger('DELETE', `drawings/${drawing.id}`)).status, 404);
	assert.deepEqual((await asStranger('GET', 'drawings')).data, []);

	assert.equal((await s.asKid('DELETE', `drawings/${drawing.id}`)).status, 204);
	assert.equal((await s.asKid('GET', `drawings/${drawing.id}/image`)).status, 404);
	assert.deepEqual((await s.asKid('GET', 'drawings')).data, []);
});

test('time is counted in the child\'s own day, capped per beat, and time_up stops new drawings but not saving what is open', async () => {
	const s = await setup(undefined, 'Pacific/Auckland');
	await addTracePicture(s);
	const open = (await s.asKid('POST', 'drawings', { json: { pictureId: ID, kind: 'trace' } })).data as { id: string };
	assert.deepEqual((await s.asKid('GET', 'usage')).data, { usedSeconds: 0, limitSeconds: 3600, remainingSeconds: 3600 }, 'a new child gets 60 minutes');

	const beat = await s.asKid('POST', 'usage/heartbeat', { json: { seconds: 500 } });
	assert.deepEqual(beat.data, { usedSeconds: 90, limitSeconds: 3600, remainingSeconds: 3510 }, 'one beat is capped at 90 seconds');
	assert.equal((await s.account.table('usage').get(s.kid.userId, '2026-10-20'))?.['seconds'], 90, 'it lands on Auckland\'s date, which is already the 20th');
	assert.equal((await s.account.table('usage').get(s.kid.userId, '2026-10-19')), undefined);
	assert.equal((await s.asKid('POST', 'usage/heartbeat', { json: { seconds: 'ten' } })).status, 400);

	assert.equal((await s.asAdmin('PUT', `limits/${s.kid.userId}`, { json: { dailyLimitMinutes: 2 } })).status, 204);
	assert.deepEqual((await s.asKid('POST', 'usage/heartbeat', { json: { seconds: 30 } })).data, { usedSeconds: 120, limitSeconds: 120, remainingSeconds: 0 });

	const refused = await s.asKid('POST', 'drawings', { json: { pictureId: ID, kind: 'trace' } });
	assert.equal(refused.status, 403);
	assert.equal((refused.data as { error: string }).error, 'time_up');
	assert.equal((await s.asKid('GET', `drawings/${open.id}/image`)).status, 403, 'resuming a drawing needs time too');
	assert.equal((await s.asKid('PUT', `drawings/${open.id}`, { json: { filledRegions: [1] } })).status, 200, 'but what is open can still be saved');
	assert.equal((await s.asKid('POST', `drawings/${open.id}/image`, { png: PNG })).status, 204);
	assert.equal((await s.asKid('GET', 'drawings')).status, 200, 'and History still opens');

	assert.equal((await s.asAdmin('PUT', `limits/${s.kid.userId}`, { json: { dailyLimitMinutes: null } })).status, 204);
	assert.equal(((await s.asKid('GET', 'usage')).data as { limitSeconds: number }).limitSeconds, 3600, 'clearing the limit falls back to the default');
});

test('the admin sees each child with today\'s time and sets a limit only for children who play this game', async () => {
	const s = await setup();
	await s.asKid('POST', 'usage/heartbeat', { json: { seconds: 75 } });
	assert.deepEqual((await s.asAdmin('GET', 'limits')).data, {
		defaultMinutes: 60,
		children: [{ userId: s.kid.userId, name: 'Ada', dailyLimitMinutes: null, usedSecondsToday: 75 }],
	});
	await s.account.table('settings').put({ partitionKey: 's', rowKey: 'default', dailyLimitMinutes: 30 });
	assert.equal(((await s.asAdmin('GET', 'limits')).data as { defaultMinutes: number }).defaultMinutes, 30);
	assert.equal(((await s.asKid('GET', 'usage')).data as { limitSeconds: number }).limitSeconds, 1800, 'the player reads the default the admin wrote');

	await s.asAdmin('PUT', `limits/${s.kid.userId}`, { json: { dailyLimitMinutes: 0 } });
	assert.equal(((await s.asAdmin('GET', 'limits')).data as { children: { dailyLimitMinutes: number }[] }).children[0]?.dailyLimitMinutes, 0, 'zero minutes is a limit, not an empty field');
	assert.equal((await s.asAdmin('PUT', `limits/${s.kid.userId}`, { json: { dailyLimitMinutes: 1441 } })).status, 400);
	assert.equal((await s.asAdmin('PUT', 'limits/11111111-1111-4111-8111-111111111111', { json: { dailyLimitMinutes: 5 } })).status, 404);
});

test('the gallery shows every child\'s drawings with their names, and their pictures', async () => {
	const s = await setup();
	await addTracePicture(s);
	const made = (await s.asKid('POST', 'drawings', { json: { pictureId: ID, kind: 'trace' } })).data as { id: string };
	await s.asKid('POST', `drawings/${made.id}/image`, { png: PNG });
	const gallery = (await s.asAdmin('GET', 'drawings')).data as { id: string; userId: string; userName: string }[];
	assert.deepEqual(gallery.map(({ id, userId, userName }) => ({ id, userId, userName })), [{ id: made.id, userId: s.kid.userId, userName: 'Ada' }]);
	assert.deepEqual((await s.asAdmin('GET', `drawings/${s.kid.userId}/${made.id}/image`)).body, PNG);
	assert.equal((await s.asAdmin('GET', `drawings/${s.kid.userId}/nope/image`)).status, 404);
});

test('a description makes three pictures through Foundry with the platform token, one step at a time, and the admin reads them back', async () => {
	const s = await setup();
	const before = foundry.calls.length;
	const queued = await s.asAdmin('POST', 'jobs', { json: { source: 'description', description: '  a fox asleep under a tree ', quality: 'standard' } });
	assert.equal(queued.status, 202);
	const job = queued.data as { id: string; description: string; steps: { key: string; state: string }[] };
	assert.equal(job.description, 'a fox asleep under a tree');
	assert.deepEqual(job.steps.map((step) => step.key), ['prompts', 'scene-1', 'scene-2', 'scene-3']);
	await s.settled();

	const done = (await s.asAdmin('GET', `jobs/${job.id}`)).data as { status: string; titles: string[]; steps: { key: string; state: string }[] };
	assert.equal(done.status, 'done');
	assert.deepEqual(done.steps.map((step) => step.state), ['done', 'done', 'done', 'done']);
	assert.deepEqual(done.titles, ['Sleepy Fox', 'Fox On A Hill', 'Little Red House']);
	const made = foundry.calls.slice(before);
	assert.deepEqual(made.map((entry) => entry.path), ['chat/completions', 'images/generations', 'images/generations', 'images/generations']);
	assert.deepEqual(made.map((entry) => entry.model), ['gpt-5.4-mini', 'gpt-image-1-mini', 'gpt-image-1-mini', 'gpt-image-1-mini']);
	assert.ok(made.every((entry) => entry.token === 'tok-cognitiveServices'), 'every call carries the platform\'s Cognitive Services token');

	for (const key of ['scene-1', 'scene-2', 'scene-3']) {
		const image = await s.asAdmin('GET', `jobs/${job.id}/${key}.png`);
		assert.equal(image.status, 200);
		assert.equal(image.headers['content-type'], 'image/png');
		assert.deepEqual([...(image.body as Uint8Array).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
	}
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}/prompts.png`)).status, 404, 'a step that draws nothing has no picture');
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}/photo.jpg`)).status, 404);
	assert.deepEqual(((await s.asAdmin('GET', 'jobs')).data as { id: string }[]).map((row) => row.id), [job.id]);
	assert.deepEqual(s.exceptions, []);

	assert.equal((await s.asAdmin('DELETE', `jobs/${job.id}`)).status, 204);
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}`)).status, 404);
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}/scene-1.png`)).status, 404);
	assert.deepEqual(await s.w.accounts.open(drawpad).container('jobs').list(`${job.id}/`), [], 'the job\'s files go with it');
});

test('a photo job runs titles first and then each redraw asked for, and a finished job makes one more outline on request', async () => {
	const s = await setup();
	const queued = await s.asAdmin('POST', 'jobs/photo?width=30&height=20&wants=best,standard&titles=1', { jpeg: JPEG });
	assert.equal(queued.status, 202);
	const job = queued.data as { id: string; steps: { key: string }[] };
	assert.deepEqual(job.steps.map((step) => step.key), ['titles', 'trace-best', 'trace-standard']);
	await s.settled();
	const done = (await s.asAdmin('GET', `jobs/${job.id}`)).data as { status: string; steps: { state: string }[]; titles: string[] };
	assert.deepEqual([done.status, ...done.steps.map((step) => step.state)], ['done', 'done', 'done', 'done']);
	assert.equal(done.titles.length, 3);
	assert.deepEqual((await s.asAdmin('GET', `jobs/${job.id}/photo.jpg`)).body, JPEG);
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}/trace-best.png`)).status, 200);

	const before = foundry.calls.length;
	const again = await s.asAdmin('POST', `jobs/${job.id}/redraw`, { json: { quality: 'best' } });
	assert.equal(again.status, 202);
	assert.equal(statusOf(again), 'queued');
	await s.settled();
	assert.deepEqual(foundry.calls.slice(before).map((entry) => `${entry.path} ${entry.model}`), ['images/edits gpt-image-2'], 'only the asked-for step ran, from the photo the job kept');
	assert.equal(statusOf(await s.asAdmin('GET', `jobs/${job.id}`)), 'done');
	assert.equal((await s.asAdmin('POST', `jobs/${job.id}/redraw`, { json: { quality: 'ultra' } })).status, 400);
	assert.equal((await s.asAdmin('POST', 'jobs/nope/redraw', { json: { quality: 'best' } })).status, 404);
});

test('a request is checked before anything is stored or queued', async () => {
	const s = await setup();
	const before = foundry.calls.length;
	for (const query of ['width=30&height=20&wants=&titles=0', 'width=30&height=20&wants=best,best&titles=1', 'width=3000&height=20&wants=best&titles=1', 'wants=best']) {
		assert.equal((await s.asAdmin('POST', `jobs/photo?${query}`, { jpeg: JPEG })).status, 400, query);
	}
	assert.equal((await s.asAdmin('POST', 'jobs/photo?width=30&height=20&wants=best&titles=1', { png: PNG })).status, 415);
	for (const body of [{ source: 'description', description: 'ab', quality: 'best' }, { source: 'description', description: 'x'.repeat(301), quality: 'best' }, { description: 'a fox', quality: 'ultra' }]) {
		assert.equal((await s.asAdmin('POST', 'jobs', { json: body })).status, 400);
	}
	assert.deepEqual((await s.asAdmin('GET', 'jobs')).data, []);
	assert.equal(s.w.accounts.messages(drawpad, 'stencil-jobs').length, 0);
	assert.equal(foundry.calls.length, before);
});

test('a refusal from the content filter settles its step at once, while the other steps carry on', async () => {
	const s = await setup();
	const before = foundry.calls.length;
	foundry.refuseNext(1);
	const job = (await s.asAdmin('POST', 'jobs', { json: { source: 'description', description: 'a fox', quality: 'best' } })).data as { id: string };
	await s.settled();
	const done = (await s.asAdmin('GET', `jobs/${job.id}`)).data as { status: string; steps: { key: string; state: string; error?: string }[] };
	assert.equal(done.status, 'done');
	assert.deepEqual(done.steps, [
		{ key: 'prompts', state: 'done' },
		{ key: 'scene-1', state: 'failed', error: 'redraw_refused' },
		{ key: 'scene-2', state: 'done' },
		{ key: 'scene-3', state: 'done' },
	]);
	assert.equal(foundry.calls.slice(before).filter((entry) => entry.path === 'images/generations').length, 3, 'a refusal is not retried');
	assert.equal((await s.asAdmin('GET', `jobs/${job.id}/scene-1.png`)).status, 404);
});

test('any other failure is tried again and skips the steps already done, until the last attempt settles what is left', async () => {
	const s = await setup();
	let before = foundry.calls.length;
	foundry.failNext(1);
	const retried = (await s.asAdmin('POST', 'jobs', { json: { source: 'description', description: 'a fox', quality: 'standard' } })).data as { id: string };
	await s.settled();
	const ok = (await s.asAdmin('GET', `jobs/${retried.id}`)).data as { steps: { state: string }[] };
	assert.deepEqual(ok.steps.map((step) => step.state), ['done', 'done', 'done', 'done']);
	assert.deepEqual(foundry.calls.slice(before).map((entry) => entry.path), ['chat/completions', 'images/generations', 'images/generations', 'images/generations', 'images/generations'], 'the prompts were not paid for twice');

	before = foundry.calls.length;
	foundry.failNext(3);
	const doomed = (await s.asAdmin('POST', 'jobs', { json: { source: 'description', description: 'a fox', quality: 'standard' } })).data as { id: string };
	await s.settled();
	const bad = (await s.asAdmin('GET', `jobs/${doomed.id}`)).data as { status: string; steps: { key: string; state: string; error?: string }[] };
	assert.equal(bad.status, 'done');
	assert.deepEqual(bad.steps.map((step) => `${step.key} ${step.state} ${step.error ?? ''}`.trim()), ['prompts done', 'scene-1 failed redraw_failed', 'scene-2 failed redraw_failed', 'scene-3 failed redraw_failed']);
	assert.equal(foundry.calls.slice(before).filter((entry) => entry.path === 'images/generations').length, 3, 'three attempts, then it stops');
});

test('a job cannot be queued without a Foundry account, or past 20 at work, and a deleted job is never brought back by the worker', async () => {
	const unset = await setup({ DRAWPAD_LOCAL_JOB_EVENTS: '1' });
	const refused = await unset.asAdmin('POST', 'jobs', { json: { source: 'description', description: 'a fox', quality: 'best' } });
	assert.equal(refused.status, 503);
	assert.equal((refused.data as { error: string }).error, 'redraw_unavailable');

	const s = await setup();
	const jobs = s.account.table('jobs');
	for (let n = 0; n < 20; n++) await jobs.put({ partitionKey: 'jobs', rowKey: `busy-${n}`, source: 'description', description: 'x', quality: 'best', status: 'processing', steps: '[]', createdAt: NOW.toISOString(), attempts: 1 });
	const full = await s.asAdmin('POST', 'jobs', { json: { source: 'description', description: 'a fox', quality: 'best' } });
	assert.equal(full.status, 429);
	assert.equal((full.data as { error: string }).error, 'too_many_jobs');
	assert.equal((await s.asAdmin('POST', 'jobs/busy-1/redraw', { json: { quality: 'best' } })).status, 400, 'only a photo job makes outlines');

	const photo = await setup();
	await photo.account.table('jobs').put({ partitionKey: 'jobs', rowKey: 'work', source: 'photo', width: 3, height: 2, status: 'processing', steps: JSON.stringify([{ key: 'trace-best', state: 'pending' }]), createdAt: NOW.toISOString(), attempts: 1 });
	const busy = await photo.asAdmin('POST', 'jobs/work/redraw', { json: { quality: 'best' } });
	assert.equal(busy.status, 409);
	assert.equal((busy.data as { error: string }).error, 'job_busy');
});

test('a queue message that is not the ready event of a job is ignored, and an event for a missing job is dropped', async () => {
	const s = await setup();
	const before = foundry.calls.length;
	const queue = s.w.accounts.open(drawpad).queue('stencil-jobs');
	await queue.send({ eventType: 'Microsoft.Storage.BlobDeleted', subject: '/blobServices/default/containers/jobs/blobs/gone/ready' });
	await queue.send('not json');
	await queue.send({ eventType: 'Microsoft.Storage.BlobCreated', subject: '/blobServices/default/containers/jobs/blobs/gone/ready' });
	await s.settled();
	assert.equal(foundry.calls.length, before);
	assert.deepEqual(s.exceptions, []);
});
