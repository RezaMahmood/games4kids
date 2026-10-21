import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSite, fillSite, telemetryOrigin, widenCsp, withGameCsp } from '../tools/site-config.ts';
import { catalogFile, gameWebDir } from '../tools/site-layout.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = 'test/fixtures/games';
const generated = (name: string) => join(repo, 'test/generated', name);

const built = existsSync(join(repo, 'dist/apps/games/shell/v1/index.js')) && existsSync(generated('catalog.json')) && existsSync(join(repo, 'design/.gen/tokens.css'));
const skip = built ? false : 'dist/ or the generated files are missing; run npm run gen and npx tsc -b';

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((path) => path.split('\\').join('/'));
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const compose = (kind: 'games' | 'admin') => {
	const out = mkdtempSync(join(tmpdir(), `g4k-site-${kind}-`));
	composeSite(repo, kind, out, { gamesRoot: FIXTURES, catalog: generated(kind === 'games' ? 'catalog.json' : 'admin-catalog.json'), csp: generated(kind === 'games' ? 'csp.json' : 'admin-csp.json') });
	return out;
};

const GAMES = {
	kind: 'games',
	tenantId: 'tenant-1',
	clientId: 'games-client',
	portalOrigin: 'https://func-g4k-portal-a1.westeurope-01.azurewebsites.net',
	playerOrigins: { fixture: 'https://func-g4k-fixture-b2.westeurope-01.azurewebsites.net', puzzle: 'https://func-g4k-puzzle-c3.westeurope-01.azurewebsites.net' },
	telemetryConnectionString: 'InstrumentationKey=k;IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/',
} as const;

test('the games site is laid out as the shell expects, with sources left out and placeholders left in', { skip }, () => {
	const out = compose('games');
	const files = tree(out);
	for (const path of ['index.html', 'redirect.html', 'welcome/index.html', 'home.js', 'shell/v1/index.js', 'shared/api-client.js', 'shared/shell.css', 'shared/tokens.css', 'shared/vendor/msal-browser.min.js', 'g/fixture/index.html', 'g/puzzle/index.js', 'staticwebapp.config.json', 'catalog.json']) {
		assert.ok(files.includes(path), `${path} is in the site`);
	}
	assert.deepEqual(files.filter((path) => path.endsWith('.ts') || path.endsWith('.map') || path.endsWith('.tsbuildinfo')), []);
	assert.equal(files.some((path) => path.startsWith('g/fixture/admin') || path.startsWith('g/admin')), false);
	assert.match(read(out, 'staticwebapp.config.json'), /__API_ORIGINS__ __AUTHORITY_ORIGIN__ __TELEMETRY_ORIGIN__/);
	assert.equal(existsSync(join(out, 'config.json')), false);
});

test('each site ships every committed file of a static game, so a page never asks for one the site lacks', { skip }, () => {
	for (const kind of ['games', 'admin'] as const) {
		const out = mkdtempSync(join(tmpdir(), `g4k-site-real-${kind}-`));
		const rows = (JSON.parse(readFileSync(catalogFile(repo, kind), 'utf8')) as { id: string }[]).filter(({ id }) => !gameWebDir(repo, 'games', kind, id).endsWith('dist'));
		const catalog = join(out, '..', `${out.split('/').at(-1)}-catalog.json`);
		writeFileSync(catalog, JSON.stringify(rows));
		composeSite(repo, kind, out, { catalog });
		for (const { id } of rows) {
			const web = gameWebDir(repo, 'games', kind, id);
			const committed = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: web, encoding: 'utf8' }).split('\0').filter((path) => path && !path.endsWith('.ts'));
			const missing = committed.filter((path) => !existsSync(join(out, 'g', id, path)));
			assert.deepEqual(missing, [], `the ${kind} site lacks these files of ${id}`);
		}
	}
});

test('the admin site serves admin pages only for games that have them', { skip }, () => {
	const out = compose('admin');
	const files = tree(out);
	assert.ok(files.includes('g/fixture/index.html'));
	assert.equal(files.some((path) => path.startsWith('g/puzzle')), false);
	assert.match(read(out, 'g/fixture/index.html'), /<\/html>/);
	assert.match(read(out, 'staticwebapp.config.json'), /__ADMIN_API_ORIGIN__/);
});

test('filling the games site writes its origins, its config, and each game its function app', { skip }, () => {
	const out = compose('games');
	fillSite(out, GAMES);
	const headers = JSON.parse(read(out, 'staticwebapp.config.json')).globalHeaders['Content-Security-Policy'] as string;
	assert.match(headers, /connect-src 'self' https:\/\/func-g4k-portal-a1\.westeurope-01\.azurewebsites\.net https:\/\/func-g4k-fixture-b2\.westeurope-01\.azurewebsites\.net https:\/\/func-g4k-puzzle-c3\.westeurope-01\.azurewebsites\.net https:\/\/login\.microsoftonline\.com https:\/\/westeurope-5\.in\.applicationinsights\.azure\.com;/);
	assert.doesNotMatch(read(out, 'staticwebapp.config.json'), /__[A-Z_]+__/);
	assert.deepEqual(JSON.parse(read(out, 'config.json')), {
		authority: 'https://login.microsoftonline.com/tenant-1',
		clientId: 'games-client',
		scope: 'api://games-client/access_as_user',
		portalApiOrigin: GAMES.portalOrigin,
		telemetryConnectionString: GAMES.telemetryConnectionString,
	});
	const catalog = JSON.parse(read(out, 'catalog.json')) as { id: string; apiBaseUrl: string }[];
	assert.deepEqual(catalog.map(({ id, apiBaseUrl }) => [id, apiBaseUrl]), Object.entries(GAMES.playerOrigins));
});

