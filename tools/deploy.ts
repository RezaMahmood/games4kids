import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionAppName } from './package-app.ts';
import { fillSite, type Deployment } from './site-config.ts';
import type { SiteKind } from './site-layout.ts';

export const RESOURCE_GROUP = 'rg-games4kids';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const staticWebAppName = (kind: SiteKind) => `swa-g4k-${kind}`;

/** The route each app answers without a token, as the apps' routers define it. */
export const healthPath = (app: string) => (app === 'portal' ? '/api/portal/health' : app === 'admin' ? '/api/admin/portal/health' : `/api/g/${app}/health`);

/** Role assignments take up to 30 minutes to reach a new resource, and until then Azure answers 403. */
export const isAuthorizationError = (text: string) => /AuthorizationFailed|does not have authorization|Forbidden|\b40[13]\b/i.test(text);

export const kuduHost = (defaultHostName: string) => defaultHostName.replace('.', '.scm.');

export type Sleep = (milliseconds: number) => Promise<void>;
const realSleep: Sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** Tries again after each failure `retryable` accepts, until the budget is spent; any other failure, or the last, is thrown. */
export async function retrying<T>(attempt: () => Promise<T> | T, options: { budget: number; every: number; retryable: (error: Error) => boolean; sleep?: Sleep }): Promise<T> {
	const sleep = options.sleep ?? realSleep;
	let waited = 0;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (!options.retryable(failure) || waited + options.every > options.budget) throw failure;
			console.log(`retrying in ${options.every / SECOND}s: ${failure.message.split('\n')[0]}`);
			await sleep(options.every);
			waited += options.every;
		}
	}
}

const whileAuthorizing = (error: Error) => isAuthorizationError(error.message);
const propagation = { budget: 32 * MINUTE, every: 30 * SECOND, retryable: whileAuthorizing };

export function az(args: readonly string[]): string {
	try {
		return execFileSync('az', [...args, '--only-show-errors'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch (error) {
		const { stderr } = error as { stderr?: string };
		throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${stderr ?? String(error)}`, { cause: error });
	}
}

export type WhatIfChange = { readonly changeType: string; readonly resourceId: string };

/** A markdown table of what a deployment would change, for the job summary. */
export function summarizeWhatIf(title: string, changes: readonly WhatIfChange[]): string {
	const rows = changes.filter(({ changeType }) => changeType !== 'Ignore').map(({ changeType, resourceId }) => `| ${changeType} | ${resourceId.split('/providers/').at(-1) ?? resourceId} |`);
	const body = rows.length > 0 ? ['| Change | Resource |', '| --- | --- |', ...rows] : ['No changes.'];
	return [`### ${title}`, '', ...body, '', ''].join('\n');
}

export type Resource = { readonly id: string; readonly type: string; readonly tags?: Readonly<Record<string, string>> | null };

const UNTAGGED_OK = new Set(['microsoft.alertsmanagement/smartdetectoralertrules', 'microsoft.managedidentity/useridentities', 'microsoft.managedidentity/userassignedidentities']);

/** Cost by tag works only while every resource carries app=games4kids and a game. Azure-made and bootstrap-made resources are exempt. */
export function untagged(resources: readonly Resource[]): readonly string[] {
	return resources.filter(({ type, tags }) => !UNTAGGED_OK.has(type.toLowerCase()) && !(tags?.['app'] === 'games4kids' && tags['game'])).map(({ id }) => id);
}

export type GameOutputs = { readonly storageAccountName: string; readonly playPrincipalId: string; readonly adminPrincipalId: string; readonly queues: readonly string[]; readonly location: string };

/** The parameters games/<id>/infra.bicep receives: what the sketch calls GameModuleParams. */
export function moduleParameters(game: string, outputs: GameOutputs): Record<string, { value: unknown }> {
	return {
		tags: { value: { app: 'games4kids', game } },
		location: { value: outputs.location },
		storageAccountName: { value: outputs.storageAccountName },
		playPrincipalId: { value: outputs.playPrincipalId },
		adminPrincipalId: { value: outputs.adminPrincipalId },
		queues: { value: outputs.queues },
	};
}

function summary(markdown: string) {
	console.log(markdown);
	if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], markdown);
}

function previewAndDeploy(name: string, template: string, parameters: readonly string[]): string {
	const run = (verb: 'what-if' | 'create', extra: readonly string[]) => az(['deployment', 'group', verb, '-g', RESOURCE_GROUP, '-n', name, '-f', template, '--parameters', ...parameters, ...extra, '-o', 'json']);
	const preview = JSON.parse(run('what-if', ['--no-pretty-print'])) as { changes?: WhatIfChange[] };
	summary(summarizeWhatIf(`what-if ${name}`, preview.changes ?? []));
	return run('create', ['--mode', 'Incremental']);
}

function checkTags() {
	const missing = untagged(JSON.parse(az(['resource', 'list', '-g', RESOURCE_GROUP, '-o', 'json'])) as Resource[]);
	if (missing.length > 0) throw new Error(`These resources lack tags app=games4kids and game, so cost cannot be split by game:\n${missing.join('\n')}`);
}

function writeParameters(parameters: Record<string, { value: unknown }>): string {
	const path = join(mkdtempSync(join(tmpdir(), 'g4k-params-')), 'parameters.json');
	writeFileSync(path, JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters }));
	return `@${path}`;
}

