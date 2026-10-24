import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { adminModule, createAdminApp, createPlayerApp, type Accounts, type App } from '@g4k/host';
import { createAdminApi, SUMMARY_COLUMNS } from '../games/colourmatch/admin/api/index.ts';
import { DEFAULT_TUNING, replayGame, parseGameLog, type TuningVersion } from '../games/colourmatch/data/index.ts';
import manifest from '../games/colourmatch/manifest.ts';
import { createPlayApi } from '../games/colourmatch/play/api/index.ts';
import { seeded, simulateGame, type WireLog } from './colourmatch/support.ts';
import { fakeGraph } from './support/graph.ts';
import { call, codeOf, type Send } from './support/http.ts';
import { fakeIdp } from './support/idp.ts';
import { gameId } from './support/ids.ts';
import { newObjectId, NOW, seedAdmin, seedPlayer, world } from './support/world.ts';

const idp = await fakeIdp();
const colourmatch = gameId('colourmatch');
const TODAY = NOW.toISOString().slice(0, 10);
const STARTED = new Date(NOW.getTime() - 60_000).toISOString();

type Saved = { gameId: string; score: number; roundsReached: number; correct: number; turns: number; bestToday: number };
type Tunings = { current: TuningVersion; versions: TuningVersion[] };
type Record = { key: string; gameId: string; score: number; turns: number; mode: string; endReason: string; tuningId: string };
type Board = { optedIn: boolean; days: string[]; children: { name: string; me: boolean; points: number[]; total: number }[] };

async function setup() {
	const w = world();
	const clock = { at: NOW };
	/** Says whether the next write to the board table throws. */
	const faults = { board: () => false };
	const accounts: Accounts = {
		open(owner) {
			const account = w.accounts.open(owner);
			return {
				...account,
				table(name) {
					const table = account.table(name);
					return owner === colourmatch && name === 'board' ? { ...table, insertIfAbsent: (row) => (faults.board() ? Promise.reject(new Error('storage is down')) : table.insertIfAbsent(row)) } : table;
				},
			};
		},
	};
	const common = { telemetry: w.telemetry, now: () => clock.at, accounts, tokens: async (service: string) => `tok-${service}` };
	const player = createPlayerApp({ ...common, issuers: [idp.games], manifest, create: createPlayApi, portal: w.reader, env: {} });
	const admin = createAdminApp({
		...common,
		issuer: idp.admin,
		store: w.admin,
		graph: () => fakeGraph().graph,
		games: [colourmatch],
		modules: [adminModule(manifest, createAdminApi)],
		env: {},
		gamesOrigin: 'https://games.example',
	});
	const adminObjectId = newObjectId();
	await seedAdmin(w, adminObjectId);
	const adminToken = await idp.adminToken(adminObjectId);
	const child = (displayName: string, timeZone = 'Europe/London') => seedPlayer(w, idp, { games: [colourmatch], profile: { displayName, timeZone } });
	const as = (token: string) => (method: string, path: string, send: Send = {}) => call(player, method, `/api/g/colourmatch/${path}`, { token, ...send });
	const asAdmin = (method: string, path: string, send: Send = {}) => call(admin, method, `/api/admin/g/colourmatch/${path}`, { token: adminToken, ...send });
	const ada = await child('Ada');
	const account = w.accounts.open(colourmatch);
	/** What the server would make of the log under `tuning`, worked out here so a test states the score it expects. */
	const expected = (wire: WireLog, id: string, tuning = DEFAULT_TUNING) => {
		const log = parseGameLog(id, wire, clock.at);
		assert.ok(log.ok, log.ok ? '' : log.problems.join('; '));
		const replayed = replayGame(tuning, log.value);
		assert.ok(replayed.ok, replayed.ok ? '' : replayed.problems.join('; '));
		return replayed.value.summary;
	};
	return { w, clock, faults, child, as, asAda: as(ada.token), asAdmin, adminToken, ada, admin: admin as App, games: account.table('games'), blobs: account.container('games'), board: account.table('board'), expected, exceptions: w.telemetry.exceptions };
}

