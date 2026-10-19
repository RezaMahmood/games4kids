# games4kids portal architecture

This is the design for the games4kids portal. Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. Below the sign-in they disagree on almost everything. drawpad is Preact with a reducer and a Vite bundle, keyed by Entra `oid`, with `route({ requires })` and `{ error: code }`. letterjoin is vanilla ES modules that own the whole document through `getElementById` across two HTML pages, keyed by email, with `{ level }` and `{ error: message }`. What they share is the portal's job. Both use MSAL against one tenant, a Functions API that validates its own JWTs behind CORS, Table and Blob storage through a managed identity, `config.json` and CSP written at deploy, and OIDC deploys from GitHub Actions.

The old repos, deployments, Entra registrations, and resource groups stay as they are. The portal gets its own registration "games4kids", its own resource group `rg-games4kids`, and its own Static Web App, Function app, and storage. It is for a family now and may open to more people later. Azure should stay boring and cheap. The repo keeps one list of games and syncs nothing by hand.

## Usage (caller's view)

A game author reads this and nothing else:

```
games/<id>/manifest.ts     export default defineGame({...})              data only
games/<id>/web/            your pages, served at /g/<id>/
games/<id>/api/index.ts    export const createGameApi = defineGameApi(manifest, (platform) => ({ routes }))
games/<id>/infra.bicep     optional: Azure resources only this game uses
Import only @g4k/sdk and '/shell/v1.js'. Run npm run dev. Nothing else in the repo lists your game.
```

letterjoin's `app.js` drops `gate.js` and `auth.js`. Its header becomes `<portal-bar title="Letter Tracing" back="/">` with the practice pill and score chip in the `center` slot.

```js
import { enter } from '/shell/v1.js';
const { api, me } = await enter({ game: 'letterjoin' });
const groups = await api.get('activities');
// admin.js
const admin = await enter({ game: 'letterjoin', requires: 'admin' });
```

drawpad's `main.tsx` replaces `boot()` with the same call. `boot.ts`, `auth/*`, `config.ts`, `ProfileName.tsx`, and `AdminUsers.tsx` are deleted.

```tsx
const session = await enter<RoleOf<typeof manifest>>({ game: 'drawpad' });
render(<App session={session} />, document.getElementById('app')!);
```

drawpad's API route, after the port ([`examples/drawpad/api.ts`](sketch/examples/drawpad/api.ts)):

```ts
export const createGameApi = defineGameApi(manifest, (platform) => ({
	routes: [{
		name: 'createDrawing', method: 'POST', path: 'drawings', access: 'player', body: 'json',
		async run({ caller, body, now }) {
			const { pictureId, kind } = parseNewDrawing(body);
			if (caller.role !== 'admin' && (await secondsLeftToday(platform.tables.usage, platform.tables.settings, caller, now)) <= 0)
				throw new HttpError(403, 'time_up', 'That is all the drawing time for today.');
			const drawing = newDrawing(platform.newId(), pictureId, kind, now);
			await platform.tables.drawings.put({ partitionKey: caller.userId, rowKey: drawing.id, ...drawing });
			return { status: 201, json: drawing };
		},
	}],
	workers: [{ queue: 'stencil-jobs', run: (message, { log }) => runStencilJob(platform, message, log) }],
}));
```

letterjoin's `createApi` loses its three auth parameters, `level` becomes `access`, and `userKey(caller.email)` becomes `caller.userId` ([`examples/letterjoin/api.ts`](sketch/examples/letterjoin/api.ts)). `platform.tables.pictures` in letterjoin, `access: 'superuser'`, `services: ['storage']`, and a non-empty `exports` are compile errors.

## Shape

### Repo layout

