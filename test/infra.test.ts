import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { moduleParameters, prefixed } from '../tools/deploy.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bicep = spawnSync('az', ['bicep', 'version'], { stdio: 'ignore' }).status === 0;
const skip = bicep ? false : 'az bicep is missing';

type Template = { parameters: Record<string, { type: string; defaultValue?: unknown }>; outputs: Record<string, unknown> };

function compile(file: string): Template {
	const out = join(mkdtempSync(join(tmpdir(), 'g4k-bicep-')), 'template.json');
	const run = spawnSync('az', ['bicep', 'build', '--file', join(repo, file), '--outfile', out], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(readFileSync(out, 'utf8')) as Template;
}

const required = (template: Template) => Object.entries(template.parameters).filter(([, parameter]) => parameter.defaultValue === undefined).map(([name]) => name).sort();

test('infra/game.bicep takes exactly the parameters gen writes and the pipeline adds', { skip }, () => {
	const template = compile('infra/game.bicep');
	assert.deepEqual(required(template), ['gamesClientId', 'id', 'storage']);
	for (const name of ['memoryMb', 'maxInstances']) assert.ok(name in template.parameters, `${name} is a parameter`);
});

test('infra/main.bicep takes the ids the repository variables hold', { skip }, () => {
	assert.deepEqual(required(compile('infra/main.bicep')), ['adminClientId', 'adminPrincipalId', 'alertEmail', 'gamesClientId', 'gamesPrincipalId']);
});

test('a game infra.bicep receives what the pipeline passes it and hands back app settings', { skip }, () => {
	const template = compile('test/fixtures/games/fixture/infra.bicep');
	assert.deepEqual(Object.keys(template.parameters).sort(), Object.keys(moduleParameters('fixture', { storageAccountName: '', playPrincipalId: '', adminPrincipalId: '', queues: [], location: '' })).sort());
	assert.ok('playSettings' in template.outputs && 'adminSettings' in template.outputs);
});

test('the workbook is valid, reads the one Application Insights, and splits every tile by game without naming a game', () => {
	const text = readFileSync(join(repo, 'infra/workbook.json'), 'utf8');
	const workbook = JSON.parse(text) as { fallbackResourceIds: string[]; items: { name: string; content: { query?: string } }[] };
	assert.deepEqual(workbook.fallbackResourceIds, ['__APP_INSIGHTS_ID__']);
	const tiles = workbook.items.filter((item) => item.content.query);
	assert.deepEqual(tiles.map((tile) => tile.name), ['requests-by-game', 'requests-over-time', 'play-minutes', 'ai-calls', 'cost-by-game']);
	for (const tile of tiles) assert.match(tile.content.query ?? '', /\bgame\b/);
	assert.doesNotMatch(text, /drawpad|letterjoin/);
	const cost = JSON.parse(tiles.at(-1)?.content.query ?? '{}') as { body: string };
	assert.deepEqual(JSON.parse(cost.body).dataset.grouping, [{ type: 'TagKey', name: 'game' }]);
});

test('admin settings of a game carry its prefix, as the admin host reads them', () => {
	assert.deepEqual(prefixed('drawpad', { FOUNDRY_ENDPOINT: 'https://x' }), { DRAWPAD_FOUNDRY_ENDPOINT: 'https://x' });
});
