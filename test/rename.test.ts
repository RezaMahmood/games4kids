import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSave, renamedToday, type StoredProfile } from '@g4k/host';

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
	{ name: 'a save that keeps the name keeps renamedAt, even when the time zone changes', stored: ada('2026-10-19T08:00:00Z'), next: save('Ada', 'Pacific/Auckland'), now: '2026-10-19T20:00:00Z', expected: { kind: 'write', renamedAt: '2026-10-19T08:00:00Z' } },
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
