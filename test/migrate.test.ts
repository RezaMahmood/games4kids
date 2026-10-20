import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENTRA, adminStore as portalAdminStore, memoryAccounts, storageFor, type MemoryAccounts } from '@g4k/host';
import { parseEmail, parseEntraObjectId, type EntraObjectId, type PortalUserId, type Row } from '@g4k/sdk';
import { adminStore as drawpadAdmin, playStore as drawpadPlay } from '../games/drawpad/data/stores.ts';
import { requiredPictureFiles } from '../games/drawpad/data/parse.ts';
import drawpad from '../games/drawpad/manifest.ts';
import { adminStore as letterjoinAdmin, playStore as letterjoinPlay } from '../games/letterjoin/data/stores.ts';
import { sortKey, submissionId } from '../games/letterjoin/data/submissions.ts';
import letterjoin from '../games/letterjoin/manifest.ts';
import { newAccounts, readPortal } from '../tools/migrate/accounts.ts';
import { migrateContent, requiredFiles } from '../tools/migrate/content.ts';
import { activityProblem } from '../tools/migrate/main.ts';
import { formatReport, type MigrationReport, type OldAccounts } from '../tools/migrate/model.ts';
import { APPLY_REFUSAL, ENTRA_ISSUER, NO_PORTAL_ROWS, buildMapping, letterjoinUserKey, migratePlayerData, type LetterjoinUserKey, parseCommand, parseConfirmation, type PlayerDataMapping } from '../tools/migrate/player-data.ts';
import { runContent, runPlayerData, type Connection, type Io } from '../tools/migrate/shell.ts';
import { JPEG_BYTES, PNG_BYTES, blob, oldAccounts, sha256, type OldData } from './support/old-accounts.ts';
import { gameId } from './support/ids.ts';

const DRAWPAD = gameId('drawpad');
const LETTERJOIN = gameId('letterjoin');
const OID_ADA = '11111111-1111-4111-8111-111111111111';
const OID_BEN = '22222222-2222-4222-8222-222222222222';
const OID_ADMIN = '33333333-3333-4333-8333-333333333333';
const ACTIVITY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTIVITY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADA_EMAIL = 'Ada.Kid@Example.com';
const BEN_EMAIL = 'ben.kid@example.com';
const NOW = new Date('2026-10-19T20:00:00Z');

const adaKey = sha256('ada.kid@example.com');
const benKey = sha256(BEN_EMAIL);

const PBN = JSON.stringify({ width: 64, height: 48, palette: ['#ff0000'], regions: [] });
const text = (value: string) => new TextEncoder().encode(value);

const pictureFiles = (id: string, names: readonly string[]) =>
	Object.fromEntries(names.map((name) => [`${id}/${name}`, name.endsWith('.jpg') ? blob(JPEG_BYTES, 'image/jpeg') : name.endsWith('.json') ? blob(text(PBN), 'application/json') : blob(PNG_BYTES, 'image/png')]));

const ALL_FILES = ['original.jpg', 'outline.png', 'pbn.json', 'pbn-regions.png', 'pbn-preview.png'];

const activityRow = (id: string, order: number, extra: Record<string, unknown> = {}): Row => ({
	partitionKey: 'activity',
	rowKey: id,
	type: 'sentence',
	title: `Sentence ${order}`,
	description: '',
	status: 'published',
	order,
	updatedAt: '2026-09-01T10:00:00.000Z',
	body: JSON.stringify({ text: 'The cat sat.', timeLimitSec: null, mode: 'trace', letterStyle: 'print', allowedStyles: ['print'], paper: 'fourLine', lineSize: 'medium' }),
	...extra,
});

const submissionIdFor = (minute: number) => submissionId(new Date(Date.UTC(2026, 9, 1, 10, minute)), new Uint8Array(10).fill(minute));

function submissionRows(userKey: string, email: string, id: string, extra: Record<string, unknown>): Row[] {
	return [
		{
			partitionKey: 'all',
			rowKey: sortKey(id),
			id,
			userKey,
			email,
			activityId: ACTIVITY_A,
			activityTitle: 'Sentence 1',
			blobName: `${userKey}/${id}.png`,
			contentType: 'image/png',
			bytes: PNG_BYTES.length,
			createdAt: '2026-10-01T10:00:00.000Z',
			reviewed: false,
			note: '',
			...extra,
		},
		{ partitionKey: userKey, rowKey: `${ACTIVITY_A}_${sortKey(id)}`, id },
	];
}

