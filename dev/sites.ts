import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitutePlaceholders, withGameCsp, type CspByGame } from '../tools/site-config.ts';
import { gameWebDir, pageDirs, sharedDirs, shellDir, swaConfigFile, tokensFile, type SiteKind } from '../tools/site-layout.ts';

export type { SiteKind };

const REPO = fileURLToPath(new URL('..', import.meta.url));

type SwaConfig = {
	readonly routes?: readonly { readonly route: string; readonly headers?: Readonly<Record<string, string>>; readonly statusCode?: number }[];
	readonly globalHeaders?: Readonly<Record<string, string>>;
};

export type SiteOptions = {
	readonly kind: SiteKind;
	readonly port: number;
	/** The dev stand-ins for the deploy job's substitutions in staticwebapp.config.json. */
	readonly origins: { readonly api: string; readonly authority: string; readonly telemetry: string };
	/** /config.json and /catalog.json, which the deploy job writes. */
	readonly config: unknown;
	readonly catalog: unknown;
	/** Where each game's play/web and admin/web folders live: games/ or test/fixtures/games/. */
	readonly gamesRoot: string;
	/** What each game's manifest widens in the policy of its own pages. */
	readonly csp: CspByGame;
};

const TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.txt': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
};

const substitute = (text: string, origins: SiteOptions['origins']) => substitutePlaceholders(text, { api: origins.api, adminApi: origins.api, authority: origins.authority, telemetry: origins.telemetry });

async function loadSwaConfig(kind: SiteKind, origins: SiteOptions['origins'], csp: CspByGame): Promise<SwaConfig> {
	const raw = await readFile(swaConfigFile(REPO, kind), 'utf8');
	return JSON.parse(substitute(withGameCsp(raw, csp), origins)) as SwaConfig;
}

/** SWA route headers: a route either matches exactly or ends in `*` and matches a prefix. A route's header replaces the global one. */
export function headersFor(config: SwaConfig, path: string): Record<string, string> {
	const headers: Record<string, string> = { ...config.globalHeaders };
	for (const { route, headers: own } of config.routes ?? []) {
		const matches = route.endsWith('*') ? path.startsWith(route.slice(0, -1)) : route === path;
		if (matches && own) Object.assign(headers, own);
	}
	return headers;
}

const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + sep);

function fileAt(root: string, relative: string): string | null {
	const target = resolve(root, `.${normalize(`/${relative}`)}`);
	if (!inside(root, target) || !existsSync(target)) return null;
	const found = statSync(target).isDirectory() ? join(target, 'index.html') : target;
	return existsSync(found) && statSync(found).isFile() ? found : null;
}

/** Where a URL on a site comes from: the layout in tools/site-layout.ts, which the deploy job composes too. */
export function resolveFile(kind: SiteKind, gamesRoot: string, path: string): string | null {
	const first = (directories: readonly string[], relative: string) => directories.map((directory) => fileAt(directory, relative)).find((found) => found !== null) ?? null;
	if (path.startsWith('/shell/v1/')) return fileAt(shellDir(REPO, kind), path.slice('/shell/v1/'.length));
	if (path === '/shared/tokens.css') return existsSync(tokensFile(REPO)) ? tokensFile(REPO) : null;
	if (path.startsWith('/shared/')) return first(sharedDirs(REPO), path.slice('/shared/'.length));
	const game = /^\/g\/([a-z][a-z0-9]*)\/(.*)$/.exec(path);
	if (game) return fileAt(gameWebDir(REPO, gamesRoot, kind, game[1] ?? ''), game[2] ?? '');
	return first(pageDirs(REPO, kind), path);
}

export type Site = { readonly origin: string; close(): Promise<void> };

/** One static site on its own port, so the two sites stay two origins, with the headers its staticwebapp.config.json sets. */
export async function startSite(options: SiteOptions): Promise<Site> {
	const swa = await loadSwaConfig(options.kind, options.origins, options.csp);
	const json = (body: unknown) => Buffer.from(JSON.stringify(body));
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		const headers = headersFor(swa, path);
		const dynamic = path === '/config.json' ? options.config : path === '/catalog.json' ? options.catalog : undefined;
		const file = dynamic === undefined ? resolveFile(options.kind, options.gamesRoot, path) : null;
		if (dynamic === undefined && !file) {
			res.writeHead(404, headers).end('Not found');
			return;
		}
		const body = dynamic === undefined && file ? await readFile(file) : json(dynamic);
		res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file ?? '.json')] ?? 'application/octet-stream' }).end(body);
	});
	await new Promise<void>((resolveListen, reject) => (server.once('error', reject), server.listen(options.port, '127.0.0.1', resolveListen)));
	const { port } = server.address() as { port: number };
	return { origin: `http://localhost:${port}`, close: () => new Promise<void>((done) => (server.close(() => done()), server.closeAllConnections())) };
}
