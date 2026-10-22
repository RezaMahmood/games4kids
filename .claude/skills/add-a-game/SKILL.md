---
name: add-a-game
description: Add a new game to games4kids. Covers the choices to make first (static or Vite pages, an admin part, infra.bicep, a scoreboard, AI content from Foundry), the files you write by hand, the traps no check catches, and the checks to run before the PR. Use this whenever someone wants to add, scaffold, or build a new game ("add a new game", "scaffold a game", "make a quiz game", "new game idea"), or only describes a game idea for the kids' site, even if they never mention manifests or folders. Not for bug fixes inside an existing game.
---

# Add a game

A game is one folder, `games/<id>/`. `npm run gen` reads its manifest and writes the registry files from it. Read these before you write anything:

- `docs/ARCHITECTURE.md`, sections "Usage (caller's view)" and "Adding a game".
- `CLAUDE.md`, section "Cold starts never show a blank page". Every page you add follows it.
- `packages/sdk/src/manifest.ts`. `GAME_ID`, `RESERVED_IDS`, `Ownership`, and `SettingSpec` are the rules for the manifest.
- `test/fixtures/games/puzzle/`. This is the smallest working game: a manifest, one table, one route, one page that calls `ready()`. Start from it.

## Decide the shape first

Settle each choice before you copy any code, because each one changes which files exist.

**Pages.** Use static pages (plain ES modules served as they are, like `games/letterjoin/play/web/`) for a few screens. Use Vite and Preact (like `games/drawpad/play/web/`) for many screens or a lot of state. A Vite part needs `vite.config.ts` and `tsconfig.json` in its `web/` folder. Set `base: '/g/<id>/'` and keep `/shell/v1/index.js` external. Put the icon in `public/`.

**Admin part.** Add one when a grown-up writes content, reviews what children made, or runs AI jobs. Any `admin` or `admin-private` name in the manifest needs one, and gen refuses the manifest without it (`no-admin-writer`). Admin pages cannot load `play/web/` files at run time, because a play change redeploys only the games site. Copy the shared modules and assert the copies match, as `test/letterjoin/parity.test.mjs` does.

**`infra.bicep`.** Add one when the game needs its own Azure resource or an app setting whose value comes from Azure. Start from `test/fixtures/games/fixture/infra.bicep`. The pipeline passes exactly six parameters, so give any other parameter a default. Mark an unused one `#disable-next-line no-unused-params`, because CI fails on any Bicep lint finding. Tag every resource with `tags`. The pipeline may assign only the roles in `ASSIGNABLE_TO_ANY` in `tools/bootstrap.ts`. A game that needs another role needs a bootstrap change, and the owner must rerun bootstrap before the merge.

**Scoreboard.** Set `scoreboard: true` only if children compare scores. The play API must then answer `GET board/me` with `{ optedIn }` and `PUT board/me` (body `{ on }`) with `{ optedIn }`. `/profile/` calls the GET after a rename, so the GET must also update any copy of the child's display name the game keeps. Conformance checks only that both routes exist. Copy the routes in `games/letterjoin/play/api/index.ts` and the rules in `games/letterjoin/data/board.ts`.

**AI content from Foundry.** Follow drawpad (`games/drawpad/infra.bicep`, `games/drawpad/admin/api/`), with these differences:

