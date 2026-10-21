import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workerConnection } from '@g4k/host';
import { CHAT_DEPLOYMENT } from '../games/drawpad/admin/api/titles.ts';
import { REDRAWS } from '../games/drawpad/admin/api/redraw.ts';
import manifest from '../games/drawpad/manifest.ts';
import letterjoin from '../games/letterjoin/manifest.ts';
import { BORROWED_VISION } from '../tools/bootstrap.ts';
import { gameId } from './support/ids.ts';
import { moduleParameters, prefixed } from '../tools/deploy.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const bicep = spawnSync('az', ['bicep', 'version'], { stdio: 'ignore' }).status === 0;
const skip = bicep ? false : 'az bicep is missing';

type Template = {
	parameters: Record<string, { type: string; defaultValue?: unknown }>;
	outputs: Record<string, { value?: Record<string, unknown> }>;
	variables?: Record<string, unknown>;
	resources: { type: string; name: string; scope?: string; properties?: Record<string, unknown> }[];
};

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

/** Each role assignment on a portal table as `table holder role`, read from the compiled ARM expressions. */
function portalTableGrants(template: Template): string[] {
	return template.resources.filter((resource) => resource.type === 'Microsoft.Authorization/roleAssignments').flatMap((resource) => {
		const table = /tableServices\/tables', format\('g4kportal\{0\}', variables\('suffix'\)\), 'default', '(\w+)'\)\]$/.exec(resource.scope ?? '')?.[1];
		if (!table) return [];
		const principal = String(resource.properties?.['principalId']);
		const holder = principal.includes("parameters('adminIdentityName')") ? 'admin' : principal.includes("'func-g4k-portal'") ? 'portal' : principal;
		const role = String(resource.properties?.['roleDefinitionId']).includes("variables('tableDataContributor')") ? 'writer' : 'reader';
		return [`${table} ${holder} ${role}`];
	}).sort();
}

test('each portal table has one writer, and the portal app and every player app read what admission needs', { skip }, () => {
	assert.deepEqual(portalTableGrants(compile('infra/main.bicep')), [
		'admins admin reader',
		'emails admin writer',
		'games admin writer',
		'games portal reader',
		'identities admin writer',
		'identities portal reader',
		'members admin writer',
		'members portal reader',
		'profiles admin reader',
		'profiles portal writer',
	]);
	assert.deepEqual(compile('infra/game.bicep').variables?.['portalTablesPlayersRead'], ['members', 'games', 'identities', 'profiles']);
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

test('drawpad deploys every model its code names, starts a job from the ready blob of the manifest\'s container, and hands the admin app what its queue trigger reads', { skip }, () => {
	const template = compile('games/drawpad/infra.bicep');
	assert.deepEqual(required(template).sort(), ['adminPrincipalId', 'location', 'playPrincipalId', 'queues', 'storageAccountName', 'tags']);
	assert.deepEqual(Object.keys(template.parameters).filter((name) => !required(template).includes(name)).sort(), ['adminIdentityName', 'deployments', 'foundryLocation']);
	assert.equal(template.parameters['foundryLocation']?.defaultValue, 'swedencentral');

	const deployed = (template.parameters['deployments']?.defaultValue as { name: string }[]).map((model) => model.name);
	assert.deepEqual(deployed.sort(), [CHAT_DEPLOYMENT, ...Object.values(REDRAWS).map((redraw) => redraw.deployment)].sort());

	const subscription = template.resources.find((resource) => resource.type === 'Microsoft.EventGrid/systemTopics/eventSubscriptions');
	const filter = subscription?.properties?.['filter'] as { subjectBeginsWith: string; subjectEndsWith: string; includedEventTypes: string[] };
	assert.ok('jobs' in manifest.storage.containers);
	assert.equal(filter.subjectBeginsWith, '/blobServices/default/containers/jobs/blobs/');
	assert.equal(filter.subjectEndsWith, '/ready');
	assert.deepEqual(filter.includedEventTypes, ['Microsoft.Storage.BlobCreated']);
	const destination = (subscription?.properties?.['deliveryWithResourceIdentity'] as { destination: { properties: { queueName: string } } }).destination;
	assert.equal(destination.properties.queueName, "[variables('jobQueue')]");
	assert.ok(String(template.variables?.['jobQueue']) in manifest.storage.queues, 'the queue the events go to is one the manifest declares');

	const settings = Object.keys(prefixed('drawpad', (template.outputs['adminSettings']?.value ?? {}) as Record<string, string>));
	assert.ok(settings.includes('DRAWPAD_FOUNDRY_ENDPOINT'));
	for (const name of ['queueServiceUri', 'credential', 'clientId']) assert.ok(settings.includes(`${workerConnection(gameId('drawpad'))}__${name}`), `the worker connection needs ${name}`);
});

test('letterjoin borrows the old letterjoin Vision account that bootstrap grants it, and hands its player app the endpoint its manifest declares', { skip }, () => {
	const template = compile('games/letterjoin/infra.bicep');
	assert.deepEqual(required(template).sort(), ['adminPrincipalId', 'location', 'playPrincipalId', 'queues', 'storageAccountName', 'tags']);
	assert.deepEqual(template.resources, [], 'the pipeline creates nothing for letterjoin, because the subscription already holds its one free Vision account');
	const account = BORROWED_VISION.path.split('/').at(-1);
	assert.equal(template.variables?.['visionEndpoint'], `https://${account}.cognitiveservices.azure.com/`);

	const settings = Object.keys(template.outputs['playSettings']?.value ?? {});
	assert.deepEqual(settings, Object.keys(letterjoin.play.settings));
	assert.deepEqual(letterjoin.play.services, ['cognitiveServices']);
});
