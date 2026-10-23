import { createHash } from 'node:crypto';
import { customDomain, RESOURCE_GROUP, staticWebAppName } from './deploy.ts';
import { guestHomeEmail } from '@g4k/host';
import { parseEmail, type Email } from '@g4k/sdk';
import { OLD_ACCOUNTS, type Game } from './migrate/model.ts';
import { functionAppName } from './package-app.ts';

export const LOCATION = 'westeurope';
export const STEPS = ['providers', 'entra-apps', 'identities', 'azure-roles', 'admin-account', 'github', 'after-first-deploy'] as const;
export type StepName = (typeof STEPS)[number];
export const DEFAULT_STEPS: readonly StepName[] = ['providers', 'entra-apps', 'identities', 'azure-roles', 'admin-account', 'github'];

export const PROVIDERS = ['Microsoft.Authorization', 'Microsoft.CognitiveServices', 'Microsoft.EventGrid', 'Microsoft.Insights', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Resources', 'Microsoft.Storage', 'Microsoft.Web'];

export const INFRA_IDENTITY = 'id-g4k-infra';
export const DEPLOY_IDENTITY = 'id-g4k-deploy';
export const ADMIN_IDENTITY = 'id-g4k-admin';
export const IDENTITIES = [INFRA_IDENTITY, DEPLOY_IDENTITY, ADMIN_IDENTITY] as const;
export const GITHUB_ENVIRONMENTS = [
	{ name: 'infra', identity: INFRA_IDENTITY },
	{ name: 'deploy', identity: DEPLOY_IDENTITY },
] as const;

export const TOKEN_EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';
export const ADMIN_MARKER = 'games4kids-admin';
export const PASSWORD_SENTINEL = '<generated-at-apply-never-printed>';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MS_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const DEFAULT_ACCESS = '00000000-0000-0000-0000-000000000000';

export const GRAPH_DELEGATED: Readonly<Record<string, string>> = {
	'User.Invite.All': '63dd7cd9-b489-4adf-a28c-ac38b9a0f962',
	'User.ReadBasic.All': 'b340eb25-3456-403f-be2f-af7a0d370277',
	'AppRoleAssignment.ReadWrite.All': '84bccea3-f856-4a8a-967b-dbe0a3d53a64',
	'Application.Read.All': 'c79f8feb-a9db-4090-85f9-90d820caa0eb',
};

/** Scopes an earlier bootstrap requested. A re-run removes them from the registration. */
export const RETIRED_GRAPH_DELEGATED: Readonly<Record<string, string>> = {
	'User.Read.All': 'a154be20-db9c-4678-8ab7-66f6cc099a59',
};

export const DIRECTORY_ROLES = {
	guestInviter: '95e79109-95c0-4d8e-aee3-d01accf2d47b',
} as const;

export const AZURE_ROLES = {
	contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
	rbacAdministrator: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168',
	websiteContributor: 'de139f84-1756-47ae-9be6-808fbbe84772',
	tableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3',
	tableDataReader: '76199698-9eea-4c19-bc75-cec21354c6b6',
	blobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',
	blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
	blobDataReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',
	queueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88',
	queueDataReader: '19e7f393-937e-4f77-808e-94535e297925',
	queueDataMessageSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a',
	cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908',
	cognitiveServicesOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd',
	monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb',
	keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
} as const;

/** What id-g4k-infra may assign to any service principal. */
export const ASSIGNABLE_TO_ANY = [
	AZURE_ROLES.tableDataContributor,
	AZURE_ROLES.tableDataReader,
	AZURE_ROLES.blobDataOwner,
	AZURE_ROLES.blobDataContributor,
	AZURE_ROLES.blobDataReader,
	AZURE_ROLES.queueDataContributor,
	AZURE_ROLES.queueDataReader,
	AZURE_ROLES.queueDataMessageSender,
	AZURE_ROLES.cognitiveServicesUser,
	AZURE_ROLES.cognitiveServicesOpenAiUser,
	AZURE_ROLES.monitoringMetricsPublisher,
	AZURE_ROLES.keyVaultSecretsUser,
] as const;

/** What id-g4k-infra may assign to id-g4k-deploy and to no other principal. */
export const ASSIGNABLE_TO_DEPLOY = [AZURE_ROLES.websiteContributor, AZURE_ROLES.contributor] as const;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Rec = Readonly<Record<string, unknown>>;
export const rec = (value: unknown): Rec => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : {});
export const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const texts = (value: unknown): readonly string[] => list(value).filter((item): item is string => typeof item === 'string');

export type Command = { readonly tool: 'az' | 'gh'; readonly args: readonly string[]; readonly body?: unknown };
export type Retry = 'none' | 'quick' | 'propagation';
export type Remember = { readonly kind: 'application' | 'servicePrincipal' | 'user'; readonly key: string };
export type Action = { readonly id: string; readonly summary: string; readonly command: Command; readonly awaits: readonly string[]; readonly retry: Retry; readonly remember?: Remember };
export type Status = 'ok' | 'change' | 'blocked' | 'skipped' | 'todo';
export type Finding = { readonly step: StepName; readonly id: string; readonly status: Status; readonly detail: string; readonly fix: readonly Action[] };

const finding = (step: StepName, id: string, status: Status, detail: string, fix: readonly Action[] = []): Finding => ({ step, id, status, detail, fix });
const fine = (step: StepName, id: string, detail: string) => finding(step, id, 'ok', detail);
const blocked = (step: StepName, id: string, reason: string) => finding(step, id, 'blocked', reason);
const skipped = (step: StepName, id: string, reason: string) => finding(step, id, 'skipped', reason);
const todo = (step: StepName, id: string, what: string) => finding(step, id, 'todo', what);
const changing = (step: StepName, id: string, detail: string, ...fix: Action[]) => finding(step, id, 'change', detail, fix);

export const action = (id: string, summary: string, command: Command, options: { awaits?: readonly string[]; retry?: Retry; remember?: Remember } = {}): Action => ({
	id,
	summary,
	command,
	awaits: options.awaits ?? [],
	retry: options.retry ?? 'none',
	...(options.remember ? { remember: options.remember } : {}),
});

