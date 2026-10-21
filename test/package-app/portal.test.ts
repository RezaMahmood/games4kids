import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertStartsOnItsOwn, skip, unpack } from '../support/packed.ts';

const dir = skip ? '' : unpack('portal', 'games');

test('the portal zip starts on its own and stops only for its missing settings', { skip }, () => assertStartsOnItsOwn('portal', dir));

test('the zip carries production dependencies and the host and sdk dist, and no dev tooling or type files', { skip }, () => {
	for (const path of ['node_modules/@g4k/host/dist/index.js', 'node_modules/@g4k/sdk/dist/index.js', 'node_modules/@azure/data-tables/package.json', 'node_modules/jose/package.json', 'node_modules/obscenity/package.json']) {
		assert.ok(existsSync(join(dir, path)), `${path} is packed`);
	}
	for (const path of ['node_modules/typescript', 'node_modules/@playwright', 'node_modules/azurite', 'node_modules/@g4k/host/src', 'apps/games/api/index.d.ts']) {
		assert.equal(existsSync(join(dir, path)), false, `${path} is left out`);
	}
});