const need = (name: string) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

type Settings = Record<string, string>;
type ModuleOutputs = { readonly playSettings?: { readonly value: Settings }; readonly adminSettings?: { readonly value: Settings } };

/** The admin app is shared, so a game's admin settings carry the game's prefix, as the host reads them. */
export const prefixed = (game: string, settings: Settings): Settings => Object.fromEntries(Object.entries(settings).map(([name, value]) => [`${game.toUpperCase()}_${name}`, value]));

/** Merges into the app's settings. Bicep writes the base settings in full, so every deploy that writes them applies these again. */
function mergeSettings(app: string, settings: Settings): void {
	const pairs = Object.entries(settings).map(([name, value]) => `${name}=${value}`);
	if (pairs.length > 0) az(['functionapp', 'config', 'appsettings', 'set', '-g', RESOURCE_GROUP, '-n', functionAppName(app), '--settings', ...pairs, '-o', 'none']);
}

function reapplyAdminSettings(): void {
	const modules = JSON.parse(az(['deployment', 'group', 'list', '-g', RESOURCE_GROUP, '--query', "[?starts_with(name,'game-') && ends_with(name,'-module') && properties.provisioningState=='Succeeded'].{name:name,outputs:properties.outputs}", '-o', 'json'])) as { name: string; outputs?: ModuleOutputs }[];
	for (const { name, outputs } of modules) mergeSettings('admin', prefixed(name.slice('game-'.length, -'-module'.length), outputs?.adminSettings?.value ?? {}));
}

export function deploySharedInfra(): void {
	const parameters = [`gamesClientId=${need('GAMES_CLIENT_ID')}`, `adminClientId=${need('ADMIN_CLIENT_ID')}`, `gamesPrincipalId=${need('GAMES_PRINCIPAL_ID')}`, `adminPrincipalId=${need('ADMIN_PRINCIPAL_ID')}`, `alertEmail=${need('ALERT_EMAIL')}`];
	previewAndDeploy('main', 'infra/main.bicep', parameters);
	reapplyAdminSettings();
	checkTags();
}

export function deployGameInfra(game: string): void {
	const core = JSON.parse(previewAndDeploy(`game-${game}`, 'infra/game.bicep', [`@games/${game}/.gen/params.json`, `gamesClientId=${need('GAMES_CLIENT_ID')}`])) as { properties: { outputs: { [K in keyof GameOutputs]: { value: GameOutputs[K] } } } };
	const module = `games/${game}/infra.bicep`;
	if (existsSync(module)) {
		const values = Object.fromEntries(Object.entries(core.properties.outputs).map(([name, { value }]) => [name, value])) as GameOutputs;
		const result = JSON.parse(previewAndDeploy(`game-${game}-module`, module, [writeParameters(moduleParameters(game, values))])) as { properties: { outputs?: ModuleOutputs } };
		mergeSettings(game, result.properties.outputs?.playSettings?.value ?? {});
		mergeSettings('admin', prefixed(game, result.properties.outputs?.adminSettings?.value ?? {}));
	}
	checkTags();
}

/** `az functionapp show` returns a Flex Consumption app in the raw ARM shape, with the host name under `properties`. */
export function defaultHostOf(site: unknown): string {
	const record = (site ?? {}) as { defaultHostName?: unknown; properties?: { defaultHostName?: unknown } };
	const host = record.properties?.defaultHostName ?? record.defaultHostName;
	if (typeof host !== 'string' || host === '') throw new Error('the Function app has no host name yet');
	return host;
}

const hostOf = (app: string) => defaultHostOf(JSON.parse(az(['functionapp', 'show', '-g', RESOURCE_GROUP, '-n', functionAppName(app), '-o', 'json'])));
const originOf = (app: string) => `https://${hostOf(app)}`;

async function get(url: string, headers: Record<string, string> = {}) {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(30 * SECOND) });
	return { status: response.status, body: await response.text() };
}

