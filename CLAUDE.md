# games4kids

The design is in docs/ARCHITECTURE.md. To check the code, run `npm ci --ignore-scripts && npm run gen && npm run lint && npx tsc -b && npm test`, and `npm run e2e` for the browser checks.

## Cold starts never show a blank page

A Function app here may be cold, so any request to one can take many seconds. A child must always see that something is happening.

- A new page HTML (`apps/*/pages/**`, `games/*/play/web/`, `games/*/admin/web/`) starts with `<body aria-busy="true">`, `inert` on its content element, and static links to `/shared/tokens.css` and `/shared/shell.css`. The shared stylesheet paints a grey layer and a spinning ring from the first paint.
- The page calls `ready()` from `/shell/v1/index.js` once its first data has rendered, on success and on failure. A shell screen (not invited, failure) calls it for you.
- A view opened later whose content waits on a reply (a new screen, a canvas, a tab, a submit that navigates) wraps that request in `whileLoading(promise)` from the same module. A view that already shows its own loading text or a disabled "Saving…" button does not need it.
- `test/loading.test.ts` fails for any page HTML missing the overlay. `test/e2e/loading.spec.ts` holds the first request open and checks the overlay shows and lifts. Add a case there for a new page.
- In e2e, call `pageReady(page)` before typing into a page, because an inert page swallows `fill()`.