```
games4kids/
	package.json                npm workspaces. gen runs on predev, prebuild, pretest
	tsconfig.json               solution file. References the generated tsconfig.games.json
	eslint.config.js            in games/*/api: no @azure/*, jose, or process.env
	packages/sdk/               @g4k/sdk: defineGame, defineGameApi, HttpError, Platform, Session.
	                            The only package a game may import
	shell/                      builds dist/site/shell/v1.js (MSAL vendored) and theme.css. <portal-bar>
	portal/web/                 / (home), /welcome/ (profile), /admin/ (members, invites, game admin links), redirect.html
	host/src/                   index.ts, host.ts, identity.ts, storage.ts, graph.ts, portal-routes.ts,
	                            adapters/functions.ts (only @azure/functions importer), adapters/node.ts
	host/generated/games.ts     gitignored, from tools/gen.mjs
	games/drawpad/              manifest.ts, web/ (Vite + Preact), api/, infra.bicep (Foundry, Event Grid)
	games/letterjoin/           manifest.ts, web/ (static), api/ (JS, checkJs), infra.bicep (Vision F0)
	tools/                      gen.mjs, build.mjs, dev.mjs, site-config.mjs, deploy.mjs, deploy-guard.mjs,
	                            infra.mjs, entra-setup.mjs, migrate/drawpad-content.mjs, migrate/letterjoin-content.mjs
	infra/main.bicep            reads infra/generated/storage.json and games.bicep (gitignored)
	dev/fake-idp.mjs            from letterjoin, unchanged
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/deploy.yml
```

### Request flow

1. A child opens `/`. The page imports `/shell/v1.js` and calls `enter({ game: null })`. With no account in MSAL's cache, the shell calls `loginRedirect` in the top window and Entra returns to the same page.
2. The shell reads `/config.json`, gets a token for `api://<clientId>/access_as_user`, and calls `GET /api/portal/me`.
3. The host verifies the token against its `TrustedIssuer` list and gets an `Identity` (issuer key, subject, email). The pure `decide` turns the stored rows into an `Admission`. A first sign-in with a matching invite runs the claim. A member with no profile is sent to `/welcome/` for a unique display name and a time zone.
4. Home renders cards from `catalog.json` for the games in `me.games`.
5. The child taps Draw Pad. The browser loads `/g/drawpad/`, whose `enter({ game: 'drawpad' })` gets a token silently from the shared sessionStorage cache and returns `{ api, me, signOut }` with `me.role` set to `player`.
6. `api.post('drawings', ...)` sends `POST /api/g/drawpad/drawings` with the bearer token. The Functions adapter turns it into a `HostRequest` for `host.handle`.
7. The host runs the fixed order in `Host.handle` ([`host.ts`](sketch/host.ts)). It verifies, admits, checks `effectiveRole` against `route.access`, parses the body, and calls `run` with a `Caller`. It maps errors to `{ error, message, problems? }` and adds CORS for the site origin only.

### Games are pages, not mounts or frames

The site is one Static Web App. The portal owns `/`, `/welcome/`, and `/admin/`. Each game is its own set of documents under `/g/<id>/`, built as `vite` (base `/g/<id>/`) or `static` (copied). Every page imports one ESM file, `/shell/v1.js`, which holds MSAL and the `<portal-bar>` custom element. Pages share an origin, so moving between games costs one cached page load and a silent token call. Deep links are plain URLs below the game's prefix. The generator writes the SWA fallback and per-game CSP for `/g/<id>/*`. Admin screens stay in each game, letterjoin's `admin.html` and drawpad's in-app mode, and `/admin/` links to each `adminPath`. This is the experience-first choice. One game's global pointer handlers, CSS, or viewport meta can never reach another game.

### One host runs every game's API

The backend is one Functions app. `createHost` mounts `/api/portal/*` and each game's routes at `/api/g/<id>/*`. A game receives a `Platform<typeof manifest>` with tables, blobs, and queues typed from the names it declared, parsed settings, tokens for declared services only, a read-only `roster` of members who can see the game, `now`, and `newId`. It never receives a credential, a client, the environment, or `@azure/functions`. `Reply` has no headers member, so a game cannot set CORS. Per boundary-discipline, the adapters are the only files that import a transport, so one host runs in Functions, in the dev stack, and in tests.

Two build rules close the gaps the types leave. Each `games/<id>/api` and Vite `web` is a composite TS project that includes only its own folder and references only `@g4k/sdk`, so importing another game's or the host's files fails `tsc -b` with TS6307, which c1 measured on a two-game toy. ESLint bans `@azure/*`, `jose`, and `process.env` in `games/*/api`.

### Startup containment and health

The generated `host/generated/games.ts` uses static imports and calls `entry(id, manifest, createGameApi)` per game. `mountGames` runs `platformFor` and `createGameApi` for each game inside its own try/catch. A game that throws, or lacks a required setting, is marked `unavailable` and answers every `/api/g/<id>/*` call with 503 `game_unavailable`, while the other games mount. `GET /api/portal/health` reports the version and each game's state, and `tools/deploy.mjs verify` fails unless every game is `ok`. Static imports do not contain a module that throws while it loads. CI catches that case, because the conformance suite imports every game.