const SUB_ADA = submissionIdFor(1);
const SUB_ADA_PLAIN = submissionIdFor(2);
const SUB_BEN = submissionIdFor(3);

function drawpadOld(): OldData {
	return {
		tables: {
			pictures: [
				{ partitionKey: 'p', rowKey: 'pic1', title: 'Cat', kinds: 'trace,pbn', width: 64, height: 48, createdAt: '2026-09-01T00:00:00.000Z' },
				{ partitionKey: 'p', rowKey: 'pic2', title: 'Dog', kinds: 'trace', width: 64, height: 48, createdAt: '2026-09-02T00:00:00.000Z' },
				{ partitionKey: 'p', rowKey: 'pic3', title: 'Owl', kinds: 'trace', width: 64, height: 48, createdAt: '2026-09-03T00:00:00.000Z' },
			],
			settings: [{ partitionKey: 's', rowKey: 'default', dailyLimitMinutes: 45 }],
			drawings: [
				{ partitionKey: OID_ADA, rowKey: 'd1', pictureId: 'pic1', kind: 'trace', status: 'finished', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z', score: '{"total":80,"stars":4,"breakdown":{}}', filledRegions: '[1,2]' },
				{ partitionKey: OID_BEN, rowKey: 'd2', pictureId: 'pic1', kind: 'pbn', status: 'in-progress', createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:05:00.000Z' },
			],
			usage: [
				{ partitionKey: OID_ADA, rowKey: '2026-10-19', seconds: 120 },
				{ partitionKey: OID_BEN, rowKey: '2026-10-19', seconds: 30 },
			],
			profiles: [
				{ partitionKey: 'p', rowKey: OID_ADA, email: ADA_EMAIL, name: 'Ada', role: 'child', timeZone: 'Europe/London', dailyLimitMinutes: 30, createdAt: '2026-09-01T00:00:00.000Z' },
				{ partitionKey: 'p', rowKey: OID_BEN, email: BEN_EMAIL, name: 'Ben', role: 'child', timeZone: 'Europe/London', dailyLimitMinutes: 20, createdAt: '2026-09-01T00:00:00.000Z' },
				{ partitionKey: 'p', rowKey: OID_ADMIN, email: 'owner@example.com', name: 'Owner', role: 'admin', timeZone: 'Europe/London', createdAt: '2026-09-01T00:00:00.000Z' },
			],
		},
		containers: {
			pictures: { ...pictureFiles('pic1', ALL_FILES), ...pictureFiles('pic2', ['original.jpg']), ...pictureFiles('pic3', ['outline.png']), ...pictureFiles('gone', ['original.jpg']) },
			drawings: { [`${OID_ADA}/d1.png`]: blob(PNG_BYTES, 'image/png'), [`${OID_BEN}/d2.png`]: blob(PNG_BYTES, 'image/png') },
		},
	};
}

function letterjoinOld(): OldData {
	return {
		tables: {
			activities: [activityRow(ACTIVITY_A, 1), activityRow(ACTIVITY_B, 2, { body: '{not json' }), { partitionKey: 'setting', rowKey: 'app', dailyPracticeMinutes: 15 }],
			results: [
				{ partitionKey: adaKey, rowKey: ACTIVITY_A, score: 91.5, timeMs: 12000, hard: true, completedAt: '2026-10-18T09:00:00.000Z' },
				{ partitionKey: `practice-${adaKey}`, rowKey: '2026-10-18', seconds: 300, email: ADA_EMAIL.toLowerCase() },
				{ partitionKey: benKey, rowKey: ACTIVITY_A, score: 70, timeMs: 9000, completedAt: '2026-10-18T09:00:00.000Z' },
			],
			attempts: [
				{ partitionKey: adaKey, rowKey: CAT, activityId: ACTIVITY_A, level: 'explorer', chars: 10, score: 91.5, timeMs: 12000, hard: true, completedAt: '2026-10-18T09:00:00.000Z' },
				{ partitionKey: benKey, rowKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', activityId: ACTIVITY_A, level: 'explorer', chars: 10, score: 70, timeMs: 9000, completedAt: '2026-10-18T09:00:00.000Z' },
			],
			submissions: [
				...submissionRows(adaKey, ADA_EMAIL.toLowerCase(), SUB_ADA, { reviewed: true, reviewedBy: 'owner@example.com', reviewedAt: '2026-10-02T08:00:00.000Z', note: 'Lovely' }),
				...submissionRows(adaKey, ADA_EMAIL.toLowerCase(), SUB_ADA_PLAIN, {}),
				...submissionRows(benKey, BEN_EMAIL, SUB_BEN, {}),
			],
		},
		containers: {
			submissions: {
				[`${adaKey}/${SUB_ADA}.png`]: blob(PNG_BYTES, 'image/png'),
				[`${adaKey}/${SUB_ADA_PLAIN}.png`]: blob(PNG_BYTES, 'image/png'),
				[`${benKey}/${SUB_BEN}.png`]: blob(PNG_BYTES, 'image/png'),
			},
		},
	};
}

type Fixture = { readonly from: OldAccounts & { readonly touched: Set<string> } };

const fixture = (): Fixture => ({ from: oldAccounts(drawpadOld(), letterjoinOld()) });

const writes = (accounts: MemoryAccounts) => accounts.ops.filter((op) => op.write).length;

async function invite(accounts: MemoryAccounts, people: readonly { email: string; objectId: string }[]): Promise<Map<string, PortalUserId>> {
	const portal = accounts.open('portal');
	const admin = portalAdminStore(
		{ members: portal.table('members'), identities: portal.table('identities'), emails: portal.table('emails'), profiles: portal.table('profiles'), admins: portal.table('admins') },
		() => crypto.randomUUID(),
	);
	const ids = new Map<string, PortalUserId>();
	for (const { email, objectId } of people) {
		const parsed = parseEmail(email);
		assert.ok(parsed);
		const userId = await admin.userIdFor(parsed);
		const oid = parseEntraObjectId(objectId);
		assert.ok(oid);
		await admin.recordIdentity(oid, userId);
		ids.set(objectId, userId);
	}
	return ids;
}

async function invitedBoth(accounts: MemoryAccounts) {
	const ids = await invite(accounts, [
		{ email: ADA_EMAIL, objectId: OID_ADA },
		{ email: BEN_EMAIL, objectId: OID_BEN },
	]);
	const ada = ids.get(OID_ADA);
	const ben = ids.get(OID_BEN);
	assert.ok(ada && ben);
	return { ada, ben, mapping: buildMapping(await readPortal(accounts)) };
}

const counts = (report: MigrationReport, name: string) => report.plan.counts[name];

test('content dry run reports counts, rejects what the new apps would not accept, and writes nothing', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const report = await migrateContent({ mode: 'dry-run', target: newAccounts(accounts) }, from, { activityProblem });

	assert.deepEqual(counts(report, 'drawpad/pictures'), { planned: 8, present: 0, rejected: 3 });
	assert.deepEqual(counts(report, 'drawpad/settings'), { planned: 1, present: 0, rejected: 0 });
	assert.deepEqual(counts(report, 'letterjoin/activities'), { planned: 2, present: 0, rejected: 1 });
	assert.equal(writes(accounts), 0);
	const reasons = report.plan.rejected.map((r) => r.reason);
	assert.ok(reasons.some((reason) => reason.includes('file its kinds need is missing')));
	assert.ok(reasons.some((reason) => reason.includes('files with no copyable picture row')));
	assert.ok(reasons.some((reason) => reason === 'an activity body is not JSON'));
});

test('content apply makes the library, default limit and activities readable by the new apps, and a second apply writes nothing', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const target = newAccounts(accounts);
	const first = await migrateContent({ mode: 'apply', target }, from, { activityProblem });

	assert.equal(first.outcomes['drawpad/pictures']?.written, 8);
	const library = drawpadAdmin(storageFor(drawpad, 'admin', accounts.open(DRAWPAD)));
	assert.deepEqual((await library.pictures()).map((picture) => [picture.id, picture.title, picture.kinds]), [['pic1', 'Cat', ['trace', 'pbn']], ['pic3', 'Owl', ['trace']]]);
	assert.deepEqual((await library.pictureFiles('pic1')).sort(), [...ALL_FILES].sort());
	const original = await library.pictureFile('pic1/original.jpg', undefined);
	assert.ok(original && original !== 'not-modified');
	assert.deepEqual([...original.bytes], [...JPEG_BYTES]);
	assert.equal(original.contentType, 'image/jpeg');
	const limits = await library.limits([], NOW);
	assert.equal(limits.defaultMinutes, 45);

	const lj = letterjoinPlay(storageFor(letterjoin, 'play', accounts.open(LETTERJOIN)));
	assert.deepEqual((await lj.activities()).map((activity) => activity.id), [ACTIVITY_A]);
	assert.deepEqual(await lj.settings(), { dailyPracticeMinutes: 15, hardModeDefault: false });

	const before = writes(accounts);
	const second = await migrateContent({ mode: 'apply', target }, from, { activityProblem });
	assert.deepEqual(second.plan.actions, []);
	assert.equal(writes(accounts), before);
	assert.equal(counts(second, 'drawpad/pictures')?.planned, 0);
});

test('content apply never overwrites what the new app already holds', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const library = accounts.open(DRAWPAD);
	await library.table('settings').put({ partitionKey: 's', rowKey: 'default', dailyLimitMinutes: 90 });
	const report = await migrateContent({ mode: 'apply', target: newAccounts(accounts) }, from, { activityProblem });

	assert.equal(counts(report, 'drawpad/settings')?.present, 1);
	assert.equal((await library.table('settings').get('s', 'default'))?.['dailyLimitMinutes'], 90);
});

