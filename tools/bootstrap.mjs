// Run on your Mac, signed in with `az login` (Owner and Global Administrator) and `gh auth login`. Reads current state,
// compares it to the goal, and applies only the difference. --plan (the default) makes no change.
//
//   node tools/bootstrap.mjs                       plan every step
//   node tools/bootstrap.mjs --apply               apply what the plan lists
//   node tools/bootstrap.mjs --verify              pass or fail table
//   node tools/bootstrap.mjs --apply --after-first-deploy
//
// Run it with --help for every option.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { PASSWORD_SENTINEL } from './bootstrap.ts';
import { parseFlags, run, USAGE } from './bootstrap-shell.ts';

const execFileAsync = promisify(execFile);

const randomPassword = () => `${randomBytes(24).toString('base64url')}aA1!`;

async function exec({ tool, args, body }) {
	let dir = null;
	const full = [...args];
	if (body !== undefined) {
		dir = await mkdtemp(join(tmpdir(), 'g4k-bootstrap-'));
		const file = join(dir, 'body.json');
		await writeFile(file, JSON.stringify(body).replaceAll(PASSWORD_SENTINEL, randomPassword()), { mode: 0o600 });
		full.push(tool === 'az' ? '--body' : '--input', tool === 'az' ? `@${file}` : file);
	}
	if (tool === 'az') full.push('--only-show-errors', '--output', 'json');
	try {
		const { stdout, stderr } = await execFileAsync(tool, full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) };
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}

async function prompt(question) {
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await lines.question(question);
	} finally {
		lines.close();
	}
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}

let flags;
try {
	flags = parseFlags(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(64);
}

process.exit(await run(flags, { exec, prompt, log: (line) => console.log(line), sleep }));