export const azCommand = (...args: string[]): Command => ({ tool: 'az', args });
export const graphCommand = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Command => ({
	tool: 'az',
	args: ['rest', '--method', method, '--url', `${GRAPH}${path}`, '--headers', 'Content-Type=application/json'],
	...(body === undefined ? {} : { body }),
});
export const ghCommand = (...args: string[]): Command => ({ tool: 'gh', args });
export const ghApiCommand = (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Command => ({ tool: 'gh', args: ['api', '--method', method, path], ...(body === undefined ? {} : { body }) });

/** Anything this cannot prove is a read counts as a write, so a new verb fails closed. */
export function isReadOnly(command: Command): boolean {
	if (command.body !== undefined) return false;
	const { tool, args } = command;
	if (tool === 'az' && args[0] === 'rest') {
		const at = args.indexOf('--method');
		return (at < 0 ? 'GET' : (args[at + 1] ?? '').toUpperCase()) === 'GET';
	}
	if (tool === 'az') {
		const flag = args.findIndex((arg) => arg.startsWith('-'));
		const path = args.slice(0, flag < 0 ? args.length : flag);
		return ['show', 'list', 'exists'].includes(path.at(-1) ?? '');
	}
	if (args[0] === 'api') {
		const at = args.findIndex((arg) => arg === '--method' || arg === '-X');
		const method = at < 0 ? 'GET' : (args[at + 1] ?? '').toUpperCase();
		const sendsFields = args.some((arg) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(arg));
		return method === 'GET' && !sendsFields;
	}
	return (args[0] === 'variable' && args[1] === 'list') || (args[0] === 'repo' && args[1] === 'view') || (args[0] === 'auth' && args[1] === 'status');
}

export function guidFrom(name: string): string {
	const hash = createHash('sha1').update(name).digest();
	hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
	hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type PermissionScope = {
	readonly id: string;
	readonly value: string;
	readonly type: string;
	readonly isEnabled: boolean;
	readonly adminConsentDisplayName: string;
	readonly adminConsentDescription: string;
	readonly userConsentDisplayName: string;
	readonly userConsentDescription: string;
};
export type ClaimEntry = { readonly name: string; readonly source: string | null; readonly essential: boolean; readonly additionalProperties: readonly string[] };
export type ResourceAccess = { readonly resourceAppId: string; readonly access: readonly { readonly id: string; readonly type: string }[] };
export type GraphApp = {
	readonly id: string;
	readonly appId: string;
	readonly displayName: string;
	readonly signInAudience: string;
	readonly tags: readonly string[];
	readonly identifierUris: readonly string[];
	readonly tokenVersion: number | null;
	readonly scopes: readonly PermissionScope[];
	readonly preAuthorized: number;
	readonly redirectUris: readonly string[];
	readonly claims: { readonly accessToken: readonly ClaimEntry[]; readonly idToken: readonly ClaimEntry[]; readonly saml2Token: readonly ClaimEntry[] };
	readonly resourceAccess: readonly ResourceAccess[];
};
export type GraphSp = { readonly id: string; readonly appId: string; readonly appRoleAssignmentRequired: boolean; readonly tags: readonly string[] };

const parseScope = (raw: unknown): PermissionScope => {
	const scope = rec(raw);
	return {
		id: text(scope['id']),
		value: text(scope['value']),
		type: text(scope['type']),
		isEnabled: scope['isEnabled'] === true,
		adminConsentDisplayName: text(scope['adminConsentDisplayName']),
		adminConsentDescription: text(scope['adminConsentDescription']),
		userConsentDisplayName: text(scope['userConsentDisplayName']),
		userConsentDescription: text(scope['userConsentDescription']),
	};
};
const parseClaim = (raw: unknown): ClaimEntry => {
	const claim = rec(raw);
	return { name: text(claim['name']), source: typeof claim['source'] === 'string' ? claim['source'] : null, essential: claim['essential'] === true, additionalProperties: texts(claim['additionalProperties']) };
};

export function parseApplication(raw: unknown): GraphApp {
	const app = rec(raw);
	const api = rec(app['api']);
	const claims = rec(app['optionalClaims']);
	return {
		id: text(app['id']),
		appId: text(app['appId']),
		displayName: text(app['displayName']),
		signInAudience: text(app['signInAudience']),
		tags: texts(app['tags']),
		identifierUris: texts(app['identifierUris']),
		tokenVersion: typeof api['requestedAccessTokenVersion'] === 'number' ? api['requestedAccessTokenVersion'] : null,
		scopes: list(api['oauth2PermissionScopes']).map(parseScope),
		preAuthorized: list(api['preAuthorizedApplications']).length,
		redirectUris: texts(rec(app['spa'])['redirectUris']),
		claims: { accessToken: list(claims['accessToken']).map(parseClaim), idToken: list(claims['idToken']).map(parseClaim), saml2Token: list(claims['saml2Token']).map(parseClaim) },
		resourceAccess: list(app['requiredResourceAccess']).map((entry) => ({
			resourceAppId: text(rec(entry)['resourceAppId']),
			access: list(rec(entry)['resourceAccess']).map((item) => ({ id: text(rec(item)['id']), type: text(rec(item)['type']) })),
		})),
	};
}

export function parseServicePrincipal(raw: unknown): GraphSp {
	const sp = rec(raw);
	return { id: text(sp['id']), appId: text(sp['appId']), appRoleAssignmentRequired: sp['appRoleAssignmentRequired'] === true, tags: texts(sp['tags']) };
}

export type AppKey = 'games' | 'admin';
export type AppSpec = {
	readonly key: AppKey;
	readonly displayName: string;
	readonly tag: string;
	readonly scopes: readonly { readonly value: string; readonly description: string }[];
	readonly claims: readonly string[];
	readonly graphScopes: readonly string[];
};

export const APP_SPECS: Readonly<Record<AppKey, AppSpec>> = {
	games: {
		key: 'games',
		displayName: 'games4kids',
		tag: 'games4kids-bootstrap:games',
		scopes: [{ value: 'access_as_user', description: 'play the games as the signed-in child' }],
		claims: ['email', 'upn'],
		graphScopes: [],
	},
	admin: {
		key: 'admin',
		displayName: 'games4kids-admin',
		tag: 'games4kids-bootstrap:admin',
		scopes: [
			{ value: 'admin.console', description: 'use the admin console as the signed-in administrator' },
			{ value: 'admin.elevate', description: 'make Entra changes as the signed-in administrator after a fresh sign-in' },
		],
		claims: ['auth_time', 'email', 'upn'],
		graphScopes: Object.keys(GRAPH_DELEGATED),
	},
};
export const APP_KEYS: readonly AppKey[] = ['games', 'admin'];

const SP_TAG = 'WindowsAzureActiveDirectoryIntegratedApp';

export function desiredScope(spec: AppSpec, value: string, description: string): PermissionScope {
	return {
		id: guidFrom(`${spec.tag}/${value}`),
		value,
		type: 'User',
		isEnabled: true,
		adminConsentDisplayName: `${spec.displayName}: ${value}`,
		adminConsentDescription: `Lets the app ${description}.`,
		userConsentDisplayName: `${spec.displayName}: ${value}`,
		userConsentDescription: `Lets the app ${description}.`,
	};
}

export function mergeScopes(spec: AppSpec, existing: readonly PermissionScope[]): readonly PermissionScope[] {
	const kept = existing.map((scope) => (spec.scopes.some(({ value }) => value === scope.value) ? { ...scope, isEnabled: true } : scope));
	const added = spec.scopes.filter(({ value }) => !existing.some((scope) => scope.value === value)).map(({ value, description }) => desiredScope(spec, value, description));
	return [...kept, ...added];
}

export function mergeClaims(spec: AppSpec, existing: readonly ClaimEntry[]): readonly ClaimEntry[] {
	return [...existing, ...spec.claims.filter((name) => !existing.some((claim) => claim.name === name)).map((name) => ({ name, source: null, essential: false, additionalProperties: [] }))];
}

export function mergeResourceAccess(spec: AppSpec, existing: readonly ResourceAccess[]): readonly ResourceAccess[] {
	if (spec.graphScopes.length === 0) return existing;
	const wanted = spec.graphScopes.map((name) => ({ id: GRAPH_DELEGATED[name] ?? '', type: 'Scope' }));
	const graph = existing.find((entry) => entry.resourceAppId === MS_GRAPH_APP_ID);
	const kept = (graph?.access ?? []).filter((have) => !Object.values(RETIRED_GRAPH_DELEGATED).includes(have.id));
	const merged = { resourceAppId: MS_GRAPH_APP_ID, access: [...kept, ...wanted.filter((scope) => !kept.some((have) => have.id === scope.id))] };
	return [...existing.filter((entry) => entry.resourceAppId !== MS_GRAPH_APP_ID), merged];
}

const wireResourceAccess = (entries: readonly ResourceAccess[]) => entries.map(({ resourceAppId, access }) => ({ resourceAppId, resourceAccess: access }));
const wireClaims = (claims: readonly ClaimEntry[]) => claims.map(({ name, source, essential, additionalProperties }) => ({ name, source, essential, additionalProperties }));

export type AppLookup = { readonly kind: 'found'; readonly app: GraphApp } | { readonly kind: 'missing' } | { readonly kind: 'conflict'; readonly reason: string };

/** Finds an app by the tag this script set, never by name alone. An untagged app with our name is someone else's and is left alone. */
export function lookupApp(apps: readonly GraphApp[], spec: AppSpec): AppLookup {
	const tagged = apps.filter((app) => app.tags.includes(spec.tag));
	if (tagged.length > 1) return { kind: 'conflict', reason: `${tagged.length} registrations carry the tag ${spec.tag}: ${tagged.map((app) => app.appId).join(', ')}` };
	const [app] = tagged;
	if (app) return app.displayName === spec.displayName ? { kind: 'found', app } : { kind: 'conflict', reason: `${app.appId} carries the tag ${spec.tag} but is named "${app.displayName}", not "${spec.displayName}"` };
	const sameName = apps.find((candidate) => candidate.displayName === spec.displayName);
	return sameName ? { kind: 'conflict', reason: `a registration named "${spec.displayName}" (${sameName.appId}) exists and bootstrap did not create it, so it is left alone` } : { kind: 'missing' };
}

export type Core = {
	readonly subscription: { readonly id: string; readonly tenantId: string; readonly user: string };
	readonly rg: { readonly exists: boolean; readonly id: string | null; readonly location: string | null };
	readonly apps: Readonly<Record<AppKey, AppLookup>>;
	readonly sps: Readonly<Record<AppKey, GraphSp | null>>;
	readonly identities: Readonly<Record<string, { readonly id: string; readonly clientId: string; readonly principalId: string } | undefined>>;
	readonly graph: { readonly spId: string | null; readonly scopes: Readonly<Record<string, string>> };
};

export const ownedIds = (core: Core): ReadonlySet<string> => {
	const ids = new Set<string>();
	for (const key of APP_KEYS) {
		const lookup = core.apps[key];
		if (lookup.kind === 'found') {
			ids.add(lookup.app.id);
			ids.add(lookup.app.appId);
		}
		const sp = core.sps[key];
		if (sp) ids.add(sp.id);
	}
	return ids;
};

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every Entra object a command names, as the ids that must be ones this script owns. Throws on any other. */
export function guardCommand(command: Command, owned: ReadonlySet<string>, what: string): void {
	if (command.tool !== 'az' || command.args[0] !== 'rest' || isReadOnly(command)) return;
	const url = command.args[command.args.indexOf('--url') + 1] ?? '';
	const touched = [...url.matchAll(/\/(?:applications|servicePrincipals|oauth2PermissionGrants)\/([0-9a-f-]{36})/gi)].map((match) => match[1] ?? '');
	const body = rec(command.body);
	for (const field of ['appId', 'clientId']) touched.push(...(text(body[field]).match(GUID) ?? []));
	const scope = text(body['directoryScopeId']);
	if (scope.length > 1) touched.push(...(scope.match(GUID) ?? []));
	const foreign = touched.filter((id) => !owned.has(id.toLowerCase()) && !owned.has(id));
	if (foreign.length > 0) throw new Error(`refusing "${what}": it touches ${foreign.join(', ')}, which bootstrap did not create. Only the games4kids and games4kids-admin registrations may change.`);
}

export const guardActions = (actions: readonly Action[], owned: ReadonlySet<string>) => actions.forEach(({ summary, command }) => guardCommand(command, new Set([...owned].map((id) => id.toLowerCase())), summary));

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const missingFrom = (have: readonly string[], want: readonly string[]) => want.filter((item) => !have.includes(item));

export function planProviders(core: Core, registered: Readonly<Record<string, string>>): Finding[] {
	const rows = PROVIDERS.map((namespace) => {
		const state = registered[namespace.toLowerCase()] ?? 'NotRegistered';
		return state === 'Registered'
			? fine('providers', `provider:${namespace}`, 'Registered')
			: changing('providers', `provider:${namespace}`, `${state}, register it`, action(`register ${namespace}`, `register resource provider ${namespace}`, azCommand('provider', 'register', '--namespace', namespace, '--wait')));
	});
	const group = core.rg.exists
		? core.rg.location === LOCATION
			? fine('providers', `resource-group:${RESOURCE_GROUP}`, `exists in ${LOCATION}`)
			: blocked('providers', `resource-group:${RESOURCE_GROUP}`, `exists in ${core.rg.location}, not ${LOCATION}. A group cannot move, so delete it or choose another name`)
		: changing('providers', `resource-group:${RESOURCE_GROUP}`, `missing, create it in ${LOCATION}`, action(`create ${RESOURCE_GROUP}`, `create resource group ${RESOURCE_GROUP} in ${LOCATION}`, azCommand('group', 'create', '--name', RESOURCE_GROUP, '--location', LOCATION)));
	return [...rows, group];
}

const rememberKey = (spec: AppSpec) => spec.tag;

function planOneApp(spec: AppSpec, core: Core): Finding[] {
	const step: StepName = 'entra-apps';
	const lookup = core.apps[spec.key];
	const label = spec.displayName;
	if (lookup.kind === 'conflict') return [blocked(step, `${label}:registration`, lookup.reason)];
	const spCreate = (appId: string | null, awaits: readonly string[]) =>
		action(`create service principal ${label}`, `create the enterprise application for ${label}`, graphCommand('POST', '/servicePrincipals', { appId: appId ?? `<${label} appId>`, appRoleAssignmentRequired: true, tags: [spec.tag, SP_TAG] }), {
			awaits,
			retry: 'quick',
			remember: { kind: 'servicePrincipal', key: rememberKey(spec) },
		});

	if (lookup.kind === 'missing') {
		const body = {
			displayName: spec.displayName,
			signInAudience: 'AzureADMyOrg',
			tags: [spec.tag],
			api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: spec.scopes.map(({ value, description }) => desiredScope(spec, value, description)) },
			spa: { redirectUris: [] },
			optionalClaims: { accessToken: wireClaims(mergeClaims(spec, [])), idToken: [], saml2Token: [] },
			requiredResourceAccess: wireResourceAccess(mergeResourceAccess(spec, [])),
		};
		const created = ['the registration'];
		return [
			changing(step, `${label}:registration`, 'missing, create it with its scopes, optional claims and token version 2', action(`create registration ${label}`, `create the app registration ${label} (single tenant, tag ${spec.tag})`, graphCommand('POST', '/applications', body), { remember: { kind: 'application', key: rememberKey(spec) } })),
			changing(step, `${label}:identifier-uri`, 'set api://<appId> once the registration exists', action(`set identifier URI ${label}`, `set the identifier URI of ${label} to api://<its appId>`, graphCommand('PATCH', `/applications/<${label} object id>`, { identifierUris: ['api://<appId>'] }), { awaits: created, retry: 'quick' })),
			changing(step, `${label}:service-principal`, 'create the enterprise application with assignment required', spCreate(null, created)),
		];
	}

	const { app } = lookup;
	const patch = (what: string, body: unknown) => action(`update ${what} of ${label}`, `update ${what} of ${label}`, graphCommand('PATCH', `/applications/${app.id}`, body));
	const rows: Finding[] = [fine(step, `${label}:registration`, `${app.appId}, found by tag ${spec.tag}`)];

	const uri = `api://${app.appId}`;
	rows.push(app.identifierUris.includes(uri) ? fine(step, `${label}:identifier-uri`, uri) : changing(step, `${label}:identifier-uri`, `missing ${uri}`, patch('the identifier URI', { identifierUris: [...app.identifierUris, uri] })));
	rows.push(app.signInAudience === 'AzureADMyOrg' ? fine(step, `${label}:sign-in-audience`, 'AzureADMyOrg') : changing(step, `${label}:sign-in-audience`, `is ${app.signInAudience}`, patch('the sign-in audience', { signInAudience: 'AzureADMyOrg' })));

	const scopeGaps = spec.scopes.filter(({ value }) => !app.scopes.some((scope) => scope.value === value && scope.isEnabled));
	const apiOk = app.tokenVersion === 2 && scopeGaps.length === 0 && app.preAuthorized === 0;
	const apiNotes = [app.tokenVersion === 2 ? '' : `token version ${app.tokenVersion}`, ...scopeGaps.map(({ value }) => `scope ${value} missing or disabled`), app.preAuthorized === 0 ? '' : `${app.preAuthorized} pre-authorized client(s)`].filter(Boolean);
	rows.push(
		apiOk
			? fine(step, `${label}:api`, `token version 2, scopes ${spec.scopes.map(({ value }) => value).join(', ')}, no pre-authorized client`)
			: changing(step, `${label}:api`, apiNotes.join('; '), patch('the API settings', { api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: mergeScopes(spec, app.scopes), preAuthorizedApplications: [] } })),
	);

	const claimGaps = missingFrom(app.claims.accessToken.map(({ name }) => name), spec.claims);
	rows.push(
		claimGaps.length === 0
			? fine(step, `${label}:optional-claims`, `access token claims ${spec.claims.join(', ')}`)
			: changing(step, `${label}:optional-claims`, `access token lacks ${claimGaps.join(', ')}`, patch('the optional claims', { optionalClaims: { accessToken: wireClaims(mergeClaims(spec, app.claims.accessToken)), idToken: wireClaims(app.claims.idToken), saml2Token: wireClaims(app.claims.saml2Token) } })),
	);

	if (spec.graphScopes.length > 0) {
		const have = app.resourceAccess.find((entry) => entry.resourceAppId === MS_GRAPH_APP_ID)?.access.map(({ id }) => id) ?? [];
		const gaps = spec.graphScopes.filter((name) => !have.includes(GRAPH_DELEGATED[name] ?? ''));
		const retired = Object.entries(RETIRED_GRAPH_DELEGATED).filter(([, id]) => have.includes(id)).map(([name]) => name);
		rows.push(
			gaps.length === 0 && retired.length === 0
				? fine(step, `${label}:graph-scopes`, `delegated ${spec.graphScopes.join(', ')}`)
				: changing(step, `${label}:graph-scopes`, [...(gaps.length > 0 ? [`missing delegated ${gaps.join(', ')}`] : []), ...(retired.length > 0 ? [`retired ${retired.join(', ')} still requested`] : [])].join(', '), patch('the requested Graph scopes', { requiredResourceAccess: wireResourceAccess(mergeResourceAccess(spec, app.resourceAccess)) })),
		);
	}

	const sp = core.sps[spec.key];
	if (!sp) rows.push(changing(step, `${label}:service-principal`, 'missing, create it with assignment required', spCreate(app.appId, [])));
	else if (!sp.appRoleAssignmentRequired) rows.push(changing(step, `${label}:service-principal`, 'assignment is not required', action(`require assignment ${label}`, `require assignment on the enterprise application ${label}`, graphCommand('PATCH', `/servicePrincipals/${sp.id}`, { appRoleAssignmentRequired: true }))));
	else rows.push(fine(step, `${label}:service-principal`, `${sp.id}, assignment required`));
	return rows;
}