### Identity and roles

There is one single-tenant Entra registration, "games4kids", with SPA redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. The portal mints its own `PortalUserId`, a branded UUID. `portalIdentities` maps `issuer|subject` to it. `portalMembers` holds `{ email, portalRole, profile, grants }` and is the single gate. Entra "assignment required" stays off, so no second list exists to drift.

Entry is by invite. An admin adds an email with per-game grants on `/admin/`, and can also send a Microsoft guest invitation through drawpad's Graph code, which now needs only `User.Invite.All`. On first sign-in the host claims the invite in three idempotent steps, per make-operations-idempotent. It inserts the identity row or reads the existing one, upserts the member row, then deletes the invite. `BOOTSTRAP_ADMIN_EMAILS` seeds the first admin.

Each manifest declares its role ladder, lowest first, so drawpad keeps `['player', 'admin']` and letterjoin keeps `['member', 'admin']`. `effectiveRole` is the only function that computes a game role. A portal admin holds the top rung. Otherwise a grant applies, `'none'` hides the game, and with no grant the manifest's `defaultRole` applies when read, so adding a game never backfills member rows. A game sees `Caller = { userId, displayName, timeZone, role }` and nothing about tokens or email.

Opening up later means adding Entra External ID as a second `TrustedIssuer` and a second authority in `config.json`. An existing member gets a `link` invite that maps the new identity to the old `PortalUserId`, so no game row changes.

### Data isolation

All data lives in one storage account. `storage.ts` is the only module with a storage client and names everything `<id><Declared>` for tables and `<id>-<declared>` for containers and queues. Portal tables use the `portal` prefix, which is reserved. The types do the isolating. `platform.tables` has only the declared keys, there is no `tables.get(name)`, and `AzureService` has no storage member. This is a code boundary, not an RBAC boundary. Per type-system-discipline, a game cannot spell another game's data, and `platformFor` is the one place a later per-game account would change.

The door for cross-game features is the manifest's reserved `exports`. A joint scoreboard would be a portal hub calling a game's declared export, never a read of its tables. Until a hub exists, the type admits only `{}` and the generator rejects a non-empty value.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and writes `host/generated/games.ts`, `tsconfig.games.json`, `catalog.json`, the SWA routes, `infra/generated/storage.json`, and `infra/generated/games.bicep`. These files are gitignored. `npm run gen` runs on predev, prebuild, and pretest, in CI, and first in `tools/infra.mjs`. The build fails, listing every problem, when a folder name differs from its manifest id, ids collide, an id is malformed or reserved (`portal`, `shell`, `admin`, `welcome`, `api`, `g`), `web/index.html` or `api/index.ts` or the `adminPath` target is missing, a prefixed storage name breaks Azure's length or character rules, `defaultRole` is off the ladder, or `exports` is non-empty. Per encode-lessons-in-structure, these rules are code, not review comments.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`.
2. Add `web/index.html` that imports `/shell/v1.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources.
5. Run `npm test`. Gen runs first, and conformance covers the new game without a new test.
6. Run `node tools/infra.mjs` from the laptop to create the new tables, containers, queues, and module.
7. Push to `main`. CI ships the code and checks health.

This touches one new folder and edits no existing file. It needs no Entra change and no workflow change.

### Hosting, deploy, and cost

The resource group `rg-games4kids` sits in North Europe, like drawpad, and holds these resources:

- Static Web App, Free.
- Function app, Flex Consumption, Node 22, 2048 MB, maximum 1 instance, system-assigned identity. drawpad's infra README says the cap applies per function group, which keeps its Foundry worker serial.
- One storage account, shared keys off, no public blob access. It holds the portal and game data and the Flex deployment container.
- Log Analytics with a 0.1 GB daily cap, and Application Insights.
- A Foundry account in Sweden Central and an Event Grid subscription from `drawpad-jobs` blobs to the `drawpad-stencil-jobs` queue, both from `games/drawpad/infra.bicep`.
- Azure AI Vision F0, from `games/letterjoin/infra.bicep`.
- A deploy identity with a GitHub federated credential and Website Contributor on the Function app only.

The monthly cost is a guess of 1 to 3 USD before Foundry calls. drawpad's README estimates under 1 USD a month for drawpad alone, and measured 0.015 to 0.048 USD per image redraw.

Infra stays a laptop step. `tools/infra.mjs` runs gen and then `az deployment group create`, as both repos do today. `tools/entra-setup.mjs` creates the registration once and needs a human with admin rights. CI on push to `main` runs lint, `tsc -b`, every test, and letterjoin's deploy guard. It then ships the API zip and the site with `config.json` and CSP written in, and runs `verify` against `/version.json` and `/api/portal/health`. There is one environment, production.

### Bringing the two games in

Each game is copied, minus what the portal now owns. For drawpad, `web/src` moves under `games/drawpad/web`. Its auth, config, profile, user-admin, and sign-out code goes. `route()` calls become `Route` objects, `storage.ts` gives way to platform handles, and the app reads `?mode=admin` at start so `/admin/` can link to it. For letterjoin, `web/` moves as is, minus `gate.js`, `auth.js`, `redirect.html`, `vendor/msal`, and the admin users tab.

Authored content migrates, and per-user history starts fresh. `tools/migrate/drawpad-content.mjs` copies the pictures table and blobs. `tools/migrate/letterjoin-content.mjs` copies the activities table, which includes the settings partition. Both upsert by original id, so a rerun is safe. History starts fresh because its keys (`oid`, `sha256(email)`) can map to a `PortalUserId` only after each child's first portal sign-in, and the old apps stay live, so nothing is lost.

### Shared now, and deliberately not

The portal owns sign-in, the profile, members, invites and grants, `<portal-bar>`, the API client with its 401 retry, protected-image object URLs, `config.json` and CSP, the error shape, theme tokens, and the dev stack. Play-time limits stay in each game. drawpad's hard daily limit (403 `time_up`) and letterjoin's soft practice goal are different products, so each keeps its own tables.

### Local dev and tests

`npm run dev` runs `tools/dev.mjs`. It starts letterjoin's fake IdP on `https://localhost:7443`, trusted as a dev issuer. It runs the host on the node adapter with memory storage, or Azurite with `STORAGE=azurite`. It also starts a site server with the SWA headers and Vite middleware for `vite` games. The real `verifyToken` runs, with no `x-dev-user` bypass.

