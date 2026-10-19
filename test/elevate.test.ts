import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELEVATION_MAX_AGE_SECONDS, elevate, openAdminSession, verifyAdminToken } from '@g4k/host';
import { fakeIdp } from './support/idp.ts';
import { newObjectId, NOW, seedAdmin, world } from './support/world.ts';

const idp = await fakeIdp();
const secondsBefore = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

const cases: readonly { readonly name: string; readonly scp: string; readonly authTime: Date | null; readonly elevated: boolean }[] = [
	{ name: 'console scope with a fresh sign-in', scp: 'admin.console', authTime: NOW, elevated: false },
	{ name: 'elevate scope with no auth_time', scp: 'admin.elevate', authTime: null, elevated: false },
	{ name: 'elevate scope signed in this second', scp: 'admin.elevate', authTime: NOW, elevated: true },
	{ name: 'elevate scope signed in 599 seconds ago', scp: 'admin.elevate', authTime: secondsBefore(599), elevated: true },
	{ name: 'elevate scope signed in exactly 600 seconds ago', scp: 'admin.elevate', authTime: secondsBefore(600), elevated: true },
	{ name: 'elevate scope signed in 601 seconds ago', scp: 'admin.elevate', authTime: secondsBefore(601), elevated: false },
	{ name: 'elevate scope signed in 11 minutes ago', scp: 'admin.elevate', authTime: secondsBefore(660), elevated: false },
	{ name: 'elevate scope with auth_time 30 seconds ahead of this clock', scp: 'admin.elevate', authTime: secondsBefore(-30), elevated: true },
	{ name: 'elevate scope with auth_time 2 minutes ahead of this clock', scp: 'admin.elevate', authTime: secondsBefore(-120), elevated: false },
	{ name: 'both scopes with a fresh sign-in', scp: 'admin.console admin.elevate', authTime: secondsBefore(5), elevated: true },
];

for (const { name, scp, authTime, elevated } of cases) {
	test(`elevate: ${name}`, async () => {
		const w = world();
		const objectId = newObjectId();
		await seedAdmin(w, objectId);
		const auth = await verifyAdminToken(idp.admin, `Bearer ${await idp.adminToken(objectId, { scp, ...(authTime ? { authTime } : {}) })}`);
		assert.ok(auth.ok);
		const session = await openAdminSession(auth.token, w.admin);
		assert.notEqual(session, 'forbidden');
		if (session === 'forbidden') return;
		const result = elevate(session, NOW);
		if (!elevated) {
			assert.deepEqual(result, { kind: 'step_up_required', maxAgeSeconds: ELEVATION_MAX_AGE_SECONDS });
			return;
		}
		assert.ok(!('kind' in result) && authTime);
		assert.equal(result.session, session);
		assert.equal(result.until.getTime(), Math.floor(authTime.getTime() / 1000) * 1000 + ELEVATION_MAX_AGE_SECONDS * 1000);
	});
}

test('openAdminSession refuses a verified admin token whose oid has no admins row', async () => {
	const w = world();
	const auth = await verifyAdminToken(idp.admin, `Bearer ${await idp.adminToken(newObjectId())}`);
	assert.ok(auth.ok);
	assert.equal(await openAdminSession(auth.token, w.admin), 'forbidden');
});