const game = (seed: number, turns: number, extra: Partial<Parameters<typeof simulateGame>[0]> = {}) =>
	simulateGame({ tuning: DEFAULT_TUNING, mode: 'normal', rng: seeded(seed), turns, endReason: 'mistakes', startedAt: STARTED, ...extra });

test('a new game starts under the defaults until the admin saves a tuning, then under the newest saved one, and every version is kept', async () => {
	const s = await setup();
	assert.deepEqual((await s.asAda('GET', 'start')).data, { tuningId: 'default', tuning: DEFAULT_TUNING });
	assert.deepEqual(((await s.asAdmin('GET', 'tuning')).data as Tunings).versions, []);

	const slower = { ...DEFAULT_TUNING, firstSecondsPerTurn: 5 };
	const first = await s.asAdmin('POST', 'tuning', { json: slower });
	assert.equal(first.status, 201, JSON.stringify(first.data));
	const v1 = first.data as TuningVersion;
	assert.deepEqual([v1.tuning, v1.savedAt], [slower, NOW.toISOString()]);
	s.clock.at = new Date(NOW.getTime() + 60_000);
	const v2 = (await s.asAdmin('POST', 'tuning', { json: { ...slower, basePoints: 120 } })).data as TuningVersion;
	assert.notEqual(v1.id, v2.id);

	const listed = (await s.asAdmin('GET', 'tuning')).data as Tunings;
	assert.deepEqual(listed.versions.map((v) => v.id), [v2.id, v1.id], 'newest first');
	assert.deepEqual(listed.current, v2);
	assert.deepEqual((await s.asAda('GET', 'start')).data, { tuningId: v2.id, tuning: v2.tuning });

	const refused = await s.asAdmin('POST', 'tuning', { json: { ...slower, decay: 2, maxTurns: 1 } });
	assert.equal(refused.status, 400);
	assert.deepEqual((refused.data as { problems: string[] }).problems, ['decay must be between 0.5 and 1', 'firstTurns must be at most maxTurns']);
	assert.deepEqual(((await s.asAdmin('GET', 'tuning')).data as Tunings).versions.length, 2, 'a refused save writes nothing');
});

test('the server scores a saved game itself, writes its blob and its row, and refuses a bad log or an unknown tuning', async () => {
	const s = await setup();
	const id = randomUUID();
	const wire = game(11, 9, { answerMs: (i) => 900 + i * 50 });
	const want = s.expected(wire, id);
	const saved = await s.asAda('PUT', `games/${id}`, { json: wire });
	assert.equal(saved.status, 200, JSON.stringify(saved.data));
	assert.deepEqual(saved.data, { gameId: id, score: want.score, roundsReached: 2, correct: 6, turns: 9, bestToday: want.score });
	assert.ok(want.score > 500, `six right answers in rounds 1 and 2 score hundreds, got ${want.score}`);

	const rows = await s.games.inPartition(s.ada.userId);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.ok(row);
	assert.deepEqual([row['gameId'], row['score'], row['mode'], row['endReason'], row['tuningId'], row['turns'], row['correct'], row['roundsReached'], row['savedAt'], row['startedAt']], [id, want.score, 'normal', 'mistakes', 'default', 9, 6, 2, NOW.toISOString(), STARTED]);
	assert.deepEqual([row['longestStreak'], row['timeouts'], row['hiddenMs'], row['pointer'], row['viewport']], [6, 0, 0, 'touch', '390x844']);
	assert.equal(typeof row['medianCongruentMs'], 'number');
	assert.ok(row.rowKey.endsWith(`-${id}`));
	const blob = await s.blobs.get(`${s.ada.userId}/${STARTED.slice(0, 7)}/${id}.json`);
	assert.ok(blob && blob !== 'not-modified', 'the blob is at <userId>/<yyyy-mm>/<gameId>.json');
	assert.equal(blob.contentType, 'application/json');
	const stored = JSON.parse(new TextDecoder().decode(blob.bytes)) as { turns: { correct: boolean; points: number; round: number }[]; savedAt: string };
	assert.equal(stored.turns.length, 9);
	assert.deepEqual(stored.turns.map((t) => t.correct), [true, true, true, true, true, true, false, false, false]);
	assert.equal(stored.turns.reduce((sum, t) => sum + t.points, 0), want.score);

	const bad = await s.asAda('PUT', `games/${randomUUID()}`, { json: { ...wire, turns: wire.turns.slice(0, 5) } });
	assert.equal(bad.status, 400);
	assert.deepEqual((bad.data as { problems: string[] }).problems, ['a game ended by mistakes ends on the 3th mistake in a row']);
	assert.equal((await s.asAda('PUT', `games/${randomUUID()}`, { json: { nonsense: true } })).status, 400);
	assert.equal((await s.asAda('PUT', `games/not-a-guid`, { json: wire })).status, 400);
	const unknown = await s.asAda('PUT', `games/${randomUUID()}`, { json: { ...wire, tuningId: 'gone' } });
	assert.deepEqual([unknown.status, codeOf(unknown)], [404, 'unknown_tuning']);
	assert.equal((await s.games.inPartition(s.ada.userId)).length, 1, 'nothing refused was saved');
	assert.deepEqual(await s.blobs.list(''), [`${s.ada.userId}/${STARTED.slice(0, 7)}/${id}.json`]);
	assert.deepEqual(s.exceptions, []);
});