test('filling the admin site gives it the admin api and both scopes, and no games origin', { skip }, () => {
	const out = compose('admin');
	const adminOrigin = 'https://func-g4k-admin-d4.westeurope-01.azurewebsites.net';
	fillSite(out, { kind: 'admin', tenantId: 'tenant-1', clientId: 'admin-client', adminOrigin, telemetryConnectionString: GAMES.telemetryConnectionString });
	assert.deepEqual(JSON.parse(read(out, 'config.json')), {
		authority: 'https://login.microsoftonline.com/tenant-1',
		clientId: 'admin-client',
		consoleScope: 'api://admin-client/admin.console',
		elevateScope: 'api://admin-client/admin.elevate',
		adminApiOrigin: adminOrigin,
		telemetryConnectionString: GAMES.telemetryConnectionString,
	});
	assert.doesNotMatch(read(out, 'staticwebapp.config.json'), /__[A-Z_]+__|func-g4k-portal/);
	assert.match(read(out, 'staticwebapp.config.json'), new RegExp(`connect-src 'self' ${adminOrigin.replaceAll('.', '\\.')} https://login`));
});

test('a game with no function app origin stops the games site deploy', { skip }, () => {
	const out = compose('games');
	assert.throws(() => fillSite(out, { ...GAMES, playerOrigins: { fixture: GAMES.playerOrigins.fixture } }), /no function app origin for game puzzle/);
});

test('a placeholder nothing fills stops the deploy', { skip }, () => {
	const out = compose('games');
	const path = join(out, 'staticwebapp.config.json');
	writeFileSync(path, readFileSync(path, 'utf8').replace('__API_ORIGINS__', '__API_ORIGIN__'));
	assert.throws(() => fillSite(out, GAMES), /still has __API_ORIGIN__/);
});

test('the telemetry origin comes from the ingestion endpoint, or falls back to self', () => {
	assert.equal(telemetryOrigin(GAMES.telemetryConnectionString), 'https://westeurope-5.in.applicationinsights.azure.com');
	assert.equal(telemetryOrigin(''), "'self'");
});

test('a game widens the policy for its own pages only, on the games site and on the admin site', { skip }, () => {
	const routes = (out: string) => (JSON.parse(read(out, 'staticwebapp.config.json')) as { routes: { route: string; headers?: Record<string, string> }[] }).routes;
	const games = routes(compose('games')).filter((row) => row.route.startsWith('/g/'));
	assert.deepEqual(games.map((row) => row.route), ['/g/fixture/*']);
	assert.match(games[0]?.headers?.['Content-Security-Policy'] ?? '', /img-src 'self' data: blob: https:\/\/cdn\.example;/);
	const admin = routes(compose('admin')).filter((row) => row.route.startsWith('/g/'));
	assert.deepEqual(admin.map((row) => row.route), ['/g/fixture/*']);
	assert.match(admin[0]?.headers?.['Content-Security-Policy'] ?? '', /frame-ancestors 'none'; worker-src 'self' blob:$/);
	const filled = mkdtempSync(join(tmpdir(), 'g4k-site-csp-'));
	composeSite(repo, 'games', filled, { gamesRoot: FIXTURES, catalog: generated('catalog.json'), csp: generated('csp.json') });
	fillSite(filled, GAMES);
	assert.doesNotMatch(read(filled, 'staticwebapp.config.json'), /__[A-Z_]+__/, 'the origins reach the game routes too');
});

test('widening a policy adds sources once, and starts a directive it lacks from self', () => {
	const policy = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
	assert.equal(widenCsp(policy, { 'img-src': ['blob:', 'data:'], 'worker-src': ['blob:'] }), "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; worker-src 'self' blob:");
	assert.equal(widenCsp(policy, {}), policy);
	assert.equal(JSON.parse(withGameCsp(JSON.stringify({ globalHeaders: { 'Content-Security-Policy': policy } }), {})).routes.length, 0);
	assert.throws(() => withGameCsp('{}', { a: {} }), /no global Content-Security-Policy/);
});

const viteBuilt = existsSync(join(repo, 'games/drawpad/play/web/dist/index.html')) && existsSync(join(repo, 'games/drawpad/admin/web/dist/index.html')) && existsSync(join(repo, 'apps/games/.gen/catalog.json'));

test('a Vite game is served from its built pages, with its fonts, and leaves the shell to the site', { skip: viteBuilt ? false : 'the pages are not built; run npm run build:web' }, () => {
	for (const kind of ['games', 'admin'] as const) {
		const out = mkdtempSync(join(tmpdir(), `g4k-site-vite-${kind}-`));
		composeSite(repo, kind, out);
		const files = tree(out).filter((path) => path.startsWith('g/drawpad/'));
		assert.ok(files.includes('g/drawpad/index.html'));
		const script = files.find((path) => /assets\/index-.*\.js$/.test(path));
		assert.ok(script, 'the page script is in the site');
		assert.match(read(out, script), /from"\/shell\/v1\/index\.js"/, 'the shell is imported at run time, not bundled');
		assert.ok(files.some((path) => path.endsWith('.woff2')), 'the fonts are served by the site itself');
		assert.deepEqual(files.filter((path) => path.endsWith('.woff') || path.endsWith('.ts') || path.endsWith('.tsx')), [], 'nothing but what a page loads');
		assert.doesNotMatch(read(out, 'g/drawpad/index.html'), /src="\/src\//);
	}
});
