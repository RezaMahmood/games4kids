import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { GameId } from '@g4k/sdk';
import { everything, planOf, targetsFor, type DeployTarget } from '../tools/targets.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));

const drawpad = 'drawpad' as GameId;
const letterjoin = 'letterjoin' as GameId;
const games = [drawpad, letterjoin];

const infraShared: DeployTarget = { kind: 'infra-shared' };
const infraGame = (game: GameId): DeployTarget => ({ kind: 'infra-game', game });
const player = (game: GameId): DeployTarget => ({ kind: 'player-app', game });
const portal: DeployTarget = { kind: 'portal-app' };
const adminApp: DeployTarget = { kind: 'admin-app' };
const gamesSite: DeployTarget = { kind: 'games-site' };
const adminSite: DeployTarget = { kind: 'admin-site' };

const bothSidesOf = (game: GameId): DeployTarget[] => [player(game), adminApp, gamesSite, adminSite];
const allApps = [player(drawpad), player(letterjoin), portal, adminApp];
const allSites = [gamesSite, adminSite];

const rows: readonly (readonly [name: string, paths: string[], expected: DeployTarget[]])[] = [
	['a game play web page', ['games/letterjoin/play/web/index.html'], [player(letterjoin), gamesSite]],
	['a game play api file', ['games/drawpad/play/api/index.ts'], [player(drawpad), gamesSite]],
	['a game admin part', ['games/drawpad/admin/api/routes.ts'], [adminApp, adminSite]],
	['a game admin web page', ['games/letterjoin/admin/web/admin.js'], [adminApp, adminSite]],
	['a game data part', ['games/letterjoin/data/index.ts'], [player(letterjoin), adminApp, gamesSite, adminSite]],
	['a game manifest', ['games/drawpad/manifest.ts'], [infraGame(drawpad), ...bothSidesOf(drawpad)]],
	['a game infra.bicep', ['games/drawpad/infra.bicep'], [infraGame(drawpad)]],
	['a bicep module beside a game infra.bicep', ['games/drawpad/foundry.bicep'], [infraGame(drawpad)]],
	['a file in a game folder no part owns', ['games/drawpad/README.md'], []],
	['the portal api', ['apps/games/api/index.ts'], [portal]],
	['the games shell', ['apps/games/shell/v1/index.ts'], [gamesSite]],
	['a games page', ['apps/games/pages/index.html'], [gamesSite]],
	['the games site config', ['apps/games/staticwebapp.config.json'], [gamesSite]],
	['the admin api', ['apps/admin/api/index.ts'], [adminApp, adminSite]],
	['the admin shell', ['apps/admin/shell/v1/index.ts'], [adminApp, adminSite]],
	['a shared browser module', ['apps/shared/api-client.ts'], allSites],
	['the design tokens', ['design/tokens.json'], allSites],
	['the host package', ['packages/host/src/player-app.ts'], allApps],
	['the sdk package', ['packages/sdk/src/manifest.ts'], [infraShared, infraGame(drawpad), infraGame(letterjoin), ...allApps, ...allSites]],
	['shared infra', ['infra/main.bicep'], [infraShared]],
	['the shared infra workbook', ['infra/workbook.json'], [infraShared]],
	['the game infra template', ['infra/game.bicep'], [infraShared]],
	['the lockfile', ['package-lock.json'], [...allApps, ...allSites]],
	['the gen tool', ['tools/gen.mjs'], [...allApps, ...allSites]],
	['the Vite page build', ['tools/build-web.mjs'], [...allApps, ...allSites]],
	['a project that compiles every game', ['games/tsconfig.admin.json'], [...allApps, ...allSites]],
	['the dev stack', ['dev/stack.ts'], []],
	['a test', ['test/conformance.test.ts'], []],
	['docs only', ['docs/ARCHITECTURE.md', 'README.md', 'docs/sketch/deploy.ts'], []],
	['the workflows only', ['.github/workflows/deploy.yml', '.github/workflows/ci.yml'], []],
	['no change at all', [], []],
];

for (const [name, paths, expected] of rows) {
	test(`targetsFor: ${name}`, () => {
		assert.deepEqual(targetsFor(paths, games), expected);
	});
}

test('targetsFor: a new game folder creates its infra first, then deploys both sides', () => {
	const fresh = 'puzzle' as GameId;
	const paths = ['games/puzzle/manifest.ts', 'games/puzzle/data/index.ts', 'games/puzzle/play/api/index.ts', 'games/puzzle/play/web/index.html', 'games/puzzle/admin/api/index.ts', 'games/puzzle/infra.bicep'];
	assert.deepEqual(targetsFor(paths, [...games, fresh]), [infraGame(fresh), player(fresh), adminApp, gamesSite, adminSite]);
});