test('the old accounts are only listed and read, never written', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const { mapping } = await invitedBoth(accounts);
	const target = newAccounts(accounts);
	await migrateContent({ mode: 'apply', target }, from, { activityProblem });
	await migratePlayerData({ mode: 'apply', mapping, target, confirmation: parseConfirmation(['--apply', '--confirm-player-data'])! }, from);

	assert.deepEqual([...from.touched].sort(), ['container', 'get', 'list', 'table']);
});

test('the mapping comes from the portal tables, as the admin app writes them', async () => {
	const accounts = memoryAccounts();
	const { ada, ben, mapping } = await invitedBoth(accounts);

	assert.equal(mapping.drawpad.get(OID_ADA as EntraObjectId), ada);
	assert.equal(mapping.drawpad.get(OID_BEN as EntraObjectId), ben);
	assert.equal(mapping.letterjoin.get(adaKey as LetterjoinUserKey), ada);
	assert.equal(mapping.letterjoin.get(letterjoinUserKey(parseEmail(BEN_EMAIL)!)), ben);
	assert.equal(mapping.drawpad.size, 2);
	assert.equal(ENTRA_ISSUER, ENTRA);
});

test('with no portal rows every player key is reported unmapped with its row and file counts, and nothing is written', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const report = await migratePlayerData({ mode: 'dry-run', mapping: buildMapping(NO_PORTAL_ROWS), target: newAccounts(accounts) }, from);

	assert.equal(report.plan.actions.length, 0);
	assert.equal(writes(accounts), 0);
	const drawpadKeys = report.plan.unmapped.filter((u) => u.game === 'drawpad');
	assert.deepEqual(drawpadKeys.map((u) => [u.oldKey, u.rows, u.files]).sort(), [[OID_ADA, 3, 1], [OID_BEN, 3, 1]]);
	const letterjoinKeys = report.plan.unmapped.filter((u) => u.game === 'letterjoin');
	assert.deepEqual(letterjoinKeys.map((u) => [u.oldKey, u.rows, u.files]).sort(), [[adaKey, 7, 2], [benKey, 4, 1]].sort());
	const lines = formatReport(report);
	assert.ok(lines.some((line) => line.includes('2 unmapped keys')));
	assert.ok(lines.every((line) => !line.includes(OID_ADA) && !line.includes(adaKey) && !line.includes('@')));
});