test('a game is marked under the tuning it names, even after the admin saves another', async () => {
	const s = await setup();
	const v1 = (await s.asAdmin('POST', 'tuning', { json: { ...DEFAULT_TUNING, basePoints: 200 } })).data as TuningVersion;
	await s.asAdmin('POST', 'tuning', { json: { ...DEFAULT_TUNING, basePoints: 50 } });
	const id = randomUUID();
	const wire = game(12, 8, { tuningId: v1.id, endReason: 'left' });
	const saved = (await s.asAda('PUT', `games/${id}`, { json: wire })).data as Saved;
	assert.equal(saved.score, s.expected(wire, id, v1.tuning).score);
	const underDefaults = s.expected({ ...wire, tuningId: 'default' }, id).score;
	assert.ok(saved.score > underDefaults * 1.9 && saved.score < underDefaults * 2.1, `base points of 200 about double the default ${underDefaults}, got ${saved.score}`);
});

test('saving the same game again answers with what was saved first and writes nothing more', async () => {
	const s = await setup();
	const id = randomUUID();
	const wire = game(13, 7, { answerMs: 1000 });
	const first = (await s.asAda('PUT', `games/${id}`, { json: wire })).data as Saved;
	s.clock.at = new Date(NOW.getTime() + 5_000);
	const again = await s.asAda('PUT', `games/${id}`, { json: game(13, 7, { answerMs: 10 }) });
	assert.equal(again.status, 200);
	assert.deepEqual(again.data, first, 'the faster repeat changes nothing');
	assert.equal((await s.games.inPartition(s.ada.userId)).length, 1);
	assert.equal((await s.blobs.list('')).length, 1);
});

test('a save whose daily best failed to write is put right by the retry, which still counts the game once', async () => {
	const s = await setup();
	const id = randomUUID();
	const wire = game(14, 7);
	s.faults.board = () => true;
	assert.equal((await s.asAda('PUT', `games/${id}`, { json: wire })).status, 500);
	s.faults.board = () => false;
	const retry = await s.asAda('PUT', `games/${id}`, { json: wire });
	const score = s.expected(wire, id).score;
	assert.ok(score > 0);
	assert.deepEqual([retry.status, (retry.data as Saved).score, (retry.data as Saved).bestToday], [200, score, score]);
	assert.equal((await s.board.get(`day-${s.ada.userId}`, TODAY))?.['points'], score);
	assert.equal((await s.games.inPartition(s.ada.userId)).length, 1);
});

