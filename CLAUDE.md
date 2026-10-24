# games4kids

The design is in docs/ARCHITECTURE.md. To check the code, run `npm ci --ignore-scripts && npm run gen && npm run lint && npx tsc -b && npm test`, and `npm run e2e` for the browser checks.

## The browser tests run here, not in CI

CI runs lint, `tsc -b`, the unit and conformance suites and Bicep. It does not run Playwright, so you prove the browser tests pass before you push.

- Commit everything, then run `npm run e2e:linux` with no test filter before every `git push` and `gh pr create`. It runs the whole suite in the Playwright Linux image in Docker, whose fonts draw wider than macOS fonts, and records the commit's files (not its Markdown) as passed.
- `npm run e2e` runs on the Mac. It is faster for iterating and accepts a spec or `-g` filter, but it records nothing.
- The hook in `.claude/settings.json` refuses a push or PR whose tree has no passing Linux run. A branch that changes only `*.md` files is exempt. After you merge main into a branch or amend its code, run `npm run e2e:linux` again.
- Docker Desktop must be running. Each Linux run is in its own container, so runs in several worktrees do not share ports.

## Cold starts never show a blank page

A Function app here may be cold, so any request to one can take many seconds. A child must always see that something is happening.

- A new page HTML (`apps/*/pages/**`, `games/*/play/web/`, `games/*/admin/web/`) starts with `<body aria-busy="true">`, `inert` on its content element, and static links to `/shared/tokens.css` and `/shared/shell.css`. The shared stylesheet paints a grey layer and a spinning ring from the first paint.
- The page calls `ready()` from `/shell/v1/index.js` once its first data has rendered, on success and on failure. A shell screen (not invited, failure) calls it for you.
- A view opened later whose content waits on a reply (a new screen, a canvas, a tab, a submit that navigates) wraps that request in `whileLoading(promise)` from the same module. A view that already shows its own loading text or a disabled "Saving…" button does not need it.
- `test/loading.test.ts` fails for any page HTML missing the overlay. `test/e2e/loading.spec.ts` holds the first request open and checks the overlay shows and lifts. Add a case there for a new page.
- In e2e, call `pageReady(page)` before typing into a page, because an inert page swallows `fill()`.
