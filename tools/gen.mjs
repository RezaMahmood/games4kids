// The folder is the registry: every games/<id>/manifest.ts. Gen checks every folder at once, so one run lists every
// problem, and writes nothing unless all pass. Run with --conditions=source so manifests load @g4k/sdk from source.
//
//   node --conditions=source tools/gen.mjs [--root <dir>]
//
// Writes (gitignored, rewritten on predev, prebuild and pretest). Each registry writes the same five outputs:
//   games/<id>/.gen/play-app.ts   the player app entry: playerAppFromEnv + registerWithFunctions
//   catalog.json                  the games site's home cards, minus apiBaseUrl, which the site deploy job fills in
//   admin-catalog.json            the admin site's game list, with whether each game has an admin part
//   modules.ts                    every game's admin part, for the admin app entry
//   games.ts / fixtures.ts        the registry, for tools/dev.mjs and the tests
// Registries: games/ writes into dev/generated, apps/games/.gen and apps/admin/.gen. The fixture games under
// test/fixtures/games write into test/generated and their own .gen folders, and are never deployed.

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GAME_ID, RESERVED_IDS } from '@g4k/sdk';

const NAME_RULES = {
	tables: { pattern: /^[A-Za-z][A-Za-z0-9]{2,62}$/, rule: 'a table name is 3 to 63 letters or digits, starting with a letter' },
	containers: { pattern: /^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/, rule: 'a container name is 3 to 63 lowercase letters, digits and single hyphens' },
	queues: { pattern: /^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/, rule: 'a queue name is 3 to 63 lowercase letters, digits and single hyphens' },
};
const ADMIN_OWNED = ['admin', 'admin-private'];

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });
const root = resolve(values.root);

const REGISTRIES = [
	{
		games: join(root, 'games'),
		out: join(root, 'dev/generated/games.ts'),
		catalog: join(root, 'apps/games/.gen/catalog.json'),
		adminCatalog: join(root, 'apps/admin/.gen/catalog.json'),
		modules: join(root, 'apps/admin/.gen/modules.ts'),
	},
	{
		games: join(root, 'test/fixtures/games'),
		out: join(root, 'test/generated/fixtures.ts'),
		catalog: join(root, 'test/generated/catalog.json'),
		adminCatalog: join(root, 'test/generated/admin-catalog.json'),
		modules: join(root, 'test/generated/modules.ts'),
	},
];