test('player data re-keys to PortalUserId and the new apps read it back', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const { ada, ben, mapping } = await invitedBoth(accounts);
	const target = newAccounts(accounts);
	const confirmation = parseConfirmation(['--apply', '--confirm-player-data']);
	assert.ok(confirmation);
	const report = await migratePlayerData({ mode: 'apply', mapping, target, confirmation }, from);
	assert.deepEqual(report.plan.unmapped, []);

	const dp = accounts.open(DRAWPAD);
	const play = drawpadPlay(storageFor(drawpad, 'play', dp));
	const adaDrawings = await play.drawings(ada);
	assert.deepEqual(adaDrawings.map((d) => [d.id, d.pictureId, d.status, d.score?.total, d.filledRegions]), [['d1', 'pic1', 'finished', 80, [1, 2]]]);
	const image = await play.drawingImage(ada, 'd1', undefined);
	assert.ok(image && image !== 'not-modified');
	assert.deepEqual([...image.bytes], [...PNG_BYTES]);
	assert.equal((await play.drawings(ben)).length, 1);
	assert.equal((await play.usage({ userId: ada, timeZone: 'Europe/London' }, NOW)).usedSeconds, 120);
	const limits = await drawpadAdmin(storageFor(drawpad, 'admin', dp)).limits([{ userId: ada, name: 'Ada', timeZone: 'Europe/London' }, { userId: ben, name: 'Ben', timeZone: 'Europe/London' }], NOW);
	assert.deepEqual(limits.children.map((c) => [c.userId, c.dailyLimitMinutes]), [[ada, 30], [ben, 20]]);

	const lj = accounts.open(LETTERJOIN);
	const ljPlay = letterjoinPlay(storageFor(letterjoin, 'play', lj));
	const results = await ljPlay.results(ada);
	assert.deepEqual([...results.entries()], [[ACTIVITY_A, { score: 91.5, timeMs: 12000, hard: true, completedAt: '2026-10-18T09:00:00.000Z' }]]);
	assert.deepEqual((await ljPlay.attempts(ada, '2026-01-01')).map((a) => [a.id, a.hard]), [[CAT, true]]);
	assert.equal(await ljPlay.practiceSeconds(ada, '2026-10-18'), 300);
	assert.deepEqual((await ljPlay.submissionIdsFor(ada, ACTIVITY_A)).sort(), [SUB_ADA, SUB_ADA_PLAIN].sort());
	const ljAdmin = letterjoinAdmin(storageFor(letterjoin, 'admin', lj));
	const submissions = await ljAdmin.submissions();
	assert.deepEqual(submissions.map((s) => s.userId).sort(), [ada, ada, ben].sort());
	const kept = submissions.find((s) => s.id === SUB_ADA);
	assert.equal(kept?.blobName, `${ada}/${SUB_ADA}.png`);
	assert.deepEqual([...((await ljAdmin.submissionImage(SUB_ADA)) ?? [])], [...PNG_BYTES]);
	const reviews = await ljAdmin.reviews();
	assert.deepEqual([...reviews.keys()], [SUB_ADA]);
	assert.deepEqual(reviews.get(SUB_ADA), { reviewed: true, discarded: false, note: 'Lovely', reviewedAt: '2026-10-02T08:00:00.000Z' });
});

