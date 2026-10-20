import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameId } from '@g4k/sdk';
import { decide, ENTRA, meFor, type Admission, type Found, type Member } from '@g4k/host';
import { gameId, portalUserId } from './support/ids.ts';

const fixture = gameId('fixture');
const other = gameId('drawpad');
const userId = portalUserId('0f8fad5b-d9cb-469f-a165-70867728950e');
const profile = { displayName: 'Ada', timeZone: 'Europe/London' };
const member = (state: Member['state'], games: readonly GameId[]): Member => ({ userId, state, games });
const known = (m: Member | undefined, p: typeof profile | null = profile): Found => ({ kind: 'known', userId, member: m, profile: p ?? undefined });
const caller = { userId, ...profile };

const cases: readonly { readonly name: string; readonly found: Found; readonly game: GameId | null; readonly expected: Admission }[] = [
	{ name: 'unknown identity', found: { kind: 'unknown' }, game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'unknown identity at the portal', found: { kind: 'unknown' }, game: null, expected: { kind: 'not-invited' } },
	{ name: 'identity with no member row', found: known(undefined), game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'revoked member granted the game', found: known(member('revoked', [fixture])), game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'revoked member at the portal', found: known(member('revoked', [fixture])), game: null, expected: { kind: 'not-invited' } },
	{ name: 'active member without a profile', found: known(member('active', [fixture]), null), game: fixture, expected: { kind: 'no-profile', userId } },
	{ name: 'active member without a profile at the portal', found: known(member('active', []), null), game: null, expected: { kind: 'no-profile', userId } },
	{ name: 'no profile outranks not entitled', found: known(member('active', [other]), null), game: fixture, expected: { kind: 'no-profile', userId } },
	{ name: 'active member without the game', found: known(member('active', [other])), game: fixture, expected: { kind: 'not-entitled' } },
	{ name: 'active member with no games at all', found: known(member('active', [])), game: fixture, expected: { kind: 'not-entitled' } },
	{ name: 'active member granted the game', found: known(member('active', [other, fixture])), game: fixture, expected: { kind: 'player', caller, games: [other, fixture] } },
	{ name: 'active member at the portal sees every granted game', found: known(member('active', [other])), game: null, expected: { kind: 'player', caller, games: [other] } },
	{ name: 'active member with no games at the portal is still a player', found: known(member('active', [])), game: null, expected: { kind: 'player', caller, games: [] } },
];

for (const { name, found, game, expected } of cases) {
	test(`decide: ${name}`, () => {
		assert.deepEqual(game === null ? decide(found, null) : decide(found, game), expected);
	});
}

test('meFor turns each portal admission into the state home routes on', () => {
	const identity = { issuer: ENTRA, subject: 'oid', email: null };
	assert.deepEqual(meFor(identity, { kind: 'not-invited' }), { state: 'not-invited', email: null });
	assert.deepEqual(meFor(identity, { kind: 'no-profile', userId }), { state: 'no-profile' });
	assert.deepEqual(meFor(identity, { kind: 'player', caller, games: [fixture] }), { state: 'active', userId, profile, games: [fixture] });
});
