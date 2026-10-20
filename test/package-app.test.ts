import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appPlan, packageApp } from '../tools/package-app.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = 'test/fixtures/games';

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

const built = existsSync(join(repo, 'dist/apps/games/api/index.js')) && existsSync(join(repo, 'dist', FIXTURES, 'fixture/.gen/play-app.js')) && existsSync(join(repo, 'dist/games/drawpad/.gen/play-app.js'));
const tools = ['zip', 'unzip'].every((tool) => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status !== null);
const skip = !built ? 'dist/ is missing; run npx tsc -b' : !tools ? 'zip and unzip are missing' : false;

const unpackedApps = new Map<string, string>();

function unpacked(app: string) {
	const known = unpackedApps.get(app);
	if (known) return known;
	const zip = packageApp(app, mkdtempSync(join(tmpdir(), 'g4k-zip-')), app === 'fixture' ? FIXTURES : 'games');
	const dir = mkdtempSync(join(tmpdir(), 'g4k-app-'));
	assert.equal(spawnSync('unzip', ['-q', zip, '-d', dir]).status, 0);
	unpackedApps.set(app, dir);
	return dir;
}

for (const app of ['portal', 'admin', 'fixture', 'drawpad']) {
	test(`the ${app} zip starts on its own and stops only for its missing settings`, { skip }, () => {
		const dir = unpacked(app);
		const { main } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		assert.ok(existsSync(join(dir, main)), `${main} is in the zip`);
		const routePrefix = JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')).extensions?.http?.routePrefix ?? 'api';
		assert.equal(routePrefix, app === 'admin' ? 'api/admin' : 'api', 'the route prefix plus each function route is the path the app serves');
		const run = spawnSync(process.execPath, [join(dir, main)], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /missing app settings: .*TENANT_ID/);
	});
}

test('the zip carries production dependencies and the host and sdk dist, and no dev tooling or type files', { skip }, () => {
	const dir = unpacked('portal');
	for (const path of ['node_modules/@g4k/host/dist/index.js', 'node_modules/@g4k/sdk/dist/index.js', 'node_modules/@azure/data-tables/package.json', 'node_modules/jose/package.json']) {
		assert.ok(existsSync(join(dir, path)), `${path} is packed`);
	}
	for (const path of ['node_modules/typescript', 'node_modules/@playwright', 'node_modules/azurite', 'node_modules/@g4k/host/src', 'apps/games/api/index.d.ts']) {
		assert.equal(existsSync(join(dir, path)), false, `${path} is left out`);
	}
});

test('the admin app packs before any game exists, with no games folder in dist', { skip }, () => {
	const dir = mkdtempSync(join(tmpdir(), 'g4k-app-'));
	const zip = packageApp('admin', mkdtempSync(join(tmpdir(), 'g4k-zip-')), 'no-such-games');
	assert.equal(spawnSync('unzip', ['-q', zip, '-d', dir]).status, 0);
	assert.ok(existsSync(join(dir, 'apps/admin/.gen/modules.js')));
	assert.equal(existsSync(join(dir, 'no-such-games')), false);
});

test('the admin zip carries each game\'s admin part and data, and neither a test nor the page sources', { skip }, () => {
	const dir = unpacked('admin');
	for (const path of ['games/drawpad/manifest.js', 'games/drawpad/data/stores.js', 'games/drawpad/admin/api/worker.js', 'apps/admin/.gen/modules.js']) assert.ok(existsSync(join(dir, path)), `${path} is packed`);
	const files = spawnSync('find', [join(dir, 'games'), '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
	assert.deepEqual(files.filter((file) => file.endsWith('.test.js') || file.includes('/web/') || file.endsWith('.tsx')), []);
});
