// Packs one Function app into a zip that Flex Consumption runs as it is (no remote build). tools/package-app.mjs is the
// command line. Run after `npm ci --ignore-scripts`, `npm run gen` and `npx tsc -b`. The zip holds the compiled entry and what it
// imports from dist, host.json, a package.json whose `main` is the entry, and the production dependencies exactly as the
// lockfile resolved them: the lockfile names each one that is not a dev dependency, and @g4k/host and @g4k/sdk are copied from their dist.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

export const functionAppName = (app: string) => `func-g4k-${app}`;

/** Where each app's compiled code sits under dist/, which mirrors the repo, and which file is its entry. */
export function appPlan(app: string, gamesRoot = 'games') {
	if (app === 'portal') return { name: functionAppName(app), main: 'apps/games/api/index.js', include: ['apps/games/api', 'apps/games/.gen'], hostJson: 'apps/games/api/host.json' };
	if (app === 'admin') return { name: functionAppName(app), main: 'apps/admin/api/index.js', include: ['apps/admin/api', 'apps/admin/.gen', gamesRoot], hostJson: 'apps/admin/api/host.json' };
	return { name: functionAppName(app), main: `${gamesRoot}/${app}/.gen/play-app.js`, include: [`${gamesRoot}/${app}`], hostJson: 'apps/games/api/host.json' };
}

const compiledOnly = (source: string) => !source.endsWith('.d.ts') && !source.endsWith('.tsbuildinfo') && !source.endsWith('.test.js');

function productionPackages(): string[] {
	const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages: Record<string, { dev?: boolean; link?: boolean }> };
	return Object.entries(lock.packages)
		.filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev && existsSync(join(REPO, path)))
		.map(([path]) => path);
}

function copyPackage(rel: string, stage: string) {
	const source = join(REPO, rel);
	if (rel.startsWith('node_modules/@g4k/')) {
		const real = realpathSync(source);
		cpSync(join(real, 'package.json'), join(stage, rel, 'package.json'));
		cpSync(join(real, 'dist'), join(stage, rel, 'dist'), { recursive: true, filter: compiledOnly });
		return;
	}
	cpSync(source, join(stage, rel), { recursive: true });
}

/** Builds the stage folder; the caller zips it. */
export function stageApp(app: string, stage: string, gamesRoot = 'games') {
	const plan = appPlan(app, gamesRoot);
	const dist = join(REPO, 'dist');
	if (!existsSync(join(dist, plan.main))) throw new Error(`${plan.main} is not in dist/. Run npm run gen and npx tsc -b first.`);
	for (const path of plan.include) if (existsSync(join(dist, path))) cpSync(join(dist, path), join(stage, path), { recursive: true, filter: compiledOnly });
	cpSync(join(REPO, plan.hostJson), join(stage, 'host.json'));
	writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name: plan.name, private: true, type: 'module', main: plan.main }, null, '\t')}\n`);
	for (const rel of productionPackages()) copyPackage(rel, stage);
	return plan;
}

export function packageApp(app: string, outDir: string, gamesRoot = 'games') {
	const stage = mkdtempSync(join(tmpdir(), `${functionAppName(app)}-`));
	try {
		const plan = stageApp(app, stage, gamesRoot);
		mkdirSync(outDir, { recursive: true });
		const zip = resolve(outDir, `${plan.name}.zip`);
		rmSync(zip, { force: true });
		execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
		return zip;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