export function planEntraApps(core: Core): Finding[] {
	const mismatched = Object.entries(GRAPH_DELEGATED).filter(([name, id]) => core.graph.scopes[name] !== id);
	const graph =
		core.graph.spId === null || mismatched.length === 0
			? fine('entra-apps', 'graph-scope-ids', 'the four delegated scope ids match Microsoft Graph in this tenant')
			: blocked('entra-apps', 'graph-scope-ids', `Microsoft Graph in this tenant lists different ids for ${mismatched.map(([name]) => name).join(', ')}`);
	return [graph, ...APP_KEYS.flatMap((key) => planOneApp(APP_SPECS[key], core))];
}

export type CredentialRow = { readonly id: string; readonly name: string; readonly issuer: string; readonly subject: string; readonly audiences: readonly string[] };
export const parseCredentials = (raw: readonly unknown[]): CredentialRow[] =>
	raw.map((item) => ({ id: text(rec(item)['id']), name: text(rec(item)['name']), issuer: text(rec(item)['issuer']), subject: text(rec(item)['subject']), audiences: texts(rec(item)['audiences']) }));

export type RepoFacts = {
	readonly owner: string;
	readonly name: string;
	readonly ownerId: number;
	readonly id: number;
	readonly oidc: { readonly useDefault: boolean; readonly useImmutableSubject: boolean; readonly prefix: string | null };
};
export type SubjectForm = 'auto' | 'name' | 'id';