The root `npm test` runs these suites:

- `identity.test` covers the `decide` table, `effectiveRole`, and a claim that crashes at each step and still converges.
- `host.test` drives the admission matrix through `host.handle`.
- `gen.test` covers each `Problem` kind.
- `boundaries.test` proves a fixture game that imports host files fails `tsc -b`.
- `conformance.test` runs `runGameConformance` for every game. It checks 401 without a token, every route's access floor, `not_entitled`, that only declared storage is touched, and that CORS names only the site origin.
- Each game keeps its own suite, and Playwright runs against the dev stack.

### Interface depth

A game author learns one manifest, one `defineGameApi`, and one `enter`. Behind them sit MSAL, onboarding, invites, JWT validation, roles, CORS, body parsing, error mapping, storage naming, credentials, Functions registration, and Bicep.

## Synthesis decision

Three candidate designs went to a bakeoff, each from a different model: c1 was one SPA with games mounted in shadow roots, c2 was iframes with a Function app per game, and c3 was co-hosted pages on one host. The candidate files are not in this repo. A cross-judge on another model scored c3 28, c1 25, and c2 18 out of 30. c3 (co-hosted pages on a capability host) is the base, because it is the only shape that brings letterjoin in without a rewrite and still gives every game one host, one sign-in, and typed storage.

Grafted in:

- From c1, the identity model. That means the portal-minted `PortalUserId`, the `identities` table, `members` as the single gate with assignment required off, idempotent invite claims, `BOOTSTRAP_ADMIN_EMAILS`, per-game role ladders, `effectiveRole` with `defaultRole` applied when read, `'none'` grants, and `TrustedIssuer` for External ID later. This replaces c3's `oid` key and `roleIn`, which tied game data to one identity provider.
- From c1, TS project references and the ESLint bans, because c3's lint alone could not stop a game importing host files.
- From c1, startup containment with a 503 per game and `/api/portal/health`, using static imports instead of c1's top-level `await import()`.
- From c2, `runGameConformance` for every game from one glob.
- From c2, the registry build checks, including rejecting a non-empty `exports`.
- Generated files are gitignored and produced by `npm run gen`, in place of c3's committed files with a CI diff check.

Declined:

