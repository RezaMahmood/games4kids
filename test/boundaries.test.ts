import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repo = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: repo });
const BOUNDARY_RULES = ['no-restricted-imports', 'no-restricted-globals'];

async function violations(path: string, code: string): Promise<number> {
	const [result] = await eslint.lintText(code, { filePath: join(repo, path) });
	return result?.messages.filter((message) => message.ruleId !== null && BOUNDARY_RULES.includes(message.ruleId)).length ?? -1;
}

const cases: readonly { readonly name: string; readonly path: string; readonly code: string; readonly banned: boolean }[] = [
	{ name: 'play imports the admin part', path: 'games/demo/play/api/index.ts', code: "import '../../admin/api/index.ts';", banned: true },
	{ name: 'data imports the play part', path: 'games/demo/data/index.ts', code: "import '../play/api/index.ts';", banned: true },
	{ name: 'data imports the admin part', path: 'games/demo/data/index.ts', code: "import '../admin/api/index.ts';", banned: true },
	{ name: "admin imports the play part's API", path: 'games/demo/admin/api/index.ts', code: "import '../../play/api/index.ts';", banned: true },
	{ name: 'a manifest imports game code', path: 'games/demo/manifest.ts', code: "import './data/index.ts';", banned: true },
	{ name: 'a game imports an Azure SDK', path: 'games/demo/play/api/index.ts', code: "import '@azure/data-tables';", banned: true },
	{ name: 'a game imports @azure/functions', path: 'games/demo/admin/api/index.ts', code: "import '@azure/functions';", banned: true },
	{ name: 'a game imports the host', path: 'games/demo/play/api/index.ts', code: "import '@g4k/host';", banned: true },
	{ name: 'a game verifies tokens itself', path: 'games/demo/play/api/index.ts', code: "import 'jose';", banned: true },
	{ name: 'a game writes telemetry', path: 'games/demo/data/index.ts', code: "import '@opentelemetry/api';", banned: true },
	{ name: 'a game reads the environment', path: 'games/demo/play/api/index.ts', code: 'export const url = process.env.URL;', banned: true },
	{ name: 'the fixture game obeys the same bans', path: 'test/fixtures/games/fixture/play/api/extra.ts', code: "import '../../admin/api/index.ts';", banned: true },
	{ name: 'the host imports @azure/functions outside the adapter', path: 'packages/host/src/player-app.ts', code: "import '@azure/functions';", banned: true },
	{ name: 'play imports the sdk and its data part', path: 'games/demo/play/api/index.ts', code: "import '@g4k/sdk';\nimport '../../data/index.ts';", banned: false },
	{ name: "admin imports the play part's pure modules", path: 'games/demo/admin/web/editor.ts', code: "import '../../play/web/render.ts';\nimport '../../data/index.ts';", banned: false },
	{ name: 'a manifest imports the sdk', path: 'games/demo/manifest.ts', code: "import '@g4k/sdk';", banned: false },
	{ name: 'the Functions adapter imports @azure/functions', path: 'packages/host/src/adapters/functions.ts', code: "import '@azure/functions';", banned: false },
];

for (const { name, path, code, banned } of cases) {
	test(`lint boundary: ${name} is ${banned ? 'refused' : 'allowed'}`, async () => {
		const count = await violations(path, code);
		if (banned) assert.ok(count > 0, `${path} should be refused`);
		else assert.equal(count, 0);
	});
}