/** The `sub` claim GitHub puts in the token for a job in an environment. The repository's own OIDC setting decides which form it is. */
export function githubSubject(repo: RepoFacts, form: SubjectForm, environment: string): { subject: string } | { blocked: string } {
	const nameForm = `repo:${repo.owner}/${repo.name}`;
	const idForm = `repo:${repo.owner}@${repo.ownerId}/${repo.name}@${repo.id}`;
	if (form === 'name') return { subject: `${nameForm}:environment:${environment}` };
	if (form === 'id') return { subject: `${idForm}:environment:${environment}` };
	if (repo.oidc.useImmutableSubject && repo.oidc.prefix) return { subject: `${repo.oidc.prefix}:environment:${environment}` };
	if (repo.oidc.useDefault) return { subject: `${nameForm}:environment:${environment}` };
	return { blocked: 'the repository customizes its OIDC subject claim. Pass --subject-form name or --subject-form id' };
}

export type IdentityExtras = { readonly credentials: Readonly<Record<string, readonly CredentialRow[]>>; readonly adminAppCredentials: readonly CredentialRow[] };

export function planIdentities(core: Core, extras: IdentityExtras, repo: RepoFacts, form: SubjectForm): Finding[] {
	const step: StepName = 'identities';
	const rows: Finding[] = [];
	const awaitsGroup = core.rg.exists ? [] : [RESOURCE_GROUP];
	for (const name of IDENTITIES) {
		rows.push(
			core.identities[name]
				? fine(step, `identity:${name}`, `client ${core.identities[name].clientId}, principal ${core.identities[name].principalId}`)
				: changing(step, `identity:${name}`, 'missing, create it', action(`create ${name}`, `create user-assigned identity ${name}`, azCommand('identity', 'create', '--resource-group', RESOURCE_GROUP, '--name', name, '--location', LOCATION), { awaits: awaitsGroup })),
		);
	}
	for (const { name: environment, identity } of GITHUB_ENVIRONMENTS) {
		const id = `federated-credential:${identity}:github-${environment}`;
		const resolved = githubSubject(repo, form, environment);
		if ('blocked' in resolved) {
			rows.push(blocked(step, id, resolved.blocked));
			continue;
		}
		const want = { issuer: 'https://token.actions.githubusercontent.com', subject: resolved.subject, audiences: [TOKEN_EXCHANGE_AUDIENCE] };
		const have = extras.credentials[identity]?.find((credential) => credential.name === `github-${environment}`);
		const verb = have ? 'update' : 'create';
		const make = action(
			`${verb} github-${environment} on ${identity}`,
			`${verb} federated credential github-${environment} on ${identity}`,
			azCommand('identity', 'federated-credential', verb, '--identity-name', identity, '--resource-group', RESOURCE_GROUP, '--name', `github-${environment}`, '--issuer', want.issuer, '--subject', want.subject, '--audiences', TOKEN_EXCHANGE_AUDIENCE),
			{ awaits: core.identities[identity] ? [] : [identity] },
		);
		const current = have && have.issuer === want.issuer && have.subject === want.subject && same(have.audiences, want.audiences);
		rows.push(current ? fine(step, id, `subject ${want.subject}`) : changing(step, id, `${have ? `subject is ${have.subject}` : 'missing'}; GitHub environment ${environment} must present subject ${want.subject}`, make));
	}

	const adminApp = core.apps.admin;
	const adminIdentity = core.identities[ADMIN_IDENTITY];
	const id = `federated-credential:games4kids-admin:${ADMIN_IDENTITY}`;
	if (adminApp.kind === 'conflict') rows.push(blocked(step, id, adminApp.reason));
	else {
		const want = { issuer: `https://login.microsoftonline.com/${core.subscription.tenantId}/v2.0`, subject: adminIdentity?.principalId ?? `<${ADMIN_IDENTITY} principal id>`, audiences: [TOKEN_EXCHANGE_AUDIENCE] };
		const awaits = [...(adminApp.kind === 'missing' ? ['the games4kids-admin registration'] : []), ...(adminIdentity ? [] : [ADMIN_IDENTITY])];
		const have = extras.adminAppCredentials.find((credential) => credential.name === ADMIN_IDENTITY);
		const body = { name: ADMIN_IDENTITY, issuer: want.issuer, subject: want.subject, audiences: want.audiences, description: 'The admin app runtime identity, trusted for the on-behalf-of exchange' };
		const path = `/applications/${adminApp.kind === 'found' ? adminApp.app.id : '<games4kids-admin object id>'}/federatedIdentityCredentials`;
		const make = have ? action(`update ${ADMIN_IDENTITY} credential`, `update federated credential ${ADMIN_IDENTITY} on games4kids-admin`, graphCommand('PATCH', `${path}/${have.id}`, body), { awaits }) : action(`create ${ADMIN_IDENTITY} credential`, `create federated credential ${ADMIN_IDENTITY} on games4kids-admin`, graphCommand('POST', path, body), { awaits, retry: 'quick' });
		const current = have && have.issuer === want.issuer && have.subject === want.subject && same(have.audiences, want.audiences);
		rows.push(current ? fine(step, id, `subject ${want.subject}`) : changing(step, id, have ? `subject is ${have.subject}` : `missing; ${ADMIN_IDENTITY} is the credential Entra trusts for the exchange`, make));
	}
	return rows;
}

