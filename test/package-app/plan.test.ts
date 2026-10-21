import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPlan } from '../../tools/package-app.ts';
import { FIXTURES } from '../support/packed.ts';

test('each app has its own name, entry and compiled folders', () => {
	assert.deepEqual(appPlan('portal'), { name: 'func-g4k-portal', main: 'apps/games/api/index.js', include: ['apps/games/api', 'apps/games/.gen'], hostJson: 'apps/games/api/host.json' });
	assert.deepEqual(appPlan('admin', FIXTURES), {
		name: 'func-g4k-admin',
		main: 'apps/admin/api/index.js',
		include: ['apps/admin/api', 'apps/admin/.gen', FIXTURES],
		hostJson: 'apps/admin/api/host.json',
	});
	assert.deepEqual(appPlan('drawpad'), { name: 'func-g4k-drawpad', main: 'games/drawpad/.gen/play-app.js', include: ['games/drawpad'], hostJson: 'apps/games/api/host.json' });
});
