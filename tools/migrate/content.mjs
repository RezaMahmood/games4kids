// Copies authored content from the old drawpad and letterjoin accounts into the new per-game accounts.
// Run on your Mac after `bootstrap.mjs --after-first-deploy`, signed in with `az login`. The old accounts are read only.
//
//   node tools/migrate/content.mjs --suffix <suffix>           report what would be copied (default)
//   node tools/migrate/content.mjs --suffix <suffix> --apply   copy it; a second run writes nothing

import { fileURLToPath } from 'node:url';
import { relaunchWithSource } from './launch.mjs';

relaunchWithSource(fileURLToPath(import.meta.url));

const { contentRules, realIo } = await import('./main.ts');
const { runContent, USAGE, describeFailure } = await import('./shell.ts');

if (process.argv.includes('--help')) {
	console.log(USAGE);
	process.exit(0);
}
try {
	process.exit(await runContent(process.argv.slice(2), realIo(), contentRules));
} catch (error) {
	console.error(describeFailure(error));
	process.exit(1);
}
