import { spawnSync } from 'node:child_process';

export function relaunchWithSource(script) {
	if (process.execArgv.includes('--conditions=source')) return;
	const { status } = spawnSync(process.execPath, ['--conditions=source', script, ...process.argv.slice(2)], { stdio: 'inherit' });
	process.exit(status ?? 1);
}
