// .githooks/pre-push holds the real check. This makes sure git will run it before Claude pushes or opens a PR.
import { spawnSync } from 'node:child_process';

const input = JSON.parse(await new Response(process.stdin).text());
if (!/\bgit\b.*\bpush\b|\bgh\s+pr\s+create\b/.test(String(input.tool_input?.command ?? ''))) process.exit(0);
const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], { cwd: input.cwd, encoding: 'utf8' }).stdout.trim();
if (hooksPath === '.githooks') process.exit(0);
process.stderr.write('Git is not set to run .githooks/pre-push, which refuses commits whose browser tests have not passed. Run `npm run e2e:linux` with no arguments on a clean tree. It sets core.hooksPath once it passes.');
process.exit(2);
