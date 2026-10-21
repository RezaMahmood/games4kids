import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertStartsOnItsOwn, skip, unpack } from '../support/packed.ts';

const dir = skip ? '' : unpack('admin', 'games');

test('the admin zip starts on its own and stops only for its missing settings', { skip }, () => assertStartsOnItsOwn('admin', dir));

test('the admin zip carries each game\'s admin part and data, and neither a test nor the page sources', { skip }, () => {
	for (const path of ['games/drawpad/manifest.js', 'games/drawpad/data/stores.js', 'games/drawpad/admin/api/worker.js', 'apps/admin/.gen/modules.js']) assert.ok(existsSync(join(dir, path)), `${path} is packed`);
	const files = spawnSync('find', [join(dir, 'games'), '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
	assert.deepEqual(files.filter((file) => file.endsWith('.test.js') || file.includes('/web/') || file.endsWith('.tsx')), []);
});