test('no email, name or time zone reaches a new row', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const { mapping } = await invitedBoth(accounts);
	const confirmation = parseConfirmation(['--apply', '--confirm-player-data']);
	assert.ok(confirmation);
	await migratePlayerData({ mode: 'apply', mapping, target: newAccounts(accounts), confirmation }, from);

	for (const [game, tables] of [['drawpad', ['drawings', 'usage', 'settings']], ['letterjoin', ['results', 'attempts', 'submissions', 'reviews']]] as const) {
		for (const table of tables) {
			for (const row of await accounts.open(gameId(game)).table(table).list()) {
				for (const field of ['email', 'name', 'timeZone', 'userKey', 'reviewedBy']) assert.equal(Object.hasOwn(row, field), false, `${game}/${table} has ${field}`);
			}
		}
	}
});

test('a second player-data apply writes nothing and a row the portal already holds is not overwritten', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const { ada, mapping } = await invitedBoth(accounts);
	const target = newAccounts(accounts);
	const dp = accounts.open(DRAWPAD);
	await dp.table('usage').put({ partitionKey: ada, rowKey: '2026-10-19', seconds: 5 });
	const confirmation = parseConfirmation(['--apply', '--confirm-player-data']);
	assert.ok(confirmation);
	const first = await migratePlayerData({ mode: 'apply', mapping, target, confirmation }, from);

	assert.equal(counts(first, 'drawpad/usage')?.present, 1);
	assert.equal((await dp.table('usage').get(ada, '2026-10-19'))?.['seconds'], 5);

	const before = writes(accounts);
	const second = await migratePlayerData({ mode: 'apply', mapping, target, confirmation }, from);
	assert.deepEqual(second.plan.actions, []);
	assert.equal(writes(accounts), before);
});