export type RoleAssignment = { readonly id: string; readonly scope: string; readonly principalId: string; readonly roleDefinitionId: string; readonly condition: string | null };
export function parseRoleAssignments(raw: readonly unknown[]): RoleAssignment[] {
	return raw.map((item) => {
		const properties = rec(rec(item)['properties']);
		return {
			id: text(rec(item)['id']),
			scope: text(properties['scope']),
			principalId: text(properties['principalId']).toLowerCase(),
			roleDefinitionId: text(properties['roleDefinitionId']).split('/').at(-1)?.toLowerCase() ?? '',
			condition: typeof properties['condition'] === 'string' ? properties['condition'] : null,
		};
	});
}

const braces = (ids: readonly string[]) => `{${ids.join(', ')}}`;

/** The ABAC condition on id-g4k-infra's Role Based Access Control Administrator assignment. Same shape as the delegate-role-assignments examples on Learn. */
export function rbacCondition(deployPrincipalId: string): string {
	const clause = (source: '@Request' | '@Resource', action_: 'write' | 'delete') =>
		[
			`((!(ActionMatches{'Microsoft.Authorization/roleAssignments/${action_}'})) OR (`,
			`(${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${braces(ASSIGNABLE_TO_ANY)} AND ${source}[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})`,
			' OR ',
			`(${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${braces(ASSIGNABLE_TO_DEPLOY)} AND ${source}[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${deployPrincipalId}})`,
			'))',
		].join('');
	return `${clause('@Request', 'write')} AND ${clause('@Resource', 'delete')}`;
}

/** Compares conditions by content: whitespace and the order of ids inside braces do not matter. */
export const conditionKey = (condition: string | null): string =>
	(condition ?? '')
		.replace(/\{([^}]*)\}/g, (_, inner: string) => `{${inner.split(',').map((part) => part.trim().toLowerCase()).sort().join(',')}}`)
		.replace(/\s+/g, '')
		.toLowerCase();

export function planAzureRoles(core: Core, assignments: readonly RoleAssignment[]): Finding[] {
	const step: StepName = 'azure-roles';
	const infra = core.identities[INFRA_IDENTITY];
	const deploy = core.identities[DEPLOY_IDENTITY];
	const scope = core.rg.id ?? `/subscriptions/${core.subscription.id}/resourceGroups/${RESOURCE_GROUP}`;
	const mine = infra ? assignments.filter((row) => row.principalId === infra.principalId.toLowerCase() && row.scope.toLowerCase() === scope.toLowerCase()) : [];
	const awaits = [...(infra ? [] : [INFRA_IDENTITY]), ...(core.rg.exists ? [] : [RESOURCE_GROUP])];
	const principal = infra?.principalId ?? `<${INFRA_IDENTITY} principal id>`;
	const create = (role: string, name: string, condition?: string) =>
		action(`assign ${name} to ${INFRA_IDENTITY}`, `assign ${name} on ${RESOURCE_GROUP} to ${INFRA_IDENTITY}${condition ? ' with the ABAC condition' : ''}`, azCommand('role', 'assignment', 'create', '--assignee-object-id', principal, '--assignee-principal-type', 'ServicePrincipal', '--role', role, '--scope', scope, ...(condition ? ['--condition', condition, '--condition-version', '2.0'] : [])), { awaits, retry: 'quick' });

	const contributor = mine.find((row) => row.roleDefinitionId === AZURE_ROLES.contributor);
	const rows = [contributor ? fine(step, 'infra:contributor', `${INFRA_IDENTITY} is Contributor on ${RESOURCE_GROUP}`) : changing(step, 'infra:contributor', `${INFRA_IDENTITY} lacks Contributor on ${RESOURCE_GROUP}`, create(AZURE_ROLES.contributor, 'Contributor'))];

	const rbac = mine.find((row) => row.roleDefinitionId === AZURE_ROLES.rbacAdministrator);
	const want = rbacCondition(deploy?.principalId ?? `<${DEPLOY_IDENTITY} principal id>`);
	const rbacAwaits = deploy ? awaits : [...awaits, DEPLOY_IDENTITY];
	const makeRbac = action(`assign Role Based Access Control Administrator to ${INFRA_IDENTITY}`, `assign Role Based Access Control Administrator on ${RESOURCE_GROUP} to ${INFRA_IDENTITY} with the ABAC condition`, azCommand('role', 'assignment', 'create', '--assignee-object-id', principal, '--assignee-principal-type', 'ServicePrincipal', '--role', AZURE_ROLES.rbacAdministrator, '--scope', scope, '--condition', want, '--condition-version', '2.0'), { awaits: rbacAwaits, retry: 'quick' });
	if (!rbac) rows.push(changing(step, 'infra:rbac-administrator', 'missing, assign it with the condition', makeRbac));
	else if (conditionKey(rbac.condition) === conditionKey(want)) rows.push(fine(step, 'infra:rbac-administrator', 'assigned with the condition'));
	else rows.push(changing(step, 'infra:rbac-administrator', 'the condition differs from the goal, replace the assignment', action('remove the old RBAC Administrator assignment', 'remove the RBAC Administrator assignment whose condition differs', azCommand('role', 'assignment', 'delete', '--ids', rbac.id), { awaits: rbacAwaits }), makeRbac));
	return rows;
}

export type UserRow = { readonly id: string; readonly userPrincipalName: string; readonly employeeType: string; readonly mail: string };
export const parseUser = (raw: unknown): UserRow => {
	const user = rec(raw);
	return { id: text(user['id']), userPrincipalName: text(user['userPrincipalName']), employeeType: text(user['employeeType']), mail: text(user['mail']) };
};
export type DirectoryRoleRow = { readonly roleDefinitionId: string; readonly directoryScopeId: string };
export type GrantRow = { readonly id: string; readonly clientId: string; readonly resourceId: string; readonly principalId: string; readonly consentType: string; readonly scope: readonly string[] };
export const parseGrant = (raw: unknown): GrantRow => {
	const grant = rec(raw);
	return { id: text(grant['id']), clientId: text(grant['clientId']), resourceId: text(grant['resourceId']), principalId: text(grant['principalId']), consentType: text(grant['consentType']), scope: text(grant['scope']).split(' ').filter(Boolean) };
};

export type AdminExtras = {
	readonly verifiedDomains: readonly string[];
	readonly admin: UserRow | null;
	readonly sameUpn: UserRow | null;
	readonly directoryRoles: readonly DirectoryRoleRow[];
	readonly assignedPrincipalIds: readonly string[];
	readonly gamesOwnerIds: readonly string[];
	readonly grants: readonly GrantRow[];
};

export type AdminGoal = { readonly create: boolean; readonly upn: string | null; readonly adopt: boolean };

