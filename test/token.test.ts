import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAdminToken, verifyGamesToken } from '@g4k/host';
import { ADMIN_CLIENT, fakeIdp } from './support/idp.ts';
import { newObjectId } from './support/world.ts';

const idp = await fakeIdp();
const oid = newObjectId();
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

const refused: readonly { readonly name: string; readonly authorization: () => Promise<string | null>; readonly code: 'unauthenticated' | 'invalid_token' }[] = [
	{ name: 'no header', authorization: async () => null, code: 'unauthenticated' },
	{ name: 'not a bearer token', authorization: async () => 'Basic dXNlcjpwYXNz', code: 'unauthenticated' },
	{ name: 'a games4kids-admin audience', authorization: async () => `Bearer ${await idp.gamesToken(oid, { audience: ADMIN_CLIENT })}`, code: 'invalid_token' },
	{ name: 'another tenant', authorization: async () => `Bearer ${await idp.gamesToken(oid, { claims: { tid: '99999999-2222-4333-8444-555555555555' } })}`, code: 'invalid_token' },
	{ name: 'a v1 token', authorization: async () => `Bearer ${await idp.gamesToken(oid, { claims: { ver: '1.0' } })}`, code: 'invalid_token' },
	{ name: 'no access_as_user scope', authorization: async () => `Bearer ${await idp.gamesToken(oid, { scp: 'User.Read' })}`, code: 'invalid_token' },
	{ name: 'an expired token', authorization: async () => `Bearer ${await idp.gamesToken(oid, { lifetimeSeconds: -120 })}`, code: 'invalid_token' },
	{ name: 'an oid that is not a GUID', authorization: async () => `Bearer ${await idp.gamesToken('not-a-guid')}`, code: 'invalid_token' },
	{ name: 'an untrusted issuer', authorization: async () => `Bearer ${await idp.untrustedToken(oid)}`, code: 'invalid_token' },
	{
		name: 'a tampered payload',
		authorization: async () => {
			const [header, , signature] = (await idp.gamesToken(oid)).split('.');
			return `Bearer ${header}.${b64({ iss: idp.games.issuer, aud: idp.games.audience, oid: newObjectId(), scp: 'access_as_user' })}.${signature}`;
		},
		code: 'invalid_token',
	},
	{
		name: 'an unsigned alg none token',
		authorization: async () => `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: idp.games.issuer, aud: idp.games.audience, oid, scp: 'access_as_user', ver: '2.0' })}.`,
		code: 'invalid_token',
	},
];

for (const { name, authorization, code } of refused) {
	test(`verifyGamesToken refuses ${name}`, async () => {
		assert.deepEqual(await verifyGamesToken([idp.games], await authorization()), { ok: false, code });
	});
}

test('verifyGamesToken admits a games4kids token and unwraps a guest UPN to the email', async () => {
	const token = await idp.gamesToken(oid, { claims: { upn: 'jane.doe_outlook.com#EXT#@owner.onmicrosoft.com' } });
	assert.deepEqual(await verifyGamesToken([idp.games], `Bearer ${token}`), { ok: true, identity: { issuer: 'entra', subject: oid, email: 'jane.doe@outlook.com' } });
});

test('verifyAdminToken refuses a games4kids token and admits a games4kids-admin one', async () => {
	assert.deepEqual(await verifyAdminToken(idp.admin, `Bearer ${await idp.gamesToken(oid)}`), { ok: false, code: 'invalid_token' });
	const auth = await verifyAdminToken(idp.admin, `Bearer ${await idp.adminToken(oid)}`);
	assert.ok(auth.ok);
	assert.deepEqual(auth.token.scopes, ['admin.console']);
	assert.equal(auth.token.authTime, null);
	assert.equal(auth.token.objectId, oid);
});
