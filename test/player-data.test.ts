import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPlayers, formatTimeline, mentioning, parseTimeline, parseUserId, timelineQuery, type UserId } from '../tools/player-data.ts';

const KITTY = 'b463e4c9-3af9-40c3-8f4a-e95486340aed' as UserId;
const OLI = '667e525d-ef10-48f4-9bb7-fba1152db437';

const profiles = [
	{ PartitionKey: 'profile', RowKey: KITTY, displayName: 'Cutest Hello Kitty ever', timeZone: 'Europe/London' },
	{ PartitionKey: 'profile', RowKey: OLI, displayName: 'Oli buck buck', timeZone: 'Europe/London' },
];
const members = [{ PartitionKey: 'member', RowKey: KITTY, state: 'active', games: '*' }];

test('a child is found by part of their name, ignoring case, or by their exact id', () => {
	assert.deepEqual(findPlayers(profiles, members, 'KITTY'), [{ userId: KITTY, name: 'Cutest Hello Kitty ever', timeZone: 'Europe/London', state: 'active', games: '*' }]);
	assert.deepEqual(findPlayers(profiles, members, OLI.toUpperCase()).map((player) => player.name), ['Oli buck buck']);
	assert.equal(findPlayers(profiles, members, OLI).at(0)?.state, 'no member row', 'a profile without a member row says so');
	assert.equal(findPlayers(profiles, members, 'buck').length, 1);
	assert.deepEqual(findPlayers(profiles, members, 'nobody'), []);
});

test("a child's rows are found however the game keys them, and another child's are not", () => {
	const rows = [
		{ PartitionKey: KITTY, RowKey: 'a1', score: 97, 'odata.etag': 'W/"x"', etag: 'W/"x"' },
		{ PartitionKey: `practice-${KITTY}`, RowKey: '2026-10-22', seconds: 1200 },
		{ PartitionKey: 'board', RowKey: KITTY, since: '2026-10-22T18:55:19.434Z' },
		{ PartitionKey: 'email', RowKey: 'kitty@example.test', userId: KITTY.toUpperCase() },
		{ PartitionKey: OLI, RowKey: 'a2', score: 50 },
		{ PartitionKey: 'board', RowKey: OLI, since: '2026-10-22T18:19:17.850Z' },
	];
	const found = mentioning(KITTY, 'letterjoin', 'results', rows);
	assert.deepEqual(found.map((row) => `${row.partitionKey} | ${row.rowKey}`), [`${KITTY} | a1`, `practice-${KITTY} | 2026-10-22`, `board | ${KITTY}`, 'email | kitty@example.test']);
	assert.deepEqual(found[0]?.fields, { score: 97 }, 'keys and etags are not repeated as fields');
});

test('only a user id reaches a query, so a name or KQL cannot', () => {
	assert.equal(parseUserId(KITTY.toUpperCase()), KITTY);
	assert.equal(parseUserId(`${KITTY}' or 1==1 //`), null);
	assert.equal(parseUserId('Cutest Hello Kitty ever'), null);
	const query = timelineQuery(KITTY, new Date('2026-10-22T18:00:00Z'), new Date('2026-10-22T19:00:00Z'));
	assert.match(query, /datetime\(2026-10-22T18:00:00\.000Z\).*datetime\(2026-10-22T19:00:00\.000Z\)/);
	assert.match(query, new RegExp(`data has '${KITTY}'`));
});

/** One row as `az monitor app-insights query` printed it for the switch-off at 18:55:18. */
const REPLY = {
	tables: [
		{
			columns: ['timestamp', 'name', 'resultCode', 'role', 'itemCount', 'writes', 'tables', 'errors'].map((name) => ({ name })),
			rows: [
				[
					'2026-10-22T18:55:18.7512327Z',
					'PUT api/g/letterjoin/board/me',
					'200',
					'func-g4k-letterjoin',
					1,
					'["TableClient.deleteEntity"]',
					JSON.stringify([
						"g4kportal347up/identities(PartitionKey='identity',RowKey='entra%7C4fb357f4-2f09-4f22-9996-067e1802baf2') 200",
						'g4kportal347up/games()?%24filter=REDACTED 200',
						`g4kportal347up/members(PartitionKey='member',RowKey='${KITTY}') 200`,
						`g4kportal347up/profiles(PartitionKey='profile',RowKey='${KITTY}') 200`,
						`g4kletterjoin347up/results(PartitionKey='board',RowKey='${KITTY}') 204`,
					]),
					null,
				],
				['2026-10-22T18:55:19.4175077Z', 'PUT api/g/letterjoin/board/me', '200', 'func-g4k-letterjoin', 3, '["TableClient.createEntity"]', '["g4kletterjoin347up/results 204"]', '["boom"]'],
			],
		},
	],
};

test('the timeline shows each write, hides the reads admission makes on every request, and flags sampled rows', () => {
	const entries = parseTimeline(REPLY);
	assert.deepEqual(entries.map((entry) => entry.writes), [['delete'], ['create']]);
	assert.deepEqual(formatTimeline(entries), [
		'2026-10-22T18:55:18.7512327Z  PUT api/g/letterjoin/board/me  200  func-g4k-letterjoin  writes: delete',
		`    g4kletterjoin347up/results(PartitionKey='board',RowKey='${KITTY}') 204`,
		'2026-10-22T18:55:19.4175077Z  PUT api/g/letterjoin/board/me  200  func-g4k-letterjoin  (sampled: more requests stand behind this row)  writes: create',
		'    g4kletterjoin347up/results 204',
		'    error: boom',
	]);
	assert.ok(formatTimeline(entries, { all: true }).includes("    g4kportal347up/identities(PartitionKey='identity',RowKey='entra|4fb357f4-2f09-4f22-9996-067e1802baf2') 200"), '--all keeps them, decoded');
	assert.deepEqual(parseTimeline({ tables: [] }), []);
});