export function planAdminAccount(core: Core, extras: AdminExtras, goal: AdminGoal): Finding[] {
	const step: StepName = 'admin-account';
	const rows: Finding[] = [];
	const games = core.sps.games;
	const adminSp = core.sps.admin;

	let account = extras.admin;
	let userAwaits: readonly string[] = [];
	if (!account) {
		if (!goal.create) return [skipped(step, 'admin-account', 'not created. Pass --create-admin-account to create the account you administer from'), todo(step, 'B5', 'run build check B5 after you create the account')];
		const upn = goal.upn;
		if (upn && !extras.verifiedDomains.includes(upn.split('@')[1]?.toLowerCase() ?? '')) return [blocked(step, 'admin-account', `${upn} is not in a verified domain of this tenant (${extras.verifiedDomains.join(', ')})`)];
		if (extras.sameUpn && !goal.adopt) return [blocked(step, 'admin-account', `${upn} already exists and bootstrap did not create it. Pass --adopt-admin-account to use it, or choose another name`)];
		if (extras.sameUpn) {
			account = extras.sameUpn;
			rows.push(changing(step, 'admin-account:marker', `${account.userPrincipalName} was not created by bootstrap, mark it`, action('mark the admin account', `set employeeType ${ADMIN_MARKER} on ${account.userPrincipalName}`, graphCommand('PATCH', `/users/${account.id}`, { employeeType: ADMIN_MARKER }))));
		} else {
			const name = upn ?? '<UPN, asked at apply>';
			rows.push(
				changing(
					step,
					'admin-account',
					`missing, create ${name} as a member with a random password that is never shown`,
					action('create the admin account', `create the admin account ${name}. Its password is random and discarded, so set one from your terminal before the first sign-in: az ad user update --id ${name} --password <temporary> --force-change-password-next-sign-in true`, graphCommand('POST', '/users', { accountEnabled: true, displayName: 'games4kids admin', mailNickname: (upn ?? 'g4k-admin').split('@')[0], userPrincipalName: name, employeeType: ADMIN_MARKER, passwordProfile: { forceChangePasswordNextSignIn: true, password: PASSWORD_SENTINEL } }), { awaits: upn ? [] : ['the UPN'], remember: { kind: 'user', key: ADMIN_MARKER } }),
				),
			);
			userAwaits = ['the admin account'];
		}
	} else rows.push(fine(step, 'admin-account', `${account.userPrincipalName}, ${account.id}`));

	const userId = account?.id ?? '<admin account object id>';
	const have = (role: string, scope: string) => extras.directoryRoles.some((row) => row.roleDefinitionId === role && row.directoryScopeId === scope);
	const roleFix = (name: string, role: string, scope: string, awaits: readonly string[]) => action(`assign ${name}`, `assign ${name} to the admin account at scope ${scope}`, graphCommand('POST', '/roleManagement/directory/roleAssignments', { principalId: userId, roleDefinitionId: role, directoryScopeId: scope }), { awaits: [...userAwaits, ...awaits], retry: 'quick' });
	const guestScope = '/';
	rows.push(have(DIRECTORY_ROLES.guestInviter, guestScope) ? fine(step, 'role:Guest Inviter', 'tenant-wide') : changing(step, 'role:Guest Inviter', 'missing', roleFix('Guest Inviter', DIRECTORY_ROLES.guestInviter, guestScope, [])));
	const gamesId = games?.id ?? '<games4kids service principal id>';
	rows.push(
		account && extras.gamesOwnerIds.includes(account.id)
			? fine(step, 'owner:games4kids', `owner of the games4kids service principal ${gamesId}`)
			: changing(step, 'owner:games4kids', 'not an owner, add it as an owner of the games4kids service principal', action('make the admin account an owner of games4kids', 'make the admin account an owner of the games4kids enterprise application', graphCommand('POST', `/servicePrincipals/${gamesId}/owners/$ref`, { '@odata.id': `${GRAPH}/directoryObjects/${userId}` }), { awaits: [...userAwaits, ...(games ? [] : ['the games4kids enterprise application'])], retry: 'quick' })),
	);
	const allowed = new Set([`${DIRECTORY_ROLES.guestInviter}|${guestScope}`]);
	const extra = extras.directoryRoles.filter((row) => !allowed.has(`${row.roleDefinitionId}|${row.directoryScopeId}`));
	rows.push(extra.length === 0 ? fine(step, 'role:no others', 'the account holds no other directory role') : blocked(step, 'role:no others', `the account also holds ${extra.map((row) => `${row.roleDefinitionId} at ${row.directoryScopeId}`).join(', ')}. Remove it in the Entra admin center`));

	rows.push(
		account && extras.assignedPrincipalIds.includes(account.id)
			? fine(step, 'assignment:games4kids-admin', 'assigned')
			: changing(step, 'assignment:games4kids-admin', 'not assigned to games4kids-admin', action('assign the admin account', 'assign the admin account to games4kids-admin', graphCommand('POST', `/servicePrincipals/${adminSp?.id ?? '<games4kids-admin service principal id>'}/appRoleAssignedTo`, { principalId: userId, resourceId: adminSp?.id ?? '<games4kids-admin service principal id>', appRoleId: DEFAULT_ACCESS }), { awaits: [...userAwaits, ...(adminSp ? [] : ['the games4kids-admin enterprise application'])], retry: 'quick' })),
	);

	const grantFor = (resourceId: string | null, label: string, scopes: readonly string[]) => {
		const id = `consent:${label}`;
		const resource = resourceId ?? `<${label} service principal id>`;
		const awaits = [...new Set([...userAwaits, ...(adminSp ? [] : ['the games4kids-admin enterprise application']), ...(resourceId ? [] : [label === 'games4kids-admin' ? 'the games4kids-admin enterprise application' : label])])];
		const existing = account && adminSp ? extras.grants.find((grant) => grant.consentType === 'Principal' && grant.principalId === account.id && grant.clientId === adminSp.id && grant.resourceId === resourceId) : undefined;
		if (existing && same(existing.scope, scopes)) return fine(step, id, `per-user consent: ${scopes.join(' ')}`);
		const fix = existing
			? action(`correct consent for ${label}`, `set the per-user consent for ${label} to ${scopes.join(' ')}`, graphCommand('PATCH', `/oauth2PermissionGrants/${existing.id}`, { scope: scopes.join(' ') }))
			: action(`grant consent for ${label}`, `grant the admin account per-user consent (Principal) to ${scopes.join(' ')} on ${label}`, graphCommand('POST', '/oauth2PermissionGrants', { clientId: adminSp?.id ?? '<games4kids-admin service principal id>', consentType: 'Principal', principalId: userId, resourceId: resource, scope: scopes.join(' ') }), { awaits, retry: 'quick' });
		return changing(step, id, existing ? `scope is "${existing.scope.join(' ')}"` : 'not granted', fix);
	};
	rows.push(grantFor(core.graph.spId, 'Microsoft Graph', Object.keys(GRAPH_DELEGATED)));
	rows.push(grantFor(adminSp?.id ?? null, 'games4kids-admin', APP_SPECS.admin.scopes.map(({ value }) => value)));

	rows.push(todo(step, 'B5', 'sign in as the admin account and prove the account owning the games4kids enterprise application can POST and DELETE an assignment on games4kids and is refused on another app'));
	return rows;
}

export type EnvironmentRow = { readonly name: string; readonly customPolicies: boolean; readonly policies: readonly { readonly id: number; readonly name: string }[]; readonly variables: Readonly<Record<string, string>> };
export type GithubExtras = { readonly repoVariables: Readonly<Record<string, string>>; readonly environments: Readonly<Record<string, EnvironmentRow | undefined>> };
export type GithubGoal = { readonly repo: string; readonly alertEmail: string | null };

export function repositoryVariables(core: Core, goal: GithubGoal, current: Readonly<Record<string, string>>): { name: string; value: string | null; blocked?: string }[] {
	const games = core.apps.games.kind === 'found' ? core.apps.games.app.appId : null;
	const admin = core.apps.admin.kind === 'found' ? core.apps.admin.app.appId : null;
	return [
		{ name: 'AZURE_TENANT_ID', value: core.subscription.tenantId },
		{ name: 'AZURE_SUBSCRIPTION_ID', value: core.subscription.id },
		{ name: 'GAMES_CLIENT_ID', value: games },
		{ name: 'ADMIN_CLIENT_ID', value: admin },
		{ name: 'GAMES_PRINCIPAL_ID', value: core.sps.games?.id ?? null },
		{ name: 'ADMIN_PRINCIPAL_ID', value: core.sps.admin?.id ?? null },
		goal.alertEmail || current['ALERT_EMAIL'] ? { name: 'ALERT_EMAIL', value: goal.alertEmail ?? current['ALERT_EMAIL'] ?? null } : { name: 'ALERT_EMAIL', value: null, blocked: 'pass --alert-email <address> for the daily cap alert' },
	];
}