test('a day on the board is the child\'s best single game that day, the week adds the days up, and the board counts from the day of the switch', async () => {
	const s = await setup();
	const bea = await s.child('Bea');
	const asBea = s.as(bea.token);
	const play = async (as: typeof asBea, seed: number, turns: number) => {
		const reply = await as('PUT', `games/${randomUUID()}`, { json: game(seed, turns, { answerMs: 500, startedAt: new Date(s.clock.at.getTime() - 60_000).toISOString() }) });
		assert.equal(reply.status, 200, JSON.stringify(reply.data));
		return reply.data as Saved;
	};

	const low = await play(s.asAda, 21, 5);
	assert.equal(low.bestToday, low.score);
	const high = await play(s.asAda, 22, 12);
	assert.ok(high.score > low.score);
	assert.equal(high.bestToday, high.score);
	const middling = await play(s.asAda, 23, 8);
	assert.equal(middling.bestToday, high.score, 'a lower game leaves the best alone');

	assert.deepEqual((await s.asAda('GET', `board?day=${TODAY}`)).data, { optedIn: false });
	assert.deepEqual((await s.asAda('GET', 'board/me')).data, { optedIn: false });
	s.clock.at = new Date(NOW.getTime() + 60_000);
	assert.deepEqual((await s.asAda('PUT', 'board/me', { json: { on: true } })).data, { optedIn: true });
	await asBea('PUT', 'board/me', { json: { on: true } });
	s.clock.at = new Date(NOW.getTime() + 120_000);
	const beas = await play(asBea, 24, 6);

	const board = (await s.asAda('GET', `board?day=${TODAY}`)).data as Board;
	assert.equal(board.days.at(-1), TODAY);
	assert.deepEqual(board.children.map(({ name, me, total }) => [name, me, total]).sort(), [['Ada', true, high.score], ['Bea', false, beas.score]], 'the day Ada switched the board on counts whole');
	assert.equal(JSON.stringify(board).includes('userId'), false);

	const adas = await play(s.asAda, 25, 10);
	const later = (await asBea('GET', `board?day=${TODAY}`)).data as Board;
	const line = later.children.find((c) => c.name === 'Ada');
	assert.deepEqual([line?.points.at(-1), line?.total], [Math.max(adas.score, high.score), Math.max(adas.score, high.score)]);
	assert.equal(later.children.find((c) => c.name === 'Bea')?.me, true);
	assert.deepEqual(later.children.map((c) => c.total), [...later.children.map((c) => c.total)].sort((a, b) => b - a), 'highest total first');

	s.clock.at = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
	const tomorrow = await play(s.asAda, 26, 6);
	assert.equal(tomorrow.bestToday, tomorrow.score, 'a new day starts from nothing');
	const week = (await s.asAda('GET', `board?day=${s.clock.at.toISOString().slice(0, 10)}`)).data as Board;
	const ada = week.children.find((c) => c.me);
	assert.deepEqual(ada?.points.slice(-2), [Math.max(adas.score, high.score), tomorrow.score]);
	assert.equal(ada?.total, Math.max(adas.score, high.score) + tomorrow.score);

	await s.asAda('PUT', 'board/me', { json: { on: false } });
	assert.deepEqual(((await asBea('GET', `board?day=${s.clock.at.toISOString().slice(0, 10)}`)).data as Board).children.map((c) => c.name), ['Bea']);
	assert.equal((await s.asAda('GET', 'board?day=2020-01-01')).status, 400);
	assert.equal((await s.asAda('PUT', 'board/me', { json: { on: 'yes' } })).status, 400);
	assert.deepEqual(s.exceptions, []);
});

