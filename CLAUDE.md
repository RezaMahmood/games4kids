# games4kids

The design is in docs/ARCHITECTURE.md. To check the code, run `npm ci --ignore-scripts && npm run gen && npm run lint && npx tsc -b && npm test`, and `npm run e2e` for the browser checks.

## The browser tests run here, not in CI

CI runs lint, `tsc -b`, the unit and conformance suites and Bicep. It does not run Playwright, so you prove the browser tests pass before you push.

- Commit everything, then run `npm run e2e:linux` with no arguments before every `git push` and `gh pr create`. It runs the whole suite in the Playwright Linux image in Docker, whose fonts draw wider than macOS fonts, and records the commit's files (not its Markdown) as passed.
- `npm run e2e` runs on the Mac. It is faster for iterating and accepts a spec or `-g` filter, but it records nothing.
- `.githooks/pre-push` refuses to push a commit with no passing Linux run, unless the branch changes only `*.md` files. The first passing run sets `core.hooksPath` to `.githooks`, and the hook in `.claude/settings.json` blocks a push or PR until it is set. After you merge main into a branch or change its code, run `npm run e2e:linux` again.
- Docker Desktop must be running. Each Linux run is in its own container, so runs in several worktrees do not share ports.
