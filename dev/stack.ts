import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { EntraObjectId, GameId } from '@g4k/sdk';
import {
	adminModule,
	adminStore,
	createAdminApp,
	createPlayerApp,
	createPortalApp,
	ENTRA,
	graphAs,
	memoryAccounts,
	portalReader,
	portalStore,
	type Accounts,
	type App,
	type PortalTableName,
	type RegistryEntry,
	type Telemetry,
	type TrustedIssuer,
} from '@g4k/host';
import { azureAccounts } from '@g4k/host/azure';
import { deliverQueues, serveWithNode } from '@g4k/host/node';
import type { CspByGame } from '../tools/site-config.ts';
import { createDirectory, type Directory } from './directory.ts';
import { startFakeFoundry, type FakeFoundry } from './fake-foundry.ts';
import { startFakeGraph } from './fake-graph.ts';
import { startFakeIdp } from './fake-idp.ts';
import { startFakeVision, type FakeVision } from './fake-vision.ts';
import { startSite } from './sites.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

export const TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const GAMES_CLIENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const ADMIN_CLIENT_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const GAMES_PRINCIPAL_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ADMIN_PRINCIPAL_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

export type StackOptions = {
	/** Serve the fixture games under test/fixtures/games instead of games/. */
	readonly fixtures?: boolean;
	/** Nine consecutive ports from here: games site, admin site, API, telemetry, IdP https, IdP http, Graph, Foundry, Vision. */
	readonly portBase?: number;
	/** Azurite or any storage account connection string. Without it every account is in memory. */
	readonly azuriteConnectionString?: string;
	readonly adminEmail?: string;
};

export type DevStack = {
	readonly gamesOrigin: string;
	readonly adminOrigin: string;
	readonly apiOrigin: string;
	readonly adminEmail: string;
	readonly adminObjectId: EntraObjectId;
	readonly idp: Awaited<ReturnType<typeof startFakeIdp>>;
	readonly graph: Awaited<ReturnType<typeof startFakeGraph>>;
	readonly foundry: FakeFoundry;
	readonly vision: FakeVision;
	readonly accounts: Accounts;
	readonly directory: Directory;
	/** Every event the shells sent to the fake Application Insights endpoint. */
	readonly events: readonly unknown[];
	/** Exceptions the apps reported, which a 500 would hide. */
	readonly exceptions: readonly unknown[];
	close(): Promise<void>;
};

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, 'utf8'));
}

/** Application Insights' track endpoint, recording what the shells send so a test can read the `game` field back. */
async function startIngestion(port: number, allowed: readonly string[], events: unknown[]) {
	const server = createServer(async (req, res) => {
		const origin = allowed.find((candidate) => candidate === req.headers.origin);
		const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
		if (req.method === 'OPTIONS') return void res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
		if (req.method === 'GET' && req.url === '/__events') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(events));
		if (req.method === 'POST' && req.url === '/v2/track') {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			events.push(...(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]));
			return void res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{"itemsReceived":1,"itemsAccepted":1,"errors":[]}');
		}
		res.writeHead(404, cors).end();
	});
	await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve));
	return { close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())) };
}

/**
 * Everything npm run dev serves, in one process: the fake IdP for both audiences, the fake Graph, every Function app
 * through serveWithNode with the real token checks, and the two sites on two ports so they stay two origins.
 */