async function scanFolder(folder) {
	const problems = [];
	const name = folder.split(sep).at(-1);
	const manifestPath = join(folder, 'manifest.ts');
	if (!existsSync(manifestPath)) return { problems: [`no-manifest: ${folder} has no manifest.ts`] };
	let manifest;
	try {
		manifest = (await import(pathToFileURL(manifestPath).href)).default;
	} catch (error) {
		return { problems: [`bad-manifest: ${manifestPath} did not load: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (typeof manifest !== 'object' || manifest === null) return { problems: [`bad-manifest: ${manifestPath} has no default export`] };
	const id = manifest.id;
	if (id !== name) problems.push(`id-mismatch: ${folder} declares id "${id}"`);
	if (!GAME_ID.test(id)) problems.push(`bad-id: ${folder}: "${id}" must match ${GAME_ID.source}`);
	if (RESERVED_IDS.includes(id)) problems.push(`reserved-id: ${folder}: "${id}" is reserved`);
	const hasAdmin = manifest.admin !== undefined;
	const required = ['data/index.ts', 'play/api/index.ts', ...(hasAdmin ? ['admin/api/index.ts'] : [])];
	for (const path of required) if (!existsSync(join(folder, path))) problems.push(`missing-file: ${id}: ${path}`);
	if (!hasAdmin && existsSync(join(folder, 'admin'))) problems.push(`missing-file: ${id}: an admin/ folder needs admin in the manifest`);
	const storage = manifest.storage ?? {};
	for (const [kind, { pattern, rule }] of Object.entries(NAME_RULES)) {
		for (const name of Object.keys(storage[kind] ?? {})) if (!pattern.test(name)) problems.push(`storage-name: ${id}: ${kind} "${name}": ${rule}`);
	}
	const adminOwned = Object.values(storage).flatMap((names) => Object.entries(names ?? {}).filter(([, owner]) => ADMIN_OWNED.includes(owner)).map(([name]) => name));
	if (!hasAdmin && adminOwned.length > 0) problems.push(`no-admin-writer: ${id}: ${adminOwned.join(', ')} need an admin part to write them`);
	const exportNames = Object.keys(manifest.exports ?? {});
	if (exportNames.length > 0) problems.push(`exports-reserved: ${id}: ${exportNames.join(', ')}; exports must stay empty`);
	return { problems, game: { id, folder, hasAdmin, title: manifest.title, summary: manifest.summary, icon: manifest.icon } };
}

async function scan(gamesDir) {
	if (!existsSync(gamesDir)) return { games: [], problems: [] };
	const entries = await readdir(gamesDir, { withFileTypes: true });
	const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => join(gamesDir, entry.name));
	const results = await Promise.all(folders.map(scanFolder));
	const games = results.flatMap((result) => (result.game ? [result.game] : []));
	const problems = results.flatMap((result) => result.problems);
	for (const id of new Set(games.map((game) => game.id))) {
		const holders = games.filter((game) => game.id === id);
		if (holders.length > 1) problems.push(`duplicate-id: "${id}" is declared by ${holders.map((game) => game.folder).join(' and ')}`);
	}
	return { games: games.sort((a, b) => (a.id < b.id ? -1 : 1)), problems };
}

function importPath(from, to) {
	const path = relative(dirname(from), to).split(sep).join('/');
	return path.startsWith('.') ? path : `./${path}`;
}

function renderRegistry(out, games) {
	const lines = ['// Generated by tools/gen.mjs. Do not edit.', "import { registryEntry, type RegistryEntry } from '@g4k/host';"];
	games.forEach((game, i) => {
		lines.push(`import manifest${i} from '${importPath(out, join(game.folder, 'manifest.ts'))}';`);
		lines.push(`import { createPlayApi as play${i} } from '${importPath(out, join(game.folder, 'play/api/index.ts'))}';`);
		if (game.hasAdmin) lines.push(`import { createAdminApi as admin${i} } from '${importPath(out, join(game.folder, 'admin/api/index.ts'))}';`);
	});
	const entries = games.map((game, i) => `\tregistryEntry({ manifest: manifest${i}, play: play${i}, admin: ${game.hasAdmin ? `admin${i}` : 'null'} }),`);
	lines.push('', `export const games: readonly RegistryEntry[] = [${entries.length ? `\n${entries.join('\n')}\n` : ''}];`, '');
	return lines.join('\n');
}

/** Writes only on change, through a temp file renamed into place, so a crash never leaves half a file. */
async function writeIfChanged(path, content) {
	if (existsSync(path) && (await readFile(path, 'utf8')) === content) return false;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, content);
	await rename(`${path}.tmp`, path);
	return true;
}

function renderPlayApp() {
	return [
		'// Generated by tools/gen.mjs. Do not edit.',
		"import { registerWithFunctions } from '@g4k/host/functions';",
		"import { playerAppFromEnv } from '@g4k/host/runtime';",
		"import manifest from '../manifest.ts';",
		"import { createPlayApi } from '../play/api/index.ts';",
		'',
		'registerWithFunctions(playerAppFromEnv(manifest, createPlayApi, process.env));',
		'',
	].join('\n');
}

function renderModules(out, games) {
	const lines = [
		'// Generated by tools/gen.mjs. Do not edit.',
		"import { adminModule, requireGameId, type AdminModule } from '@g4k/host';",
		"import type { GameId } from '@g4k/sdk';",
	];
	games.forEach((game, i) => {
		lines.push(`import manifest${i} from '${importPath(out, join(game.folder, 'manifest.ts'))}';`);
		if (game.hasAdmin) lines.push(`import { createAdminApi as admin${i} } from '${importPath(out, join(game.folder, 'admin/api/index.ts'))}';`);
	});
	const list = (items) => (items.length ? `[\n${items.map((item) => `\t${item},`).join('\n')}\n]` : '[]');
	lines.push('', '/** Every game a member can be granted, with or without an admin part. */');
	lines.push(`export const grantable: readonly GameId[] = ${list(games.map((_, i) => `requireGameId(manifest${i})`))};`);
	lines.push('', `export const modules: readonly AdminModule[] = ${list(games.flatMap((game, i) => (game.hasAdmin ? [`adminModule(manifest${i}, admin${i})`] : [])))};`, '');
	return lines.join('\n');
}

const renderCatalog = (games) => `${JSON.stringify(games.map(({ id, title, summary, icon }) => ({ id, title, summary, icon, path: `/g/${id}/` })), null, '\t')}\n`;
const renderAdminCatalog = (games) => `${JSON.stringify(games.map(({ id, title, hasAdmin }) => ({ id, title, hasAdmin, path: `/g/${id}/` })), null, '\t')}\n`;

const scans = await Promise.all(REGISTRIES.map(async (registry) => ({ ...registry, ...(await scan(registry.games)) })));
const problems = scans.flatMap((result) => result.problems);
if (problems.length > 0) {
	for (const problem of problems) console.error(`gen: ${problem}`);
	process.exit(1);
}
for (const { out, games, catalog, adminCatalog, modules } of scans) {
	const outputs = [
		[out, renderRegistry(out, games)],
		[catalog, renderCatalog(games)],
		[adminCatalog, renderAdminCatalog(games)],
		[modules, renderModules(modules, games)],
		...games.map((game) => [join(game.folder, '.gen/play-app.ts'), renderPlayApp()]),
	];
	for (const [path, content] of outputs) {
		const changed = await writeIfChanged(path, content);
		const count = path === out ? ` (${games.length} ${games.length === 1 ? 'game' : 'games'})` : '';
		console.log(`gen: ${relative(root, path)} ${changed ? 'written' : 'unchanged'}${count}`);
	}
}
