import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, unpack } from '../support/packed.ts';

test('the admin app packs before any game exists, with no games folder in dist', { skip }, () => {
	const dir = unpack('admin', 'no-such-games');
	assert.ok(existsSync(join(dir, 'apps/admin/.gen/modules.js')));
	assert.equal(existsSync(join(dir, 'no-such-games')), false);
});
