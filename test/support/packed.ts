import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageApp } from '../../tools/package-app.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export const FIXTURES = 'test/fixtures/games';

const built = existsSync(join(repo, 'dist/apps/games/api/index.js')) && existsSync(join(repo, 'dist', FIXTURES, 'fixture/.gen/play-app.js')) && existsSync(join(repo, 'dist/games/drawpad/.gen/play-app.js'));
const tools = ['zip', 'unzip'].every((tool) => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status !== null);
export const skip = !built ? 'dist/ is missing; run npx tsc -b' : !tools ? 'zip and unzip are missing' : false;

const temps: string[] = [];
after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

/** Packs one app into a zip and unpacks it into a folder that is removed when the test file ends. */
export function unpack(app: string, gamesRoot: string) {
	const zip = packageApp(app, temp('g4k-zip-'), gamesRoot);
	const dir = temp('g4k-app-');
	assert.equal(spawnSync('unzip', ['-q', zip, '-d', dir]).status, 0);
	return dir;
}

export function assertStartsOnItsOwn(app: string, dir: string) {
	const { main } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	assert.ok(existsSync(join(dir, main)), `${main} is in the zip`);
	const routePrefix = JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')).extensions?.http?.routePrefix ?? 'api';
	assert.equal(routePrefix, app === 'admin' ? 'api/admin' : 'api', 'the route prefix plus each function route is the path the app serves');
	const run = spawnSync(process.execPath, [join(dir, main)], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
	assert.notEqual(run.status, 0);
	assert.match(run.stderr, /missing app settings: .*TENANT_ID/);
}
