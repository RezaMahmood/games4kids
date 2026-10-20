import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSite, fillSite, telemetryOrigin } from '../tools/site-config.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = 'test/fixtures/games';
const generated = (name: string) => join(repo, 'test/generated', name);

const built = existsSync(join(repo, 'dist/apps/games/shell/v1/index.js')) && existsSync(generated('catalog.json')) && existsSync(join(repo, 'design/.gen/tokens.css'));
const skip = built ? false : 'dist/ or the generated files are missing; run npm run gen and npx tsc -b';

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((path) => path.split('\\').join('/'));
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const compose = (kind: 'games' | 'admin') => {
	const out = mkdtempSync(join(tmpdir(), `g4k-site-${kind}-`));
	composeSite(repo, kind, out, { gamesRoot: FIXTURES, catalog: generated(kind === 'games' ? 'catalog.json' : 'admin-catalog.json') });
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
