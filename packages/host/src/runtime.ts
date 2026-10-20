import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { AzureService, CreatePlayApi, GameId, GameManifest } from '@g4k/sdk';
import { azureAccounts } from './adapters/azure.ts';
import { otelTelemetry, startAzureMonitor } from './adapters/telemetry.ts';
import { createAdminApp, type AdminModule } from './admin-app.ts';
import { graphAs } from './graph.ts';
import type { App } from './http.ts';
import { createPlayerApp, createPortalApp } from './player-app.ts';
import { requireGameId, type Env, type TokenSource } from './platform.ts';
import { adminStore, portalReader, portalStore, type PortalTableName } from './portal-tables.ts';
import type { Accounts } from './storage.ts';
import { entraIssuer } from './token.ts';

const SERVICE_SCOPES: { readonly [S in AzureService]: string } = { cognitiveServices: 'https://cognitiveservices.azure.com/.default' };

export const tokenSourceFor = (credential: TokenCredential): TokenSource => async (service) => {
	const token = await credential.getToken(SERVICE_SCOPES[service]);
	if (!token) throw new Error(`no token for ${service}`);
	return token.token;
};

type Variables<N extends string> = { readonly [K in N]: string };

/** Every variable an app needs, read once at startup, so one missing setting lists them all before the app serves anything. */
function required<const N extends string>(env: Env, names: readonly N[]): Variables<N> {
	const missing = names.filter((name) => !env[name]);
	if (missing.length > 0) throw new Error(`missing app settings: ${missing.join(', ')}`);
	return Object.fromEntries(names.map((name) => [name, env[name]])) as Variables<N>;
}

/** AZURITE_CONNECTION_STRING selects the emulator; otherwise STORAGE_SUFFIX selects the real accounts. */
function accountsFor(env: Env, credential: TokenCredential): Accounts {
	const connectionString = env['AZURITE_CONNECTION_STRING'];
	return azureAccounts(connectionString ? { kind: 'azurite', connectionString } : { kind: 'azure', suffix: required(env, ['STORAGE_SUFFIX']).STORAGE_SUFFIX, credential });
}

function telemetryFor(env: Env, app: GameId | 'portal' | 'admin') {
	const connectionString = env['APPLICATIONINSIGHTS_CONNECTION_STRING'];
	if (connectionString) startAzureMonitor({ app, connectionString });
	return otelTelemetry();
}

/** The portal tables a games-side app may read. */
const portalTables = (accounts: Accounts) => {
	const account = accounts.open('portal');
	return (name: PortalTableName) => account.table(name);
};

/** func-g4k-<id>: built from the manifest and the app settings Bicep sets. */
export function playerAppFromEnv<M extends GameManifest>(manifest: M, create: CreatePlayApi<M>, env: Env, credential: TokenCredential = new DefaultAzureCredential()): App {
	const { TENANT_ID, GAMES_CLIENT_ID } = required(env, ['TENANT_ID', 'GAMES_CLIENT_ID']);
	const accounts = accountsFor(env, credential);
	const table = portalTables(accounts);
	return createPlayerApp({
		issuers: [entraIssuer(TENANT_ID, GAMES_CLIENT_ID)],
		telemetry: telemetryFor(env, requireGameId(manifest)),
		now: () => new Date(),
		manifest,
		create,
		portal: portalReader({ identities: table('identities'), members: table('members'), profiles: table('profiles') }),
		accounts,
		tokens: tokenSourceFor(credential),
		env,
	});
}

/** func-g4k-portal: `games` is every registered game, from the generated apps/games/.gen/registered.ts. */
export function portalAppFromEnv(games: readonly GameId[], env: Env, credential: TokenCredential = new DefaultAzureCredential()): App {
	const { TENANT_ID, GAMES_CLIENT_ID } = required(env, ['TENANT_ID', 'GAMES_CLIENT_ID']);
	const accounts = accountsFor(env, credential);
	const table = portalTables(accounts);
	return createPortalApp({
		issuers: [entraIssuer(TENANT_ID, GAMES_CLIENT_ID)],
		telemetry: telemetryFor(env, 'portal'),
		now: () => new Date(),
		portal: portalStore({ identities: table('identities'), members: table('members'), profiles: table('profiles') }),
		games,
	});
}

/** func-g4k-admin: `games` is every grantable game and `modules` the admin parts, both from the generated modules.ts. */
export function adminAppFromEnv(games: readonly GameId[], modules: readonly AdminModule[], env: Env, credential: TokenCredential = new DefaultAzureCredential()): App {
	const settings = required(env, ['TENANT_ID', 'ADMIN_CLIENT_ID', 'GAMES_PRINCIPAL_ID', 'ADMIN_PRINCIPAL_ID', 'GAMES_ORIGIN']);
	const accounts = accountsFor(env, credential);
	const table = portalTables(accounts);
	const graphConfig = { tenantId: settings.TENANT_ID, clientId: settings.ADMIN_CLIENT_ID, gamesPrincipalId: settings.GAMES_PRINCIPAL_ID, adminPrincipalId: settings.ADMIN_PRINCIPAL_ID };
	const clientAssertion = async () => {
		const token = await credential.getToken('api://AzureADTokenExchange/.default');
		if (!token) throw new Error('no federated token');
		return token.token;
	};
	return createAdminApp({
		issuer: entraIssuer(settings.TENANT_ID, settings.ADMIN_CLIENT_ID),
		telemetry: telemetryFor(env, 'admin'),
		now: () => new Date(),
		store: adminStore({ members: table('members'), identities: table('identities'), emails: table('emails'), profiles: table('profiles'), admins: table('admins') }, randomUUID),
		graph: (elevation) => graphAs(elevation, clientAssertion, graphConfig),
		games,
		modules,
		accounts,
		tokens: tokenSourceFor(credential),
		env,
		gamesOrigin: settings.GAMES_ORIGIN,
	});
}