export function planGithub(core: Core, extras: GithubExtras, goal: GithubGoal): Finding[] {
	const step: StepName = 'github';
	const rows: Finding[] = [];
	const setVariable = (name: string, value: string | null, env: string | null, waitingFor: string) =>
		action(`set ${env ? `${env}/` : ''}${name}`, `set ${env ? `environment ${env} ` : 'repository '}variable ${name}`, ghCommand('variable', 'set', name, '--repo', goal.repo, ...(env ? ['--env', env] : []), '--body', value ?? `<${name}, known after ${waitingFor}>`), { awaits: value === null ? [waitingFor] : [] });

	for (const row of repositoryVariables(core, goal, extras.repoVariables)) {
		const id = `variable:${row.name}`;
		const have = extras.repoVariables[row.name];
		if (row.blocked) rows.push(blocked(step, id, row.blocked));
		else if (row.value !== null && have === row.value) rows.push(fine(step, id, row.value));
		else rows.push(changing(step, id, `${have === undefined ? 'unset' : `is ${have}`}, goal ${row.value ?? 'not known yet'}`, setVariable(row.name, row.value, null, row.name.startsWith('ADMIN') ? 'games4kids-admin' : row.name.startsWith('GAMES') ? 'games4kids' : 'the account')));
	}

	for (const { name, identity } of GITHUB_ENVIRONMENTS) {
		const env = extras.environments[name];
		const path = `repos/${goal.repo}/environments/${name}`;
		const makeEnv = action(`create environment ${name}`, `create environment ${name} restricted to custom deployment branch policies`, ghApiCommand('PUT', path, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
		const envAwaits = env ? [] : [`environment ${name}`];
		rows.push(env?.customPolicies ? fine(step, `environment:${name}`, 'exists with custom branch policies') : changing(step, `environment:${name}`, env ? 'exists without custom branch policies' : 'missing', makeEnv));
		const main = env?.policies.find((policy) => policy.name === 'main');
		const extra = env?.policies.filter((policy) => policy.name !== 'main') ?? [];
		rows.push(main && extra.length === 0 ? fine(step, `environment:${name}:branches`, 'only main may deploy') : changing(step, `environment:${name}:branches`, [main ? '' : 'main is not allowed', ...extra.map((policy) => `${policy.name} is allowed`)].filter(Boolean).join('; '), ...(main ? [] : [action(`allow main in ${name}`, `allow only branch main to deploy to ${name}`, ghApiCommand('POST', `${path}/deployment-branch-policies`, { name: 'main', type: 'branch' }), { awaits: envAwaits })]), ...extra.map((policy) => action(`remove branch ${policy.name} from ${name}`, `stop branch ${policy.name} deploying to ${name}`, ghApiCommand('DELETE', `${path}/deployment-branch-policies/${policy.id}`)))));
		const clientId = core.identities[identity]?.clientId ?? null;
		const have = env?.variables['AZURE_CLIENT_ID'];
		rows.push(clientId !== null && have === clientId ? fine(step, `environment:${name}:AZURE_CLIENT_ID`, `${identity} ${clientId}`) : changing(step, `environment:${name}:AZURE_CLIENT_ID`, `${have === undefined ? 'unset' : `is ${have}`}, goal ${identity}`, { ...setVariable('AZURE_CLIENT_ID', clientId, name, identity), awaits: [...(clientId === null ? [identity] : []), ...envAwaits] }));
	}
	return rows;
}

export type SpaExtras = {
	readonly hosts: Readonly<Record<AppKey, string | null>>;
	readonly portal: { readonly name: string; readonly id: string } | null;
	readonly me: { readonly id: string; readonly mail: string; readonly userPrincipalName: string } | null;
	readonly roles: readonly RoleAssignment[];
	readonly row: { readonly state: 'present' | 'absent' | 'unknown'; readonly email: string | null };
	readonly vision: { readonly playPrincipalId: string | null; readonly roles: readonly RoleAssignment[] };
};
/** The admin app reads the admins row's email only if it parses. */
export function signInEmail(user: { readonly mail: string; readonly userPrincipalName: string }): Email | null {
	return parseEmail(user.mail) ?? guestHomeEmail(user.userPrincipalName) ?? parseEmail(user.userPrincipalName);
}

export type SpaGoal = { readonly adminAccount: UserRow | null; readonly seedSelf: boolean };

/** letterjoin reads handwriting with the old letterjoin's free AI Vision account until its data has moved. A subscription may hold one free account, and the pipeline has no rights in rg-letterjoin. */
export const BORROWED_VISION = { game: 'letterjoin', path: 'resourceGroups/rg-letterjoin/providers/Microsoft.CognitiveServices/accounts/cv-letterjoin-ul5nga' } as const;
export const borrowedVisionScope = (core: Core) => `/subscriptions/${core.subscription.id}/${BORROWED_VISION.path}`;

export const redirectUrisFor = (host: string) => [`https://${host}/`, `https://${host}/redirect.html`];
export const TABLE_DATA_CONTRIBUTOR_NAME = 'Storage Table Data Contributor';

export function planAfterFirstDeploy(core: Core, extras: SpaExtras, goal: SpaGoal): Finding[] {
	const step: StepName = 'after-first-deploy';
	const rows: Finding[] = [];
	for (const key of APP_KEYS) {
		const spec = APP_SPECS[key];
		const lookup = core.apps[key];
		const host = extras.hosts[key];
		const id = `spa:${spec.displayName}`;
		if (lookup.kind !== 'found') {
			rows.push(blocked(step, id, `${spec.displayName} is not registered. Run the entra-apps step first`));
			continue;
		}
		if (!host) {
			rows.push(blocked(step, id, `${staticWebAppName(key)} does not exist yet. Merge to main so the infra job creates it, then run this again`));
			continue;
		}
		const wanted = [customDomain(key), host].flatMap(redirectUrisFor);
		const gaps = missingFrom(lookup.app.redirectUris, wanted);
		rows.push(gaps.length === 0 ? fine(step, id, wanted.join(', ')) : changing(step, id, `missing ${gaps.join(', ')}`, action(`add redirect URIs to ${spec.displayName}`, `add SPA redirect URIs ${gaps.join(', ')} to ${spec.displayName}`, graphCommand('PATCH', `/applications/${lookup.app.id}`, { spa: { redirectUris: [...lookup.app.redirectUris, ...gaps] } }))));
	}

	const visionScope = borrowedVisionScope(core);
	const reader = extras.vision.playPrincipalId;
	const visionId = `vision:${BORROWED_VISION.game}`;
	if (!reader) rows.push(blocked(step, visionId, `${functionAppName(BORROWED_VISION.game)} does not exist yet. Merge to main so the pipeline deploys it, then run this again`));
	else if (extras.vision.roles.some((row) => row.principalId === reader.toLowerCase() && row.roleDefinitionId === AZURE_ROLES.cognitiveServicesUser && row.scope.toLowerCase() === visionScope.toLowerCase())) rows.push(fine(step, visionId, `${functionAppName(BORROWED_VISION.game)} may read handwriting with ${visionScope}`));
	else rows.push(changing(step, visionId, `${functionAppName(BORROWED_VISION.game)} cannot call ${visionScope} yet`, action('let letterjoin read handwriting', `assign Cognitive Services User on ${visionScope} to ${functionAppName(BORROWED_VISION.game)}`, azCommand('role', 'assignment', 'create', '--assignee-object-id', reader, '--assignee-principal-type', 'ServicePrincipal', '--role', AZURE_ROLES.cognitiveServicesUser, '--scope', visionScope), { retry: 'quick' })));

	const seeded = goal.adminAccount ? { ...goal.adminAccount, who: 'the admin account' } : goal.seedSelf && extras.me ? { ...extras.me, who: 'you' } : null;
	if (!seeded) {
		rows.push(blocked(step, 'admins-row', 'no admin account exists. Create it with --create-admin-account, or pass --seed-self to seed your own sign-in (the B5 fallback)'));
		return rows;
	}
	const email = signInEmail(seeded);
	if (!email) {
		rows.push(blocked(step, 'admins-row', `${seeded.userPrincipalName} has no mail address the admin app accepts. Set its mail in Entra, then run this again`));
		return rows;
	}
	const source = { id: seeded.id, email, who: seeded.who };
	if (!extras.portal) {
		rows.push(blocked(step, 'admins-row', 'the portal storage account does not exist yet. Run the infra deploy first'));
		return rows;
	}
	const tableScope = `${extras.portal.id}/tableServices/default/tables/admins`;
	const holds = extras.me ? extras.roles.some((row) => row.principalId === extras.me?.id.toLowerCase() && row.roleDefinitionId === AZURE_ROLES.tableDataContributor && row.scope.toLowerCase() === tableScope.toLowerCase()) : false;
	rows.push(
		holds
			? fine(step, 'admins-row:your data role', `${TABLE_DATA_CONTRIBUTOR_NAME} on the admins table`)
			: changing(step, 'admins-row:your data role', `you lack ${TABLE_DATA_CONTRIBUTOR_NAME} on the admins table`, action('give you the admins table role', `assign ${TABLE_DATA_CONTRIBUTOR_NAME} on the admins table to you, to write the one row`, azCommand('role', 'assignment', 'create', '--assignee-object-id', extras.me?.id ?? '<your object id>', '--assignee-principal-type', 'User', '--role', AZURE_ROLES.tableDataContributor, '--scope', tableScope), { retry: 'quick' })),
	);
	const insert = (replace: boolean) =>
		action('write the admins row', `write the admins row for ${source.who} (${source.email}, ${source.id})`, azCommand('storage', 'entity', 'insert', '--account-name', extras.portal?.name ?? '', '--table-name', 'admins', '--entity', 'PartitionKey=admin', `RowKey=${source.id}`, `email=${source.email}`, '--auth-mode', 'login', ...(replace ? ['--if-exists', 'replace'] : [])), { retry: 'propagation', awaits: holds ? [] : ['your data role'] });
	if (extras.row.state === 'present' && extras.row.email === source.email) rows.push(fine(step, 'admins-row', `${source.id} ${source.email}`));
	else if (extras.row.state === 'present') rows.push(changing(step, 'admins-row', `the row has email ${extras.row.email}, goal ${source.email}`, insert(true)));
	else rows.push(changing(step, 'admins-row', extras.row.state === 'absent' ? 'missing' : 'not readable yet, write it', insert(false)));
	return rows;
}

/** A role you hold also covers the weaker roles listed here, at its own scope and every scope beneath it. */
const COVERED_BY: Readonly<Record<string, readonly string[]>> = {
	[AZURE_ROLES.tableDataReader]: [AZURE_ROLES.tableDataReader, AZURE_ROLES.tableDataContributor],
	[AZURE_ROLES.tableDataContributor]: [AZURE_ROLES.tableDataContributor],
	[AZURE_ROLES.blobDataReader]: [AZURE_ROLES.blobDataReader, AZURE_ROLES.blobDataContributor, AZURE_ROLES.blobDataOwner],
	[AZURE_ROLES.blobDataContributor]: [AZURE_ROLES.blobDataContributor, AZURE_ROLES.blobDataOwner],
};

const ROLE_NAMES: Readonly<Record<string, string>> = {
	[AZURE_ROLES.tableDataReader]: 'Storage Table Data Reader',
	[AZURE_ROLES.tableDataContributor]: TABLE_DATA_CONTRIBUTOR_NAME,
	[AZURE_ROLES.blobDataReader]: 'Storage Blob Data Reader',
	[AZURE_ROLES.blobDataContributor]: 'Storage Blob Data Contributor',
};

export type DataExtras = {
	readonly me: { readonly id: string } | null;
	/** Account resource ids. null is an account that does not exist. */
	readonly old: Readonly<Record<Game, string | null>>;
	readonly games: Readonly<Record<Game, string | null>>;
	/** Every account in the resource group with a `game` tag: the portal's, each game's, and `shared`, which holds only Functions host state. */
	readonly tagged: readonly { readonly game: string; readonly id: string }[];
	/** Your role assignments at, above and beneath those accounts. */
	readonly roles: readonly RoleAssignment[];
};

export const oldAccountId = (core: Core, game: Game) => `/subscriptions/${core.subscription.id}/resourceGroups/${OLD_ACCOUNTS[game].resourceGroup}/providers/Microsoft.Storage/storageAccounts/${OLD_ACCOUNTS[game].name}`;

/**
 * The data roles you need from your Mac. tools/migrate reads the old accounts and writes the new game accounts. Diagnosing
 * a child's data reads every table of the portal and of each game, so you get Table Data Reader on every tagged account,
 * which also covers the portal's emails and identities tables that tools/migrate reads. A role you already hold at or above
 * a scope counts, so a game account the migration makes you a contributor on needs no reader as well.
 */
export function planDataRoles(extras: DataExtras): Finding[] {
	const step: StepName = 'after-first-deploy';
	const me = extras.me?.id.toLowerCase();
	const games = ['drawpad', 'letterjoin'] as const satisfies readonly Game[];
	const migrated = new Set(games.map((game) => extras.games[game]?.toLowerCase()));
	const wanted = [
		...games.flatMap((game) => [
			{ id: `migration:old ${game}`, scope: extras.old[game], gone: `${OLD_ACCOUNTS[game].name} does not exist, so there is nothing to migrate from it`, roles: [AZURE_ROLES.tableDataReader, AZURE_ROLES.blobDataReader] },
			{ id: `migration:new ${game}`, scope: extras.games[game], gone: `the ${game} storage account does not exist yet. Run the infra deploy first`, roles: [AZURE_ROLES.tableDataContributor, AZURE_ROLES.blobDataContributor] },
		]),
		...(extras.tagged.some((account) => account.game === 'portal') ? [] : [{ id: 'diagnosis:portal', scope: null, gone: 'the portal storage account does not exist yet. Run the infra deploy first', roles: [AZURE_ROLES.tableDataReader] }]),
		...extras.tagged.filter((account) => account.game !== 'shared' && !migrated.has(account.id.toLowerCase())).map((account) => ({ id: `diagnosis:${account.game}`, scope: account.id, gone: '', roles: [AZURE_ROLES.tableDataReader] })),
	];
	const holds = (scope: string, role: string) =>
		extras.roles.some((row) => row.principalId === me && COVERED_BY[role]?.includes(row.roleDefinitionId) && `${scope.toLowerCase()}/`.startsWith(`${row.scope.toLowerCase().replace(/\/$/, '')}/`));
	return wanted.flatMap(({ id, scope, gone, roles }) =>
		roles.map((role) => {
			const name = ROLE_NAMES[role] ?? role;
			const check = `${id}:${name}`;
			if (!scope) return (id.startsWith('migration:old') ? skipped : blocked)(step, check, gone);
			if (me && holds(scope, role)) return fine(step, check, `covered by a role you hold at or above ${scope}`);
			const why = id.startsWith('diagnosis:') ? { purpose: 'to read player data', reason: 'so you can read every table when you diagnose a child\'s data' } : { purpose: 'for the migration', reason: 'so tools/migrate can run from your Mac' };
			return changing(step, check, `you lack ${name} on ${scope}`, action(`give you ${name} ${why.purpose}`, `assign ${name} on ${scope} to you, ${why.reason}`, azCommand('role', 'assignment', 'create', '--assignee-object-id', extras.me?.id ?? '<your object id>', '--assignee-principal-type', 'User', '--role', role, '--scope', scope), { retry: 'quick' }));
		}),
	);
}

export const symbol: Readonly<Record<Status, string>> = { ok: 'ok     ', change: 'CHANGE ', blocked: 'BLOCKED', skipped: 'skip   ', todo: 'todo   ' };

export const render = (command: Command): string => [command.tool, ...command.args.map((arg) => (/[\s'"{}()<>|&;]/.test(arg) ? JSON.stringify(arg) : arg)), ...(command.body === undefined ? [] : [`--body ${JSON.stringify(command.body)}`])].join(' ');

export function formatFinding(row: Finding, verbose: boolean): string[] {
	const head = `  ${symbol[row.status]} ${row.id}${row.detail ? `: ${row.detail}` : ''}`;
	if (!verbose || row.status !== 'change') return [head];
	return [head, ...row.fix.flatMap((fix) => [`          -> ${fix.summary}${fix.awaits.length > 0 ? ` (after ${fix.awaits.join(' and ')})` : ''}`, `             $ ${render(fix.command)}`])];
}

export function formatVerify(rows: readonly Finding[]): string {
	const wide = Math.max(...rows.map((row) => row.id.length), 5);
	const result = (row: Finding) => (row.status === 'ok' ? 'PASS' : row.status === 'change' || row.status === 'blocked' ? 'FAIL' : row.status === 'todo' ? 'TODO' : 'SKIP');
	const lines = rows.map((row) => `| ${row.step.padEnd(18)} | ${row.id.padEnd(wide)} | ${result(row)} | ${row.detail} |`);
	return [`| ${'step'.padEnd(18)} | ${'check'.padEnd(wide)} | result | detail |`, `| ${'-'.repeat(18)} | ${'-'.repeat(wide)} | ------ | ------ |`, ...lines].join('\n');
}

export const changesIn = (rows: readonly Finding[]) => rows.filter((row) => row.status === 'change').flatMap((row) => row.fix);