- Per-game storage account and managed identity (c1, c2). In one process, RBAC only stops accidents the typed handles already stop. A later split changes `platformFor` and Bicep with zero game edits.
- Bicep in CI with Owner on the resource group (c3). Infra stays a laptop step as in both repos, and the CI identity only ships code.
- c2's iframes and ticket broker. They suit hostile third-party games, and they stay the recorded next step for that case.
- c1's shadow-root SPA mount. It forces a letterjoin port and shadow-DOM risk for no gain a child can see.

## Tradeoffs accepted

- We accept a page load between games in exchange for zero coupling between game runtimes.
- We accept isolation by types, project references, and lint, not Azure RBAC, in exchange for one Function app, one identity, and one deploy.
- We accept one Node process for every game's HTTP in exchange for no plumbing between services. Startup failures are contained. A runtime hang or leak in one game slows every game until the instance recycles.
- We accept maximum 1 instance in exchange for drawpad's worker staying serial.
- We accept that every deploy ships every game. Health blocks a deploy that leaves a game unavailable.
- We accept that any account in the tenant can get a token and reach the "not invited" screen, in exchange for one list of who may enter.
- We accept fresh per-user history in exchange for not re-keying on day one.
- We accept gitignored generated files, so a fresh clone needs `npm run gen`, which every npm entry point runs first.

## Alternatives considered

- **One SPA with games mounted in shadow roots.** Its contract with a game covers mount, router, CSS scope, and build. letterjoin breaks all four today, so day one is a rewrite of a working game on an axis no child sees.
- **Iframes with a Function app per game.** Entra refuses to run in a frame, so each frame needs a token bridge. It multiplies JWT validation, CORS, and deploys, and it protects against a hostile game author when the author runs the portal.
- **Entra app roles and assignment as the gate.** It moves "who may enter" and "which role" into Graph calls and leaves a members table anyway for profiles and grants, so two lists would drift apart.
- **The shell as an npm package bundled into each game.** letterjoin would need a bundler, and the browser would hold one MSAL per game.

## Open questions and risks

- Should one Entra account per child stay the model, or should one account hold several child profiles chosen from a picker?
- drawpad's README says the Flex instance cap applies per function group. Nobody has measured that here. Is it worth a check before drawpad's worker moves?
- Infra stays on the laptop. Should a later CI identity run Bicep `what-if` on pull requests without the rights to deploy?
- With assignment required off, any tenant account reaches the "not invited" screen. Is that acceptable for this tenant?
- A game whose new storage was not provisioned by `tools/infra.mjs` mounts and then fails on first use. Should health probe declared storage?
- A game module that throws while it loads takes down every game, because imports are static. CI catches it before deploy. Is that enough?
- Should letterjoin history be re-keyed at cutover, or only if a child asks for it?
- Is `exports` the right door for a joint scoreboard, or should games write events to a portal table?

## Build plan

Each phase ends in a named check and does not start until the previous check is green, per sequence-verifiable-units.

1. **Scaffold, host, and identity.** Workspaces, `@g4k/sdk`, `tools/gen.mjs`, `createHost`, identity, the node adapter, and a fixture game. Done when `npm test` passes `identity.test`, `host.test`, `gen.test`, `boundaries.test`, and conformance for the fixture, and a throwing fixture shows `unavailable` in health.
2. **Shell and portal pages.** `/shell/v1.js`, `<portal-bar>`, `/`, `/welcome/`, `/admin/`. Done when the Playwright portal flow passes against the dev stack, covering fake IdP sign-in, invite claim, profile, cards, the admin hub, and the not-invited screen.
3. **drawpad port.** Done when drawpad's Vitest suite, drawpad conformance, and a Playwright smoke (open, draw, save, `time_up` at the limit) all pass.
4. **letterjoin port.** Done when letterjoin's `node --test` suite, its Playwright e2e retargeted at `/g/letterjoin/`, and letterjoin conformance all pass.
5. **Infra, Entra, and deploy.** `tools/entra-setup.mjs`, `tools/infra.mjs`, the CI workflow, and the content migration. Done when `tools/deploy.mjs verify` passes with both games `ok` in health, and a family member signs in on the iPad and plays both games.

## Next implementation step

Write `host/src/identity.ts` and `host/src/host.ts` against `test/identity.test.ts` and `test/host.test.ts`, with the node adapter and the fake IdP, so the admission matrix is green before any game is copied in.
