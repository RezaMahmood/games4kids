// node tools/package-app.mjs <portal|admin|game-id> [--out out/apps] [--games-root games]
// Writes <out>/func-g4k-<app>.zip and prints its path.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packageApp } from './package-app.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'out/apps' }, 'games-root': { type: 'string', default: 'games' } } });
const [app] = positionals;
if (!app) throw new Error('usage: package-app.mjs <portal|admin|game-id> [--out dir] [--games-root dir]');
console.log(packageApp(app, resolve(values.out), values['games-root']));
