import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { catalogFile, gameWebDir, pageDirs, sharedDirs, shellDir, swaConfigFile, tokensFile, type SiteKind } from './site-layout.ts';

export const ENTRA_ORIGIN = 'https://login.microsoftonline.com';

const SHIPPED = new Set(['.html', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.webp', '.ico', '.txt', '.webmanifest', '.woff2']);

const shipped = (source: string) => statSync(source).isDirectory() || (SHIPPED.has(extname(source)) && !source.endsWith('.d.ts'));

type CatalogRow = { readonly id: string; readonly hasAdmin?: boolean };

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown;

function copyOver(directories: readonly string[], to: string) {
	for (const directory of [...directories].reverse()) {
		if (existsSync(directory)) cpSync(directory, to, { recursive: true, filter: shipped });
	}
}

/**
 * Assembles one site's folder from the build, with the placeholders of staticwebapp.config.json and the game list still
 * in place, because the origins come from Azure and the build job has no Azure access. `fillSite` finishes it.
 */
export function composeSite(repo: string, kind: SiteKind, out: string, options: { readonly gamesRoot?: string; readonly catalog?: string } = {}): void {
	const { gamesRoot = 'games', catalog: catalogPath = catalogFile(repo, kind) } = options;
	mkdirSync(out, { recursive: true });
	copyOver(pageDirs(repo, kind), out);
	copyOver([shellDir(repo, kind)], join(out, 'shell/v1'));
	copyOver(sharedDirs(repo), join(out, 'shared'));
	cpSync(tokensFile(repo), join(out, 'shared/tokens.css'));
	const catalog = readJson(catalogPath) as readonly CatalogRow[];
	for (const { id, hasAdmin } of catalog) {
		if (kind === 'admin' && !hasAdmin) continue;
		const web = gameWebDir(repo, gamesRoot, kind, id);
		if (!existsSync(join(web, 'index.html'))) throw new Error(`${web} has no index.html`);
		copyOver([web], join(out, 'g', id));
	}
	cpSync(swaConfigFile(repo, kind), join(out, 'staticwebapp.config.json'));
	cpSync(catalogPath, join(out, 'catalog.json'));
}

export type Origins = { readonly api: string; readonly adminApi: string; readonly authority: string; readonly telemetry: string };

/** Fills the origin placeholders in staticwebapp.config.json. A placeholder this does not know stays, and fillSite refuses it. */
export function substitutePlaceholders(text: string, origins: Origins): string {
	return text
		.replaceAll('__API_ORIGINS__', origins.api)
		.replaceAll('__ADMIN_API_ORIGIN__', origins.adminApi)
		.replaceAll('__AUTHORITY_ORIGIN__', origins.authority)
		.replaceAll('__TELEMETRY_ORIGIN__', origins.telemetry);
}

export function telemetryOrigin(connectionString: string): string {
	const endpoint = connectionString.split(';').find((part) => part.startsWith('IngestionEndpoint='))?.slice('IngestionEndpoint='.length);
	return endpoint ? new URL(endpoint).origin : "'self'";
}

export type Deployment =
	| { readonly kind: 'games'; readonly tenantId: string; readonly clientId: string; readonly portalOrigin: string; readonly playerOrigins: Readonly<Record<string, string>>; readonly telemetryConnectionString: string }
	| { readonly kind: 'admin'; readonly tenantId: string; readonly clientId: string; readonly adminOrigin: string; readonly telemetryConnectionString: string };

function configAndOrigins(deployment: Deployment): { config: object; origins: Origins } {
	const authority = `${ENTRA_ORIGIN}/${deployment.tenantId}`;
	const telemetry = telemetryOrigin(deployment.telemetryConnectionString);
	const { clientId, telemetryConnectionString } = deployment;
	if (deployment.kind === 'games') {
		const api = [deployment.portalOrigin, ...Object.values(deployment.playerOrigins)].join(' ');
		return {
			config: { authority, clientId, scope: `api://${clientId}/access_as_user`, portalApiOrigin: deployment.portalOrigin, telemetryConnectionString },
			origins: { api, adminApi: api, authority: ENTRA_ORIGIN, telemetry },
		};
	}
	return {
		config: { authority, clientId, consoleScope: `api://${clientId}/admin.console`, elevateScope: `api://${clientId}/admin.elevate`, adminApiOrigin: deployment.adminOrigin, telemetryConnectionString },
		origins: { api: deployment.adminOrigin, adminApi: deployment.adminOrigin, authority: ENTRA_ORIGIN, telemetry },
	};
}

/** Finishes a composed site: the SWA headers, /config.json, and on the games site each game's apiBaseUrl in /catalog.json. */
export function fillSite(dir: string, deployment: Deployment): void {
	const { config, origins } = configAndOrigins(deployment);
	const swaPath = join(dir, 'staticwebapp.config.json');
	const filled = substitutePlaceholders(readFileSync(swaPath, 'utf8'), origins);
	const left = filled.match(/__[A-Z_]+__/g);
	if (left) throw new Error(`staticwebapp.config.json still has ${[...new Set(left)].join(', ')}`);
	writeFileSync(swaPath, filled);
	writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, '\t')}\n`);
	if (deployment.kind === 'games') {
		const catalogPath = join(dir, 'catalog.json');
		const entries = (readJson(catalogPath) as readonly CatalogRow[]).map((entry) => {
			const apiBaseUrl = deployment.playerOrigins[entry.id];
			if (!apiBaseUrl) throw new Error(`no function app origin for game ${entry.id}`);
			return { ...entry, apiBaseUrl };
		});
		writeFileSync(catalogPath, `${JSON.stringify(entries, null, '\t')}\n`);
	}
}
