import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameId } from '@g4k/sdk';
import { decide, ENTRA, meFor, type Admission, type Found, type GameGrant, type Member } from '@g4k/host';
import { gameId, portalUserId } from './support/ids.ts';

const fixture = gameId('fixture');
const other = gameId('drawpad');
const userId = portalUserId('0f8fad5b-d9cb-469f-a165-70867728950e');
const profile = { displayName: 'Ada', timeZone: 'Europe/London' };
const some = (...ids: GameId[]): GameGrant => ({ kind: 'some', ids });
const all: GameGrant = { kind: 'all' };
const member = (state: Member['state'], games: GameGrant): Member => ({ userId, state, games });
const known = (m: Member | undefined, p: typeof profile | null = profile): Found => ({ kind: 'known', userId, member: m, profile: p ?? undefined });
const caller = { userId, ...profile };

const cases: readonly { readonly name: string; readonly found: Found; readonly game: GameId | null; readonly paused?: readonly GameId[]; readonly expected: Admission }[] = [
	{ name: 'unknown identity', found: { kind: 'unknown' }, game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'unknown identity at the portal', found: { kind: 'unknown' }, game: null, expected: { kind: 'not-invited' } },
	{ name: 'identity with no member row', found: known(undefined), game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'revoked member granted the game', found: known(member('revoked', some(fixture))), game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'revoked member at the portal', found: known(member('revoked', some(fixture))), game: null, expected: { kind: 'not-invited' } },
	{ name: 'active member without a profile', found: known(member('active', some(fixture)), null), game: fixture, expected: { kind: 'no-profile', userId } },
	{ name: 'active member without a profile at the portal', found: known(member('active', some()), null), game: null, expected: { kind: 'no-profile', userId } },
	{ name: 'no profile outranks not entitled', found: known(member('active', some(other)), null), game: fixture, expected: { kind: 'no-profile', userId } },
	{ name: 'active member without the game', found: known(member('active', some(other))), game: fixture, expected: { kind: 'not-entitled' } },
	{ name: 'active member with no games at all', found: known(member('active', some())), game: fixture, expected: { kind: 'not-entitled' } },
	{ name: 'active member granted the game', found: known(member('active', some(other, fixture))), game: fixture, expected: { kind: 'player', caller, games: some(other, fixture) } },
	{ name: 'active member at the portal sees every granted game', found: known(member('active', some(other))), game: null, expected: { kind: 'player', caller, games: some(other) } },
	{ name: 'active member with no games at the portal is still a player', found: known(member('active', some())), game: null, expected: { kind: 'player', caller, games: some() } },
	{ name: 'all-games member at a game', found: known(member('active', all)), game: fixture, expected: { kind: 'player', caller, games: all } },
	{ name: 'all-games member at a game registered after the row', found: known(member('active', all)), game: gameId('latecomer'), expected: { kind: 'player', caller, games: all } },
	{ name: 'revoked all-games member', found: known(member('revoked', all)), game: fixture, expected: { kind: 'not-invited' } },
	{ name: 'all-games member without a profile', found: known(member('active', all), null), game: fixture, expected: { kind: 'no-profile', userId } },
	{ name: 'paused game granted to the member', found: known(member('active', some(fixture))), game: fixture, paused: [fixture], expected: { kind: 'paused' } },
	{ name: 'paused game for an all-games member', found: known(member('active', all)), game: fixture, paused: [fixture], expected: { kind: 'paused' } },
	{ name: 'paused game not granted stays not entitled', found: known(member('active', some(other))), game: fixture, paused: [fixture], expected: { kind: 'not-entitled' } },
	{ name: 'another game paused', found: known(member('active', some(fixture))), game: fixture, paused: [other], expected: { kind: 'player', caller, games: some(fixture) } },
	{ name: 'paused game for a revoked member', found: known(member('revoked', some(fixture))), game: fixture, paused: [fixture], expected: { kind: 'not-invited' } },
	{ name: 'paused game for a member without a profile', found: known(member('active', some(fixture)), null), game: fixture, paused: [fixture], expected: { kind: 'no-profile', userId } },
];

for (const { name, found, game, paused = [], expected } of cases) {
	test(`decide: ${name}`, () => {
		assert.deepEqual(game === null ? decide(found, null) : decide(found, game, new Set(paused)), expected);
	});
}

test('meFor turns each portal admission into the state home routes on', () => {
	const identity = { issuer: ENTRA, subject: 'oid', email: null };
	const registered = [other, fixture];
	const none = new Set<GameId>();
	assert.deepEqual(meFor(identity, { kind: 'not-invited' }, registered, none), { state: 'not-invited', email: null });
	assert.deepEqual(meFor(identity, { kind: 'no-profile', userId }, registered, none), { state: 'no-profile' });
	assert.deepEqual(meFor(identity, { kind: 'player', caller, games: some(fixture) }, registered, none), { state: 'active', userId, profile, games: [{ id: fixture, paused: false }] });
});

test('meFor marks a granted game paused and never lists a paused game that is not granted', () => {
	const identity = { issuer: ENTRA, subject: 'oid', email: null };
	const paused = new Set([other, fixture]);
	assert.deepEqual(meFor(identity, { kind: 'player', caller, games: some(fixture) }, [other, fixture], paused), { state: 'active', userId, profile, games: [{ id: fixture, paused: true }] });
	assert.deepEqual(meFor(identity, { kind: 'player', caller, games: all }, [other, fixture], new Set([other])), {
		state: 'active',
		userId,
		profile,
		games: [
			{ id: other, paused: true },
			{ id: fixture, paused: false },
		],
	});
});

test('meFor lists every registered game for an all-games member', () => {
	const identity = { issuer: ENTRA, subject: 'oid', email: null };
	const latecomer = gameId('latecomer');
	assert.deepEqual(meFor(identity, { kind: 'player', caller, games: all }, [other, fixture, latecomer], new Set()), {
		state: 'active',
		userId,
		profile,
		games: [other, fixture, latecomer].map((id) => ({ id, paused: false })),
	});
});
