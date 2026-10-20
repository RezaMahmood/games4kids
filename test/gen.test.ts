import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

function gen(root: string) {
	const run = spawnSync(process.execPath, ['--conditions=source', 'tools/gen.mjs', '--root', root], { cwd: repo, encoding: 'utf8' });
	return { status: run.status, stdout: run.stdout, problems: run.stderr.split('\n').filter((line) => line.startsWith('gen: ')) };
}

function write(root: string, path: string, content = '') {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

const part = { web: { kind: 'static' }, settings: {}, services: [] };
const manifest = (fields: object) =>
	`export default ${JSON.stringify({ title: 'T', summary: '', icon: 'icon.svg', storage: { tables: {}, containers: {}, queues: {} }, play: part, ...fields })};`;

function game(root: string, folder: string, fields: object, files = ['data/index.ts', 'play/api/index.ts']) {
	write(root, `games/${folder}/manifest.ts`, manifest(fields));
	for (const file of files) write(root, `games/${folder}/${file}`);
}

test('gen lists every problem in one run and writes nothing', () => {
	const root = mkdtempSync(join(tmpdir(), 'g4k-gen-'));
	game(root, 'good', { id: 'good' });
	game(root, 'Bad', { id: 'Bad' });
	game(root, 'mismatch', { id: 'other' });
	game(root, 'admin', { id: 'admin' });
	mkdirSync(join(root, 'games/nomanifest'), { recursive: true });
	game(root, 'lonely', { id: 'lonely', storage: { tables: { content: 'admin' }, containers: {}, queues: { 'job-queue': 'admin-private' } } }, []);
	game(root, 'names', { id: 'names', storage: { tables: { 'bad-name': 'play' }, containers: { Bad_Name: 'play' }, queues: {} }, exports: { scores: 'v1' } });
	game(root, 'twin', { id: 'other' });

	const { status, problems } = gen(root);
	assert.equal(status, 1);
	const kinds = problems.map((line) => line.slice('gen: '.length).split(':')[0]).sort();
	assert.deepEqual(kinds, [
		'bad-id',
		'duplicate-id',
		'exports-reserved',
		'id-mismatch',
		'id-mismatch',
		'missing-file',
		'missing-file',
		'no-admin-writer',
		'no-manifest',
		'reserved-id',
		'storage-name',
		'storage-name',
	]);
	assert.ok(problems.some((line) => line.includes('no-admin-writer: lonely: content, job-queue')));
	assert.ok(!problems.some((line) => line.includes('good')));
	assert.equal(existsSync(join(root, 'dev/generated/games.ts')), false);
});

test('gen writes the registry for valid games, and a second run changes nothing', () => {
	const root = mkdtempSync(join(tmpdir(), 'g4k-gen-'));
	game(root, 'alpha', { id: 'alpha' });
	game(root, 'beta', { id: 'beta', admin: part, storage: { tables: { content: 'admin' }, containers: {}, queues: {} } }, ['data/index.ts', 'play/api/index.ts', 'admin/api/index.ts']);

	const first = gen(root);
	assert.equal(first.status, 0);
	assert.match(first.stdout, /dev\/generated\/games\.ts written \(2 games\)/);
	const registry = readFileSync(join(root, 'dev/generated/games.ts'), 'utf8');
	assert.match(registry, /registryEntry\(\{ manifest: manifest0, play: play0, admin: null \}\)/);
	assert.match(registry, /registryEntry\(\{ manifest: manifest1, play: play1, admin: admin1 \}\)/);
	assert.match(registry, /from '\.\.\/\.\.\/games\/beta\/admin\/api\/index\.ts'/);

	const second = gen(root);
	assert.equal(second.status, 0);
	assert.match(second.stdout, /dev\/generated\/games\.ts unchanged/);
	assert.equal(readFileSync(join(root, 'dev/generated/games.ts'), 'utf8'), registry);
});
