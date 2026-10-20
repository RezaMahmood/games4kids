// node tools/site-config.mjs <games|admin> [--out out/sites/<kind>] [--games-root games]
// Assembles the site's folder from the build. deploy.mjs fills in the origins at deploy time.

import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeSite } from './site-config.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, 'games-root': { type: 'string', default: 'games' } } });
const [kind] = positionals;
if (kind !== 'games' && kind !== 'admin') throw new Error('usage: site-config.mjs <games|admin> [--out dir] [--games-root dir]');
const out = resolve(values.out ?? `out/sites/${kind}`);
composeSite(fileURLToPath(new URL('..', import.meta.url)), kind, out, { gamesRoot: values['games-root'] });
console.log(out);
