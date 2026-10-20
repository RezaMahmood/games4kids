// Moves each child's drawings, usage, results, attempts, practice and copies to the new accounts, re-keyed to PortalUserId.
// Run on your Mac, signed in with `az login`. The old accounts are read only. Do not apply until the owner says so.
//
//   node tools/migrate/player-data.mjs --suffix <suffix>                                  report counts and unmapped keys (default)
//   node tools/migrate/player-data.mjs --suffix <suffix> --apply --confirm-player-data    write; both flags are required

import { fileURLToPath } from 'node:url';
import { relaunchWithSource } from './launch.mjs';

relaunchWithSource(fileURLToPath(import.meta.url));

const { realIo } = await import('./main.ts');
const { runPlayerData, USAGE, describeFailure } = await import('./shell.ts');

if (process.argv.includes('--help')) {
	console.log(`${USAGE}\n  --confirm-player-data         Required with --apply.`);
	process.exit(0);
}
try {
	process.exit(await runPlayerData(process.argv.slice(2), realIo()));
} catch (error) {
	console.error(describeFailure(error));
	process.exit(1);
}