test('the admin sees each child by name, their games newest first with the turns of any one, and a CSV of every summary', async () => {
	const s = await setup();
	const bea = await s.child('Bea');
	const older = randomUUID();
	await s.asAda('PUT', `games/${older}`, { json: game(31, 6, { startedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }) });
	const newer = randomUUID();
	await s.asAda('PUT', `games/${newer}`, { json: game(32, 8, { mode: 'hard', endReason: 'left' }) });
	await s.as(bea.token)('PUT', `games/${randomUUID()}`, { json: game(33, 5, { endReason: 'left' }) });

	const children = (await s.asAdmin('GET', 'children')).data as { children: { userId: string; name: string }[] };
	assert.deepEqual(children.children.map((c) => c.name).sort(), ['Ada', 'Bea']);

	const listed = (await s.asAdmin('GET', `children/${s.ada.userId}/games`)).data as { child: { name: string }; games: Record[] };
	assert.equal(listed.child.name, 'Ada');
	assert.deepEqual(listed.games.map((g) => [g.gameId, g.mode, g.endReason, g.turns]), [[newer, 'hard', 'left', 8], [older, 'normal', 'mistakes', 6]]);

	const key = listed.games[0]?.key ?? '';
	const detail = (await s.asAdmin('GET', `children/${s.ada.userId}/games/${key}`)).data as { gameId: string; mode: string; turns: { round: number; word: string; ink: string; squares: string[]; correct: boolean; points: number; answer: { tapped: number } | null }[] };
	assert.equal(detail.gameId, newer);
	assert.equal(detail.turns.length, 8);
	assert.ok(detail.turns.every((t) => t.squares.length === 4 && typeof t.correct === 'boolean' && typeof t.points === 'number'));
	assert.equal((await s.asAdmin('GET', `children/${s.ada.userId}/games/nope`)).status, 404);
	assert.equal((await s.asAdmin('GET', `children/${randomUUID()}/games`)).status, 404);

	const csv = await s.asAdmin('GET', 'summaries.csv');
	assert.equal(csv.status, 200);
	assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8');
	const lines = new TextDecoder().decode(csv.body as Uint8Array).trimEnd().split('\r\n');
	assert.equal(lines[0], SUMMARY_COLUMNS.join(','));
	assert.equal(lines.length, 4, 'a header and three games');
	const cells = lines.slice(1).map((line) => line.split(','));
	assert.deepEqual(cells.map((c) => [c[1], c[2]]).sort(), [['Ada', newer], ['Ada', older], ['Bea', cells.find((c) => c[1] === 'Bea')?.[2]]].sort());
	assert.ok(cells.every((c) => c.length === SUMMARY_COLUMNS.length));
});

test('a name a spreadsheet would read as a formula is written to the CSV as text', async () => {
	const s = await setup();
	const names = ['=HYPERLINK("http://x","y")', '+1', '-1', '@SUM(A1)', '\tTab', '\rReturn'];
	for (const [i, name] of names.entries()) await s.as((await s.child(name)).token)('PUT', `games/${randomUUID()}`, { json: game(40 + i, 3) });
	const csv = new TextDecoder().decode((await s.asAdmin('GET', 'summaries.csv')).body as Uint8Array);
	const cells = csv.trimEnd().split('\r\n').slice(1).map((line) => /^[^,]*,("(?:[^"]|"")*"|[^,]*)/.exec(line)?.[1]);
	assert.deepEqual(cells.sort(), ['"\'=HYPERLINK(""http://x"",""y"")"', '"\'+1"', '"\'-1"', '"\'@SUM(A1)"', '"\'\tTab"', '"\'\rReturn"'].sort());
});

test('a games token opens no admin route, and the admin token opens no play route', async () => {
	const s = await setup();
	for (const path of ['tuning', 'children', `children/${s.ada.userId}/games`, 'summaries.csv']) {
		const reply = await call(s.admin, 'GET', `/api/admin/g/colourmatch/${path}`, { token: s.ada.token });
		assert.deepEqual([reply.status, codeOf(reply)], [401, 'invalid_token'], path);
	}
	assert.equal((await call(s.admin, 'POST', '/api/admin/g/colourmatch/tuning', { token: s.ada.token, json: DEFAULT_TUNING })).status, 401);
	const play = await s.as(s.adminToken)('GET', 'start');
	assert.deepEqual([play.status, codeOf(play)], [401, 'invalid_token']);
});
