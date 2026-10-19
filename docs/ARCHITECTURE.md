# games4kids portal architecture

This is the design for the games4kids portal, revised three times after owner feedback (see [Revision 4](#revision-4-cost-by-game-and-identity-without-p1)). Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. Below the sign-in they disagree on almost everything. drawpad is Preact with Vite, keyed by Entra `oid`, with `{ error: code }`. letterjoin is vanilla ES modules, keyed by email, with `{ error: message }`. What they share is the portal's job: MSAL against one tenant, a Functions API that validates its own JWTs, storage through a managed identity, and OIDC deploys. On a shared platform you also need to see which game costs what.

The old repos, deployments, Entra registrations, and resource groups stay as they are. The portal gets its own registration "games4kids" and resource group `rg-games4kids` in West Europe. Players are invite only, with one sign-in per child for every game. Every deploy goes through a pipeline, and the repo keeps one list of games.

## Where each action runs

People and access change only in the admin portal at `/admin/`. Azure resources, code, and the existing games4kids registration's settings change only through GitHub Actions. Your Mac creates the identities, grants their rights, and runs one-off data moves.

| | Mac (bootstrap only) | Admin portal, `/admin/` | Pipelines |
| --- | --- | --- | --- |
| People and access | Nothing | Invite with games and roles, change access, revoke, view and fix drift | Nothing |
| Entra | The games4kids registration and its settings. The managed identities, federated credentials, directory roles, Graph permission, and consent. The spike | Guests and their assignment to games4kids | Redirect URIs on the games4kids registration |
| Azure | `rg-games4kids`, the identities' Azure roles, your migration data roles | Nothing | Everything in Bicep, with tags and the workbook |
| GitHub | Environments, reviewers, and variables (ids and `BOOTSTRAP_ADMINS`, no secrets), through `gh` | Nothing | Nothing |
| Code | Nothing | Nothing | Both APIs and the site |
| Data | Content migration at cutover, player-data migration only when you say so | Nothing | Nothing |

The Mac never creates a user, sends an invite, or deploys. No pipeline or app creates a registration or managed identity, or grants a directory role or Graph permission. `tools/bootstrap.mjs` applies only the difference from current state.

## Usage (caller's view)

A game author reads this and nothing else:

```
games/<id>/manifest.ts     export default defineGame({...})              data only
games/<id>/web/            your pages, served at /g/<id>/
games/<id>/api/index.ts    export const createGameApi = defineGameApi(manifest, (platform) => ({ routes }))
games/<id>/infra.bicep     optional: Azure resources only this game uses, each tagged with the `tags` param
Import only @g4k/sdk and '/shell/v1.js'. Run npm run dev. Nothing else in the repo lists your game.
```

letterjoin's header becomes `<portal-bar title="Letter Tracing" back="/">`, with its practice pill and score chip in the `center` slot.

```js
import { enter } from '/shell/v1.js';
const { api, me } = await enter({ game: 'letterjoin' });
const groups = await api.get('activities');
// admin.js
const admin = await enter({ game: 'letterjoin', requires: 'admin' });
```

drawpad's `main.tsx` replaces `boot()` with the same call.

```tsx
const session = await enter<RoleOf<typeof manifest>>({ game: 'drawpad' });
render(<App session={session} />, document.getElementById('app')!);
```

On the API side, drawpad's `route({ requires })` and letterjoin's `level` become `Route` objects with `access`, and both user keys become `caller.userId` ([drawpad](sketch/examples/drawpad/api.ts), [letterjoin](sketch/examples/letterjoin/api.ts)). `platform.tables.pictures` in letterjoin and `access: 'superuser'` are compile errors. A game writes no telemetry code.

## Shape

### Repo layout

```
games4kids/
	package.json                npm workspaces. gen runs on predev, prebuild, pretest
	tsconfig.json               solution file. References the generated tsconfig.games.json
	eslint.config.js            no @azure/*, @opentelemetry/*, jose, or process.env in games/*/api
	packages/sdk/               @g4k/sdk: defineGame, defineGameApi, HttpError, Platform, Session
	shell/                      builds dist/site/shell/v1.js (MSAL and Application Insights vendored) and theme.css
	portal/web/                 / (home), /welcome/, /admin/ (invite form, access grid, drift), redirect.html
	host/src/                   index.ts, host.ts, identity.ts, storage.ts, telemetry.ts, portal-routes.ts, adapters/
	host/generated/games.ts     gitignored, from tools/gen.mjs
	admin/src/                  admin Function app: admin.ts, graph.ts, adapters/. Never imports games/*
	games/drawpad/              manifest.ts, web/ (Vite + Preact), api/, infra.bicep (Foundry, Event Grid)
	games/letterjoin/           manifest.ts, web/ (static), api/ (JS, checkJs), infra.bicep (Vision F0)
	tools/                      gen, build, dev, site-config, deploy, deploy-guard, changes, infra, bootstrap,
	                            migrate/content, migrate/player-data (all .mjs)
	infra/                      main.bicep, workbook.json, generated/ (gitignored: storage.json, games.bicep)
	dev/fake-idp.mjs            from letterjoin, unchanged
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/          deploy.yml, then the reusable infra.yml, api.yml, admin-api.yml, web.yml
```

### Request flow

1. A child opens `/`, which calls `enter({ game: null })` from `/shell/v1.js`. With no cached account, the shell calls `loginRedirect`, and Entra signs in only accounts assigned to games4kids.
2. The shell gets a token for `api://<clientId>/access_as_user` and calls `GET /api/portal/me`.
3. The host verifies the token, and the pure `decide` turns the stored rows into an `Admission`. An invited child's first sign-in claims, and a member with no profile goes to `/welcome/`.
4. Home renders cards from `catalog.json` for the granted games in `me.games`.
5. On Draw Pad, `enter({ game: 'drawpad' })` gets a token silently, returns `{ api, me, signOut }`, and starts the play heartbeat.
6. `api.post('drawings', ...)` reaches `host.handle`, which runs the fixed order in [`host.ts`](sketch/host.ts) inside a telemetry scope for `{ game, route, user }`: verify, admit, check `effectiveRole` against `route.access`, parse, `run`, map errors to `{ error, message, problems? }`, and add CORS for the site origin.

### Games are pages, not mounts or frames

The site is one Static Web App. The portal owns `/`, `/welcome/`, and `/admin/`. Each game is its own set of documents under `/g/<id>/`, built as `vite` or `static`, and every page imports `/shell/v1.js`. Pages share an origin, so moving between games costs one cached page load and a silent token call. Game admin screens stay in each game. One game's pointer handlers, CSS, or viewport meta can never reach another game.

### One host runs every game's API

The game host is one Functions app. `createHost` mounts `/api/portal/*` and each game's routes at `/api/g/<id>/*`. A game receives a `Platform<typeof manifest>` with tables, blobs, and queues typed from the names it declared, parsed settings, tokens for declared services only, a read-only `roster`, `now`, and `newId`. It never receives a credential, a client, or the environment, and `Reply` has no headers, so a game cannot set CORS. Only the adapters import a transport.

Each `games/<id>/api` and Vite `web` is a composite TS project that references only `@g4k/sdk`, so importing another game's or the host's files fails `tsc -b` (c1 measured TS6307). ESLint closes the rest.

### Startup containment and health

`mountGames` runs `platformFor` and `createGameApi` per game inside its own try/catch, so a game that throws, or lacks a required setting, answers 503 `game_unavailable` while the others mount, and `GET /api/portal/health` reports it. A module that throws while it loads is not contained, so CI catches it.

### Identity and roles

There is one single-tenant Entra registration, "games4kids", with SPA redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. The admin app mints a `PortalUserId`, a branded UUID, at invite. It is the only user key a game sees or stores.

Entry needs two things ([`identity.ts`](sketch/identity.ts)). Entra "assignment required" is on, and each invited account holds its own assignment to the games4kids enterprise app, so Entra issues no token to anyone else. Then the host admits only an active `members` row. The admin app writes both lists. Assigning a group instead would need Entra ID P1, which this tenant lacks (measured).

Each portal table lives in the portal account and has one writer, enforced by table-scoped roles for the admin app and by `HostStore`, which has no member writer, for the host.

| Table | Holds | Writer |
| --- | --- | --- |
| `members` | email, Entra object id, state, portal role, grants | admin app |
| `emails` | email to `PortalUserId` | admin app |
| `identities` | issuer and subject to `PortalUserId` | host, at first sign-in |
| `profiles`, `names` | display name and time zone | host, on `/welcome/` |

Each manifest declares its role ladder, lowest first, such as drawpad's `['player', 'admin']`. `effectiveRole`, the only function that computes a game role, gives a portal admin the top rung of every game and anyone else their grant, or `'none'` without one. So a new game is hidden from every child until you grant it, and `defaultRole` only pre-selects the role picker. A game sees `Caller = { userId, displayName, timeZone, role }` and nothing about tokens or email.

### The admin app holds the user rights, and no game code

`func-g4k-admin` is a second, small Function app that serves only `/api/admin/*` to the `/admin/` pages ([`admin.ts`](sketch/admin.ts)). It requires an active portal admin and reads games from `catalog.json`. It never imports `games/*`, so no game code runs under its identity, and the host's identity holds no Entra right.

Its identity, `id-g4k-graph`, holds two rights from bootstrap. Graph `User.Invite.All` creates guests, and is narrower than the Guest Inviter role, which also reads every user's profile, groups, and devices ([permissions reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)). The built-in Cloud Application Administrator role, scoped to the games4kids service principal only, adds and removes that app's assignments.

Tenant-wide, that role could add a credential to any app, drawpad's and letterjoin's included, and act as it. Scoped, it reaches only games4kids, where it could also add a credential or turn assignment off. games4kids holds no API permission, an app-only token lacks the `access_as_user` scope the host requires, and the member gate still holds, so that reaches no data (inferred).

Microsoft Learn confirms that built-in roles need no licence and accept an enterprise app or registration as scope ([RBAC overview](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/custom-overview)), and that the role includes `servicePrincipals/appRoleAssignedTo/update`. It leaves two gaps. Only "some relevant built-in roles" accept a single-resource scope ([assign roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal)), and Graph documents the app-only assignment call with `AppRoleAssignment.ReadWrite.All` only ([API page](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0)). Bootstrap's spike closes both.

### Onboarding a child

1. On `/admin/` you enter the child's email, a portal role, and a role for each game you tick.
2. The admin app reads or creates the `emails` row, which fixes the `PortalUserId`, so a re-invited child keeps their history.
3. It writes the active member row with the role and grants.
4. Unless the child has signed in, it sends Microsoft's B2B invitation and records the returned object id.
5. It assigns the account to games4kids, retrying after 2, 4, 8, and 16 seconds while Entra replicates a new guest, as drawpad's commit 83bc093 does for group adds (assignments assumed alike, guess).
6. The child accepts the email and signs in. With no identity row, the host finds the member through `emails` by the token's email, checks that its object id equals the token's `oid`, and inserts the identity row.
7. `/welcome/` asks for a display name and a time zone, and home shows only the granted games.

Steps 2 to 5 are `invite`, and each is safe to repeat. A crash after step 3 or 4 leaves an active member with no recorded account, which drift shows as `no-account`. After step 5 it leaves one Entra refuses, `not-assigned`. Sending the form again converges.

To revoke, the admin app marks the member revoked, then removes the assignment. The host reads the member row on every request, so the next call gets 403 `not_invited` even with a live token. A crash between the steps leaves `assigned-without-member`.

The access grid changes only grants and roles. Every `GET /api/admin/members` reads the app's assignments from Graph and runs `computeDrift` against the member rows, which are the intent, so **Fix drift** changes only Entra. On each cold start the admin app seeds an admin row for each `BOOTSTRAP_ADMINS` entry without one, and assigns that account.

### Doors left for other sign-ins and parents

Google and Facebook sign-in are not built. An Entra External ID tenant federated with both would join as a second `TrustedIssuer` whose identity rows map to the child's existing `PortalUserId`. Its tokens carry no workforce assignment or `oid`, so its claim rule waits for that door. You are the parent for now, as portal admin. A later parent account is a relation, not a role, and `identity.ts` reserves `guardianships` and `policies` tables for it.

### Data isolation

Each game has its own storage account, `g4k<id><suffix>`, and the portal has `g4kportal<suffix>`, with the suffix taken from Bicep's `uniqueString(resourceGroup().id)`. Inside an account, tables, containers, and queues keep their declared names, such as `pictures`, so the old `<id>` prefix is gone. Game ids are now 3 to 16 characters so account names fit Azure's 24.

`storage.ts` is the only module with a storage client, and `platformFor` builds a game's handles against that game's account only. `platform.tables` has only the declared keys, and `AzureService` has no storage member, so a game cannot spell another game's data. The host's identity holds data roles on every game account, since one process serves them all, so separate accounts stop accidents, such as a naming bug, but not hostile game code. Their reason is cost.

Cross-game features, such as a joint scoreboard, would go through the manifest's reserved `exports`, which admits only `{}` until a hub exists.

### Cost and usage by game

**Tags.** Bicep tags every resource `app=games4kids`. Each game's storage account and `infra.bicep` resources, such as drawpad's Foundry and Event Grid and letterjoin's Vision, also get `game=<id>` through a `tags` parameter from gen. The Static Web App, both Function apps, the portal account, Log Analytics, and Application Insights get `game=shared`. Tags reach usage records only while applied and only for types that emit them ([Cost Management data](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)), so `tools/infra.mjs` fails on a missing tag. Splitting one storage account by game would need storage logs, whose ingestion could cost more than the storage (guess). Extra accounts cost nothing, since storage bills by data and operations (inferred).

**Telemetry** goes to one workspace-based Application Insights. [`telemetry.ts`](sketch/telemetry.ts) defines the envelope `GameTelemetry = { game, route, user }`. `game` is a `GameId`, or `portal` for `/api/portal/*`, the admin app, and portal pages. `user` is the random `PortalUserId`, never an email.

- The Functions host writes each invocation's request row itself, so `registerWithFunctions` names each function `<owner>_<route>`, and every request and worker-run row carries the owner.
- The worker's dependencies, exceptions, and logs run inside `telemetry.within(envelope)`, and a span processor copies the envelope onto each record ([Functions OpenTelemetry](https://learn.microsoft.com/en-us/azure/azure-functions/opentelemetry-howto)). The host binds it before `run`, so a game cannot misreport itself.
- The shell stamps `game` and the user on page views, and sends a `game_session` event each minute a game page is visible. Play minutes are a count of those events.

**Sampling is off.** In OpenTelemetry mode `host.json` sampling no longer applies (verified), the worker samples always, and the shell sends 100 percent. The workspace and Application Insights cap ingestion at 0.2 GB a day, about ten times a guessed 10 to 30 MB. At the cap, collection stops for every table until the workspace's reset hour ([daily cap](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap)), so every game loses the rest of that day. An alert on `_LogOperation` rows containing "OverQuota" emails you, and the workbook marks capped days.

**The workbook**, `infra/workbook.json`, deploys with infra and groups every query by `game`, so a new game appears with no edit. It shows daily active players, play minutes, requests, errors, and p95 latency, Foundry and Vision calls, cost by tag `game`, and the host's compute split, with `portal` and `shared` as their own lines. `/admin/` gets no usage panel.

**The compute split is an estimate.** Flex bills an instance's memory while it executes, plus executions, with a 1,000 ms minimum rounded up to 100 ms ([Flex billing](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan#billing)). A KQL step returns `{ date, game, billedMs, share }` from request and worker durations after that rounding. A Cost Management step returns `{ date, costUsd }` for `func-g4k-host`, and a merge on `date` gives each game `costUsd * share`. The admin app's cost is all `portal`. Concurrent executions bill once but count per game, cold starts bill but belong to no request, and executions split by duration, not count. The workbook plots `OnDemandFunctionExecutionUnits` ([metrics](https://learn.microsoft.com/en-us/azure/azure-functions/monitor-functions-reference)) against `sum(billedMs) * 2048`, so the unattributed gap shows daily.

**Cost data in the workbook.** Workbooks can POST to Azure Resource Manager when it answers 200 synchronously ([data sources](https://learn.microsoft.com/en-us/azure/azure-monitor/visualize/workbooks-data-sources)), the Cost Management query is such a POST ([Query Usage](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage)), and Cost Management supports Pay-As-You-Go, up to 72 hours late. Each fact is verified, but the combination is untested. The fallback is a daily cost export to the portal account, shown on an admin page.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and writes the host registry, project references, `catalog.json`, the SWA routes, and `infra/generated/`, all gitignored, before every dev, build, test, and infra run. The build fails, listing every problem, on a folder that differs from its id, a duplicate, malformed, or reserved id (`portal`, `shared`, `shell`, `admin`, `welcome`, `api`, `g`), a missing required file, a declared storage name Azure rejects, a `defaultRole` off the ladder, a rung named `none`, or non-empty `exports`. `tools/infra.mjs` fails on an untagged resource.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`.
2. Add `web/index.html` that imports `/shell/v1.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources, tagging each with the `tags` param.
5. Run `npm test`. Gen runs first, and conformance covers the new game.
6. Push to `main`. `deploy.yml` runs infra after your approval, then the APIs, then web, and checks health.
7. In `/admin/`, grant the game to each child who should see it.

This touches one new folder and no Entra, workflow, or Mac step. Its storage account, tags, telemetry dimension, and workbook rows follow from the registry.

### Hosting and cost

Everything sits in West Europe, except the Foundry account in Sweden Central.

- Static Web App, Free.
- Two Flex Consumption Function apps on Node 22 with maximum 1 instance. The cap applies per function group, and a queue function scales alone (verified, [Flex scaling](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan#per-function-scaling)), so the HTTP routes share one instance and drawpad's Foundry worker runs serially on another. The game host has 2048 MB and a system-assigned identity. `func-g4k-admin` has 512 MB and `id-g4k-graph`.
- A storage account per game and one for the portal, which also holds both deployment containers. Shared keys off, no public blob access.
- Log Analytics, Application Insights, the workbook, and each game's `infra.bicep` resources.

The monthly cost is a guess of 1 to 3 USD, telemetry included, before Foundry at 0.015 to 0.048 USD per redraw (drawpad measured).

### Pipelines and deploy identities

`deploy.yml` runs lint, `tsc -b`, every test, and letterjoin's deploy guard on pull requests and pushes to `main`. `tools/changes.mjs` maps changed paths and gen output to layers, and `deploy.yml` calls the reusable `infra.yml`, `api.yml`, `admin-api.yml`, and `web.yml` in order, skipping unchanged layers.

1. Infra runs Bicep `what-if` on a pull request and deploys on `main`, so a new game's account exists before its api ships. Then it sets the SWA redirect URIs on the games4kids registration, writing only a difference.
2. Api and admin-api zip-deploy side by side, and `tools/deploy.mjs verify` requires health at this commit: every game `ok`, the admin seed done.
3. Web builds every page, writes `config.json` with both API origins, the telemetry connection string, and CSP, uploads the site, and verifies `/version.json`.

Each layer has its own user-assigned identity, federated to its own GitHub environment, which only `main` may deploy to. GitHub holds only ids, which `azure/login` uses with the job's OIDC token.

- `id-g4k-infra`, environments `infra` and `infra-plan`. Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition that allows only storage data roles, Cognitive Services User, and Monitoring Metrics Publisher for service principals, Website Contributor for `id-g4k-api` and `id-g4k-admin-api`, and Contributor for `id-g4k-web`. Cloud Application Administrator scoped to the games4kids registration, for redirect URIs.
- `id-g4k-api` and `id-g4k-admin-api`. Website Contributor on their app and a blob role on its deployment container.
- `id-g4k-web`. Contributor on the Static Web App.

`id-g4k-infra` and `id-g4k-admin-api` can both run code as `id-g4k-graph`, so their environments require your approval.

### Bootstrap and the spike

`tools/bootstrap.mjs` runs under your Owner and Global Administrator sign-in and never touches an individual user.

1. Create the games4kids registration and service principal, the `access_as_user` scope, and assignment required. With no app roles defined, assignments use the default access role.
2. Create the five identities, their federated credentials, and the GitHub environments and variables.
3. Run the spike. A throwaway probe registration, its certificate held only in memory, gets Cloud Application Administrator scoped to the games4kids service principal and to the registration. With an app-only token, the probe assigns your account, lists assignments, removes yours, and rewrites the redirect URIs unchanged, retrying for ten minutes while roles propagate. Bootstrap then deletes the probe.
4. If the spike passes, give `id-g4k-graph` the role on the service principal and `User.Invite.All` with admin consent, and `id-g4k-infra` the role on the registration.

If Entra refuses the scope ("The given built-in role is not supported to be assigned to a single resource scope") or a probe call answers 403, bootstrap stops, names the call, and prints the fallbacks:

1. Buy one Entra ID P1 licence (a guess of about 6 USD a month) and return to revision 3's group, whose Graph permission reaches every group that is not role-assignable.
2. Grant `AppRoleAssignment.ReadWrite.All`, which can assign any app role, Graph's included, to any principal, itself included. That is control of the tenant.
3. Assign the role tenant-wide, which reaches drawpad's and letterjoin's registrations.

If only the registration write fails, infra returns to owning the registration with `Application.ReadWrite.OwnedBy`. If only the list fails, add the read-only `Application.Read.All`. The probe and `id-g4k-graph` are both service principals, so the result should carry over (inferred). Phase 7 proves it.

### Bringing the two games in

Each game's web and api folders are copied, minus what the portal now owns, such as drawpad's auth and profile code and letterjoin's `gate.js`, `auth.js`, and `vendor/msal`.

Content migrates at cutover, and player data gets a tested tool that waits for your word. Both read the old accounts only, write each game's new account, and leave both old apps live. Every write is insert-if-absent at a key derived from the source, so reruns converge ([`migrate.ts`](sketch/migrate.ts)).

- `tools/migrate/content.mjs` copies drawpad's pictures and settings tables and pictures container, including accepted AI-generated files, and letterjoin's activities table.
- `tools/migrate/player-data.mjs` re-keys each game's per-child tables and images from member rows, so a child is mapped once invited. drawpad's `oid` is the member's Entra object id, and letterjoin's key is `sha256(email)`. The default is a dry run reporting unmapped keys. Writing needs `--apply --confirm-player-data`, and the type admits apply only with the confirmation that flag mints.

### Shared now, and deliberately not

The portal owns sign-in, profiles, members, invites, grants, `<portal-bar>`, the API client, `config.json` and CSP, the error shape, theme tokens, telemetry, the workbook, and the dev stack. Play-time limits stay in each game, since drawpad's hard daily limit and letterjoin's soft practice goal are different products.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP, both apps on the node adapter with memory storage or Azurite (one account per owner), a fake Graph, an in-memory telemetry sink, and a site server with SWA headers and Vite. The root `npm test` runs these suites:

- `identity.test`, `host.test`, and `gen.test` cover `decide`, `effectiveRole`, the admission matrix, and each `Problem` kind.
- `boundaries.test` proves that game code importing host files, or admin code importing `games/*`, fails `tsc -b`.
- `conformance.test` runs per game: 401 without a token, every access floor, `not_entitled` without a grant, its own account and declared names only, site-only CORS, and the game's id on every telemetry record.
- `admin.test` uses the fake Graph for drift, its fix, the seed, and invites and revokes that crash at each step.
- `migrate.test` and `changes.test` cover the migration modes and the path-to-layer map.

## Synthesis decision

Three designs went to a bakeoff. c1 mounted games in shadow roots of one SPA, c2 used iframes and a Function app per game, and c3 co-hosted pages on one host. A cross-judge scored c3 28, c1 25, and c2 18 out of 30. c3 is the base, because only it brings letterjoin in without a rewrite. It took c1's identity model, project references, lint bans, and containment, and c2's conformance suite and registry checks.

### Earlier revisions

Revision 2 moved to West Europe and added Entra assignment, the migrations, and per-layer pipelines. Revision 3 moved invites, grants, revokes, and live drift into `/admin/` on a separate admin app, and made no grant mean no access.

### Revision 4: cost by game, and identity without P1

- Cost by game is a day-one requirement. Tags come from the registry, every telemetry record carries `game`, and a workbook labels the compute split an estimate.
- Each game gets its own storage account, reversing the bakeoff's decline of c1's and c2's accounts, because tags make storage cost exact. The `<id>` and `portal` name prefixes are gone, ids cap at 16 characters, and `shared` is reserved.
- The tenant has no Entra ID P1 (measured), so revision 3's `games4kids-players` group would have failed at bootstrap. Accounts are assigned directly, and the group, `GroupMember.ReadWrite.All`, and the group drift kinds are deleted.
- Cloud Application Administrator, scoped to the games4kids objects, lets the admin identity assign users and the infra identity set redirect URIs, replacing ownership and `Application.ReadWrite.OwnedBy`. The spike proves it first.

## Tradeoffs accepted

Each item names the cost, then what it buys.

- A page load between games, for zero coupling between game runtimes.
- Isolation by types, project references, and lint, not RBAC, for one game host and one api deploy.
- One instance for every game's HTTP routes, so a hang in one slows all, for drawpad's worker staying serial.
- Every deploy ships every game, with health blocking one that leaves a game unavailable.
- An estimated compute split, shown beside the billed metric, for not running a Function app per game.
- A telemetry cap that can blind a day, alerted and marked, for a bounded bill.
- An admin identity that can change any setting of the games4kids enterprise app, for onboarding with no Entra right where game code runs.
- Two lists of who may enter, for Entra refusing anyone you have not invited.
- An approval click per infra or admin-api deploy, for deploys without the Mac.
- Player history waiting in the old apps, for no change to the old resource groups.

## Alternatives considered

- **Entra app roles for game roles.** Each new game would need an Entra change.
- **An assigned group, or `AppRoleAssignment.ReadWrite.All`.** These are the spike's fallbacks, for the reasons given there.
- **One storage account split by logs.** The split costs ingestion and stays approximate.
- **A usage panel in `/admin/`.** The workbook already shows usage beside cost.
- **Graph on the game host.** Every game's code would run under an identity that can invite guests.
- **Invites from the Mac, or one deploy identity.** Access would change in two places, and a web job bug could change infra.
- **The shell as an npm package per game.** letterjoin would need a bundler.

## Open questions and risks

- The design depends on the spike. If it fails, which fallback do you take?
- Can the workbook query Cost Management on this Pay-As-You-Go subscription? Untested.
- Is 0.2 GB a day right? The volume behind it is a guess until a week of real use.
- The migrations run on your Mac because a pipeline would need read roles on the old storage accounts. Do you accept that?
- drawpad keeps a fallback object-id lookup needing `User.Read.All`. Is it ever needed?
- A game module that throws while it loads takes down every game, and only CI catches it. Is that enough?
- Is `exports` the right door for a joint scoreboard, and would a parent join as a guest or wait for External ID?
- Could a Reader-only identity run the what-if? Do the api deploy identities need the blob role?

## Build plan

Each phase starts only when the previous phase's named check is green.

1. **Scaffold, host, identity, and telemetry.** Done when the unit suites and fixture conformance pass, a throwing fixture shows `unavailable`, and every record in the telemetry sink carries the fixture's id.
2. **Shell, portal pages, and admin app.** Done when `admin.test` passes and Playwright on the dev stack covers an invite with one game, the claim, home showing only that game, a revoke, and the not-invited screen.
3. **drawpad port.** Done when its Vitest suite, conformance, and a Playwright smoke reaching `time_up` pass.
4. **letterjoin port.** Done when its `node --test` suite, conformance, and Playwright e2e at `/g/letterjoin/` pass.
5. **Bootstrap.** Done when the spike passes, a second run changes nothing, and a pull request runs the infra what-if.
6. **Pipelines and the workbook.** Done when `changes.test` passes, a web-only push skips infra and both APIs, a fixture-game push runs every layer, and after a Playwright smoke run of both games the workbook shows drawpad and letterjoin with non-zero players, play minutes, requests, and compute share. Cost tiles are checked 72 hours later.
7. **Onboarding and content.** Done when a family member invited from `/admin/` sees only their granted games, drift is empty, a second content apply writes nothing, and the old pictures and activities show on the iPad.
8. **Player-data migration, not applied.** Done when `migrate.test` passes and a dry run reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `host/src/identity.ts`, `host/src/host.ts`, and `host/src/telemetry.ts` against their tests, with the node adapter and the fake IdP, so the admission matrix and the telemetry stamping are green before any game is copied in.
