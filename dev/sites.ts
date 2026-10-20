import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

export type SiteKind = 'games' | 'admin';

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
};

const TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.txt': 'text/plain; charset=utf-8',
};

function substitute(text: string, origins: SiteOptions['origins']): string {
	return text
		.replaceAll('__API_ORIGINS__', origins.api)
		.replaceAll('__ADMIN_API_ORIGIN__', origins.api)
		.replaceAll('__AUTHORITY_ORIGIN__', origins.authority)
		.replaceAll('__TELEMETRY_ORIGIN__', origins.telemetry);
}

async function loadSwaConfig(kind: SiteKind, origins: SiteOptions['origins']): Promise<SwaConfig> {
	const raw = await readFile(join(REPO, 'apps', kind, 'staticwebapp.config.json'), 'utf8');
	return JSON.parse(substitute(raw, origins)) as SwaConfig;
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

/**
 * Where a URL on a site comes from, with the layout the deploy job will compose:
 *   /shell/v1/*       the compiled shell of this site
 *   /shared/*         the compiled shared modules, shell.css, the vendored MSAL, and tokens.css from design/tokens.json
 *   /g/<id>/*         that game's play/web (games site) or admin/web (admin site)
 *   /<name>.js        a compiled page script;  everything else under apps/<site>/pages
 */
export function resolveFile(kind: SiteKind, gamesRoot: string, path: string): string | null {
	const dist = join(REPO, 'dist/apps');
	if (path.startsWith('/shell/v1/')) return fileAt(join(dist, kind, 'shell/v1'), path.slice('/shell/v1/'.length));
	if (path === '/shared/tokens.css') return fileAt(join(REPO, 'design/.gen'), 'tokens.css');
	if (path.startsWith('/shared/')) return fileAt(join(dist, 'shared'), path.slice('/shared/'.length)) ?? fileAt(join(REPO, 'apps/shared'), path.slice('/shared/'.length));
	const game = /^\/g\/([a-z][a-z0-9]*)\/(.*)$/.exec(path);
	if (game) return fileAt(join(resolve(REPO, gamesRoot), game[1] ?? '', kind === 'games' ? 'play/web' : 'admin/web'), game[2] ?? '');
	return fileAt(join(dist, kind, 'pages'), path) ?? fileAt(join(REPO, 'apps', kind, 'pages'), path);
}

export type Site = { readonly origin: string; close(): Promise<void> };

/** One static site on its own port, so the two sites stay two origins, with the headers its staticwebapp.config.json sets. */
export async function startSite(options: SiteOptions): Promise<Site> {
	const swa = await loadSwaConfig(options.kind, options.origins);
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
	await new Promise<void>((resolveListen, reject) => (server.once('error', reject), server.listen(options.port, 'localhost', resolveListen)));
	const { port } = server.address() as { port: number };
	return { origin: `http://localhost:${port}`, close: () => new Promise<void>((done) => (server.close(() => done()), server.closeAllConnections())) };
}
