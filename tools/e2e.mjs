// The browser tests run here, not in CI, so a push carries proof that they passed on the code it pushes.
//
//   node tools/e2e.mjs [playwright args]           on this machine, for quick iteration
//   node tools/e2e.mjs --linux [playwright args]   in the Playwright Linux image, the run a push needs
//   node tools/e2e.mjs --check                     exits 2 unless HEAD's tree has a passing Linux run
//
// A full Linux run (no test filter) on a clean tree records a hash of HEAD's files in the worktree's git dir. --check is
// what the Claude Code hook in .claude/settings.json runs before git push and gh pr create. Linux is the one that
// counts because its fonts draw wider than macOS fonts, and a layout that fits on a Mac can overflow there.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const stampFile = git('rev-parse', '--path-format=absolute', '--git-path', 'g4k-e2e-passed');
/** HEAD's files without the Markdown, so a docs-only commit keeps the run that came before it. */
const tree = () =>
	createHash('sha256')
		.update(git('ls-tree', '-r', 'HEAD').split('\n').filter((line) => !line.endsWith('.md')).join('\n'))
		.digest('hex');
const clean = () => git('status', '--porcelain', '--untracked-files=normal') === '';

const args = process.argv.slice(2);

if (args[0] === '--check') {
	const changed = git('diff', '--name-only', 'origin/main...HEAD').split('\n').filter(Boolean);
	if (changed.every((path) => path.endsWith('.md'))) process.exit(0);
	const passed = existsSync(stampFile) && readFileSync(stampFile, 'utf8').split('\n').includes(tree());
	if (passed) process.exit(0);
	console.error(
		'The browser tests have not passed on this commit. Commit everything, then run `npm run e2e:linux` with no test filter, and push once it passes. CI does not run them.',
	);
	process.exit(2);
}

const linux = args[0] === '--linux';
const playwrightArgs = linux ? args.slice(1) : args;
const fullRun = !playwrightArgs.some((arg) => !arg.startsWith('-'));
const testedTree = fullRun && clean() ? tree() : undefined;

let status;
if (linux) {
	const version = JSON.parse(readFileSync(`${root}/node_modules/@playwright/test/package.json`, 'utf8')).version;
	if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
		console.error('Docker is not running. Start Docker Desktop and run this again.');
		process.exit(1);
	}
	// The anonymous volume hides the host's macOS node_modules from the container, and the named one keeps npm's cache warm.
	const quoted = playwrightArgs.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
	status = spawnSync(
		'docker',
		[
			'run', '--rm', '--init', '--ipc=host',
			'-v', `${root}:/w`, '-v', '/w/node_modules', '-v', 'g4k-npm-cache:/root/.npm', '-w', '/w',
			`mcr.microsoft.com/playwright:v${version}-noble`,
			'bash', '-c', `npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npm run e2e:here -- ${quoted}`,
		],
		{ stdio: 'inherit' },
	).status;
} else {
	status = spawnSync('npm', ['run', 'e2e:here', '--', ...playwrightArgs], { stdio: 'inherit', cwd: root }).status;
}

if (status === 0 && linux && testedTree && tree() === testedTree && clean()) {
	appendFileSync(stampFile, `${testedTree}\n`);
	console.log(`e2e: recorded a passing Linux run for ${testedTree.slice(0, 12)}`);
} else if (status === 0 && linux && !testedTree) {
	console.log('e2e: passed, but a filtered run or uncommitted changes record nothing for the push check.');
}
process.exit(status ?? 1);