- Create the game's own Foundry account in its `infra.bicep`. Cost splits by the `game` tag, so don't call drawpad's account. Its `customSubDomainName` must be globally unique, so name it `ai-<id>-${uniqueString(resourceGroup().id)}`. Give `adminPrincipalId` Cognitive Services OpenAI User and output `FOUNDRY_ENDPOINT` in `adminSettings`.
- Copy the Foundry client code from `games/drawpad/admin/api/foundry.ts` rather than import it, so a drawpad change cannot change your game.
- Declare `services: ['cognitiveServices']` on the admin part. Make the endpoint setting `optional` and answer 503 without it, like drawpad's `FOUNDRY_ENDPOINT`, so a missing value turns off one feature instead of the admin app.
- Run the jobs in a worker. Declare an `admin-private` queue, add `workers: [{ queue, run }]` to `defineAdminApi`, and output the three `STORAGE__*` settings in `adminSettings` (copy drawpad's lines). Send the message from the route that creates the job. Use Event Grid, as drawpad does, only when an uploaded blob must start the job.
- Make each worker step safe to repeat and save its result before the next step. `apps/admin/api/host.json` runs one message at a time, tries each message at most 3 times, and waits 60 seconds after a failure. On the last attempt, mark the job failed instead of throwing (`MAX_ATTEMPTS` in `games/drawpad/admin/api/worker.ts`).
- Store generated content as rows with a status, and have the play API list only approved rows. A grown-up approves each item on the admin page before any child sees it.
- In dev, `dev/fake-foundry.ts` answers chat completions by `response_format.json_schema.name`. Add a case for your schema name and for any endpoint it doesn't answer. Add `<ID>_FOUNDRY_ENDPOINT: foundry.origin` to `adminEnv` in `dev/stack.ts`.

## Write these by hand

Gen writes the catalogs, the registered ids, the admin module list, the per-game parameters, the CSP and `tsconfig.games.json`. The deploy targets and the workbook come from paths and names. Nothing in `.github/workflows/`, `infra/main.bicep`, `infra/game.bicep`, or the shared `tsconfig` files needs a per-game edit. You write:

1. `games/<id>/manifest.ts`. The id matches `GAME_ID` (no hyphen, at most 16 characters, because the storage account `g4k<id><5 chars>` must fit in 24), equals the folder name, and is not in `RESERVED_IDS`. The manifest imports only `@g4k/sdk`. Storage names follow `NAME_RULES` in `tools/gen.mjs`, and gen prints the rule a name breaks.
2. `data/index.ts`, `play/api/index.ts`, `play/web/index.html`, and the icon the manifest names, under the served web root. With an admin part, also `admin/api/index.ts` and `admin/web/index.html`. ESLint enforces which part may import which. Read the message when it refuses an import, and don't work around it.
3. Each setting. Admin settings are read as `<ID>_<NAME>` and play settings as `<NAME>`. A required setting (a `url` or `string` without `optional`) must come out of `infra.bicep`, and in dev from `playEnv` or `adminEnv` in `dev/stack.ts`. Without it the app refuses to start.
4. A case in `test/e2e/loading.spec.ts` for each page. Add a play page to `GAMES_PAGES`, and copy the Draw Pad admin cases for an admin page.
5. A parity test like `test/letterjoin/parity.test.mjs` when web JavaScript repeats a rule from `data/`.
6. Tests for the game's own rules and routes, in `test/<id>.test.ts` over the real apps. Conformance covers the platform contract for every game with no edit.

## Traps no check catches

- A missing icon shows a broken image on home. Nothing tests it.
- A missing required admin setting stops the whole admin app, so every game's admin pages and the members page go down with it.
- A play part that imports from another game's folder passes lint, `tsc -b`, and the tests, then fails in Azure. A player app's zip holds only `games/<id>/` (`appPlan` in `tools/package-app.ts`).

## After the merge

`deploy.yml` creates the game's infra, then deploys the apps, then the sites. New role assignments take up to 30 minutes to work, and the deploy retries until then. Later, a manifest change redeploys the game's infra, its player app, the portal and admin apps, and both sites. A change outside `play/`, `admin/`, `data/`, `manifest.ts`, and `*.bicep` in the game's folder deploys nothing.

Then tell the owner to:

- Tick the game for each child on the admin members page. A child who holds every game sees it already.
- Run `node tools/bootstrap.mjs --apply --after-first-deploy` so `tools/player-data.mjs` can read the new account. This is only needed to diagnose a child's data.

## Verify before the PR

1. Run `npm ci --ignore-scripts && npm run gen && npm run lint && npx tsc -b && npm test`.
2. Run `npm run e2e`.
3. Start `npm run dev`. Sign in to the admin site with the email it prints. Add a child with the new game ticked and sync them. Sign in to the games site as that child and play the game through. With an admin part, use each admin screen. With a worker, create a job and watch it finish, because the dev stack runs queue messages in process.
