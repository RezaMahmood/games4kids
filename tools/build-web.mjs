// node tools/build-web.mjs [--games-root games]
// Builds the pages of every game part that declares a Vite build: games/<id>/<part>/web/vite.config.ts writes the part's
// pages to games/<id>/<part>/web/dist, which tools/site-layout.ts serves from. A part with no vite.config.ts is plain
// files that are served as they are.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';

const { values } = parseArgs({ options: { 'games-root': { type: 'string', default: 'games' } } });
const repo = fileURLToPath(new URL('..', import.meta.url));
const gamesRoot = resolve(repo, values['games-root']);

const parts = readdirSync(gamesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .flatMap((entry) => ['play', 'admin'].map((part) => join(gamesRoot, entry.name, part, 'web')))
  .filter((dir) => existsSync(join(dir, 'vite.config.ts')));

for (const root of parts) {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
  console.log(`build-web: ${root.slice(repo.length)}/dist`);
}
