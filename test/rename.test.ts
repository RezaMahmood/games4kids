import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parsePortalUserId, type Row } from '@g4k/sdk';
import { memoryAccounts, planSave, portalStore, renamedToday, type StoredProfile } from '@g4k/host';

const at = (iso: string) => new Date(iso);
const ada = (renamedAt?: string, timeZone = 'Europe/London'): StoredProfile => ({ displayName: 'Ada', timeZone, ...(renamedAt === undefined ? {} : { renamedAt }) });
const save = (displayName: string, timeZone = 'Europe/London') => ({ displayName, timeZone });

const renameCases: readonly { readonly name: string; readonly stored: StoredProfile | undefined; readonly next: ReturnType<typeof save>; readonly now: string; readonly expected: ReturnType<typeof planSave> }[] = [
	{ name: 'the first name is not a rename and sets no renamedAt', stored: undefined, next: save('Ada'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: undefined } },
	{ name: 'a rename on a row that never renamed is allowed and stamps now', stored: ada(), next: save('Bea'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-19T20:00:00.000Z' } },
	{ name: 'a second rename on the same day is refused', stored: ada('2026-10-19T08:00:00Z'), next: save('Bea'), now: '2026-10-19T20:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a rename the next day is allowed', stored: ada('2026-10-18T20:00:00Z'), next: save('Bea'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-19T20:00:00.000Z' } },
	{ name: 'a change of case alone is a rename, so it is refused the same day', stored: ada('2026-10-19T08:00:00Z'), next: save('ADA'), now: '2026-10-19T20:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a change of case alone is allowed on a later day', stored: ada('2026-10-18T08:00:00Z'), next: save('ADA'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-19T20:00:00.000Z' } },
	{ name: 'a time zone change on a day the child renamed is refused, so a zone past midnight cannot reset the day', stored: ada('2026-10-19T09:50:00Z'), next: save('Ada', 'Pacific/Kiritimati'), now: '2026-10-19T10:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a save that keeps the name keeps renamedAt, and may change the time zone on a later day', stored: ada('2026-10-18T08:00:00Z'), next: save('Ada', 'Pacific/Auckland'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-18T08:00:00Z' } },
	{ name: 'a rename that also changes the time zone is refused, so a hand-made request cannot rename into a zone a minute from midnight', stored: ada(), next: save('Bea', 'Pacific/Kiritimati'), now: '2026-10-19T20:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a change of case that also changes the time zone is refused', stored: ada('2026-10-18T08:00:00Z'), next: save('ADA', 'Pacific/Auckland'), now: '2026-10-19T20:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a first profile picks its time zone with its name', stored: undefined, next: save('Ada', 'Pacific/Kiritimati'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: undefined } },
	{ name: 'a save that keeps the name and the zone on a day the child renamed is allowed', stored: ada('2026-10-19T08:00:00Z'), next: save('Ada'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-19T08:00:00Z' } },
	{ name: 'a save that keeps the name on a row that never renamed stamps nothing', stored: ada(), next: save('Ada', 'UTC'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: undefined } },
	{ name: 'one hour apart across local midnight in London is the next day', stored: ada('2026-10-18T22:30:00Z'), next: save('Bea'), now: '2026-10-18T23:30:00Z', expected: { kind: 'write', renamedAt: '2026-10-18T23:30:00.000Z' } },
	{ name: 'a rename in Auckland that is a different UTC day is still the same local day', stored: ada('2026-10-18T12:00:00Z', 'Pacific/Auckland'), next: save('Bea', 'Pacific/Auckland'), now: '2026-10-19T10:00:00Z', expected: { kind: 'refused' } },
	{ name: 'a rename in Auckland that is the same UTC day is a new local day', stored: ada('2026-10-18T10:00:00Z', 'Pacific/Auckland'), next: save('Bea', 'Pacific/Auckland'), now: '2026-10-18T12:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-18T12:00:00.000Z' } },
	{ name: 'the day is read in the stored time zone, not the one in the save', stored: ada('2026-10-19T08:00:00Z', 'UTC'), next: save('Bea', 'Pacific/Auckland'), now: '2026-10-19T20:00:00Z', expected: { kind: 'refused' } },
];

for (const { name, stored, next, now, expected } of renameCases) {
	test(`planSave: ${name}`, () => assert.deepEqual(planSave(stored, next, at(now)), expected));
}

test('renamedToday reads the calendar day in the given zone', () => {
	const now = at('2026-10-19T20:00:00Z');
	assert.equal(renamedToday(undefined, 'UTC', now), false);
	assert.equal(renamedToday('2026-10-19T00:00:00Z', 'UTC', now), true);
	assert.equal(renamedToday('2026-10-18T23:59:59Z', 'UTC', now), false);
	assert.equal(renamedToday('2026-10-19T20:00:00Z', 'Pacific/Auckland', at('2026-10-20T10:00:00Z')), true, '09:00 and 23:00 on the 20th in Auckland');
});

/** One child, and a store whose next read of the profiles is followed by a save from `other`, as if from a second tab. */
function twoTabs() {
	const portal = memoryAccounts().open('portal');
	const tables = { identities: portal.table('identities'), members: portal.table('members'), games: portal.table('games'), profiles: portal.table('profiles') };
	let afterRead: (() => Promise<unknown>) | undefined;
	const profiles = {
		...tables.profiles,
		async inPartition<R extends Row>(partitionKey: string) {
			const rows = await tables.profiles.inPartition<R>(partitionKey);
			const run = afterRead;
			afterRead = undefined;
			await run?.();
			return rows;
		},
	};
	const user = parsePortalUserId(randomUUID());
	if (!user) throw new Error('a UUID is a user id');
	return {
		user,
		tab: portalStore({ ...tables, profiles }),
		other: portalStore(tables),
		afterNextRead: (run: () => Promise<unknown>) => void (afterRead = run),
		stored: () => tables.profiles.get('profile', user),
	};
}

test('setProfile: a rename that read the row before another tab renamed it does not overwrite that rename', async () => {
	const { user, tab, other, afterNextRead, stored } = twoTabs();
	await other.setProfile(user, save('Ada'), at('2026-10-18T20:00:00Z'));
	const now = at('2026-10-19T20:00:00Z');
	afterNextRead(() => other.setProfile(user, save('Cleo'), now));
	assert.equal(await tab.setProfile(user, save('Bea'), now), 'rename_tomorrow');
	assert.equal((await stored())?.['displayName'], 'Cleo');
});

test('setProfile: a first profile that read no row before another tab saved one reads that row and saves over it as a rename', async () => {
	const { user, tab, other, afterNextRead, stored } = twoTabs();
	afterNextRead(() => other.setProfile(user, save('Ada'), at('2026-10-19T20:00:00Z')));
	assert.equal(await tab.setProfile(user, save('Bea'), at('2026-10-19T20:05:00Z')), 'ok');
	const row = await stored();
	assert.deepEqual([row?.['displayName'], row?.['renamedAt']], ['Bea', '2026-10-19T20:05:00.000Z']);
});