async function waitForHealth(app: string, origin: string) {
	const url = `${origin}${healthPath(app)}`;
	await retrying(
		async () => {
			const { status, body } = await get(url);
			if (status !== 200 || !body.includes('"ok":true')) throw new Error(`${url} answered ${status}`);
			console.log(`${url} is healthy`);
		},
		{ budget: 10 * MINUTE, every: 10 * SECOND, retryable: () => true },
	);
}

type Latest = { readonly id?: string; readonly complete?: boolean; readonly status?: number };

async function latestDeployment(scm: string, token: string): Promise<Latest> {
	const { status, body } = await get(`https://${scm}/api/deployments/latest`, { authorization: `Bearer ${token}` });
	if (status === 404) return {};
	if (status !== 200) throw new Error(`Kudu answered ${status} for the latest deployment`);
	return JSON.parse(body) as Latest;
}

export async function deployApp(app: string, zipPath: string): Promise<void> {
	const name = functionAppName(app);
	const host = await retrying(() => hostOf(app), propagation);
	const scm = kuduHost(host);
	const token = az(['account', 'get-access-token', '--resource', 'https://management.azure.com', '--query', 'accessToken', '-o', 'tsv']);
	const authorization = { authorization: `Bearer ${token}` };
	const previous = (await retrying(() => latestDeployment(scm, token), propagation)).id;
	const zip = readFileSync(zipPath);
	await retrying(
		async () => {
			const response = await fetch(`https://${scm}/api/publish?type=zip&RemoteBuild=false`, { method: 'POST', headers: { ...authorization, 'content-type': 'application/zip' }, body: zip, signal: AbortSignal.timeout(10 * MINUTE) });
			if (response.status !== 200 && response.status !== 202) throw new Error(`publish answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
		},
		propagation,
	);
	await retrying(
		async () => {
			const latest = await latestDeployment(scm, token);
			if (!latest.complete || latest.id === previous) throw new Error('the deployment is still running');
			if (latest.status !== 4) throw new Error(`deployment ${latest.id} finished with status ${latest.status}; see https://${scm}/api/deployments/${latest.id}/log`);
		},
		{ budget: 5 * MINUTE, every: 5 * SECOND, retryable: (error) => error.message === 'the deployment is still running' },
	);
	console.log(`${name} deployed`);
	await waitForHealth(app, `https://${host}`);
}

export async function deploySite(kind: SiteKind, dir: string, swaCli: string): Promise<void> {
	const games = kind === 'games';
	const telemetryConnectionString = await retrying(() => az(['functionapp', 'config', 'appsettings', 'list', '-g', RESOURCE_GROUP, '-n', functionAppName(games ? 'portal' : 'admin'), '--query', "[?name=='APPLICATIONINSIGHTS_CONNECTION_STRING'].value | [0]", '-o', 'tsv']), propagation);
	const common = { tenantId: az(['account', 'show', '--query', 'tenantId', '-o', 'tsv']), telemetryConnectionString };
	const deployment: Deployment = games
		? await gamesDeployment(common, dir)
		: { kind: 'admin', ...common, clientId: need('ADMIN_CLIENT_ID'), adminOrigin: await retrying(() => originOf('admin'), propagation) };
	fillSite(dir, deployment);
	const name = staticWebAppName(kind);
	const apiKey = await retrying(() => az(['staticwebapp', 'secrets', 'list', '-g', RESOURCE_GROUP, '-n', name, '--query', 'properties.apiKey', '-o', 'tsv']), propagation);
	console.log(`::add-mask::${apiKey}`);
	execFileSync(process.execPath, [swaCli, 'deploy', dir, '--env', 'production'], { stdio: 'inherit', env: { ...process.env, SWA_CLI_DEPLOYMENT_TOKEN: apiKey } });
	const host = az(['staticwebapp', 'show', '-g', RESOURCE_GROUP, '-n', name, '--query', 'defaultHostname', '-o', 'tsv']);
	await retrying(
		async () => {
			const { status, body } = await get(`https://${host}/config.json`);
			if (status !== 200 || !body.includes(deployment.clientId)) throw new Error(`https://${host}/config.json answered ${status}`);
			console.log(`https://${host} serves the new config`);
		},
		{ budget: 5 * MINUTE, every: 10 * SECOND, retryable: () => true },
	);
}

async function gamesDeployment(common: { tenantId: string; telemetryConnectionString: string }, dir: string): Promise<Deployment> {
	const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')) as { id: string }[];
	const playerOrigins: Record<string, string> = {};
	for (const { id } of catalog) playerOrigins[id] = await retrying(() => originOf(id), propagation);
	return { kind: 'games', ...common, clientId: need('GAMES_CLIENT_ID'), portalOrigin: await retrying(() => originOf('portal'), propagation), playerOrigins };
}
