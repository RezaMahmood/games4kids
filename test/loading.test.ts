import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

function htmlUnder(dir: string): string[] {
	return readdirSync(join(repo, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.html') && !entry.parentPath.includes('node_modules') && !entry.parentPath.includes('dist'))
		.map((entry) => relative(repo, join(entry.parentPath, entry.name)));
}

/** redirect.html only hands MSAL its reply and never waits on a Function app. */
const pages = ['apps', 'games', 'test/fixtures/games']
	.flatMap(htmlUnder)
	.filter((path) => !path.endsWith('redirect.html'))
	.filter((path, index, all) => all.indexOf(path) === index);

test('every page is found', () => {
	for (const expected of ['apps/games/pages/index.html', 'apps/games/pages/welcome/index.html', 'apps/admin/pages/index.html', 'games/letterjoin/play/web/index.html', 'games/drawpad/play/web/index.html']) {
		assert.ok(pages.includes(expected), expected);
	}
});

for (const page of pages) {
	test(`${page} shows the loading overlay from its first paint, so a cold Function app is never a blank page`, () => {
		const html = readFileSync(join(repo, page), 'utf8');
		assert.match(html, /<body[^>]*\saria-busy="true"/, 'body starts aria-busy="true"');
		assert.match(html, /<[a-z]+[^>]*\sinert[\s>]/, 'the page content starts inert');
		assert.match(html, /<link rel="stylesheet" href="\/shared\/shell\.css">/, 'links /shared/shell.css statically');
		assert.match(html, /<link rel="stylesheet" href="\/shared\/tokens\.css">/, 'links /shared/tokens.css statically');
	});
}
