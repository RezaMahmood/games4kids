// On every push to main, deploy.yml asks this for the targets the commit range touched.
//
//   node tools/changes.mjs --base <sha> --head <sha> [--all] [--github-output]
//
// --all (a manual run, a first push, or a base that cannot be diffed) deploys every target. The plan prints as JSON,
// and with --github-output each field is also appended to $GITHUB_OUTPUT for the workflow's matrices.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { everything, planOf, targetsFor } from './targets.ts';

const { values } = parseArgs({
	options: { base: { type: 'string', default: '' }, head: { type: 'string', default: 'HEAD' }, all: { type: 'boolean', default: false }, 'github-output': { type: 'boolean', default: false } },
});

const gamesDir = 'games';
const games = existsSync(gamesDir)
	? readdirSync(gamesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(gamesDir, entry.name, 'manifest.ts')))
			.map((entry) => entry.name)
	: [];

function changedPaths() {
	if (values.all || !/[1-9a-f]/.test(values.base)) return null;
	try {
		return execFileSync('git', ['diff', '--name-only', values.base, values.head], { encoding: 'utf8' }).split('\n').filter(Boolean);
	} catch {
		return null;
	}
}

const paths = changedPaths();
const plan = planOf(paths === null ? everything(games) : targetsFor(paths, games));
console.log(JSON.stringify(plan, null, 2));

if (values['github-output'] && process.env.GITHUB_OUTPUT) {
	const lines = Object.entries(plan).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
	appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
