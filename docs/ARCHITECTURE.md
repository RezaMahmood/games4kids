# games4kids portal architecture

This is the design for the games4kids portal, revised once after owner feedback (see [Revision 2](#revision-2-owner-feedback)). Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. Below the sign-in they disagree on almost everything. drawpad is Preact with a Vite bundle, keyed by Entra `oid`, with `route({ requires })` and `{ error: code }`. letterjoin is vanilla ES modules that own two HTML pages through `getElementById`, keyed by email, with `{ level }` and `{ error: message }`. What they share is the portal's job. Both use MSAL against one tenant, a Functions API that validates its own JWTs behind CORS, Table and Blob storage through a managed identity, `config.json` and CSP written at deploy, and OIDC deploys.

The old repos, deployments, Entra registrations, and resource groups stay as they are. The portal gets its own registration "games4kids", its own resource group `rg-games4kids` in West Europe, and its own Static Web App, Function app, and storage. Players are invite only, with one sign-in per child for every game, now and later. Azure should stay boring and cheap, deploys go through a pipeline, and the repo keeps one list of games.

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

On the API side, drawpad's `route({ requires })` calls become `Route` objects with `access`, and `caller.profile.oid` becomes `caller.userId` ([`examples/drawpad/api.ts`](sketch/examples/drawpad/api.ts)). letterjoin's `createApi` loses its three auth parameters, `level` becomes `access`, and `userKey(caller.email)` becomes `caller.userId` ([`examples/letterjoin/api.ts`](sketch/examples/letterjoin/api.ts)). `platform.tables.pictures` in letterjoin, `access: 'superuser'`, `services: ['storage']`, and a non-empty `exports` are compile errors.

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
	portal/web/                 / (home), /welcome/ (profile), /admin/ (members, grants, invites, drift,
	                            game admin links), redirect.html
	host/src/                   index.ts, host.ts, identity.ts, storage.ts, portal-routes.ts,
	                            adapters/functions.ts (only @azure/functions importer), adapters/node.ts
	host/generated/games.ts     gitignored, from tools/gen.mjs
	games/drawpad/              manifest.ts, web/ (Vite + Preact), api/, infra.bicep (Foundry, Event Grid)
	games/letterjoin/           manifest.ts, web/ (static), api/ (JS, checkJs), infra.bicep (Vision F0)
	tools/                      gen.mjs, build.mjs, dev.mjs, site-config.mjs, deploy.mjs, deploy-guard.mjs,
	                            changes.mjs, infra.mjs, bootstrap.mjs, invite.mjs, members.mjs,
	                            migrate/content.mjs, migrate/player-data.mjs
	infra/main.bicep            reads infra/generated/storage.json and games.bicep (gitignored)
	dev/fake-idp.mjs            from letterjoin, unchanged
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/          deploy.yml, then the reusable infra.yml, api.yml, web.yml
```

### Request flow

1. A child opens `/`, which calls `enter({ game: null })` from `/shell/v1.js`. With no account in MSAL's cache, the shell calls `loginRedirect` in the top window. Entra signs in only accounts assigned to the games4kids enterprise app.
2. The shell reads `/config.json`, gets a token for `api://<clientId>/access_as_user`, and calls `GET /api/portal/me`.
3. The host verifies the token against its `TrustedIssuer` list, and the pure `decide` turns the stored rows into an `Admission`. A first sign-in with a matching invite runs the claim. An identity with no active member or invite is not invited and is logged as drift. A member with no profile goes to `/welcome/` for a unique display name and a time zone.
4. Home renders cards from `catalog.json` for the games in `me.games`.
5. The child taps Draw Pad. `/g/drawpad/` calls `enter({ game: 'drawpad' })`, which gets a token silently from the shared sessionStorage cache and returns `{ api, me, signOut }` with `me.role` set to `player`.
6. `api.post('drawings', ...)` sends `POST /api/g/drawpad/drawings`, which the Functions adapter hands to `host.handle`.
7. The host runs the fixed order in `Host.handle` ([`host.ts`](sketch/host.ts)). It verifies, admits, checks `effectiveRole` against `route.access`, parses the body, calls `run` with a `Caller`, maps errors to `{ error, message, problems? }`, and adds CORS for the site origin only.

### Games are pages, not mounts or frames

The site is one Static Web App. The portal owns `/`, `/welcome/`, and `/admin/`. Each game is its own set of documents under `/g/<id>/`, built as `vite` (base `/g/<id>/`) or `static` (copied). Every page imports `/shell/v1.js`, which holds MSAL and `<portal-bar>`. Pages share an origin, so moving between games costs one cached page load and a silent token call. Admin screens stay in each game, and `/admin/` links to each `adminPath`. This is the experience-first choice. One game's global pointer handlers, CSS, or viewport meta can never reach another game.

### One host runs every game's API

The backend is one Functions app. `createHost` mounts `/api/portal/*` and each game's routes at `/api/g/<id>/*`. A game receives a `Platform<typeof manifest>` with tables, blobs, and queues typed from the names it declared, parsed settings, tokens for declared services only, a read-only `roster`, `now`, and `newId`. It never receives a credential, a client, the environment, or `@azure/functions`. `Reply` has no headers member, so a game cannot set CORS. Per boundary-discipline, the adapters are the only files that import a transport, so one host runs in Functions, in the dev stack, and in tests.

Two build rules close the gaps the types leave. Each `games/<id>/api` and Vite `web` is a composite TS project that includes only its own folder and references only `@g4k/sdk`, so importing another game's or the host's files fails `tsc -b` with TS6307, which c1 measured on a two-game toy. ESLint bans `@azure/*`, `jose`, and `process.env` in `games/*/api`.

### Startup containment and health

`host/generated/games.ts` imports each game statically and calls `entry(id, manifest, createGameApi)`. `mountGames` runs `platformFor` and `createGameApi` per game inside its own try/catch. A game that throws, or lacks a required setting, answers every `/api/g/<id>/*` call with 503 `game_unavailable` while the others mount. `GET /api/portal/health` reports the version and each game's state. A module that throws while it loads is not contained, so CI's conformance suite, which imports every game, catches it.

### Identity and roles

There is one single-tenant Entra registration, "games4kids", with SPA redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. Each child has one account and one sign-in for every game, now and later. The portal mints its own `PortalUserId`, a branded UUID, which is the only user key a game sees or stores. `portalIdentities` maps `issuer|subject` to it.

Entry needs two things ([`identity.ts`](sketch/identity.ts)). Entra "assignment required" is on for the games4kids enterprise app, so Entra issues no token to an account you have not assigned. Then the host admits only an active `portalMembers` row or a pending invite. Assignments use the default access role, so roles and grants live only in `portalMembers`.

On first sign-in the host claims the invite in three idempotent steps, per make-operations-idempotent. It inserts the identity row or reads the existing one, upserts the member row, then deletes the invite. `BOOTSTRAP_ADMIN_EMAILS` seeds the first admin.

Each manifest declares its role ladder, lowest first, such as drawpad's `['player', 'admin']`. `effectiveRole` is the only function that computes a game role. A portal admin holds the top rung. Otherwise a grant applies, `'none'` hides the game, and with no grant the manifest's `defaultRole` applies when read, so adding a game never backfills member rows. A game sees `Caller = { userId, displayName, timeZone, role }` and nothing about tokens or email.

### Invites, revokes, and drift

You invite and revoke from your laptop with your own `az login` ([`admin.ts`](sketch/admin.ts)). The Function app holds no Graph permission, so the backend cannot add anyone to the tenant or the app.

`tools/invite.mjs <email> --grant drawpad=player` upserts the invite through the portal admin API, sends a B2B guest invitation if needed, then assigns the account to the enterprise app. The row goes first because alone it is harmless. Each step treats "already done" as done, so a rerun converges. Using the admin API, not a table write, gives the CLI and `/admin/` one writer and one `parseGrants`, at the cost of needing the API deployed.

`tools/members.mjs revoke <email>` marks the member revoked, which closes the portal gate at once, then removes the assignment. `tools/members.mjs reconcile` reports drift both ways: an assignment with no row, an active member or invite with no assignment, and a revoked member still assigned. The rows are the intent, so `--fix` changes only Entra. Each run uploads its report, which the `/admin/` hub shows beside members, grants, and invites. The host also sees drift itself, since a workforce token proves an assignment, and `decide` returns not-invited with `drift: true`.

### Doors left for other sign-ins and parents

Google and Facebook sign-in are not built. An Entra External ID tenant, which can federate with both, would join as a second `TrustedIssuer`. Its tokens prove no assignment, so for it the members gate stands alone. A `link` invite maps the new identity to the child's existing `PortalUserId`, so no game row changes.

You are the parent for now, as portal admin. A later parent account is a relation, not a role. `identity.ts` reserves `portalGuardianships`, from parent to child, and `portalPolicies`, per-child rules such as a daily play limit. Games would read a policy as a new `Caller` field. Neither table exists yet.

### Data isolation

All data lives in one storage account. `storage.ts` is the only module with a storage client and names everything `<id><Declared>` or `<id>-<declared>`. The `portal` prefix is reserved. `platform.tables` has only the declared keys, there is no `tables.get(name)`, and `AzureService` has no storage member. This is a code boundary, not an RBAC boundary. Per type-system-discipline, a game cannot spell another game's data, and `platformFor` is the one place a later per-game account would change.

The door for cross-game features, such as a joint scoreboard, is the manifest's reserved `exports`, which a portal hub would call instead of reading a game's tables. Until a hub exists, the type admits only `{}` and the generator rejects anything else.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and writes `host/generated/games.ts`, `tsconfig.games.json`, `catalog.json`, the SWA routes, `infra/generated/storage.json`, and `infra/generated/games.bicep`, all gitignored. `npm run gen` runs on predev, prebuild, and pretest, in CI, and first in `tools/infra.mjs`. The build fails, listing every problem, on a folder that differs from its id, a duplicate, malformed, or reserved id (`portal`, `shell`, `admin`, `welcome`, `api`, `g`), a missing required file, a storage name Azure rejects, a `defaultRole` off the ladder, or non-empty `exports`. Per encode-lessons-in-structure, these rules are code, not review comments.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`.
2. Add `web/index.html` that imports `/shell/v1.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources.
5. Run `npm test`. Gen runs first, and conformance covers the new game without a new test.
6. Push to `main`. The new storage changes `infra/generated/`, so `deploy.yml` runs infra after your approval, then api, then web, and checks health.

This touches one new folder and edits no existing file. It needs no Entra change, no workflow change, and no laptop step.

### Hosting and cost

`rg-games4kids` and every resource in it sit in West Europe, except the Foundry account, which stays in Sweden Central.

- Static Web App, Free.
- Function app, Flex Consumption, Node 22, 2048 MB, system-assigned identity, maximum 1 instance, which keeps drawpad's Foundry worker serial.
- One storage account, shared keys off, no public blob access, holding all data and the Flex deployment container.
- Log Analytics with a 0.1 GB daily cap, and Application Insights.
- From `games/drawpad/infra.bicep`, the Foundry account and an Event Grid subscription from `drawpad-jobs` blobs to the `drawpad-stencil-jobs` queue.
- Azure AI Vision F0, from `games/letterjoin/infra.bicep`.

The monthly cost is a guess of 1 to 3 USD before Foundry calls. drawpad's README estimates under 1 USD a month for drawpad alone, and measured 0.015 to 0.048 USD per image redraw.

### Pipelines and deploy identities

GitHub Actions deploys through three reusable workflows, `infra.yml`, `api.yml`, and `web.yml`, each with `workflow_call` and `workflow_dispatch`. `deploy.yml` runs on pull requests and pushes to `main`. It runs lint, `tsc -b`, every test, and letterjoin's deploy guard, then `tools/changes.mjs` maps changed paths and gen output to layers. Layers run in this order and skip when unchanged.

1. Infra runs Bicep `what-if` on a pull request and deploys on `main`. New storage in `infra/generated/` triggers it, so a new game's tables exist before its api ships.
2. Api zip-deploys the Function app. Then `tools/deploy.mjs verify` requires `/api/portal/health` at this commit with every game `ok`.
3. Web builds every page, writes `config.json` and CSP, uploads the site, and verifies `/version.json`.

Within a layer, games are not deployed one by one, because they share one Function app and one Static Web App. Each layer has its own user-assigned identity, federated to its own GitHub environment, which only `main` may deploy to.

- `id-g4k-infra`, environments `infra` (you as required reviewer) and `infra-plan` (pull request what-if). It holds Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition. The condition allows only storage data roles, Cognitive Services User, and Monitoring Metrics Publisher for service principals, Website Contributor for `id-g4k-api`, and Contributor for `id-g4k-web`.
- `id-g4k-api`, environment `api`. Bicep gives it Website Contributor on the Function app and Storage Blob Data Contributor on the deployment container.
- `id-g4k-web`, environment `web`. Bicep gives it Contributor on the Static Web App, and it reads the deployment token at run time, as drawpad's deploy script does. No layer then stores a secret, and the token alone could already replace the whole site.

`tools/bootstrap.mjs` needs admin rights no pipeline should hold, so it runs on your laptop. It creates `rg-games4kids`, the three identities and their federated credentials, the infra identity's roles, the Entra registration with assignment required, Azure CLI as an authorized client, your assignment, your data roles for the migration tools, and the GitHub environments. It applies only the difference from current state, so a second run after the first infra deploy adds the site hostname to the redirect URIs.

### Bringing the two games in

Each game's web and api folders are copied, minus what the portal now owns. drawpad loses its auth, config, profile, user-admin, and sign-out code. letterjoin loses `gate.js`, `auth.js`, `redirect.html`, `vendor/msal`, and the admin users tab.

Content migrates at cutover. Player data gets a tested tool that waits for your word. Both run on your laptop and only read the old accounts, with your existing data roles, because a pipeline would need new role assignments there. Every write is insert-if-absent at a key derived from the source, so reruns converge and never overwrite a portal row ([`migrate.ts`](sketch/migrate.ts)).

- `tools/migrate/content.mjs` copies drawpad's pictures and settings tables and its pictures container, which holds the tracing and paint-by-numbers files, including accepted AI-generated ones. It also copies letterjoin's activities table with its settings partition. drawpad's jobs hold only in-flight AI work that expires after 7 days, so they stay.
- `tools/migrate/player-data.mjs` re-keys drawpad's drawings and their images, usage, and per-child limits, and letterjoin's results, attempts, practice days, and submissions with their images. It derives the mapping from portal rows, so a child is mapped only after a first portal sign-in. drawpad's `oid` is the child's `entra` identity subject, and letterjoin's key is `sha256(email)`. The default is a dry-run report with unmapped keys. Writing needs `--apply --confirm-player-data`, and the type admits apply only with the confirmation that flag mints.

Both old apps stay live, so nothing is lost while player data waits.

### Shared now, and deliberately not

The portal owns sign-in, profiles, members, invites, grants, `<portal-bar>`, the API client, protected-image object URLs, `config.json` and CSP, the error shape, theme tokens, and the dev stack. Play-time limits stay in each game. drawpad's hard daily limit (403 `time_up`) and letterjoin's soft practice goal are different products, so each keeps its own tables. A parent-set limit would live in the reserved portal policy, and drawpad's check would read it from `Caller` before its own setting. Until a parent exists to set it, nothing needs it.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP on `https://localhost:7443` as a trusted dev issuer, the host on the node adapter with memory storage or Azurite, and a site server with the SWA headers and Vite middleware. The real `verifyToken` runs, with no `x-dev-user` bypass.

The root `npm test` runs these suites:

- `identity.test` covers the `decide` table, including revoked members and drift, `effectiveRole`, and a claim that crashes at each step and still converges.
- `host.test` drives the admission matrix through `host.handle`.
- `gen.test` covers each `Problem` kind.
- `boundaries.test` proves a fixture game that imports host files fails `tsc -b`.
- `conformance.test` runs `runGameConformance` for every game: 401 without a token, every access floor, `not_entitled`, declared storage only, and CORS for the site origin only.
- `admin.test` covers `reconcile`, `fixesFor`, and invites and revokes that crash at each step.
- `migrate.test` covers a dry-run that writes nothing, repeated and crashed applies converging, and unmapped keys.
- `changes.test` maps path changes to layers.
- Each game keeps its own suite, and Playwright runs against the dev stack.

### Interface depth

A game author learns one manifest, one `defineGameApi`, and one `enter`. Behind them sit MSAL, onboarding, invites, JWT validation, roles, CORS, body parsing, error mapping, storage naming, credentials, Functions registration, and Bicep.

## Synthesis decision

Three candidate designs from different models went to a bakeoff: c1 was one SPA with games in shadow roots, c2 was iframes with a Function app per game, and c3 was co-hosted pages on one host. A cross-judge on another model scored c3 28, c1 25, and c2 18 out of 30. c3 is the base, because it is the only shape that brings letterjoin in without a rewrite and still gives every game one host, one sign-in, and typed storage.

Grafted in:

- From c1, the identity model: `PortalUserId`, the `identities` table, `members` as the gate, idempotent claims, per-game role ladders, `effectiveRole`, `'none'` grants, and `TrustedIssuer`. It replaces c3's `oid` key, which tied game data to one identity provider. Revision 2 adds Entra assignment as a first gate.
- From c1, TS project references and the ESLint bans, because c3's lint alone could not stop a game importing host files. Also startup containment with a 503 per game, using static imports instead of c1's `await import()`.
- From c2, `runGameConformance` for every game, and the registry build checks.
- Generated files are gitignored and produced by `npm run gen`, in place of c3's committed files with a CI diff check.

Declined:

- Per-game storage account and managed identity (c1, c2). In one process, RBAC only stops accidents the typed handles already stop. A later split changes `platformFor` and Bicep with zero game edits.
- Bicep in CI with Owner (c3). Revision 2 adopts CI Bicep at your direction, with narrowed per-layer identities instead of Owner.
- c2's iframes and ticket broker. They suit hostile third-party games, and they stay the recorded next step for that case.
- c1's shadow-root SPA mount. It forces a letterjoin port and shadow-DOM risk for no gain a child can see.

### Revision 2: owner feedback

Your feedback changed five things, each folded in above as a day-one requirement.

- West Europe for `rg-games4kids`, with Foundry still in Sweden Central. Revision 1 used North Europe.
- Entra assignment required, reversing revision 1. `tools/invite.mjs` writes both lists, `reconcile` finds drift, and the Function app loses `User.Invite.All`.
- One sign-in per child for every game, now explicit. Other sign-ins and parent accounts are doors only.
- Content migrates at cutover, and player data has a tool that waits for `--confirm-player-data`. Revision 1 started history fresh.
- Per-layer pipelines and identities. Revision 1 deployed infra from the laptop.

## Tradeoffs accepted

- We accept a page load between games in exchange for zero coupling between game runtimes.
- We accept isolation by types, project references, and lint, not Azure RBAC, in exchange for one Function app, one runtime identity, and one api deploy.
- We accept one Node process for every game's HTTP in exchange for no plumbing between services. A runtime hang in one game slows every game until the instance recycles.
- We accept maximum 1 instance in exchange for drawpad's worker staying serial.
- We accept that every api or web deploy ships every game. Health blocks a deploy that leaves a game unavailable.
- We accept two lists of who may enter, CLI-only invites, and a hub drift view as fresh as your last `reconcile`, in exchange for Entra refusing anyone you have not invited and no Graph permission on the backend.
- We accept one approval click per infra deploy, a recommendation you can drop, in exchange for no unreviewed change to Azure.
- We accept an infra identity that can change anything in `rg-games4kids` in exchange for deploys without the laptop.
- We accept player history waiting in the old apps, and migrations run from your laptop, in exchange for re-keying after each child signs in and no change to the old resource groups.
- We accept gitignored generated files, so a fresh clone needs `npm run gen`, which every npm entry point runs first.

## Alternatives considered

- **One SPA with games mounted in shadow roots.** letterjoin breaks its contract on mount, router, CSS scope, and build, so day one is a rewrite of a working game.
- **Iframes with a Function app per game.** Entra refuses to run in a frame, so each frame needs a token bridge, and it multiplies JWT validation, CORS, and deploys to guard against a hostile author who is also you.
- **Entra app roles for game roles.** Each rung of each game would need an app role, and each new game an Entra change.
- **Graph on the Function app, so `/admin/` can invite.** That puts a tenant-wide permission on the backend that runs every game.
- **One deploy identity for all layers.** A bug in the web job could then change infra.
- **Migrations in the pipeline.** Its identity would need roles on the old storage accounts.
- **The shell as an npm package bundled into each game.** letterjoin would need a bundler, and the browser would hold one MSAL per game.

## Open questions and risks

- drawpad's README says the Flex instance cap applies per function group. It is unmeasured here. Check it before drawpad's worker moves?
- A game module that throws while it loads takes down every game. CI catches it before deploy. Is that enough?
- Is `exports` the right door for a joint scoreboard, or should games write events to a portal table?
- Pull request what-if runs as the infra identity with no reviewer, which today only you can trigger. Could a Reader-only identity run it? Untested.
- letterjoin deploys its Flex app with Website Contributor alone. Does `id-g4k-api` need the blob role at all?
- When should player data move? Each run moves only mapped children, so it can run once at the end or after each first sign-in.
- Could an app outside this repo share the sign-in by calling `GET /api/portal/me` with an `access_as_user` token? Nothing here designs that.
- Would a parent join as a guest in your tenant, or wait for External ID?

## Build plan

Each phase ends in a named check and does not start until the previous check is green, per sequence-verifiable-units.

1. **Scaffold, host, and identity.** Done when `npm test` passes `identity.test`, `host.test`, `gen.test`, `boundaries.test`, and fixture conformance, and a throwing fixture shows `unavailable` in health.
2. **Shell and portal pages.** Done when the Playwright portal flow passes against the dev stack, covering sign-in, invite claim, profile, cards, the admin hub, and the not-invited screen.
3. **drawpad port.** Done when its Vitest suite, its conformance, and a Playwright smoke (open, draw, save, `time_up` at the limit) pass.
4. **letterjoin port.** Done when its `node --test` suite, its Playwright e2e at `/g/letterjoin/`, and its conformance pass.
5. **Bootstrap.** Done when a second `tools/bootstrap.mjs` run changes nothing and a pull request runs the infra what-if.
6. **Pipelines.** Done when `changes.test` passes, a web-only push skips infra and api, a fixture-game push runs infra after approval, then api, then web, and verify passes.
7. **Invites and content.** Done when `admin.test` passes, `reconcile` reports no drift, a second content apply writes nothing, and a family member plays both games on the iPad with the old pictures and activities.
8. **Player-data migration, not applied.** Done when `migrate.test` passes and a dry-run against the old accounts reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `host/src/identity.ts` and `host/src/host.ts` against `test/identity.test.ts` and `test/host.test.ts`, with the node adapter and the fake IdP, so the admission matrix is green before any game is copied in.
