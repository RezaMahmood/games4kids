// The browser tests run here, not in CI, so a push carries proof that they passed on the code it pushes.
//
//   node tools/e2e.mjs [playwright args]           on this machine, for quick iteration
//   node tools/e2e.mjs --linux [playwright args]   in the Playwright Linux image, the run a push needs
//   node tools/e2e.mjs --pre-push                  what .githooks/pre-push runs, with git's ref lines on stdin
//
// `--linux` with no arguments on a clean tree records a hash of HEAD's files in the worktree's git dir, and it points
// core.hooksPath at .githooks so git refuses to push a commit with no such record. Linux is the one that counts because
// its fonts draw wider than macOS fonts, and a layout that fits on a Mac can overflow there.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const stampFile = git('rev-parse', '--path-format=absolute', '--git-path', 'g4k-e2e-passed');
/** A commit's files without the Markdown, so a docs-only commit keeps the run that came before it. */
const filesOf = (rev) =>
	createHash('sha256')
		.update(git('ls-tree', '-r', rev).split('\n').filter((line) => !line.endsWith('.md')).join('\n'))
		.digest('hex');
const clean = () => git('status', '--porcelain', '--untracked-files=normal') === '';
const passed = () => (existsSync(stampFile) ? readFileSync(stampFile, 'utf8').split('\n') : []);

const args = process.argv.slice(2);

if (args[0] === '--pre-push') {
	const deleted = /^0+$/;
	const lines = readFileSync(0, 'utf8').split('\n').filter(Boolean);
	const untested = lines
		.map((line) => line.split(' ')[1])
		.filter((sha) => !deleted.test(sha))
		.filter((sha) => !git('diff', '--name-only', `origin/main...${sha}`).split('\n').filter(Boolean).every((path) => path.endsWith('.md')))
		.filter((sha) => !passed().includes(filesOf(sha)));
	if (untested.length === 0) process.exit(0);
	console.error(`The browser tests have not passed on ${untested.map((sha) => sha.slice(0, 8)).join(', ')}. CI does not run them.`);
	console.error('Check out that commit with nothing uncommitted, run `npm run e2e:linux` with no arguments, and push once it passes.');
	process.exit(1);
}

const linux = args[0] === '--linux';
const playwrightArgs = linux ? args.slice(1) : args;
const testedFiles = linux && playwrightArgs.length === 0 && clean() ? filesOf('HEAD') : undefined;

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

if (status === 0 && testedFiles && filesOf('HEAD') === testedFiles && clean()) {
	appendFileSync(stampFile, `${testedFiles}\n`);
	git('config', 'core.hooksPath', '.githooks');
	console.log(`e2e: recorded a passing Linux run for ${git('rev-parse', '--short', 'HEAD')}`);
} else if (status === 0 && linux) {
	console.log('e2e: passed, but a run with arguments or uncommitted changes records nothing for the push check.');
}
process.exit(status ?? 1);