export async function startDevStack(options: StackOptions = {}): Promise<DevStack> {
	const base = options.portBase;
	const next = async (offset: number) => (base === undefined ? freePort() : base + offset);
	const gamesPort = await next(0);
	const adminPort = await next(1);
	const apiPort = await next(2);
	const telemetryPort = await next(3);
	const idpHttps = await next(4);
	const idpHttp = await next(5);
	const graphPort = await next(6);
	const foundryPort = await next(7);
	const visionPort = await next(8);
	const gamesOrigin = `http://localhost:${gamesPort}`;
	const adminOrigin = `http://localhost:${adminPort}`;
	const adminEmail = options.adminEmail ?? 'admin@example.com';

	const layout = options.fixtures
		? { registry: '../test/generated/fixtures.ts', gamesRoot: 'test/fixtures/games', catalog: 'test/generated/catalog.json', adminCatalog: 'test/generated/admin-catalog.json', csp: 'test/generated/csp.json', adminCsp: 'test/generated/admin-csp.json' }
		: { registry: './generated/games.ts', gamesRoot: 'games', catalog: 'apps/games/.gen/catalog.json', adminCatalog: 'apps/admin/.gen/catalog.json', csp: 'apps/games/.gen/csp.json', adminCsp: 'apps/admin/.gen/csp.json' };
	const { games: registry } = (await import(layout.registry)) as { games: readonly RegistryEntry[] };
	const gamesRoot = layout.gamesRoot;

	const directory = createDirectory();
	const adminObjectId = directory.add({ mail: adminEmail, guest: false }).id;

	const graph = await startFakeGraph({ port: graphPort, gamesPrincipalId: GAMES_PRINCIPAL_ID, adminPrincipalId: ADMIN_PRINCIPAL_ID, directory });
	const idp = await startFakeIdp({
		httpsPort: idpHttps,
		httpPort: idpHttp,
		tenantId: TENANT_ID,
		directory,
		clients: [
			{ id: GAMES_CLIENT_ID, origin: gamesOrigin, redirectUris: [`${gamesOrigin}/`, `${gamesOrigin}/redirect.html`], authTimeClaim: false },
			{ id: ADMIN_CLIENT_ID, origin: adminOrigin, redirectUris: [`${adminOrigin}/`, `${adminOrigin}/redirect.html`], authTimeClaim: true },
		],
	});

	const foundry = await startFakeFoundry({ port: foundryPort });
	const vision = await startFakeVision({ port: visionPort });
	const apps: App[] = [];
	const storage: Accounts = options.azuriteConnectionString ? azureAccounts({ kind: 'azurite', connectionString: options.azuriteConnectionString }) : memoryAccounts();
	const accounts = deliverQueues(storage, () => apps, (worker, error, dequeueCount) => console.error(`dev stack: ${worker.name} failed attempt ${dequeueCount}`, error));
	const portalAccount = accounts.open('portal');
	await portalAccount.table('admins').put({ partitionKey: 'admin', rowKey: adminObjectId, email: adminEmail });

	const exceptions: unknown[] = [];
	const telemetry: Telemetry = {
		setUser() {},
		setRoute() {},
		log() {},
		exception(error) {
			exceptions.push(error);
			console.error('dev stack: unexpected error', error);
		},
	};
	const issuer = (audience: string): TrustedIssuer => ({ key: ENTRA, issuer: idp.issuer, audience, keys: idp.jwks, tenantId: TENANT_ID });
	const table = (name: PortalTableName) => portalAccount.table(name);
	const common = { telemetry, now: () => new Date() };
	const tokens = async (service: string) => `dev-${service}-token`;
	const playEnv = { VISION_ENDPOINT: vision.origin };
	const adminEnv = { DRAWPAD_FOUNDRY_ENDPOINT: foundry.origin, DRAWPAD_LOCAL_JOB_EVENTS: '1', TIMEDETECTIVES_FOUNDRY_ENDPOINT: foundry.origin };

	const playerApps = registry.map((entry) =>
		entry.use(({ manifest, play }) =>
			createPlayerApp({
				...common,
				issuers: [issuer(GAMES_CLIENT_ID)],
				manifest,
				create: play,
				portal: portalReader({ identities: table('identities'), members: table('members'), games: table('games'), profiles: table('profiles') }),
				accounts,
				tokens,
				env: playEnv,
			}),
		),
	);
	const portalApp = createPortalApp({ ...common, issuers: [issuer(GAMES_CLIENT_ID)], portal: portalStore({ identities: table('identities'), members: table('members'), games: table('games'), profiles: table('profiles') }), games: registry.map((entry): GameId => entry.id) });
	const modules = registry.flatMap((entry) => entry.use(({ manifest, admin }) => (admin ? [adminModule(manifest, admin)] : [])));
	const adminApp = createAdminApp({
		...common,
		issuer: issuer(ADMIN_CLIENT_ID),
		store: adminStore({ members: table('members'), games: table('games'), identities: table('identities'), emails: table('emails'), profiles: table('profiles'), admins: table('admins') }, randomUUID),
		graph: (elevation) =>
			graphAs(elevation, async () => 'dev-federated-credential', {
				tenantId: TENANT_ID,
				clientId: ADMIN_CLIENT_ID,
				gamesPrincipalId: GAMES_PRINCIPAL_ID,
				adminPrincipalId: ADMIN_PRINCIPAL_ID,
				authorityHost: idp.httpOrigin,
				graphOrigin: graph.origin,
				log: telemetry.log,
			}),
		games: registry.map((entry): GameId => entry.id),
		modules,
		accounts,
		tokens,
		env: adminEnv,
		gamesOrigin,
	});

	apps.push(...playerApps, portalApp, adminApp);
	const api = await serveWithNode(apps, { port: apiPort, allowedOrigins: (app) => (app === adminApp ? [adminOrigin] : [gamesOrigin]) });

	const events: unknown[] = [];
	const ingestion = await startIngestion(telemetryPort, [gamesOrigin, adminOrigin], events);
	const telemetryOrigin = `http://localhost:${telemetryPort}`;
	const connectionString = `InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=${telemetryOrigin}/`;
	const origins = { api: api.origin, authority: idp.origin, telemetry: telemetryOrigin };

	const gamesCatalog = (await readJson(`${REPO}${layout.catalog}`)) as object[];
	const adminCatalog = await readJson(`${REPO}${layout.adminCatalog}`);
	const gamesCsp = (await readJson(`${REPO}${layout.csp}`)) as CspByGame;
	const adminCsp = (await readJson(`${REPO}${layout.adminCsp}`)) as CspByGame;
	const gamesSite = await startSite({
		kind: 'games',
		port: gamesPort,
		origins,
		gamesRoot,
		csp: gamesCsp,
		config: { authority: idp.authority, clientId: GAMES_CLIENT_ID, scope: `api://${GAMES_CLIENT_ID}/access_as_user`, portalApiOrigin: api.origin, telemetryConnectionString: connectionString },
		catalog: gamesCatalog.map((entry) => ({ ...entry, apiBaseUrl: api.origin })),
	});
	const adminSite = await startSite({
		kind: 'admin',
		port: adminPort,
		origins,
		gamesRoot,
		csp: adminCsp,
		config: {
			authority: idp.authority,
			clientId: ADMIN_CLIENT_ID,
			consoleScope: `api://${ADMIN_CLIENT_ID}/admin.console`,
			elevateScope: `api://${ADMIN_CLIENT_ID}/admin.elevate`,
			adminApiOrigin: api.origin,
			telemetryConnectionString: connectionString,
		},
		catalog: adminCatalog,
	});

	return {
		gamesOrigin: gamesSite.origin,
		adminOrigin: adminSite.origin,
		apiOrigin: api.origin,
		adminEmail,
		adminObjectId,
		idp,
		graph,
		foundry,
		vision,
		accounts: storage,
		directory,
		events,
		exceptions,
		close: async () => void (await Promise.all([gamesSite.close(), adminSite.close(), api.close(), ingestion.close(), idp.close(), graph.close(), foundry.close(), vision.close()])),
	};
}
