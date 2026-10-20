// The Azure side of deploy.yml. Every command runs inside a deploy job, after azure/login, from the downloaded bundle.
//
//   node tools/deploy.mjs infra shared
//   node tools/deploy.mjs infra game <id>
//   node tools/deploy.mjs app <portal|admin|game-id> <zip>
//   node tools/deploy.mjs site <games|admin> <dir> <swa-cli.js>

import { deployApp, deployGameInfra, deploySharedInfra, deploySite } from './deploy.ts';

const [command, ...rest] = process.argv.slice(2);

try {
	if (command === 'infra' && rest[0] === 'shared') deploySharedInfra();
	else if (command === 'infra' && rest[0] === 'game' && rest[1]) deployGameInfra(rest[1]);
	else if (command === 'app' && rest[0] && rest[1]) await deployApp(rest[0], rest[1]);
	else if (command === 'site' && (rest[0] === 'games' || rest[0] === 'admin') && rest[1] && rest[2]) await deploySite(rest[0], rest[1], rest[2]);
	else throw new Error('usage: deploy.mjs infra shared | infra game <id> | app <app> <zip> | site <games|admin> <dir> <swa-cli.js>');
} catch (error) {
	console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
