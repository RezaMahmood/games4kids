// Blocks Claude's git push and gh pr create until `npm run e2e:linux` has passed on the commit, because CI no longer runs the browser tests.
import { spawnSync } from 'node:child_process';

const input = JSON.parse(await new Response(process.stdin).text());
const command = String(input.tool_input?.command ?? '');
if (!/\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(command) || /\bgit\s+push\b.*(--delete|\s:\S)/.test(command)) process.exit(0);
const cwd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command)?.[1].replace(/^["']|["']$/g, '') ?? input.cwd;
const check = spawnSync('node', [new URL('../../tools/e2e.mjs', import.meta.url).pathname, '--check'], { cwd, encoding: 'utf8' });
if (check.status === 0) process.exit(0);
process.stderr.write(check.stderr || check.stdout || 'The browser-test check could not run.');
process.exit(2);