test('targetsFor: several paths deduplicate and order infra, then apps, then sites', () => {
	const paths = ['apps/admin/shell/v1/index.ts', 'games/letterjoin/play/web/index.html', 'infra/main.bicep', 'games/drawpad/infra.bicep', 'games/drawpad/play/api/index.ts', 'apps/games/api/index.ts'];
	assert.deepEqual(targetsFor(paths, games), [infraShared, infraGame(drawpad), player(drawpad), player(letterjoin), portal, adminApp, gamesSite, adminSite]);
});

test('targetsFor: a deleted game redeploys the sites and nothing that belongs to it', () => {
	assert.deepEqual(targetsFor(['games/gone/play/api/index.ts', 'games/gone/manifest.ts', 'games/gone/admin/api/index.ts', 'games/gone/data/index.ts'], games), [adminApp, gamesSite, adminSite]);
});

test('targetsFor: a host change reaches every player app, however many games exist', () => {
	assert.deepEqual(targetsFor(['packages/host/src/http.ts'], []), [portal, adminApp]);
});

test('everything deploys all of it, infra first', () => {
	assert.deepEqual(everything(games), [infraShared, infraGame(drawpad), infraGame(letterjoin), player(drawpad), player(letterjoin), portal, adminApp, gamesSite, adminSite]);
});

test('planOf turns targets into the lists the workflow matrices read', () => {
	assert.deepEqual(planOf(targetsFor(['games/drawpad/manifest.ts', 'apps/games/api/index.ts', 'infra/main.bicep'], games)), {
		any: true,
		infraShared: true,
		infraGames: ['drawpad'],
		apps: ['drawpad', 'portal', 'admin'],
		sites: ['games', 'admin'],
	});
	assert.deepEqual(planOf(targetsFor(['docs/ARCHITECTURE.md'], games)), { any: false, infraShared: false, infraGames: [], apps: [], sites: [] });
});

test('tools/changes.mjs --all lists the games on disk and appends each field to GITHUB_OUTPUT', () => {
	const root = mkdtempSync(join(tmpdir(), 'g4k-changes-'));
	for (const id of ['alpha', 'beta']) {
		mkdirSync(join(root, 'games', id), { recursive: true });
		writeFileSync(join(root, 'games', id, 'manifest.ts'), '');
	}
	mkdirSync(join(root, 'games', 'stray'));
	const output = join(root, 'github-output');
	const run = spawnSync(process.execPath, [join(repo, 'tools/changes.mjs'), '--all', '--github-output'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), { any: true, infraShared: true, infraGames: ['alpha', 'beta'], apps: ['alpha', 'beta', 'portal', 'admin'], sites: ['games', 'admin'] });
	const lines = readFileSync(output, 'utf8').split('\n');
	assert.ok(lines.includes('apps=["alpha","beta","portal","admin"]'));
	assert.ok(lines.includes('infraShared=true'));
});

test('tools/changes.mjs treats an all-zero base as a first push and deploys everything', () => {
	const root = mkdtempSync(join(tmpdir(), 'g4k-changes-'));
	const run = spawnSync(process.execPath, [join(repo, 'tools/changes.mjs'), '--base', '0000000000000000000000000000000000000000'], { cwd: root, encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout).infraShared, true);
});

test('tools/changes.mjs diffs a real range of commits', () => {
	const root = mkdtempSync(join(tmpdir(), 'g4k-changes-'));
	const git = (...args: string[]) => {
		const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' });
		assert.equal(run.status, 0, run.stderr);
		return run.stdout.trim();
	};
	git('init', '-q');
	mkdirSync(join(root, 'games/alpha/play/web'), { recursive: true });
	mkdirSync(join(root, 'docs'));
	writeFileSync(join(root, 'games/alpha/manifest.ts'), '');
	writeFileSync(join(root, 'games/alpha/play/web/index.html'), 'v1');
	writeFileSync(join(root, 'docs/a.md'), 'v1');
	git('add', '.');
	git('commit', '-q', '-m', 'one');
	const base = git('rev-parse', 'HEAD');
	writeFileSync(join(root, 'games/alpha/play/web/index.html'), 'v2');
	writeFileSync(join(root, 'docs/a.md'), 'v2');
	git('commit', '-q', '-am', 'two');
	const run = spawnSync(process.execPath, [join(repo, 'tools/changes.mjs'), '--base', base, '--head', 'HEAD'], { cwd: root, encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), { any: true, infraShared: false, infraGames: [], apps: ['alpha'], sites: ['games'] });
});