test('a half-finished apply is completed by the next run', async () => {
	const accounts = memoryAccounts();
	const { from } = fixture();
	const { ada, mapping } = await invitedBoth(accounts);
	const dp = accounts.open(DRAWPAD);
	await dp.container('drawings').put(`${ada}/d1.png`, PNG_BYTES, 'image/png');
	const confirmation = parseConfirmation(['--apply', '--confirm-player-data']);
	assert.ok(confirmation);
	const report = await migratePlayerData({ mode: 'apply', mapping, target: newAccounts(accounts), confirmation }, from);

	assert.equal(counts(report, 'drawpad/drawings')?.present, 1);
	assert.equal((await drawpadPlay(storageFor(drawpad, 'play', dp)).drawings(ada)).length, 1);
});

test('apply is refused without both flags, and nothing is written', async () => {
	for (const flags of [['--apply'], ['--confirm-player-data']]) {
		const accounts = memoryAccounts();
		await invitedBoth(accounts);
		const lines: string[] = [];
		const before = writes(accounts);
		const io: Io = { print: (line) => void lines.push(line), connect: async (): Promise<Connection> => ({ from: fixture().from, to: newAccounts(accounts), readPortal: () => readPortal(accounts) }) };
		const code = await runPlayerData(['--suffix', 'abcde', ...flags], io);

		assert.equal(code, 2);
		assert.equal(lines.at(-1), APPLY_REFUSAL);
		assert.equal(writes(accounts), before);
		assert.equal(parseConfirmation(flags), null);
		assert.equal(parseCommand(flags).kind, 'dry-run');
	}
});

test('apply with both flags writes, and a plain run prints the closing refusal line without writing', async () => {
	const accounts = memoryAccounts();
	await invitedBoth(accounts);
	const lines: string[] = [];
	const io: Io = { print: (line) => void lines.push(line), connect: async () => ({ from: fixture().from, to: newAccounts(accounts), readPortal: () => readPortal(accounts) }) };
	const before = writes(accounts);

	assert.equal(await runPlayerData(['--suffix', 'abcde'], io), 0);
	assert.equal(writes(accounts), before);
	assert.match(lines.at(-1) ?? '', /^Nothing was written\. Applying needs --apply --confirm-player-data/);
	assert.ok(lines.some((line) => line.includes('names and time zones')));

	assert.equal(await runPlayerData(['--suffix', 'abcde', '--apply', '--confirm-player-data'], io), 0);
	assert.ok(writes(accounts) > before);
});

test('content migration never reads the portal, so it runs without access to the sign-in tables', async () => {
	const lines: string[] = [];
	const refused = Object.assign(new Error('AuthorizationPermissionMismatch'), { statusCode: 403 });
	const io: Io = { print: (line) => void lines.push(line), connect: async () => ({ from: fixture().from, to: newAccounts(memoryAccounts()), readPortal: () => Promise.reject(refused) }) };

	assert.equal(await runContent(['--suffix', 'abcde'], io, { activityProblem }), 0);
	assert.ok(lines.some((line) => line.startsWith('drawpad/pictures: to write 8')));
});

test('without a suffix a dry run plans against empty accounts and an apply is refused', async () => {
	const lines: string[] = [];
	const io: Io = { print: (line) => void lines.push(line), connect: async () => ({ from: fixture().from, to: null, readPortal: async () => NO_PORTAL_ROWS }) };

	assert.equal(await runContent([], io, { activityProblem }), 0);
	assert.ok(lines.some((line) => line.includes('No --suffix')));
	assert.ok(lines.some((line) => line.startsWith('drawpad/pictures: to write 8')));
	assert.equal(await runContent(['--apply'], io, { activityProblem }), 2);
	assert.equal(await runPlayerData(['--apply', '--confirm-player-data'], io), 2);
	assert.equal(await runContent(['--confirm-player-data'], io, { activityProblem }), 2);
});

test('a picture is copied when the files the player needs exist, even if its original photo is gone', () => {
	for (const kinds of [['trace'], ['pbn'], ['trace', 'pbn']] as const) {
		const upload = requiredPictureFiles({ kinds: [...kinds] });
		assert.ok(upload.filter((file) => file !== 'original.jpg').every((file) => requiredFiles(kinds).includes(file)));
		assert.ok(requiredFiles(kinds).every((file) => upload.includes(file) || file === 'pbn.json'));
	}
});

test('the mapping type is built only from portal rows', () => {
	const empty: PlayerDataMapping = buildMapping(NO_PORTAL_ROWS);
	assert.equal(empty.drawpad.size + empty.letterjoin.size, 0);
});
